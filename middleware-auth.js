const db = require('./db');
function requireLogin(req, res, next) {
  const currentVersion = Number(req.session && req.session.adminSessionVersion || 0);
  const storedVersion = Number(db.get('settings.adminSessionVersion').value() || 0);
  if (req.session && req.session.isAdmin && currentVersion === storedVersion) return next();
  if (req.session) delete req.session.isAdmin;
  return res.redirect('/admin/login');
}
module.exports = { requireLogin };
