// Seguridad: NIP con scrypt, clave de administrador y sesiones del panel.
//
// Acceso al panel (dashboard):
//   - El personal de seguridad entra con CLAVE_SEGURIDAD (en .env; si no está, se usa ADMIN_KEY).
//   - POST /api/login da un token de sesión (aleatorio, 12 h). El panel lo manda en
//     "Authorization: Bearer <token>" y al conectarse a Socket.IO.
//   - La cabecera x-admin-key con ADMIN_KEY sigue sirviendo (scripts, pruebas).
//   - 5 claves equivocadas seguidas desde una misma IP la bloquean 1 minuto.
// Las sesiones viven en memoria: si el servidor se reinicia, hay que volver a entrar.
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

/** Compara dos textos en tiempo constante (sin revelar por tiempo cuántos caracteres coinciden) */
function iguales(a, b) {
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- Sesiones ----------
const DURACION_MS = 12 * 3600 * 1000;
const sesiones = new Map();   // token -> expira (ms)

function crearSesion() {
  const token = crypto.randomBytes(32).toString('hex');
  sesiones.set(token, Date.now() + DURACION_MS);
  return { token, expira: new Date(Date.now() + DURACION_MS).toISOString() };
}
function sesionValida(token) {
  if (!token || typeof token !== 'string') return false;
  const exp = sesiones.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sesiones.delete(token); return false; }
  return true;
}
function cerrarSesion(token) { sesiones.delete(token); }
const tokenDe = req => (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

/** ¿La petición viene del panel con sesión, o con la clave de administrador? */
function claveAdminValida(req) {
  if (sesionValida(tokenDe(req))) return true;
  return iguales(process.env.ADMIN_KEY, req.get('x-admin-key'));
}
function exigirAdmin(req, res, next) {
  if (!claveAdminValida(req)) return res.status(403).json({ error: 'Acceso no autorizado: inicia sesión en el panel' });
  next();
}

// ---------- Inicio de sesión ----------
const fallos = new Map();   // ip -> { n, hasta }
const MAX_FALLOS = 5, BLOQUEO_MS = 60 * 1000;

/** POST /api/login {clave} -> {token, expira} | 401 | 429 */
function login(req, res) {
  const ip = req.ip || 'desconocida';
  const f = fallos.get(ip);
  if (f && f.hasta > Date.now()) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.' });
  }
  const clave = String(req.body?.clave || '');
  const correcta = process.env.CLAVE_SEGURIDAD || process.env.ADMIN_KEY;
  if (!correcta) return res.status(503).json({ error: 'El servidor no tiene clave de acceso configurada (CLAVE_SEGURIDAD en .env).' });
  if (!iguales(correcta, clave)) {
    const n = (f && f.hasta <= Date.now() && f.n >= MAX_FALLOS ? 0 : f?.n || 0) + 1;
    fallos.set(ip, { n, hasta: n >= MAX_FALLOS ? Date.now() + BLOQUEO_MS : 0 });
    return res.status(401).json({ error: 'Clave incorrecta.' });
  }
  fallos.delete(ip);
  res.json(crearSesion());
}
function logout(req, res) { cerrarSesion(tokenDe(req)); res.json({ ok: true }); }

module.exports = { hashNip, verificarNip, exigirAdmin, claveAdminValida, sesionValida, login, logout };
