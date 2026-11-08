// 50 usuarios ficticios + 7 días de eventos y fotografías de prueba.
// Repetible: si ya hay usuarios no duplica ni borra información.
const fs = require('node:fs');
const path = require('node:path');
const { db, hoyLocal, obtenerAforo } = require('./db');
const { diaAnterior, fechaLocal } = require('./fecha');
const { hashNip } = require('./seguridad');

const fotos = path.join(__dirname, 'public', 'fotos');
fs.mkdirSync(fotos, { recursive: true });
if (db.prepare('SELECT COUNT(*) AS total FROM usuarios').get().total > 0) {
  console.log('Ya existen usuarios: el seed NO duplicó datos.');
  console.log('Aforo actual:', obtenerAforo());
  process.exit(0);
}

const carreras = ['Tecnologías de la Información','Ingeniería de Software','Administración','Contaduría','Derecho','Ingeniería Industrial'];
const insertCarrera = db.prepare('INSERT INTO carreras (nombre) VALUES (?)');
const insertUser = db.prepare(`
  INSERT INTO usuarios (matricula,codigo_credencial,nombre,tipo,carrera_id,grupo,estatus,foto_url,nip,tutor_email,tutor_telefono,notificar_tutor)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
const insertEvento = db.prepare(`
  INSERT INTO eventos (usuario_id,tipo,origen,kiosco_id,foto_captura,fecha_hora)
  VALUES (?,?,'kiosco','KIOSCO-01',NULL,?)`);
let eventos = 0;

const crear = db.transaction(() => {
  carreras.forEach(nombre => insertCarrera.run(nombre));
  for (let i = 1; i <= 50; i++) {
    const n = String(i).padStart(2, '0');
    const tipo = i <= 35 ? 'alumno' : i <= 45 ? 'docente' : 'administrativo';
    const estatus = i % 11 === 0 ? 'inactivo' : i % 13 === 0 ? 'externo' : 'activo';
    const carreraId = ((i - 1) % carreras.length) + 1;
    const grupo = `G${31 + (i % 4)}`;
    const color = ['#0B6E99','#396F80','#86599F','#A76431','#327A58'][i % 5];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><rect width="180" height="180" rx="14" fill="${color}"/><circle cx="90" cy="65" r="29" fill="white"/><path d="M32 160 Q40 109 90 109 Q140 109 148 160" fill="white"/><text x="90" y="176" text-anchor="middle" font-size="13" fill="white">${n}</text></svg>`;
    fs.writeFileSync(path.join(fotos, `usuario-${n}.svg`), svg);
    const res = insertUser.run(
      `L2026${String(i).padStart(4, '0')}`, `LINCE-${n}`, `PERSONA DE PRUEBA ${n}`,
      tipo, carreraId, grupo, estatus, `/fotos/usuario-${n}.svg`,
      hashNip('1234'), `tutor${n}@example.com`, null, tipo === 'alumno' ? 1 : 0
    );
    if (estatus === 'inactivo') continue;
    const id = Number(res.lastInsertRowid);
    let dia = hoyLocal();
    const fechas = [dia];
    for (let x = 1; x < 7; x++) { dia = diaAnterior(dia); fechas.unshift(dia); }
    for (const [indice, fecha] of fechas.entries()) {
      const finde = [0,6].includes(new Date(`${fecha}T12:00:00Z`).getUTCDay());
      if (finde && i % 3 !== 0) continue;
      const ingreso = `${fecha} ${String(8 + (i % 3)).padStart(2,'0')}:05:00`;
      const salida = `${fecha} ${String(13 + (i % 4)).padStart(2,'0')}:45:00`;
      if (ingreso > fechaLocal()) continue;
      insertEvento.run(id, 'ingreso', ingreso); eventos++;
      // Hoy, parte de la gente permanece dentro para que se vea aforo.
      if ((indice < 6 || i % 3 === 0) && salida <= fechaLocal()) {
        insertEvento.run(id, 'egreso', salida); eventos++;
      }
    }
  }
});
crear.immediate();

// Permiso nocturno de demostración (hoy 18:00 -> mañana 08:00) para 3 personas,
// así la página de Permisos y el dato "con permiso nocturno" no salen vacíos.
const manana = fechaLocal(new Date(Date.now() + 24 * 3600e3)).slice(0, 10);
const insertPermiso = db.prepare(`INSERT INTO permisos (usuario_id, nombre, desde, hasta, autorizado_por, creado)
  VALUES (?, 'Hackatón LinceCode', ?, ?, 'Seed de pruebas', ?)`);
for (const id of [1, 7, 13]) insertPermiso.run(id, `${hoyLocal()} 18:00:00`, `${manana} 08:00:00`, fechaLocal());

console.log('Datos de prueba listos:');
console.log('Usuarios:', db.prepare('SELECT COUNT(*) AS c FROM usuarios').get().c);
console.log('Carreras:', carreras.length, '| Eventos:', eventos);
console.log('NIP de pruebas: 1234 | Credencial: LINCE-01 | Matrícula: L20260001');
console.log('Aforo actual:', obtenerAforo());
