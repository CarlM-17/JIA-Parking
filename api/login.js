const { getRange } = require('../lib/sheets');
const { ADMIN_PASS } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const body = req.body || await parseBody(req);
    const username = (body.username || '').trim();
    const password = body.password || '';
    if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' });

    // Admin
    if (username.toLowerCase() === 'admin') {
      if (password === ADMIN_PASS) {
        return res.status(200).json({ ok: true, role: 'admin', userid: 'admin', name: 'Administrator', token: ADMIN_PASS });
      }
      return res.status(401).json({ ok: false, error: 'Invalid admin password' });
    }

    // Cashier - look up in sheet
    const rows = await getRange('Cashiers!A2:E');
    const match = rows.find(r =>
      (r[0] || '').toString().trim() === username &&
      (r[2] || '') === password
    );
    if (!match) return res.status(401).json({ ok: false, error: 'Invalid User ID or password' });
    if ((match[3] || '').toString().toUpperCase() !== 'TRUE') {
      return res.status(403).json({ ok: false, error: 'This cashier account is deactivated' });
    }

    return res.status(200).json({
      ok: true, role: 'cashier',
      userid: match[0], name: match[1], token: password
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}
