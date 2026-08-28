const { getRange } = require('../lib/sheets');

module.exports = async (req, res) => {
  try {
    const env = {
      GOOGLE_SHEET_ID: !!process.env.GOOGLE_SHEET_ID,
      GOOGLE_CLIENT_EMAIL: !!process.env.GOOGLE_CLIENT_EMAIL,
      GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
    };
    try {
      const rows = await getRange('Members!A1:E1');
      return res.status(200).json({ ok: true, env, sheet_headers: rows[0] || [], can_read_sheet: true });
    } catch (sheetErr) {
      return res.status(500).json({ ok: false, env, can_read_sheet: false, sheet_error: sheetErr.message });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
