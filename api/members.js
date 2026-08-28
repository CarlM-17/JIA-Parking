const { getRange, appendRow } = require('../lib/sheets');
const { requireAuth } = require('../lib/auth');
const QRCode = require('qrcode');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token, x-user-id');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res, 'admin');
  if (!user) return;

  try {
    if (req.method === 'GET') {
      const rows = await getRange('Members!A2:E');
      const members = rows.map(r => ({
        qr_id: r[0] || '',
        plate: r[1] || '',
        owner: r[2] || '',
        active: (r[3] || '').toString().toUpperCase() === 'TRUE',
        created: r[4] || ''
      })).filter(m => m.qr_id);
      return res.status(200).json({ ok: true, members });
    }

    if (req.method === 'POST') {
      const body = req.body || await parseBody(req);
      const quantity = parseInt(body.quantity) || 1;
      const note = (body.note || '').trim();

      if (quantity < 1 || quantity > 200) {
        return res.status(400).json({ ok: false, error: 'quantity must be 1-200' });
      }

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

      return res.status(200).json({ ok: true, count: generated.length, generated });
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
