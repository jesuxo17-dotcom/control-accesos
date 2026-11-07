/* =====================================================================
   util.js — Funciones de apoyo compartidas por todas las páginas
   del dashboard (fechas en hora de Mazatlán, avatares, escapado de
   HTML y avisos "toast").
   ===================================================================== */

const ZONA = 'America/Mazatlan';

// Formateador que produce "YYYY-MM-DD HH:MM:SS" en hora local de Mazatlán.
// (El locale sv-SE usa justo ese formato, por eso lo elegimos.)
const _fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

/** Fecha y hora actual en Mazatlán: "2026-11-07 14:03:22" */
function ahoraLocal(fecha = new Date()) {
  return _fmt.format(fecha).replace('T', ' ');
}

/** Solo la fecha de hoy en Mazatlán: "2026-11-07" */
function hoyLocal() {
  return ahoraLocal().slice(0, 10);
}

/**
 * Convierte cualquier fecha_hora que mande el servidor a texto local.
 * - Si viene como "YYYY-MM-DD HH:MM:SS" (sin zona) se asume que ya es hora local.
 * - Si viene en ISO con zona ("...Z" o "+00:00") se convierte a Mazatlán.
 */
function aLocal(fh) {
  if (!fh) return '';
  const s = String(fh);
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return ahoraLocal(new Date(s));
  return s.replace('T', ' ').slice(0, 19);
}

/** Solo la hora "HH:MM:SS" de una fecha_hora */
function horaDe(fh) { return aLocal(fh).slice(11, 19); }

/** Número de hora (0-23) de una fecha_hora, para la gráfica de horas pico */
function horaNum(fh) { return parseInt(aLocal(fh).slice(11, 13), 10); }

/** Evita inyección de HTML al pintar textos que vienen de la BD */
function esc(txt) {
  return String(txt ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Avatar SVG con las iniciales (funciona sin internet).
 * Se usa cuando el usuario no tiene foto o la foto no carga.
 */
function avatar(nombre = '?') {
  const ini = nombre.split(' ').filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
  let h = 0; for (const c of nombre) h = (h * 31 + c.charCodeAt(0)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">
    <rect width="80" height="80" fill="hsl(${h},55%,45%)"/>
    <text x="50%" y="54%" font-family="Arial" font-size="32" fill="#fff"
      text-anchor="middle" dominant-baseline="middle">${ini}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** <img> con foto del usuario y respaldo automático al avatar */
function imgUsuario(u, clase = 'foto') {
  const nombre = u?.nombre || '?';
  const src = u?.foto_url || avatar(nombre);
  return `<img class="${clase}" src="${esc(src)}" alt="${esc(nombre)}"
    onerror="this.onerror=null;this.src=avatar(this.alt)">`;
}

/**
 * Código de credencial aleatorio de 12 caracteres: "K7Q2-M9XD-4TPA".
 * Sin 0/O ni 1/I para que no se confundan al leerlos en voz alta.
 * (Lo usa el mock; en producción el código lo genera el servidor.)
 */
function codigoAleatorio() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const n = new Uint32Array(12);
  crypto.getRandomValues(n);
  const s = [...n].map(x => abc[x % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** Texto corto "dd/mm HH:MM" para fechas de permisos */
function fechaCorta(fh) {
  const s = aLocal(fh);
  return s ? `${s.slice(8, 10)}/${s.slice(5, 7)} ${s.slice(11, 16)}` : '';
}

/** Aviso flotante que desaparece solo */
function toast(msg, tipo = 'info') {
  let caja = document.getElementById('toasts');
  if (!caja) {
    caja = document.createElement('div');
    caja.id = 'toasts';
    document.body.appendChild(caja);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + tipo;
  t.textContent = msg;
  caja.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
