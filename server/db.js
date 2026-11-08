// Inicializa SQLite al primer require; no necesita MySQL ni servidor de BD aparte.
require('./fecha');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { hoyLocal, fechaLocal, diaAnterior, epochLocal } = require('./fecha');
const archivo = process.env.DB_PATH || path.join(__dirname, 'lincecode.db');
const db = new Database(archivo);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
// Bases creadas antes de semestre/equipo: agregar las columnas (quedan vacías)
const columnasUsuarios = new Set(db.prepare('PRAGMA table_info(usuarios)').all().map(c => c.name));
if (!columnasUsuarios.has('semestre')) db.exec('ALTER TABLE usuarios ADD COLUMN semestre INTEGER CHECK (semestre BETWEEN 1 AND 12)');
if (!columnasUsuarios.has('equipo')) db.exec('ALTER TABLE usuarios ADD COLUMN equipo TEXT');
if (!columnasUsuarios.has('email')) db.exec('ALTER TABLE usuarios ADD COLUMN email TEXT');

// Quién está dentro: su ÚLTIMO evento es ingreso y además
//   - ese ingreso fue HOY, o
//   - entró antes de hoy pero un permiso nocturno lo cubrió (por eso el
//     cierre de las 00:00 no le marcó salida).
// Misma regla que usa server/ia.js. También trae el permiso vigente AHORA.
const consultaDentro = db.prepare(`
  WITH ultimo AS (
    SELECT e.usuario_id, e.tipo, e.fecha_hora,
           ROW_NUMBER() OVER (PARTITION BY e.usuario_id ORDER BY e.fecha_hora DESC, e.id DESC) AS rn
    FROM eventos e
    WHERE e.fecha_hora <= @ahora
  )
  SELECT u.id, u.nombre, u.matricula, u.tipo, u.grupo, u.estatus,
         u.foto_url, c.nombre AS carrera, x.fecha_hora AS desde,
         pv.nombre AS permiso, pv.hasta AS permiso_hasta
  FROM ultimo x
  JOIN usuarios u ON u.id = x.usuario_id
  LEFT JOIN carreras c ON c.id = u.carrera_id
  LEFT JOIN permisos pv ON pv.id = (
    SELECT p.id FROM permisos p
    WHERE p.usuario_id = u.id AND p.desde <= @ahora AND p.hasta >= @ahora
    ORDER BY p.hasta DESC LIMIT 1)
  WHERE x.rn = 1 AND x.tipo = 'ingreso'
    AND (substr(x.fecha_hora, 1, 10) = @hoy
         OR EXISTS (SELECT 1 FROM permisos p
                    WHERE p.usuario_id = u.id AND p.hasta >= x.fecha_hora AND p.desde <= @ahora))
  ORDER BY u.nombre
`);
/** Personas dentro en este momento (ver regla arriba). */
function usuariosDentro(ahora = fechaLocal()) {
  return consultaDentro.all({ ahora, hoy: ahora.slice(0, 10) });
}
/** Permiso nocturno vigente de un usuario en un momento dado, o null. */
const consultaPermiso = db.prepare(`
  SELECT nombre, hasta FROM permisos
  WHERE usuario_id = ? AND desde <= ? AND hasta >= ?
  ORDER BY hasta DESC LIMIT 1`);
function permisoVigente(usuarioId, momento = fechaLocal()) {
  return consultaPermiso.get(usuarioId, momento, momento) || null;
}
function obtenerAforo() {
  const usuarios = usuariosDentro();
  const conteo = (campo, nombre) => {
    const mapa = new Map();
    for (const u of usuarios) {
      const valor = u[campo] || 'Sin asignar';
      mapa.set(valor, (mapa.get(valor) || 0) + 1);
    }
    return [...mapa].map(([valor, dentro]) => ({ [nombre]: valor, dentro }));
  };
  // con_permiso: campo adicional (el contrato original no lo tiene; no rompe a nadie)
  return { total: usuarios.length, con_permiso: usuarios.filter(u => u.permiso).length,
    por_carrera: conteo('carrera', 'carrera'), por_grupo: conteo('grupo', 'grupo') };
}
module.exports = { db, obtenerAforo, usuariosDentro, permisoVigente, hoyLocal, fechaLocal, diaAnterior, epochLocal };
if (require.main === module) {
  console.log('Base de datos creada:', archivo);
  console.log('Aforo:', obtenerAforo());
}
