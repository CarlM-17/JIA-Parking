const QRCode = require('qrcode');

module.exports = async (req, res) => {
  try {
    const qr_id = (req.query && req.query.id) || new URL(req.url, 'http://x').searchParams.get('id');
    if (!qr_id) return res.status(400).json({ ok: false, error: 'id required' });
    const dataUrl = await QRCode.toDataURL(qr_id, { width: 500, margin: 2 });
    res.status(200).json({ ok: true, qr_id, qr_image: dataUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
