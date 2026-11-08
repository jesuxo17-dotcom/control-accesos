const crypto = require('node:crypto');
function hashNip(nip) {
  const sal = crypto.randomBytes(16).toString('hex');
  return `scrypt$${sal}$${crypto.scryptSync(String(nip), sal, 32).toString('hex')}`;
}
function verificarNip(nip, almacenado) {
  const [tipo, sal, hash] = (almacenado || '').split('$');
  if (tipo !== 'scrypt' || !sal || !/^[0-9a-f]{64}$/i.test(hash || '')) return false;
  const original = Buffer.from(hash, 'hex');
  const calculado = crypto.scryptSync(String(nip), sal, 32);
  return crypto.timingSafeEqual(original, calculado);
}
function claveAdminValida(req) {
  const requerida = process.env.ADMIN_KEY;
  const recibida = req.get('x-admin-key') || '';
  if (!requerida || !recibida) return false;
  const a = Buffer.from(requerida);
  const b = Buffer.from(recibida);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function exigirAdmin(req, res, next) {
  if (!claveAdminValida(req)) return res.status(403).json({ error: 'Acceso administrativo no autorizado' });
  next();
}
module.exports = { hashNip, verificarNip, exigirAdmin };
