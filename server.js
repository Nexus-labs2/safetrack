const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://safetrack-frontend.onrender.com',
  /\.onrender\.com$/
];

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(bodyParser.json());

let deviceState = {
  connected: false,
  lat: null,
  lng: null,
  sos: false,
  sosLocation: null,
  lastSeen: null,
  deviceId: null
};

app.get('/', (req, res) => {
  res.json({
    status: 'SafeTrack Backend Running',
    time: new Date().toISOString(),
    device: deviceState.deviceId || 'not connected'
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/location', (req, res) => {
  const { lat, lng, deviceId } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  deviceState.connected = true;
  deviceState.lat = parseFloat(lat);
  deviceState.lng = parseFloat(lng);
  deviceState.lastSeen = new Date().toISOString();
  deviceState.deviceId = deviceId || 'DEVICE_01';

  io.emit('location_update', {
    lat: deviceState.lat,
    lng: deviceState.lng,
    deviceId: deviceState.deviceId,
    lastSeen: deviceState.lastSeen,
    connected: true
  });

  console.log(`📍 [${deviceState.deviceId}] ${lat}, ${lng}`);
  res.json({ status: 'ok' });
});

app.post('/api/sos', (req, res) => {
  const { lat, lng, deviceId, active } = req.body;

  deviceState.sos = active;

  if (active) {
    deviceState.sosLocation = {
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      time: new Date().toISOString()
    };
    console.log(`🚨 SOS ON at ${lat}, ${lng}`);
  } else {
    console.log(`✅ SOS OFF`);
  }

  io.emit('sos_update', {
    active: deviceState.sos,
    sosLocation: deviceState.sosLocation,
    deviceId: deviceId || deviceState.deviceId
  });

  res.json({ status: 'ok' });
});

app.get('/api/state', (req, res) => res.json(deviceState));

setInterval(() => {
  if (deviceState.lastSeen) {
    const diff = (Date.now() - new Date(deviceState.lastSeen)) / 1000;
    if (diff > 30 && deviceState.connected) {
      deviceState.connected = false;
      io.emit('device_offline', { deviceId: deviceState.deviceId });
      console.log('⚠️ Device went offline');
    }
  }
}, 5000);

io.on('connection', (socket) => {
  console.log('🖥️ Dashboard connected:', socket.id);
  socket.emit('init_state', deviceState);
  socket.on('disconnect', () => {
    console.log('🖥️ Dashboard disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SafeTrack backend running on port ${PORT}`);
});