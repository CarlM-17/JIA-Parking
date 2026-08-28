const { getRange, appendRow, updateRow } = require('../lib/sheets');

// Charge rules: First 3 hours = P20 flat, then P10 per succeeding hour (partial hour = 1 hour)
function calculateCharge(hours) {
  if (hours <= 3) return 20;
  const extraHours = Math.ceil(hours - 3);
  return 20 + (extraHours * 10);
}

function nowPH() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // UTC+8
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const body = req.body || await parseBody(req);
    const { qr_id, action } = body;
    if (!qr_id) return res.status(400).json({ ok: false, error: 'qr_id required' });

    // Validate member
    const members = await getRange('Members!A2:E');
    const member = members.find(r => (r[0] || '').trim().toUpperCase() === qr_id.trim().toUpperCase());
    if (!member) return res.status(404).json({ ok: false, error: 'QR not registered', qr_id });
    if ((member[3] || '').toString().toUpperCase() !== 'TRUE') {
      return res.status(403).json({ ok: false, error: 'Member is inactive', qr_id });
    }

    const plate = member[1] || '';
    const owner = member[2] || '';

    // Check existing active ticket (no time_out)
    const logs = await getRange('ParkingLog!A2:H');
    const openIdx = logs.findIndex(r =>
      (r[1] || '').trim().toUpperCase() === qr_id.trim().toUpperCase() &&
      (!r[4] || r[4].trim() === '') &&
      (r[7] || '').toString().toUpperCase() === 'ACTIVE'
    );

    // AUTO mode: if no open ticket => entry; if open ticket => exit
    const isEntry = openIdx === -1;

    if (isEntry) {
      const memberTickets = logs.filter(r => (r[0] || '').startsWith(qr_id + '-T'));
      const nextTicketNum = (memberTickets.length + 1).toString().padStart(3, '0');
      const ticket_no = `${qr_id}-T${nextTicketNum}`;
      const time_in = nowPH();

      await appendRow('ParkingLog!A:H', [ticket_no, qr_id, plate, time_in, '', '', '', 'ACTIVE']);

      return res.status(200).json({
        ok: true,
        mode: 'ENTRY',
        ticket_no, qr_id, plate, owner, time_in,
        message: 'ENTRY - Ticket Issued'
      });
    } else {
      // EXIT
      const row = logs[openIdx];
      const ticket_no = row[0];
      const time_in_str = row[3];
      const time_in = new Date(time_in_str.replace(' ', 'T') + '+08:00');
      const time_out_str = nowPH();
      const time_out = new Date(time_out_str.replace(' ', 'T') + '+08:00');
      const durationHrs = (time_out - time_in) / 3600000;
      const charge = calculateCharge(durationHrs);

      // Row number = index + 2 (header row is row 1)
      const rowNum = openIdx + 2;
      await updateRow(`ParkingLog!A${rowNum}:H${rowNum}`, [
        ticket_no, qr_id, plate, time_in_str, time_out_str,
        durationHrs.toFixed(2), charge, 'COMPLETED'
      ]);

      return res.status(200).json({
        ok: true,
        mode: 'EXIT',
        ticket_no, qr_id, plate, owner,
        time_in: time_in_str,
        time_out: time_out_str,
        duration_hrs: durationHrs.toFixed(2),
        charge: charge,
        message: 'EXIT - Charge Calculated'
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
