// Ruta central de acceso. Toda la validación + INSERT ocurre en UNA transacción.
const express = require('express');
const { verificarQR } = require('./qr');
const { fechaLocal, hoyLocal, epochLocal } = require('./fecha');

function crearRutaScan(db, io, procesarNotificaciones) {
  const router = express.Router();
  const buscarCredencial = db.prepare(`
    SELECT u.*, c.nombre AS carrera FROM usuarios u
    LEFT JOIN carreras c ON c.id = u.carrera_id
    WHERE u.codigo_credencial = ?`);
  const buscarPorId = db.prepare(`
    SELECT u.*, c.nombre AS carrera FROM usuarios u
    LEFT JOIN carreras c ON c.id = u.carrera_id
    WHERE u.id = ?`);
  // Último evento (de cualquier día) para saber si la persona está dentro.
  const ultimoEvento = db.prepare(`
    SELECT tipo, origen, fecha_hora FROM eventos
    WHERE usuario_id = ? AND fecha_hora <= ?
    ORDER BY fecha_hora DESC, id DESC LIMIT 1`);
  // ¿Un permiso nocturno cubrió el tiempo desde ese ingreso hasta ahora?
  const permisoCubre = db.prepare(`
    SELECT 1 FROM permisos WHERE usuario_id = ? AND hasta >= ? AND desde <= ? LIMIT 1`);
  const permisoAhora = db.prepare(`
    SELECT nombre, hasta FROM permisos
    WHERE usuario_id = ? AND desde <= ? AND hasta >= ?
    ORDER BY hasta DESC LIMIT 1`);
  const ultimoKiosco = db.prepare(`
    SELECT fecha_hora FROM eventos WHERE usuario_id = ? AND origen = 'kiosco'
    ORDER BY fecha_hora DESC, id DESC LIMIT 1`);
  const guardarIntento = db.prepare(`
    INSERT INTO intentos (codigo_leido, usuario_id, motivo, kiosco_id, fecha_hora)
    VALUES (?, ?, ?, ?, ?)`);
  const insertarEvento = db.prepare(`
    INSERT INTO eventos (usuario_id, tipo, origen, kiosco_id, foto_captura, fecha_hora)
    VALUES (?, ?, 'kiosco', ?, ?, ?)`);
  const marcarUsado = db.prepare('UPDATE tokens_qr SET usado = 1 WHERE token = ? AND usado = 0');
  const notificar = db.prepare(`
    INSERT INTO notificaciones (evento_id, canal, estado, fecha_hora)
    VALUES (?, 'email', 'pendiente', ?)`);

  function vistaUsuario(u) {
    return u ? {
      id: u.id, nombre: u.nombre, foto_url: u.foto_url,
      carrera: u.carrera, grupo: u.grupo, tipo: u.tipo
    } : null;
  }

  function escanear(body) {
    const codigo = typeof body.codigo === 'string' ? body.codigo.trim() : '';
    const kiosco = typeof body.kiosco_id === 'string' ? body.kiosco_id.slice(0, 80) : 'KIOSCO-01';
    const modo = body.modo;
    const fecha = fechaLocal();
    const hoy = fecha.slice(0, 10);
    let usuario = null;
    let token = null;

    // Campo adicional "permiso": null | {nombre, hasta} (permiso nocturno vigente).
    // El kiosco y el dashboard lo muestran; quien no lo usa simplemente lo ignora.
    const permisoDe = u => (u ? permisoAhora.get(u.id, fecha, fecha) || null : null);

    const rechazar = (motivo, resultado = 'rechazado', motivoInterno = motivo, extra = {}) => {
      guardarIntento.run(codigo.slice(0, 250), usuario ? usuario.id : null, motivoInterno, kiosco, fecha);
      return {
        respuesta: { resultado, color: 'rojo', motivo, usuario: vistaUsuario(usuario), fecha_hora: fecha,
          permiso: permisoDe(usuario) },
        motivoInterno, ...extra
      };
    };

    if (!codigo) return rechazar('no_registrada');
    if (codigo.startsWith('D.')) {
      let verificacion;
      try { verificacion = verificarQR(db, codigo); }
      catch { return rechazar('codigo_vencido'); }
      if (verificacion.error) return rechazar('codigo_vencido');
      usuario = buscarPorId.get(verificacion.usuarioId);
      token = verificacion.token;
    } else {
      usuario = buscarCredencial.get(codigo);
    }

    // 1. Existe la credencial
    if (!usuario) return rechazar('no_registrada');
    // Los QR válidos se consumen aunque se rechacen por estatus o repetición.
    if (token && marcarUsado.run(token).changes !== 1) return rechazar('codigo_vencido');
    // 2. Validación de estatus
    if (usuario.estatus === 'inactivo') return rechazar('inactiva');
    // 3. Antirrebote: últimos 60 s desde el último registro exitoso de kiosco.
    const ultimoExitoso = ultimoKiosco.get(usuario.id);
    if (ultimoExitoso) {
      const diferencia = Date.now() - epochLocal(ultimoExitoso.fecha_hora);
      if (Number.isFinite(diferencia) && diferencia >= 0 && diferencia < 60000) {
        return rechazar('repetido', 'repetido');
      }
    }
    // 4. Estado dentro/fuera según la última lectura. Cuenta como dentro si
    //    entró HOY, o si entró antes pero un permiso nocturno lo cubre
    //    (misma regla que el aforo en db.js).
    const ultimo = ultimoEvento.get(usuario.id, fecha);
    const dentro = Boolean(ultimo && ultimo.tipo === 'ingreso' &&
      (ultimo.fecha_hora.slice(0, 10) === hoy || permisoCubre.get(usuario.id, ultimo.fecha_hora, fecha)));
    if (modo === 'entrada' && dentro) return rechazar('ya_dentro');
    if (modo === 'salida' && !dentro) {
      // El contrato no incluye motivo 'sin_ingreso': se comunica motivo:null.
      // El motivo interno SÍ queda registrado claramente en intentos y alerta.
      // Caso especial: el cierre de las 00:00 le marcó salida automática (no
      // tenía permiso nocturno) y ahora intenta salir -> alerta noche_sin_permiso.
      const tras_cierre = Boolean(ultimo && ultimo.origen === 'automatico' &&
        Date.now() - epochLocal(ultimo.fecha_hora) < 12 * 3600e3);
      return rechazar(null, 'rechazado', 'sin_ingreso', { nocheSinPermiso: tras_cierre });
    }

    const tipo = modo === 'entrada' ? 'ingreso' : modo === 'salida' ? 'egreso' : dentro ? 'egreso' : 'ingreso';
    const foto = typeof body.foto_base64 === 'string' && body.foto_base64.length <= 2500000
      ? body.foto_base64 : null;
    const evento = insertarEvento.run(usuario.id, tipo, kiosco, foto, fecha);
    if (usuario.notificar_tutor && usuario.tutor_email) {
      notificar.run(evento.lastInsertRowid, fecha);
    }
    return {
      respuesta: {
        resultado: tipo,
        color: usuario.estatus === 'externo' ? 'ambar' : 'verde',
        motivo: usuario.estatus === 'externo' ? 'externo' : null,
        usuario: vistaUsuario(usuario), fecha_hora: fecha,
        permiso: permisoDe(usuario)
      },
      notificar: Boolean(usuario.notificar_tutor && usuario.tutor_email)
    };
  }

  const ejecutar = db.transaction(escanear);
  router.post('/scan', (req, res) => {
    const body = req.body || {};
    if (!['entrada', 'salida', 'mixto'].includes(body.modo) || typeof body.codigo !== 'string') {
      return res.status(400).json({ error: 'Se requieren codigo y modo (entrada, salida o mixto)' });
    }
    try {
      const registro = ejecutar.immediate(body);
      const { respuesta, motivoInterno } = registro;
      const mensaje = { ...respuesta, kiosco_id: body.kiosco_id || 'KIOSCO-01' };
      if (respuesta.resultado === 'ingreso' || respuesta.resultado === 'egreso') {
        io.emit('evento', mensaje);
      } else {
        io.emit('alerta', {
          tipo: registro.nocheSinPermiso ? 'noche_sin_permiso' : (respuesta.motivo || motivoInterno || 'rechazado'),
          mensaje: registro.nocheSinPermiso
            ? 'Se le marcó salida automática a las 00:00 (sin permiso nocturno) y ahora intenta salir'
            : `Escaneo ${respuesta.resultado}: ${motivoInterno || respuesta.motivo || 'sin motivo'}`,
          usuario: respuesta.usuario, fecha_hora: respuesta.fecha_hora
        });
      }
      const { obtenerAforo } = require('./db');
      io.emit('aforo', obtenerAforo());
      res.json(respuesta);
      // Se procesa FUERA de la transacción y DESPUÉS de contestar al kiosco.
      if (registro.notificar) setImmediate(() => procesarNotificaciones().catch(console.error));
    } catch (error) {
      console.error('Error en /api/scan:', error);
      res.status(500).json({ error: 'No se pudo procesar el escaneo' });
    }
  });
  return router;
}
module.exports = crearRutaScan;
