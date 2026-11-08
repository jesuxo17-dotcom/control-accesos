// Formato usado por TODO el proyecto y por server/ia.js de Persona 3.
process.env.TZ = 'America/Mazatlan';
const ZONA = 'America/Mazatlan';
const formato = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function fechaLocal(fecha = new Date()) {
  const partes = Object.fromEntries(
    formato.formatToParts(fecha).filter(p => p.type !== 'literal').map(p => [p.type, p.value])
  );
  return `${partes.year}-${partes.month}-${partes.day} ${partes.hour}:${partes.minute}:${partes.second}`;
}
function hoyLocal() { return fechaLocal().slice(0, 10); }
function diaAnterior(dia) {
  const [y, m, d] = dia.split('-').map(Number);
  const fecha = new Date(Date.UTC(y, m - 1, d - 1, 12, 0, 0));
  return fecha.toISOString().slice(0, 10);
}
// Date usa TZ definido arriba; válido para las horas locales almacenadas en SQLite.
function epochLocal(texto) {
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(texto || '')) return NaN;
  const [fecha, hora] = texto.split(' ');
  const [y, m, d] = fecha.split('-').map(Number);
  const [hh, mm, ss] = hora.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, ss).getTime();
}
module.exports = { ZONA, fechaLocal, hoyLocal, diaAnterior, epochLocal };
