require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { point, polygon } = require('@turf/helpers');

const app = express();
const server = http.createServer(app);

// ── Supabase ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CORS ──────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://safetrack-frontend1.onrender.com',
  /\.onrender\.com$/
];

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true },
  transports: ['websocket', 'polling']
});

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(bodyParser.json());

// ── In-memory state ───────────────────────────────────────
let deviceState = {
  connected: false, lat: null, lng: null,
  sos: false, sosLocation: null, lastSeen: null, deviceId: null
};

// ── Auth middleware ───────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ── Health ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'SafeTrack Running', time: new Date() }));
app.get('/health', (req, res) => res.json({ ok: true }));

// ── Admin Login ───────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const { data: admin } = await supabase
    .from('admins').select('*').eq('username', username).single();

  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

  // For first-time setup: if password_hash starts with 'plain:', compare directly
  let valid = false;
  if (admin.password_hash.startsWith('plain:')) {
    valid = password === admin.password_hash.replace('plain:', '');
  } else {
    valid = await bcrypt.compare(password, admin.password_hash);
  }

  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: admin.id, username: admin.username },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ token, username: admin.username });
});

// ── Location (ESP32 → Server) ─────────────────────────────
app.post('/api/location', async (req, res) => {
  const { lat, lng, deviceId } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  const parsedLat = parseFloat(lat);
  const parsedLng = parseFloat(lng);
  const devId = deviceId || 'DEVICE_01';

  deviceState = {
    ...deviceState,
    connected: true, lat: parsedLat, lng: parsedLng,
    lastSeen: new Date().toISOString(), deviceId: devId
  };

  // Upsert device
  await supabase.from('devices').upsert({
    id: devId, connected: true, last_seen: deviceState.lastSeen
  });

  // Save location history
  await supabase.from('locations').insert({
    device_id: devId, lat: parsedLat, lng: parsedLng
  });

  // Check geofence breaches
  await checkGeofences(devId, parsedLat, parsedLng);

  io.emit('location_update', {
    lat: parsedLat, lng: parsedLng,
    deviceId: devId, lastSeen: deviceState.lastSeen, connected: true
  });

  res.json({ status: 'ok' });
});

// ── SOS (ESP32 → Server) ──────────────────────────────────
app.post('/api/sos', async (req, res) => {
  const { lat, lng, deviceId, active } = req.body;
  deviceState.sos = active;

  if (active) {
    deviceState.sosLocation = { lat: parseFloat(lat), lng: parseFloat(lng), time: new Date().toISOString() };
    await supabase.from('sos_events').insert({
      device_id: deviceId || deviceState.deviceId,
      lat: parseFloat(lat), lng: parseFloat(lng), active: true
    });
  } else {
    await supabase.from('sos_events')
      .update({ active: false, cleared_at: new Date().toISOString() })
      .eq('device_id', deviceId || deviceState.deviceId).eq('active', true);
  }

  io.emit('sos_update', { active, sosLocation: deviceState.sosLocation, deviceId });
  res.json({ status: 'ok' });
});

// ── Geofence check ────────────────────────────────────────
async function checkGeofences(deviceId, lat, lng) {
  const { data: fences } = await supabase
    .from('geofences').select('*').eq('device_id', deviceId).eq('active', true);

  if (!fences || fences.length === 0) return;

  const pt = point([lng, lat]);

  for (const fence of fences) {
    try {
      // Handle both Polygon and Circle-style zones
      if (!fence.zone || !fence.zone.coordinates) continue;

      const poly = polygon(fence.zone.coordinates);
      const inside = booleanPointInPolygon(pt, poly);

      if (!inside) {
        await supabase.from('geofence_breaches').insert({
          device_id: deviceId,
          geofence_id: fence.id,
          lat, lng,
          breach_type: 'exit'
        });

        io.emit('geofence_breach', {
          deviceId,
          fenceName: fence.name,
          lat, lng,
          time: new Date().toISOString(),
          message: `⚠️ ${deviceId} left safe zone "${fence.name}"!`
        });

        console.log(`🚨 GEOFENCE BREACH: ${deviceId} left "${fence.name}"`);
      }
    } catch (err) {
      console.error(`Geofence check error for fence ${fence.id}:`, err.message);
    }
  }
}

// ── Geofence CRUD (admin protected) ──────────────────────
app.get('/api/geofences/:deviceId', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('geofences')
    .select('*').eq('device_id', req.params.deviceId);
  res.json(data || []);
});

app.post('/api/geofences', authMiddleware, async (req, res) => {
  const { name, deviceId, zone, centerLat, centerLng, radiusMeters } = req.body;
  const { data, error } = await supabase.from('geofences').insert({
    name, device_id: deviceId, zone,
    center_lat: centerLat, center_lng: centerLng,
    radius_meters: radiusMeters
  }).select().single();
  if (error) return res.status(400).json({ error });
  io.emit('geofence_updated', data);
  res.json(data);
});

app.put('/api/geofences/:id', authMiddleware, async (req, res) => {
  const { name, zone, centerLat, centerLng, radiusMeters, active } = req.body;
  const { data, error } = await supabase.from('geofences')
    .update({ name, zone, center_lat: centerLat, center_lng: centerLng, radius_meters: radiusMeters, active, updated_at: new Date() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error });
  io.emit('geofence_updated', data);
  res.json(data);
});

app.delete('/api/geofences/:id', authMiddleware, async (req, res) => {
  await supabase.from('geofences').delete().eq('id', req.params.id);
  io.emit('geofence_deleted', { id: req.params.id });
  res.json({ status: 'deleted' });
});

// ── Bhuvan WMS Proxy (bypasses browser CORS) ──────────────
app.get('/api/bhuvan-proxy', async (req, res) => {
  try {
    const params = new URLSearchParams(req.query);
    const bhuvanUrl = `https://bhuvan-vec1.nrsc.gov.in/bhuvan/wms?${params}`;
    const response = await fetch(bhuvanUrl);
    const buffer = await response.buffer();
    res.set('Content-Type', response.headers.get('content-type') || 'image/png');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(buffer);
  } catch (err) {
    // Fallback: return transparent pixel if Bhuvan is down
    res.status(502).json({ error: 'Bhuvan WMS unavailable' });
  }
});

// ── State & history ───────────────────────────────────────
app.get('/api/state', (req, res) => res.json(deviceState));

app.get('/api/history/:deviceId', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('locations')
    .select('*').eq('device_id', req.params.deviceId)
    .order('recorded_at', { ascending: false }).limit(100);
  res.json(data || []);
});

app.get('/api/breaches/:deviceId', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('geofence_breaches')
    .select('*, geofences(name)').eq('device_id', req.params.deviceId)
    .order('occurred_at', { ascending: false }).limit(50);
  res.json(data || []);
});

// ── Offline detection ─────────────────────────────────────
setInterval(async () => {
  if (deviceState.lastSeen) {
    const diff = (Date.now() - new Date(deviceState.lastSeen)) / 1000;
    if (diff > 30 && deviceState.connected) {
      deviceState.connected = false;
      await supabase.from('devices').update({ connected: false }).eq('id', deviceState.deviceId);
      io.emit('device_offline', { deviceId: deviceState.deviceId });
    }
  }
}, 5000);

// ── Socket.IO ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('🖥️ Dashboard connected:', socket.id);
  socket.emit('init_state', deviceState);
  socket.on('disconnect', () => console.log('🖥️ Disconnected:', socket.id));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 SafeTrack on port ${PORT}`));