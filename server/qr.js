// QR dinámico: D.<usuario_id>.<timestamp_ms>.<firma HMAC SHA-256>
// Sin añadir campos al formato fijo de Persona 2.
const crypto = require('node:crypto');
const { fechaLocal } = require('./fecha');
const { verificarNip } = require('./seguridad');
function secreto() {
  const valor = process.env.QR_SECRET;
  if (!valor || valor.length < 32 || valor.includes('CAMBIAR')) {
    throw new Error('Configura QR_SECRET con al menos 32 caracteres en server/.env');
  }
  return valor;
}
function firmar(texto) {
  return crypto.createHmac('sha256', secreto()).update(texto).digest('hex');
}
function crearQR(db, matricula, nip) {
  const usuario = db.prepare('SELECT id, nip, estatus FROM usuarios WHERE matricula = ?').get(matricula);
  if (!usuario || !verificarNip(nip, usuario.nip)) return null;
  if (usuario.estatus === 'inactivo') return null;
  let ts = Date.now();
  let token;
  // Evita colisiones de peticiones del mismo milisegundo.
  do {
    const texto = `D.${usuario.id}.${ts}`;
    token = `${texto}.${firmar(texto)}`;
    if (!db.prepare('SELECT 1 FROM tokens_qr WHERE token = ?').get(token)) break;
    ts += 1;
  } while (true);
  db.prepare('INSERT INTO tokens_qr (token, usuario_id, expira, usado) VALUES (?, ?, ?, 0)')
    .run(token, usuario.id, fechaLocal(new Date(ts + 30000)));
  return { qr: token, expira_en: 30 };
}
// No altera datos; su consumo sucede en la transacción del escaneo.
function verificarQR(db, codigo) {
  const match = /^D\.([1-9][0-9]*)\.([0-9]{13})\.([0-9a-f]{64})$/.exec(codigo);
  if (!match) return { error: 'codigo_vencido' };
  const [, idString, tsString, firma] = match;
  const texto = `D.${idString}.${tsString}`;
  const esperada = Buffer.from(firmar(texto), 'hex');
  const recibida = Buffer.from(firma, 'hex');
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) {
    return { error: 'codigo_vencido' };
  }
  const ts = Number(tsString);
  const ahora = Date.now();
  if (ts > ahora + 1000 || ahora > ts + 30000) return { error: 'codigo_vencido' };
  const fila = db.prepare('SELECT usuario_id, usado FROM tokens_qr WHERE token = ?').get(codigo);
  if (!fila || fila.usado || fila.usuario_id !== Number(idString)) return { error: 'codigo_vencido' };
  return { usuarioId: fila.usuario_id, token: codigo };
}
module.exports = { crearQR, verificarQR };
