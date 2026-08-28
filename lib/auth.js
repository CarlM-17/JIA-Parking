// Auth: Admin password from env var. Cashiers stored in Google Sheet "Cashiers" tab.
const { getRange } = require('./sheets');

const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin123';

// Header pattern:
//   x-auth-token = password (admin password OR cashier password)
//   x-user-id    = "admin" OR cashier UserID
async function identifyUser(req) {
  const token = req.headers['x-auth-token'] || '';
  const userid = (req.headers['x-user-id'] || '').trim();
  if (!token || !userid) return null;

  if (userid === 'admin') {
    if (token === ADMIN_PASS) return { role: 'admin', userid: 'admin', name: 'Administrator' };
    return null;
  }

  // Cashier lookup
  try {
    const rows = await getRange('Cashiers!A2:E');
    const match = rows.find(r =>
      (r[0] || '').toString().trim() === userid &&
      (r[2] || '') === token &&
      (r[3] || '').toString().toUpperCase() === 'TRUE'
    );
    if (match) return { role: 'cashier', userid: match[0], name: match[1] };
  } catch (e) {
    console.error('Cashier lookup failed:', e.message);
  }
  return null;
}

// Convenience: allowed if role is admin, or if role is cashier and requiredRole is 'cashier'
async function requireAuth(req, res, requiredRole) {
  const user = await identifyUser(req);
  if (!user) {
    res.status(401).json({ ok: false, error: 'Unauthorized - please log in' });
    return null;
  }
  if (requiredRole === 'admin' && user.role !== 'admin') {
    res.status(403).json({ ok: false, error: 'Admin only' });
    return null;
  }
  return user;
}

module.exports = { identifyUser, requireAuth, ADMIN_PASS };
