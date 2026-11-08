// GET/POST/PUT usuarios. Listado compatible con dashboard de Persona 3.
const crypto = require('node:crypto');
const express = require('express');
const { hashNip, exigirAdmin } = require('./seguridad');

// Código de credencial aleatorio "K7Q2-M9XD-4TPA" (sin 0/O ni 1/I para que no se confundan)
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function codigoAleatorio() {
  const s = [...crypto.randomBytes(12)].map(b => ABC[b % ABC.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
// Correo con forma válida (nombre@dominio.algo)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function crearRutasUsuarios(db) {
  const router = express.Router();
  const columnas = ['matricula','codigo_credencial','nombre','tipo','carrera_id','grupo','estatus','foto_url','tutor_email','tutor_telefono','notificar_tutor','semestre','equipo','email'];
  const tipos = ['alumno', 'docente', 'administrativo'];
  const estatus = ['activo', 'inactivo', 'externo'];
  const listado = `SELECT u.id, u.matricula, u.codigo_credencial, u.nombre, u.tipo,
       u.carrera_id, c.nombre AS carrera, u.grupo, u.estatus, u.foto_url,
       u.notificar_tutor, u.semestre, u.equipo, u.email FROM usuarios u LEFT JOIN carreras c ON c.id = u.carrera_id`;
  function validar(datos, completo = false) {
    // El NIP es opcional en el alta: el dashboard no lo captura. Sin NIP, el
    // usuario usa su credencial impresa y no puede pedir QR dinámico (/api/mi-qr)
    // hasta que se le asigne uno con PUT {nip}.
    if (completo && (!datos.matricula || !datos.codigo_credencial || !datos.nombre)) return 'Faltan datos obligatorios';
    if (datos.nip !== undefined && datos.nip !== null && !/^\d{4,8}$/.test(String(datos.nip))) return 'El NIP debe tener de 4 a 8 dígitos';
    if (datos.tipo !== undefined && !tipos.includes(datos.tipo)) return 'Tipo inválido';
    if (datos.estatus !== undefined && !estatus.includes(datos.estatus)) return 'Estatus inválido';
    if (datos.carrera_id !== undefined && datos.carrera_id !== null && !Number.isInteger(Number(datos.carrera_id))) return 'Carrera inválida';
    if (datos.notificar_tutor !== undefined && ![0, 1, true, false].includes(datos.notificar_tutor)) return 'notificar_tutor inválido';
    if (datos.semestre !== undefined && datos.semestre !== null && !(Number.isInteger(datos.semestre) && datos.semestre >= 1 && datos.semestre <= 12)) return 'El semestre debe ser un número de 1 a 12';
    if (datos.email !== undefined && datos.email !== null && datos.email !== '' && !EMAIL.test(String(datos.email).trim())) return 'Correo inválido';
    if (datos.equipo !== undefined && datos.equipo !== null && (typeof datos.equipo !== 'string' || datos.equipo.length > 60)) return 'Equipo inválido';
    return null;
  }
  router.get('/', (_req, res) => res.json(db.prepare(listado + ' ORDER BY u.nombre').all()));
  router.post('/', exigirAdmin, (req, res) => {
    const data = req.body || {};
    const error = validar(data, true);
    if (error) return res.status(400).json({ error });
    try {
      const r = db.prepare(`INSERT INTO usuarios
        (matricula,codigo_credencial,nombre,tipo,carrera_id,grupo,estatus,foto_url,nip,tutor_email,tutor_telefono,notificar_tutor,semestre,equipo,email)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        data.matricula, data.codigo_credencial, data.nombre,
        data.tipo || 'alumno', data.carrera_id ?? null, data.grupo ?? null,
        data.estatus || 'activo', data.foto_url ?? null,
        // Sin NIP: se guarda el hash de uno aleatorio que nadie conoce
        hashNip(data.nip ?? crypto.randomBytes(16).toString('hex')), data.tutor_email ?? null,
        data.tutor_telefono ?? null, Number(Boolean(data.notificar_tutor)),
        data.semestre ?? null, data.equipo?.trim() || null, String(data.email || '').trim().toLowerCase() || null
      );
      res.status(201).json(db.prepare(listado + ' WHERE u.id = ?').get(r.lastInsertRowid));
    } catch (errorBD) {
      res.status(400).json({ error: errorBD.message });
    }
  });
  router.put('/:id', exigirAdmin, (req, res) => {
    const id = Number(req.params.id);
    const data = req.body || {};
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
    const error = validar(data);
    if (error) return res.status(400).json({ error });
    const cambios = Object.entries(data).filter(([k, valor]) => columnas.includes(k) && valor !== undefined);
    if (data.nip !== undefined) cambios.push(['nip', hashNip(data.nip)]);
    if (!cambios.length) return res.status(400).json({ error: 'Sin cambios válidos' });
    const valores = cambios.map(([k, v]) => k === 'notificar_tutor' ? Number(Boolean(v)) : k === 'email' ? (String(v || '').trim().toLowerCase() || null) : v);
    const sql = 'UPDATE usuarios SET ' + cambios.map(([k]) => `${k} = ?`).join(', ') + ' WHERE id = ?';
    try {
      const r = db.prepare(sql).run(...valores, id);
      if (!r.changes) return res.status(404).json({ error: 'Usuario no encontrado' });
      res.json(db.prepare(listado + ' WHERE u.id = ?').get(id));
    } catch (errorBD) { res.status(400).json({ error: errorBD.message }); }
  });
  // Reponer credencial (pérdida o robo): código nuevo; el anterior deja de
  // existir y el kiosco lo rechazará como "no_registrada".
  router.post('/:id/reponer', exigirAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
    const existe = db.prepare('SELECT 1 FROM usuarios WHERE codigo_credencial = ?');
    let codigo;
    do { codigo = codigoAleatorio(); } while (existe.get(codigo));
    const r = db.prepare('UPDATE usuarios SET codigo_credencial = ? WHERE id = ?').run(codigo, id);
    if (!r.changes) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ codigo_credencial: codigo });
  });
  return router;
}
module.exports = crearRutasUsuarios;
