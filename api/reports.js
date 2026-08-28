const { getRange } = require('../lib/sheets');
const { requireAuth } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token, x-user-id');
  const user = await requireAuth(req, res, 'admin');
  if (!user) return;
  try {
    const logs = await getRange('ParkingLog!A2:J');
    const total = logs.reduce((sum, r) => sum + (parseFloat(r[6]) || 0), 0);
    res.status(200).json({ ok: true, count: logs.length, total, logs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
