// Funciones de consulta destinadas a server/ia.js de Persona 3.
const { usuariosDentro } = require('./db');
function crearConsultas(db) {
  function aforo_por_carrera(carrera) {
    const dentro = usuariosDentro();
    return { carrera, dentro: dentro.filter(u => u.carrera === carrera).length };
  }
  function usuarios_dentro() {
    return usuariosDentro().map(u => ({ id: u.id, nombre: u.nombre, carrera: u.carrera, grupo: u.grupo, tipo: u.tipo }));
  }
  function entradas_en_rango(desde, hasta) {
    if (typeof desde !== 'string' || typeof hasta !== 'string') return [];
    return db.prepare(`
      SELECT e.id, u.nombre, c.nombre AS carrera, e.fecha_hora,
             u.grupo, e.kiosco_id
      FROM eventos e
      JOIN usuarios u ON u.id = e.usuario_id
      LEFT JOIN carreras c ON c.id = u.carrera_id
      WHERE e.tipo = 'ingreso' AND e.fecha_hora >= ? AND e.fecha_hora <= ?
      ORDER BY e.fecha_hora DESC LIMIT 500`).all(desde, hasta);
  }
  return { aforo_por_carrera, usuarios_dentro, entradas_en_rango };
}
module.exports = crearConsultas;
