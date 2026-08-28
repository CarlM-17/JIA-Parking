const { getRange, appendRow } = require('../lib/sheets');
const QRCode = require('qrcode');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
      const { plate, owner } = body;
      if (!plate) return res.status(400).json({ ok: false, error: 'plate required' });

      const existing = await getRange('Members!A2:A');
      const nextNum = (existing.length + 1).toString().padStart(4, '0');
      const qr_id = `JIA-${nextNum}`;
      const today = new Date().toISOString().slice(0, 10);

      await appendRow('Members!A:E', [qr_id, plate.toUpperCase(), owner || '', 'TRUE', today]);

      const qrDataUrl = await QRCode.toDataURL(qr_id, { width: 400, margin: 2 });
      return res.status(200).json({ ok: true, qr_id, plate, qr_image: qrDataUrl });
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
