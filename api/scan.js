const { getRange, appendRow, updateRow, updateCell } = require('../lib/sheets');
const { requireAuth } = require('../lib/auth');

function calculateCharge(hours) {
  if (hours <= 3) return 20;
  const extraHours = Math.ceil(hours - 3);
  return 20 + (extraHours * 10);
}

function nowPH() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-auth-token, x-user-id');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const user = await requireAuth(req, res, 'cashier');
  if (!user) return;
  const cashierTag = `${user.userid} - ${user.name}`;

  try {
    const body = req.body || await parseBody(req);
    const { qr_id } = body;
    if (!qr_id) return res.status(400).json({ ok: false, error: 'qr_id required' });

    const members = await getRange('Members!A2:E');
    const memberIdx = members.findIndex(r => (r[0] || '').trim().toUpperCase() === qr_id.trim().toUpperCase());
    if (memberIdx === -1) return res.status(404).json({ ok: false, error: 'QR not registered', qr_id });
    const member = members[memberIdx];
    if ((member[3] || '').toString().toUpperCase() !== 'TRUE') {
      return res.status(403).json({ ok: false, error: 'This QR has already been used. Please request a new one.', qr_id });
    }

    const plate = member[1] || '';
    const owner = member[2] || '';

    // Sheet columns: A Ticket, B QR, C Plate, D TimeIn, E TimeOut, F Hrs, G Charge, H Status, I CashierIn, J CashierOut
    const logs = await getRange('ParkingLog!A2:J');
    const openIdx = logs.findIndex(r =>
      (r[1] || '').trim().toUpperCase() === qr_id.trim().toUpperCase() &&
      (!r[4] || r[4].trim() === '') &&
      (r[7] || '').toString().toUpperCase() === 'ACTIVE'
    );

    const isEntry = openIdx === -1;

    if (isEntry) {
      const memberTickets = logs.filter(r => (r[0] || '').startsWith(qr_id + '-T'));
      const nextTicketNum = (memberTickets.length + 1).toString().padStart(3, '0');
      const ticket_no = `${qr_id}-T${nextTicketNum}`;
      const time_in = nowPH();

      await appendRow('ParkingLog!A:J', [ticket_no, qr_id, plate, time_in, '', '', '', 'ACTIVE', cashierTag, '']);

      return res.status(200).json({
        ok: true, mode: 'ENTRY',
        ticket_no, qr_id, plate, owner, time_in,
        cashier: cashierTag,
        message: 'ENTRY - Ticket Issued'
      });
    } else {
      const row = logs[openIdx];
      const ticket_no = row[0];
      const time_in_str = row[3];
      const cashier_in = row[8] || '';
      const time_in = new Date(time_in_str.replace(' ', 'T') + '+08:00');
      const time_out_str = nowPH();
      const time_out = new Date(time_out_str.replace(' ', 'T') + '+08:00');
      const durationHrs = (time_out - time_in) / 3600000;
      const charge = calculateCharge(durationHrs);

      const rowNum = openIdx + 2;
      await updateRow(`ParkingLog!A${rowNum}:J${rowNum}`, [
        ticket_no, qr_id, plate, time_in_str, time_out_str,
        durationHrs.toFixed(2), charge, 'COMPLETED', cashier_in, cashierTag
      ]);

      const memberRowNum = memberIdx + 2;
      await updateCell(`Members!D${memberRowNum}`, 'FALSE');

      return res.status(200).json({
        ok: true, mode: 'EXIT',
        ticket_no, qr_id, plate, owner,
        time_in: time_in_str, time_out: time_out_str,
        duration_hrs: durationHrs.toFixed(2),
        charge: charge,
        cashier_in, cashier_out: cashierTag,
        message: 'EXIT - Charge Calculated (QR now deactivated)'
      });
    }
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
