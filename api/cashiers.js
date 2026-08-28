const { getRange, appendRow, updateCell } = require('../lib/sheets');
const { requireAuth } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token, x-user-id');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res, 'admin');
  if (!user) return;

  try {
    if (req.method === 'GET') {
      const rows = await getRange('Cashiers!A2:E');
      const cashiers = rows.map(r => ({
        userid: r[0] || '',
        name: r[1] || '',
        password: r[2] || '',
        active: (r[3] || '').toString().toUpperCase() === 'TRUE',
        added: r[4] || ''
      })).filter(c => c.userid);
      return res.status(200).json({ ok: true, cashiers });
    }

    if (req.method === 'POST') {
      const body = req.body || await parseBody(req);
      const userid = (body.userid || '').toString().trim();
      const name = (body.name || '').toString().trim();
      const password = (body.password || '').toString().trim();
      if (!userid || !name || !password) {
        return res.status(400).json({ ok: false, error: 'userid, name, and password all required' });
      }

      // Duplicate check
      const existing = await getRange('Cashiers!A2:A');
      const dup = existing.some(r => (r[0] || '').toString().trim() === userid);
      if (dup) return res.status(409).json({ ok: false, error: 'User ID already exists' });

      const today = new Date().toISOString().slice(0, 10);
      await appendRow('Cashiers!A:E', [userid, name, password, 'TRUE', today]);
      return res.status(200).json({ ok: true, cashier: { userid, name, active: true, added: today } });
    }

    if (req.method === 'PATCH') {
      const body = req.body || await parseBody(req);
      const { userid, action, new_password } = body;
      if (!userid) return res.status(400).json({ ok: false, error: 'userid required' });

      const rows = await getRange('Cashiers!A2:E');
      const idx = rows.findIndex(r => (r[0] || '').toString().trim() === userid);
      if (idx === -1) return res.status(404).json({ ok: false, error: 'Cashier not found' });
      const rowNum = idx + 2;

      if (action === 'deactivate') {
        await updateCell(`Cashiers!D${rowNum}`, 'FALSE');
        return res.status(200).json({ ok: true, message: 'Cashier deactivated' });
      }
      if (action === 'activate') {
        await updateCell(`Cashiers!D${rowNum}`, 'TRUE');
        return res.status(200).json({ ok: true, message: 'Cashier activated' });
      }
      if (action === 'reset_password') {
        if (!new_password) return res.status(400).json({ ok: false, error: 'new_password required' });
        await updateCell(`Cashiers!C${rowNum}`, new_password);
        return res.status(200).json({ ok: true, message: 'Password reset' });
      }
      return res.status(400).json({ ok: false, error: 'Unknown action' });
    }

    res.status(405).json({ ok: false, error: 'method not allowed' });
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
