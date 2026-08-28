const { getRange } = require('../lib/sheets');

module.exports = async (req, res) => {
  try {
    const logs = await getRange('ParkingLog!A2:H');
    const total = logs.reduce((sum, r) => sum + (parseFloat(r[6]) || 0), 0);
    res.status(200).json({ ok: true, count: logs.length, total, logs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
