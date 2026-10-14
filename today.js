const { getRange } = require('../lib/sheets');
const { requireAuth } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token, x-user-id');
  const user = await requireAuth(req, res, 'cashier');
  if (!user) return;

  try {
    const logs = await getRange('ParkingLog!A2:J');
    // Today in Philippines (UTC+8)
    const nowPH = new Date(Date.now() + 8 * 3600 * 1000);
    const today = nowPH.toISOString().slice(0, 10);

    const todayLogs = logs
      .filter(r => (r[3] || '').startsWith(today))
      .map(r => ({
        ticket_no: r[0] || '',
        qr_id: r[1] || '',
        plate: r[2] || '',
        time_in: r[3] || '',
        time_out: r[4] || '',
        duration_hrs: r[5] || '',
        charge: r[6] || '',
        status: r[7] || '',
        cashier_in: r[8] || '',
        cashier_out: r[9] || ''
      }));

    const totalCharge = todayLogs.reduce((s, r) => s + (parseFloat(r.charge) || 0), 0);
    const active = todayLogs.filter(r => r.status === 'ACTIVE').length;
    const completed = todayLogs.filter(r => r.status === 'COMPLETED').length;

    res.status(200).json({
      ok: true, date: today, logs: todayLogs,
      total_charge: totalCharge, active_count: active, completed_count: completed
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
