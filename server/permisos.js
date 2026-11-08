// Permisos nocturnos (los usa dashboard/permisos.html y la tarjeta
// "Dentro sin permiso" del dashboard en vivo).
//   GET  /api/permisos            -> [{id,usuario_id,usuario,nombre,desde,hasta,autorizado_por,creado}]
//   POST /api/permisos  (admin)   {nombre, desde, hasta, usuario_ids? | carrera_id? | grupo?}
//                                 -> {creados}
//   GET  /api/dentro-sin-permiso  -> quién está dentro AHORA sin permiso vigente
//                                    (a ellos les toca la salida automática de las 00:00)
// Fechas: 'YYYY-MM-DD HH:MM:SS' en hora de Mazatlán, igual que eventos.
const express = require('express');
const { exigirAdmin } = require('./seguridad');
const { fechaLocal } = require('./fecha');

const FECHA = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;
const completar = s => (s.length === 16 ? s + ':00' : s);

function crearRutasPermisos(db, usuariosDentro) {
  const router = express.Router();
  const listar = db.prepare(`
    SELECT p.id, p.usuario_id, u.nombre AS usuario, p.nombre, p.desde, p.hasta,
           p.autorizado_por, p.creado
    FROM permisos p JOIN usuarios u ON u.id = p.usuario_id
    ORDER BY p.desde DESC, p.id DESC LIMIT 1000`);
  const insertar = db.prepare(`
    INSERT INTO permisos (usuario_id, nombre, desde, hasta, autorizado_por, creado)
    VALUES (?, ?, ?, ?, ?, ?)`);
  // Los inactivos no reciben permiso (de todos modos el kiosco los rechaza)
  const porIds = ids => db.prepare(
    `SELECT id FROM usuarios WHERE estatus != 'inactivo' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const porCarrera = db.prepare(`SELECT id FROM usuarios WHERE estatus != 'inactivo' AND carrera_id = ?`);
  const porGrupo = db.prepare(`SELECT id FROM usuarios WHERE estatus != 'inactivo' AND grupo = ?`);

  router.get('/permisos', (_req, res) => res.json(listar.all()));

  router.post('/permisos', exigirAdmin, (req, res) => {
    const d = req.body || {};
    const nombre = typeof d.nombre === 'string' ? d.nombre.trim().slice(0, 120) : '';
    if (!nombre) return res.status(400).json({ error: 'Falta el nombre del evento' });
    if (!FECHA.test(d.desde || '') || !FECHA.test(d.hasta || '')) {
      return res.status(400).json({ error: 'desde y hasta deben tener formato "YYYY-MM-DD HH:MM:SS"' });
    }
    const desde = completar(d.desde), hasta = completar(d.hasta);
    if (hasta <= desde) return res.status(400).json({ error: '"hasta" debe ser después de "desde"' });

    // Se acepta SOLO uno de los tres alcances
    let destinatarios;
    if (Array.isArray(d.usuario_ids)) {
      const ids = [...new Set(d.usuario_ids.map(Number))].filter(n => Number.isInteger(n) && n > 0).slice(0, 2000);
      if (!ids.length) return res.status(400).json({ error: 'Selecciona al menos una persona' });
      destinatarios = porIds(ids);
    } else if (d.carrera_id != null) {
      if (!Number.isInteger(Number(d.carrera_id))) return res.status(400).json({ error: 'Carrera inválida' });
      destinatarios = porCarrera.all(Number(d.carrera_id));
    } else if (typeof d.grupo === 'string' && d.grupo.trim()) {
      destinatarios = porGrupo.all(d.grupo.trim());
    } else {
      return res.status(400).json({ error: 'Indica usuario_ids, carrera_id o grupo' });
    }
    if (!destinatarios.length) return res.status(400).json({ error: 'Nadie coincide con ese alcance' });

    const autorizo = typeof d.autorizado_por === 'string' && d.autorizado_por.trim()
      ? d.autorizado_por.trim().slice(0, 80) : 'Administración';
    const creado = fechaLocal();
    const crear = db.transaction(lista => {
      for (const u of lista) insertar.run(u.id, nombre, desde, hasta, autorizo, creado);
      return lista.length;
    });
    res.status(201).json({ creados: crear(destinatarios) });
  });

  router.get('/dentro-sin-permiso', (_req, res) => {
    res.json(usuariosDentro().filter(u => !u.permiso).map(u => ({
      id: u.id, nombre: u.nombre, foto_url: u.foto_url, carrera: u.carrera,
      grupo: u.grupo, tipo: u.tipo, desde: u.desde
    })));
  });

  return router;
}
module.exports = crearRutasPermisos;
