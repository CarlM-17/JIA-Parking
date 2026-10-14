const express = require('express');
const https = require('https');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ============ CONFIG ============
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123';

// ============ GOOGLE SHEETS HELPER ============
let cachedToken = null;
let tokenExpiry = 0;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const claim = base64url(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now
  }));
  const signInput = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  const signature = signer.sign(PRIVATE_KEY).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${signInput}.${signature}`;
  const body = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`;
  const res = await httpsRequest({
    hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  const data = JSON.parse(res);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

async function getRange(range) {
  const token = await getAccessToken();
  const res = await httpsRequest({
    hostname: 'sheets.googleapis.com',
    path: `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
    method: 'GET', headers: { Authorization: `Bearer ${token}` }
  });
  return JSON.parse(res).values || [];
}

async function appendRow(range, values) {
  const token = await getAccessToken();
  const body = JSON.stringify({ values: [values] });
  await httpsRequest({
    hostname: 'sheets.googleapis.com',
    path: `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
}

async function updateRow(range, values) {
  const token = await getAccessToken();
  const body = JSON.stringify({ values: [values] });
  await httpsRequest({
    hostname: 'sheets.googleapis.com',
    path: `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
}

const updateCell = (range, value) => updateRow(range, [value]);

// ============ AUTH ============
async function identifyUser(req) {
  const token = req.headers['x-auth-token'] || '';
  const userid = (req.headers['x-user-id'] || '').trim();
  if (!token || !userid) return null;
  if (userid === 'admin') {
    return token === ADMIN_PASS ? { role: 'admin', userid: 'admin', name: 'Administrator' } : null;
  }
  try {
    const rows = await getRange('Cashiers!A2:E');
    const match = rows.find(r =>
      (r[0] || '').toString().trim() === userid &&
      (r[2] || '') === token &&
      (r[3] || '').toString().toUpperCase() === 'TRUE'
    );
    if (match) return { role: 'cashier', userid: match[0], name: match[1] };
  } catch (e) { console.error('Cashier lookup:', e.message); }
  return null;
}

async function requireAuth(req, res, requiredRole) {
  const user = await identifyUser(req);
  if (!user) { res.status(401).json({ ok: false, error: 'Unauthorized - please log in' }); return null; }
  if (requiredRole === 'admin' && user.role !== 'admin') {
    res.status(403).json({ ok: false, error: 'Admin only' }); return null;
  }
  return user;
}

// ============ UTILITIES ============
function nowPH() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function calculateCharge(hours) {
  if (hours <= 3) return 20;
  return 20 + (Math.ceil(hours - 3) * 10);
}

function matchesToday(timeIn, year, month, day) {
  if (!timeIn) return false;
  const t = timeIn.toString();
  const m2 = String(month).padStart(2, '0');
  const d2 = String(day).padStart(2, '0');
  if (t.includes(`${year}-${m2}-${d2}`)) return true;
  if (t.includes(`${month}/${day}/${year}`) || t.includes(`${m2}/${d2}/${year}`)) return true;
  if (t.includes(`${day}/${month}/${year}`) || t.includes(`${d2}/${m2}/${year}`)) return true;
  const parsed = new Date(t);
  if (!isNaN(parsed)) {
    const phDate = new Date(parsed.getTime() + 8 * 3600 * 1000);
    if (phDate.getUTCFullYear() === year && phDate.getUTCMonth() + 1 === month && phDate.getUTCDate() === day) return true;
  }
  return false;
}

// ============ API: LOGIN ============
app.post('/api/login', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' });

    if (username.toLowerCase() === 'admin') {
      if (password === ADMIN_PASS) {
        return res.json({ ok: true, role: 'admin', userid: 'admin', name: 'Administrator', token: ADMIN_PASS });
      }
      return res.status(401).json({ ok: false, error: 'Invalid admin password' });
    }

    const rows = await getRange('Cashiers!A2:E');
    const match = rows.find(r => (r[0] || '').toString().trim() === username && (r[2] || '') === password);
    if (!match) return res.status(401).json({ ok: false, error: 'Invalid User ID or password' });
    if ((match[3] || '').toString().toUpperCase() !== 'TRUE') {
      return res.status(403).json({ ok: false, error: 'This cashier account is deactivated' });
    }
    res.json({ ok: true, role: 'cashier', userid: match[0], name: match[1], token: password });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============ API: HEALTH ============
app.get('/api/health', async (req, res) => {
  const env = {
    GOOGLE_SHEET_ID: !!process.env.GOOGLE_SHEET_ID,
    GOOGLE_CLIENT_EMAIL: !!process.env.GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
    ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD
  };
  try {
    const rows = await getRange('Members!A1:E1');
    res.json({ ok: true, env, sheet_headers: rows[0] || [], can_read_sheet: true });
  } catch (e) {
    res.status(500).json({ ok: false, env, can_read_sheet: false, sheet_error: e.message });
  }
});

// ============ API: MEMBERS (admin) ============
app.get('/api/members', async (req, res) => {
  const user = await requireAuth(req, res, 'admin'); if (!user) return;
  try {
    const rows = await getRange('Members!A2:E');
    const members = rows.map(r => ({
      qr_id: r[0] || '', plate: r[1] || '', owner: r[2] || '',
      active: (r[3] || '').toString().toUpperCase() === 'TRUE', created: r[4] || ''
    })).filter(m => m.qr_id);
    res.json({ ok: true, members });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/members', async (req, res) => {
  const user = await requireAuth(req, res, 'admin'); if (!user) return;
  try {
    const quantity = parseInt(req.body.quantity) || 1;
    const note = (req.body.note || '').trim();
    if (quantity < 1 || quantity > 200) return res.status(400).json({ ok: false, error: 'quantity must be 1-200' });
    const existing = await getRange('Members!A2:A');
    let startNum = existing.length + 1;
    const today = new Date().toISOString().slice(0, 10);
    const generated = [];
    for (let i = 0; i < quantity; i++) {
      const num = (startNum + i).toString().padStart(4, '0');
      const qr_id = `JIA-${num}`;
      await appendRow('Members!A:E', [qr_id, '', note, 'TRUE', today]);
      const qr_image = await QRCode.toDataURL(qr_id, { width: 400, margin: 2 });
      generated.push({ qr_id, qr_image });
    }
    res.json({ ok: true, count: generated.length, generated });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/qr-image', async (req, res) => {
  try {
    const qr_id = req.query.id;
    if (!qr_id) return res.status(400).json({ ok: false, error: 'id required' });
    const dataUrl = await QRCode.toDataURL(qr_id, { width: 500, margin: 2 });
    res.json({ ok: true, qr_id, qr_image: dataUrl });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ============ API: CASHIERS (admin) ============
app.get('/api/cashiers', async (req, res) => {
  const user = await requireAuth(req, res, 'admin'); if (!user) return;
  try {
    const rows = await getRange('Cashiers!A2:E');
    const cashiers = rows.map(r => ({
      userid: r[0] || '', name: r[1] || '', password: r[2] || '',
      active: (r[3] || '').toString().toUpperCase() === 'TRUE', added: r[4] || ''
    })).filter(c => c.userid);
    res.json({ ok: true, cashiers });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/cashiers', async (req, res) => {
  const user = await requireAuth(req, res, 'admin'); if (!user) return;
  try {
    const userid = (req.body.userid || '').toString().trim();
    const name = (req.body.name || '').toString().trim();
    const password = (req.body.password || '').toString().trim();
    if (!userid || !name || !password) return res.status(400).json({ ok: false, error: 'userid, name, and password all required' });
    const existing = await getRange('Cashiers!A2:A');
    if (existing.some(r => (r[0] || '').toString().trim() === userid)) {
      return res.status(409).json({ ok: false, error: 'User ID already exists' });
    }
    const today = new Date().toISOString().slice(0, 10);
    await appendRow('Cashiers!A:E', [userid, name, password, 'TRUE', today]);
    res.json({ ok: true, cashier: { userid, name, active: true, added: today } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/cashiers', async (req, res) => {
  const user = await requireAuth(req, res, 'admin'); if (!user) return;
  try {
    const { userid, action, new_password } = req.body;
    if (!userid) return res.status(400).json({ ok: false, error: 'userid required' });
    const rows = await getRange('Cashiers!A2:E');
    const idx = rows.findIndex(r => (r[0] || '').toString().trim() === userid);
    if (idx === -1) return res.status(404).json({ ok: false, error: 'Cashier not found' });
    const rowNum = idx + 2;
    if (action === 'deactivate') { await updateCell(`Cashiers!D${rowNum}`, 'FALSE'); return res.json({ ok: true }); }
    if (action === 'activate') { await updateCell(`Cashiers!D${rowNum}`, 'TRUE'); return res.json({ ok: true }); }
    if (action === 'reset_password') {
      if (!new_password) return res.status(400).json({ ok: false, error: 'new_password required' });
      await updateCell(`Cashiers!C${rowNum}`, new_password);
      return res.json({ ok: true });
    }
    res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ============ API: SCAN ============
app.post('/api/scan', async (req, res) => {
  const user = await requireAuth(req, res, 'cashier'); if (!user) return;
  const cashierTag = `${user.userid} - ${user.name}`;
  try {
    const qr_id = (req.body.qr_id || '').trim();
    const plateInput = (req.body.plate || '').trim().toUpperCase();
    if (!qr_id) return res.status(400).json({ ok: false, error: 'qr_id required' });

    const members = await getRange('Members!A2:E');
    const memberIdx = members.findIndex(r => (r[0] || '').trim().toUpperCase() === qr_id.toUpperCase());
    if (memberIdx === -1) return res.status(404).json({ ok: false, error: 'QR not registered', qr_id });
    const member = members[memberIdx];
    if ((member[3] || '').toString().toUpperCase() !== 'TRUE') {
      return res.status(403).json({ ok: false, error: 'This QR has already been used. Please request a new one.', qr_id });
    }
    const owner = member[2] || '';

    const logs = await getRange('ParkingLog!A2:J');
    const openIdx = logs.findIndex(r =>
      (r[1] || '').trim().toUpperCase() === qr_id.toUpperCase() &&
      (!r[4] || r[4].trim() === '') &&
      (r[7] || '').toString().toUpperCase() === 'ACTIVE'
    );
    const isEntry = openIdx === -1;

    if (isEntry) {
      if (!plateInput) {
        return res.json({ ok: false, needs_plate: true, mode: 'ENTRY', qr_id, error: 'Plate number required for entry' });
      }
      const memberTickets = logs.filter(r => (r[0] || '').startsWith(qr_id + '-T'));
      const nextTicketNum = (memberTickets.length + 1).toString().padStart(3, '0');
      const ticket_no = `${qr_id}-T${nextTicketNum}`;
      const time_in = nowPH();
      await appendRow('ParkingLog!A:J', [ticket_no, qr_id, plateInput, time_in, '', '', '', 'ACTIVE', cashierTag, '']);
      return res.json({ ok: true, mode: 'ENTRY', ticket_no, qr_id, plate: plateInput, owner, time_in, cashier: cashierTag, message: 'ENTRY - Ticket Issued' });
    } else {
      const row = logs[openIdx];
      const ticket_no = row[0];
      const plate = row[2] || '';
      const time_in_str = row[3];
      const cashier_in = row[8] || '';
      const time_in = new Date(time_in_str.replace(' ', 'T') + '+08:00');
      const time_out_str = nowPH();
      const time_out = new Date(time_out_str.replace(' ', 'T') + '+08:00');
      const durationHrs = (time_out - time_in) / 3600000;
      const charge = calculateCharge(durationHrs);
      const rowNum = openIdx + 2;
      await updateRow(`ParkingLog!A${rowNum}:J${rowNum}`, [
        ticket_no, qr_id, plate, time_in_str, time_out_str, durationHrs.toFixed(2), charge, 'COMPLETED', cashier_in, cashierTag
      ]);
      await updateCell(`Members!D${memberIdx + 2}`, 'FALSE');
      return res.json({
        ok: true, mode: 'EXIT', ticket_no, qr_id, plate, owner,
        time_in: time_in_str, time_out: time_out_str, duration_hrs: durationHrs.toFixed(2),
        charge, cashier_in, cashier_out: cashierTag, message: 'EXIT - Charge Calculated (QR now deactivated)'
      });
    }
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ============ API: TODAY (cashier + admin) ============
app.get('/api/today', async (req, res) => {
  const user = await requireAuth(req, res, 'cashier'); if (!user) return;
  try {
    const logs = await getRange('ParkingLog!A2:J');
    const nowP = new Date(Date.now() + 8 * 3600 * 1000);
    const year = nowP.getUTCFullYear();
    const month = nowP.getUTCMonth() + 1;
    const day = nowP.getUTCDate();
    const today = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const todayLogs = logs.filter(r => matchesToday(r[3], year, month, day)).map(r => ({
      ticket_no: r[0] || '', qr_id: r[1] || '', plate: r[2] || '',
      time_in: r[3] || '', time_out: r[4] || '',
      duration_hrs: r[5] || '', charge: r[6] || '', status: r[7] || '',
      cashier_in: r[8] || '', cashier_out: r[9] || ''
    }));
    const totalCharge = todayLogs.reduce((s, r) => s + (parseFloat(r.charge) || 0), 0);
    const active = todayLogs.filter(r => r.status === 'ACTIVE').length;
    const completed = todayLogs.filter(r => r.status === 'COMPLETED').length;
    res.json({ ok: true, date: today, total_rows_in_sheet: logs.length, logs: todayLogs, total_charge: totalCharge, active_count: active, completed_count: completed });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ============ API: REPORTS (admin) ============
app.get('/api/reports', async (req, res) => {
  const user = await requireAuth(req, res, 'admin'); if (!user) return;
  try {
    const logs = await getRange('ParkingLog!A2:J');
    const total = logs.reduce((s, r) => s + (parseFloat(r[6]) || 0), 0);
    res.json({ ok: true, count: logs.length, total, logs });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ============ HTML PAGES ============
const nav = (active) => `
<nav style="margin-bottom:12px">
  <a href="/admin" style="padding:8px 14px;background:${active==='admin'?'#1e3a8a':'#1e40af'};color:white;text-decoration:none;border-radius:6px;margin-right:6px">Admin</a>
  <a href="/cashiers" style="padding:8px 14px;background:${active==='cashiers'?'#1e3a8a':'#1e40af'};color:white;text-decoration:none;border-radius:6px;margin-right:6px">Cashiers</a>
  <a href="/cashier" style="padding:8px 14px;background:${active==='cashier'?'#1e3a8a':'#1e40af'};color:white;text-decoration:none;border-radius:6px;margin-right:6px">Scan</a>
  <a href="/reports" style="padding:8px 14px;background:${active==='reports'?'#1e3a8a':'#1e40af'};color:white;text-decoration:none;border-radius:6px;margin-right:6px">Reports</a>
  <button onclick="logout()" style="padding:8px 14px;background:#dc2626;color:white;border:none;border-radius:6px;cursor:pointer">Logout</button>
</nav>`;

const authScript = `
const TOKEN = localStorage.getItem('jia_token');
const ROLE = localStorage.getItem('jia_role');
const USERID = localStorage.getItem('jia_userid') || 'admin';
const NAME = localStorage.getItem('jia_name') || '';
function logout() { localStorage.clear(); window.location.href = '/login'; }
function authHdr() { return {'Content-Type':'application/json', 'x-auth-token': TOKEN, 'x-user-id': USERID}; }
`;

app.get('/login', (req, res) => res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JIA Login</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:linear-gradient(135deg,#1e40af,#3b82f6);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.box{background:white;padding:32px;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.2);max-width:400px;width:100%}
h1{color:#1e40af;margin-bottom:8px}p{color:#6b7280;margin-bottom:20px;font-size:14px}
input,button{width:100%;padding:12px;font-size:16px;border-radius:6px;border:1px solid #d1d5db;margin-bottom:12px}
button{background:#1e40af;color:white;border:none;cursor:pointer;font-weight:600}
.err{background:#fee2e2;color:#991b1b;padding:10px;border-radius:6px;font-size:14px;margin-bottom:12px;display:none}</style></head><body>
<div class="box"><h1>JIA Parking</h1><p>Log in with your User ID (cashier) or type "admin"</p>
<div class="err" id="err"></div>
<input type="text" id="u" placeholder="User ID (or 'admin')">
<input type="password" id="p" placeholder="Password">
<button onclick="login()">Login</button></div>
<script>
if (localStorage.getItem('jia_role')) window.location.href = localStorage.getItem('jia_role')==='admin'?'/admin':'/cashier';
document.getElementById('p').addEventListener('keypress',e=>{if(e.key==='Enter')login()});
async function login(){
  const u=document.getElementById('u').value.trim(), p=document.getElementById('p').value;
  const err=document.getElementById('err'); err.style.display='none';
  if(!u||!p){err.textContent='User ID and password required';err.style.display='block';return;}
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const d=await r.json();
    if(!d.ok){err.textContent=d.error;err.style.display='block';return;}
    localStorage.setItem('jia_role',d.role);localStorage.setItem('jia_userid',d.userid);
    localStorage.setItem('jia_name',d.name);localStorage.setItem('jia_token',d.token);
    window.location.href=d.role==='admin'?'/admin':'/cashier';
  }catch(e){err.textContent='Error: '+e.message;err.style.display='block';}
}
</script></body></html>`));

app.get('/admin', (req, res) => res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JIA Admin</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#f3f4f6;padding:20px}
h1{color:#1e40af;margin-bottom:20px}
.card{background:white;padding:20px;border-radius:10px;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
input,button{padding:12px;font-size:16px;border-radius:6px;border:1px solid #d1d5db}
button{background:#1e40af;color:white;border:none;cursor:pointer}button:hover{background:#1e3a8a}button:disabled{background:#9ca3af}
table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:10px;text-align:left;border-bottom:1px solid #e5e7eb}th{background:#f9fafb;font-weight:600}
.qr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-top:16px}
.qr-item{border:2px solid #1e40af;border-radius:8px;padding:12px;text-align:center;background:white}
.qr-item img{width:100%;max-width:180px}.qr-item .id{font-weight:bold;color:#1e40af;margin:8px 0}
.qr-item button{padding:6px 10px;font-size:13px;margin:2px}.btn-share{background:#16a34a}
.err{background:#fee2e2;color:#991b1b;padding:12px;border-radius:6px;margin-top:10px}
.ok{background:#d1fae5;color:#065f46;padding:12px;border-radius:6px;margin-top:10px}
.field{margin:8px 0}.field label{display:block;font-size:13px;color:#6b7280;margin-bottom:4px}
.used{color:#dc2626;font-weight:bold}.active{color:#16a34a;font-weight:bold}</style></head><body>
<h1>JIA Parking - Admin</h1>${nav('admin')}
<div class="card"><h2>Generate QR Codes (Bulk)</h2>
<p style="color:#6b7280;margin:8px 0">Each QR is valid for ONE entry + ONE exit only.</p>
<div class="field"><label>Quantity</label><input id="quantity" type="number" min="1" max="200" value="10" style="width:120px"></div>
<div class="field"><label>Batch note (optional)</label><input id="note" placeholder="e.g. Sunday Batch 1" style="width:350px"></div>
<button id="genBtn" onclick="generate()">Generate QR Codes</button><div id="msg"></div></div>
<div class="card" id="qrResults" style="display:none"><h2>Generated QR Codes</h2>
<div style="margin:10px 0"><button onclick="downloadAll()">Download All</button>
<button onclick="printAll()" style="background:#6b7280">Print All</button></div>
<div class="qr-grid" id="qrGrid"></div></div>
<div class="card"><h2>All Registered QR Codes</h2>
<button onclick="loadMembers()" style="margin-bottom:10px">Refresh</button>
<table id="mTable"><thead><tr><th>QR ID</th><th>Note</th><th>Status</th><th>Created</th><th>Action</th></tr></thead><tbody></tbody></table></div>
<script>${authScript}
if(!TOKEN||ROLE!=='admin')window.location.href='/login';
let lastGen=[];
async function generate(){
  const q=parseInt(document.getElementById('quantity').value)||0;
  const n=document.getElementById('note').value.trim();
  const btn=document.getElementById('genBtn'),msg=document.getElementById('msg');msg.innerHTML='';
  if(q<1||q>200){msg.innerHTML='<div class="err">Quantity must be 1-200</div>';return;}
  btn.disabled=true;btn.textContent='Generating '+q+' QR codes...';
  try{
    const r=await fetch('/api/members',{method:'POST',headers:authHdr(),body:JSON.stringify({quantity:q,note:n})});
    if(r.status===401)return logout();
    const d=await r.json();
    if(!d.ok)msg.innerHTML='<div class="err">'+d.error+'</div>';
    else{lastGen=d.generated;msg.innerHTML='<div class="ok">Generated '+d.count+' QR codes</div>';showQRs(d.generated);loadMembers();}
  }catch(e){msg.innerHTML='<div class="err">'+e.message+'</div>';}
  btn.disabled=false;btn.textContent='Generate QR Codes';
}
function showQRs(items){
  const g=document.getElementById('qrGrid');g.innerHTML='';
  items.forEach(it=>{
    const d=document.createElement('div');d.className='qr-item';
    d.innerHTML='<img src="'+it.qr_image+'"><div class="id">'+it.qr_id+'</div>'+
      '<button onclick="dlOne(\\''+it.qr_id+'\\',\\''+it.qr_image+'\\')">Download</button>'+
      '<button class="btn-share" onclick="shareOne(\\''+it.qr_id+'\\',\\''+it.qr_image+'\\')">Share</button>';
    g.appendChild(d);
  });
  document.getElementById('qrResults').style.display='block';
}
function dlOne(id,url){const a=document.createElement('a');a.href=url;a.download=id+'.png';a.click();}
function downloadAll(){lastGen.forEach((it,i)=>setTimeout(()=>dlOne(it.qr_id,it.qr_image),i*200));}
async function shareOne(id,url){
  try{const b=await(await fetch(url)).blob();const f=new File([b],id+'.png',{type:'image/png'});
    if(navigator.canShare&&navigator.canShare({files:[f]}))await navigator.share({files:[f],title:'JIA QR',text:'Your JIA parking QR: '+id});
    else{dlOne(id,url);alert('Sharing not supported. QR downloaded.');}
  }catch(e){console.error(e);}
}
function printAll(){
  const w=window.open('','_blank');
  let h='<html><head><title>JIA QR</title><style>body{font-family:sans-serif;padding:20px}.q{display:inline-block;text-align:center;margin:10px;padding:10px;border:2px solid #1e40af;border-radius:8px;page-break-inside:avoid}.q img{width:200px}.q div{font-weight:bold;color:#1e40af;margin-top:8px}</style></head><body>';
  lastGen.forEach(it=>{h+='<div class="q"><img src="'+it.qr_image+'"><div>'+it.qr_id+'</div></div>';});
  h+='</body></html>';w.document.write(h);w.document.close();setTimeout(()=>w.print(),500);
}
async function loadMembers(){
  try{
    const r=await fetch('/api/members',{headers:authHdr()});
    if(r.status===401)return logout();
    const d=await r.json();const tb=document.querySelector('#mTable tbody');tb.innerHTML='';
    (d.members||[]).forEach(m=>{
      const s=m.active?'<span class="active">ACTIVE</span>':'<span class="used">USED</span>';
      const tr=document.createElement('tr');
      tr.innerHTML='<td>'+m.qr_id+'</td><td>'+(m.owner||'')+'</td><td>'+s+'</td><td>'+m.created+'</td>'+
        '<td><button onclick="viewQR(\\''+m.qr_id+'\\')">View QR</button></td>';
      tb.appendChild(tr);
    });
  }catch(e){console.error(e);}
}
async function viewQR(id){
  const r=await fetch('/api/qr-image?id='+encodeURIComponent(id));const d=await r.json();
  if(d.ok){lastGen=[{qr_id:id,qr_image:d.qr_image}];showQRs(lastGen);window.scrollTo({top:0,behavior:'smooth'});}
}
loadMembers();
</script></body></html>`));

app.get('/cashiers', (req, res) => res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Manage Cashiers</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#f3f4f6;padding:20px}
h1{color:#1e40af;margin-bottom:20px}
.card{background:white;padding:20px;border-radius:10px;margin:20px 0;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
input,button{padding:12px;font-size:16px;border-radius:6px;border:1px solid #d1d5db}
button{background:#1e40af;color:white;border:none;cursor:pointer}button:hover{background:#1e3a8a}
button.sm{padding:6px 10px;font-size:13px;margin:2px}button.danger{background:#dc2626}button.warn{background:#d97706}button.ok{background:#16a34a}
table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:10px;text-align:left;border-bottom:1px solid #e5e7eb}th{background:#f9fafb;font-weight:600}
.err{background:#fee2e2;color:#991b1b;padding:12px;border-radius:6px;margin-top:10px}
.okmsg{background:#d1fae5;color:#065f46;padding:12px;border-radius:6px;margin-top:10px}
.field{margin:8px 0}.field label{display:block;font-size:13px;color:#6b7280;margin-bottom:4px}
.active{color:#16a34a;font-weight:bold}.inactive{color:#dc2626;font-weight:bold}</style></head><body>
<h1>Manage Cashiers</h1>${nav('cashiers')}
<div class="card"><h2>Add New Cashier</h2>
<p style="color:#6b7280;margin:8px 0">Cashier logs in with User ID + Password. Their name is recorded on every scan.</p>
<div class="field"><label>User ID (e.g. C001, 12345)</label><input id="uid" style="width:250px" placeholder="e.g. C001"></div>
<div class="field"><label>Complete Name</label><input id="nm" style="width:350px" placeholder="e.g. Juan Dela Cruz"></div>
<div class="field"><label>Password</label><input id="pw" type="text" style="width:250px" placeholder="Set a password"></div>
<button onclick="addC()">Add Cashier</button><div id="msg"></div></div>
<div class="card"><h2>All Cashiers</h2>
<button onclick="loadC()" style="margin-bottom:10px">Refresh</button>
<table id="cTable"><thead><tr><th>User ID</th><th>Name</th><th>Password</th><th>Status</th><th>Added</th><th>Actions</th></tr></thead><tbody></tbody></table></div>
<script>${authScript}
if(!TOKEN||ROLE!=='admin')window.location.href='/login';
async function addC(){
  const uid=document.getElementById('uid').value.trim();
  const nm=document.getElementById('nm').value.trim();
  const pw=document.getElementById('pw').value.trim();
  const msg=document.getElementById('msg');msg.innerHTML='';
  if(!uid||!nm||!pw){msg.innerHTML='<div class="err">All 3 fields required</div>';return;}
  const r=await fetch('/api/cashiers',{method:'POST',headers:authHdr(),body:JSON.stringify({userid:uid,name:nm,password:pw})});
  if(r.status===401)return logout();
  const d=await r.json();
  if(!d.ok)msg.innerHTML='<div class="err">'+d.error+'</div>';
  else{msg.innerHTML='<div class="okmsg">Added: '+nm+' ('+uid+')</div>';
    document.getElementById('uid').value='';document.getElementById('nm').value='';document.getElementById('pw').value='';loadC();}
}
async function loadC(){
  const r=await fetch('/api/cashiers',{headers:authHdr()});
  if(r.status===401)return logout();
  const d=await r.json();const tb=document.querySelector('#cTable tbody');tb.innerHTML='';
  (d.cashiers||[]).forEach(c=>{
    const s=c.active?'<span class="active">ACTIVE</span>':'<span class="inactive">DEACTIVATED</span>';
    const tgl=c.active?'<button class="sm danger" onclick="tgl(\\''+c.userid+'\\',\\'deactivate\\')">Deactivate</button>'
      :'<button class="sm ok" onclick="tgl(\\''+c.userid+'\\',\\'activate\\')">Activate</button>';
    const tr=document.createElement('tr');
    tr.innerHTML='<td>'+c.userid+'</td><td>'+c.name+'</td><td>'+c.password+'</td><td>'+s+'</td><td>'+c.added+'</td>'+
      '<td>'+tgl+'<button class="sm warn" onclick="rst(\\''+c.userid+'\\')">Reset Password</button></td>';
    tb.appendChild(tr);
  });
}
async function tgl(uid,act){
  if(!confirm(act.toUpperCase()+' '+uid+'?'))return;
  const r=await fetch('/api/cashiers',{method:'PATCH',headers:authHdr(),body:JSON.stringify({userid:uid,action:act})});
  const d=await r.json();if(d.ok)loadC();else alert(d.error);
}
async function rst(uid){
  const np=prompt('New password for '+uid+':');if(!np)return;
  const r=await fetch('/api/cashiers',{method:'PATCH',headers:authHdr(),body:JSON.stringify({userid:uid,action:'reset_password',new_password:np})});
  const d=await r.json();if(d.ok){alert('Password reset to: '+np);loadC();}else alert(d.error);
}
loadC();
</script></body></html>`));

app.get('/cashier', (req, res) => res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JIA Cashier</title>
<script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0f172a;color:white;padding:12px;min-height:100vh}
h1{color:#60a5fa;margin-bottom:8px;text-align:center}.who{text-align:center;color:#94a3b8;margin-bottom:10px;font-size:14px}
nav{text-align:center;margin-bottom:12px}nav button{padding:6px 12px;background:#dc2626;color:white;border-radius:6px;border:none;cursor:pointer;font-size:14px}
.mbtn{display:block;width:100%;max-width:500px;margin:16px auto;padding:24px;font-size:24px;font-weight:bold;background:#1e40af;color:white;border:none;border-radius:12px;cursor:pointer;box-shadow:0 4px 12px rgba(30,64,175,0.4)}
.mbtn:hover{background:#1e3a8a}.mbtn.on{background:#dc2626}
#scanArea{max-width:500px;margin:0 auto;display:none}#reader{width:100%;border-radius:12px;overflow:hidden;background:#1e293b}
.card{background:#1e293b;padding:16px;border-radius:12px;margin:12px auto;max-width:500px}
.ok{background:#065f46;border:2px solid #10b981}.entry{background:#1e3a8a;border:2px solid #3b82f6}
.err{background:#7f1d1d;border:2px solid #ef4444}.plt{background:#78350f;border:2px solid #f59e0b}
.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1)}.row:last-child{border:none}
.lbl{color:#94a3b8}.val{font-weight:600}.big{font-size:28px;text-align:center;padding:10px;color:#fbbf24;font-weight:bold}
.chg{font-size:48px;text-align:center;padding:16px;color:#fbbf24;font-weight:bold}
button{padding:12px;font-size:16px;border-radius:8px;border:none;background:#1e40af;color:white;cursor:pointer;margin-top:8px}
.wide{width:100%;padding:14px;font-size:18px}
input{width:100%;padding:12px;font-size:18px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:white;margin-bottom:10px;text-transform:uppercase}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:500px;margin:16px auto}
.st{background:#1e293b;padding:12px;border-radius:8px;text-align:center}.st .n{font-size:24px;font-weight:bold;color:#60a5fa}.st .l{font-size:11px;color:#94a3b8;text-transform:uppercase}
.wrap{max-width:100%;overflow-x:auto;margin:12px auto}table{width:100%;background:#1e293b;border-collapse:collapse;font-size:13px}
th,td{padding:8px;text-align:left;border-bottom:1px solid #334155}th{background:#0f172a;color:#60a5fa}
tr.a{background:#1e3a8a}.sA{color:#fbbf24;font-weight:bold}.sD{color:#10b981;font-weight:bold}</style></head><body>
<h1>JIA Cashier</h1><div class="who">Logged in as: <span id="who"></span></div>
<nav><button onclick="logout()">Logout</button></nav>
<button id="scanBtn" class="mbtn" onclick="toggleScan()">Scan QR Code</button>
<div id="scanArea"><div id="reader"></div>
<div style="margin:10px 0"><input id="mInput" placeholder="OR type QR (e.g. JIA-0001)"><button class="wide" onclick="mSubmit()">Submit</button></div></div>
<div id="rb"></div>
<div class="stats"><div class="st"><div class="n" id="sT">0</div><div class="l">Total Today</div></div>
<div class="st"><div class="n" id="sA">0</div><div class="l">Still Parked</div></div>
<div class="st"><div class="n" id="sC">PHP 0</div><div class="l">Collected</div></div></div>
<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
<strong>Today's Scans</strong><button onclick="loadToday()" style="padding:4px 10px;font-size:13px">Refresh</button></div>
<div class="wrap"><table id="tT"><thead><tr><th>Ticket</th><th>QR</th><th>Plate</th><th>In</th><th>Out</th><th>Charge</th><th>Status</th></tr></thead><tbody></tbody></table></div></div>
<script>${authScript}
if(!TOKEN||(ROLE!=='admin'&&ROLE!=='cashier'))window.location.href='/login';
document.getElementById('who').textContent=USERID+' - '+NAME;
let scanner=null,scanning=false,processing=false,lastT=0,pending=null;
function beep(t){try{const c=new(window.AudioContext||window.webkitAudioContext)();const o=c.createOscillator(),g=c.createGain();o.connect(g);g.connect(c.destination);
if(t==='ok'){o.frequency.value=880;g.gain.setValueAtTime(0.3,c.currentTime);o.start();o.stop(c.currentTime+0.15);}
else if(t==='exit'){o.frequency.value=660;g.gain.setValueAtTime(0.3,c.currentTime);o.start();o.frequency.setValueAtTime(880,c.currentTime+0.15);o.stop(c.currentTime+0.35);}
else{o.frequency.value=200;o.type='sawtooth';g.gain.setValueAtTime(0.3,c.currentTime);o.start();o.stop(c.currentTime+0.4);}}catch(e){}}
async function toggleScan(){
  if(scanning){await stopS();document.getElementById('scanArea').style.display='none';
    document.getElementById('scanBtn').textContent='Scan QR Code';document.getElementById('scanBtn').classList.remove('on');}
  else{document.getElementById('scanArea').style.display='block';
    document.getElementById('scanBtn').textContent='Stop Scanner';document.getElementById('scanBtn').classList.add('on');await startS();}
}
async function startS(){scanning=true;try{scanner=new Html5Qrcode('reader');await scanner.start({facingMode:'environment'},{fps:10,qrbox:{width:250,height:250}},onScan);}
catch(e){document.getElementById('reader').innerHTML='<div style="padding:20px;text-align:center;color:#fbbf24">Camera unavailable. Type QR manually.<br><small>'+e+'</small></div>';}}
async function stopS(){scanning=false;if(scanner){try{await scanner.stop();await scanner.clear();}catch(e){}scanner=null;}}
function onScan(txt){const n=Date.now();if(processing||n-lastT<3000)return;lastT=n;processScan(txt.trim().toUpperCase());}
async function mSubmit(){const v=document.getElementById('mInput').value.trim().toUpperCase();if(!v)return;document.getElementById('mInput').value='';await processScan(v);}
async function processScan(qr,plate){
  processing=true;
  document.getElementById('rb').innerHTML='<div class="card">Checking '+qr+'...</div>';
  try{
    const r=await fetch('/api/scan',{method:'POST',headers:authHdr(),body:JSON.stringify({qr_id:qr,plate:plate||''})});
    if(r.status===401)return logout();
    const d=await r.json();
    if(d.needs_plate){beep('ok');showPlate(qr);}
    else if(d.ok){beep(d.mode==='EXIT'?'exit':'ok');showRes(d);await stopS();
      document.getElementById('scanArea').style.display='none';
      document.getElementById('scanBtn').textContent='Scan QR Code';
      document.getElementById('scanBtn').classList.remove('on');loadToday();}
    else{beep('err');await stopS();
      document.getElementById('scanArea').style.display='none';
      document.getElementById('scanBtn').textContent='Scan QR Code';
      document.getElementById('scanBtn').classList.remove('on');
      showErr(d.error||'Error',qr);alert('INVALID QR CODE\\n\\n'+(d.error||'Error')+'\\n\\nCode scanned: '+qr);}
  }catch(e){beep('err');await stopS();
    document.getElementById('scanArea').style.display='none';
    document.getElementById('scanBtn').textContent='Scan QR Code';
    document.getElementById('scanBtn').classList.remove('on');
    showErr(e.message,qr);alert('ERROR\\n\\n'+e.message);}
  setTimeout(()=>{processing=false;},1500);
}
function showPlate(qr){
  pending=qr;
  document.getElementById('rb').innerHTML='<div class="card plt"><div class="big">ENTRY</div>'+
    '<div class="row"><span class="lbl">QR ID</span><span class="val">'+qr+'</span></div>'+
    '<div style="margin-top:16px;color:#fde68a;font-size:14px">Enter plate number:</div>'+
    '<input id="plateIn" placeholder="e.g. ABC-1234" style="margin-top:8px;background:#451a03;font-size:22px;text-align:center">'+
    '<button class="wide" onclick="subPlate()">Confirm Entry</button>'+
    '<button class="wide" style="background:#6b7280" onclick="clr()">Cancel</button></div>';
  setTimeout(()=>{const i=document.getElementById('plateIn');if(i){i.focus();i.addEventListener('keypress',e=>{if(e.key==='Enter')subPlate();});}},100);
}
async function subPlate(){
  const p=document.getElementById('plateIn').value.trim().toUpperCase();
  if(!p){alert('Plate required');return;}
  const q=pending;pending=null;await processScan(q,p);
}
function showRes(d){
  const cls=d.mode==='EXIT'?'ok':'entry';
  let h='<div class="card '+cls+'"><div class="big">'+d.mode+'</div>'+
    '<div class="row"><span class="lbl">Ticket</span><span class="val">'+d.ticket_no+'</span></div>'+
    '<div class="row"><span class="lbl">QR ID</span><span class="val">'+d.qr_id+'</span></div>';
  if(d.plate)h+='<div class="row"><span class="lbl">Plate</span><span class="val">'+d.plate+'</span></div>';
  h+='<div class="row"><span class="lbl">Time In</span><span class="val">'+d.time_in+'</span></div>';
  if(d.mode==='EXIT'){
    h+='<div class="row"><span class="lbl">Time Out</span><span class="val">'+d.time_out+'</span></div>'+
      '<div class="row"><span class="lbl">Duration</span><span class="val">'+d.duration_hrs+' hrs</span></div>'+
      '<div class="row"><span class="lbl">Cashier In</span><span class="val">'+(d.cashier_in||'-')+'</span></div>'+
      '<div class="row"><span class="lbl">Cashier Out</span><span class="val">'+(d.cashier_out||'-')+'</span></div>'+
      '<div class="chg">PHP '+d.charge+'</div>'+
      '<div style="text-align:center;color:#fca5a5;padding:8px">QR deactivated</div>';
  }else{
    h+='<div class="row"><span class="lbl">Cashier</span><span class="val">'+(d.cashier||'-')+'</span></div>'+
      '<div style="text-align:center;padding:12px;color:#93c5fd">Ticket issued. Scan again upon exit.</div>';
  }
  h+='<button class="wide" onclick="clr()">Done</button></div>';
  document.getElementById('rb').innerHTML=h;
}
function showErr(m,qr){document.getElementById('rb').innerHTML='<div class="card err"><div class="big">INVALID</div>'+
  '<div class="row"><span class="lbl">Code</span><span class="val">'+(qr||'')+'</span></div>'+
  '<div class="row"><span class="lbl">Reason</span><span class="val">'+m+'</span></div>'+
  '<button class="wide" onclick="clr()">Try Again</button></div>';}
function clr(){document.getElementById('rb').innerHTML='';}
async function loadToday(){
  try{
    const r=await fetch('/api/today',{headers:authHdr()});
    if(r.status===401)return logout();
    const d=await r.json();if(!d.ok)return;
    document.getElementById('sT').textContent=d.logs.length;
    document.getElementById('sA').textContent=d.active_count;
    document.getElementById('sC').textContent='PHP '+d.total_charge;
    const tb=document.querySelector('#tT tbody');tb.innerHTML='';
    if(d.logs.length===0){tb.innerHTML='<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:16px">No scans today yet</td></tr>';return;}
    d.logs.slice().reverse().forEach(r=>{
      const tr=document.createElement('tr');if(r.status==='ACTIVE')tr.className='a';
      const sc=r.status==='ACTIVE'?'sA':'sD';
      const tI=(r.time_in||'').slice(11,16),tO=(r.time_out||'').slice(11,16);
      tr.innerHTML='<td>'+r.ticket_no+'</td><td>'+r.qr_id+'</td><td>'+r.plate+'</td>'+
        '<td>'+tI+'</td><td>'+tO+'</td><td>'+(r.charge?'P'+r.charge:'-')+'</td>'+
        '<td class="'+sc+'">'+r.status+'</td>';
      tb.appendChild(tr);
    });
  }catch(e){console.error(e);}
}
loadToday();setInterval(loadToday,30000);
</script></body></html>`));

app.get('/reports', (req, res) => res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reports</title>
<style>body{font-family:system-ui,sans-serif;background:#f3f4f6;padding:20px}h1{color:#1e40af}
table{width:100%;background:white;border-collapse:collapse;margin-top:12px;font-size:13px}
th,td{padding:8px;text-align:left;border-bottom:1px solid #e5e7eb}th{background:#1e40af;color:white}
.totals{background:white;padding:16px;border-radius:8px;margin:16px 0;font-size:18px}.wrap{overflow-x:auto}</style></head><body>
<h1>JIA Parking - Reports</h1>${nav('reports')}
<div class="totals" id="totals">Loading...</div>
<div class="wrap"><table id="t"><thead><tr><th>Ticket</th><th>QR</th><th>Plate</th><th>In</th><th>Out</th><th>Hrs</th><th>Charge</th><th>Status</th><th>Cashier In</th><th>Cashier Out</th></tr></thead><tbody></tbody></table></div>
<script>${authScript}
if(!TOKEN||ROLE!=='admin')window.location.href='/login';
async function load(){
  const r=await fetch('/api/reports',{headers:authHdr()});if(r.status===401)return logout();
  const d=await r.json();
  document.getElementById('totals').innerHTML='Total records: <b>'+d.count+'</b> | Total collected: <b>PHP '+d.total+'</b>';
  const tb=document.querySelector('#t tbody');tb.innerHTML='';
  (d.logs||[]).reverse().forEach(r=>{
    const tr=document.createElement('tr');
    tr.innerHTML='<td>'+(r[0]||'')+'</td><td>'+(r[1]||'')+'</td><td>'+(r[2]||'')+'</td>'+
      '<td>'+(r[3]||'')+'</td><td>'+(r[4]||'')+'</td><td>'+(r[5]||'')+'</td>'+
      '<td>'+(r[6]||'')+'</td><td>'+(r[7]||'')+'</td><td>'+(r[8]||'')+'</td><td>'+(r[9]||'')+'</td>';
    tb.appendChild(tr);
  });
}
load();
</script></body></html>`));

app.get('/', (req, res) => res.redirect('/login'));

// ============ START ============
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`JIA Parking running on port ${PORT}`));
}

module.exports = app;
