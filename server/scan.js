// Ruta central de acceso. Toda la validación + INSERT ocurre en UNA transacción.
const express = require('express');
const { verificarQR } = require('./qr');
const { fechaLocal, hoyLocal, epochLocal } = require('./fecha');
const { normalizarFolio, buscarPorLectura } = require('./gafete');

// leerGafete(fotoBase64, mediaType) -> lectura normalizada (ver gafete.js).
// Es opcional: sin IA_API_KEY, /api/scan-foto responde 503 y el kiosco sigue
// funcionando solo con el código de barras.
// tutores (LinceTutores): { avisos: crearGestorAvisos(db), push: crearEnvioPush(db) } o null
function crearRutaScan(db, io, procesarNotificaciones, leerGafete = null, tutores = null) {
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
  // Aviso al propio usuario: notificaciones.js lee su nombre y correo por ID al enviar
  const avisarUsuario = db.prepare(`
    INSERT INTO notificaciones (evento_id, canal, estado, fecha_hora)
    VALUES (?, 'correo_usuario', 'pendiente', ?)`);
  const { motivoCorreoInvalido } = require('./notificaciones');

  function vistaUsuario(u) {
    return u ? {
      id: u.id, nombre: u.nombre, foto_url: u.foto_url,
      carrera: u.carrera, grupo: u.grupo, tipo: u.tipo
    } : null;
  }

  // usuarioId solo lo pasa /api/scan-foto (persona ya identificada por visión);
  // nunca se toma del cuerpo de la petición.
  function escanear(body, usuarioId = null) {
    let codigo = typeof body.codigo === 'string' ? body.codigo.trim() : '';
    // Folio de gafete LinceCode: "lc26'4317" (lector USB en teclado español) -> "LC26-4317"
    if (!usuarioId) codigo = normalizarFolio(codigo) || codigo;
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

    if (usuarioId) {
      usuario = buscarPorId.get(usuarioId);
    } else if (!codigo) {
      return rechazar('no_registrada');
    } else if (codigo.startsWith('D.')) {
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
    // 3. Antirrebote: últimos N s desde el último registro exitoso de kiosco.
    //    N = ANTIRREBOTE_SEGUNDOS en .env (por defecto 60, como dice el contrato).
    const antirreboteMs = (Number(process.env.ANTIRREBOTE_SEGUNDOS) || 60) * 1000;
    const ultimoExitoso = ultimoKiosco.get(usuario.id);
    if (ultimoExitoso) {
      const diferencia = Date.now() - epochLocal(ultimoExitoso.fecha_hora);
      if (Number.isFinite(diferencia) && diferencia >= 0 && diferencia < antirreboteMs) {
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
    // Correo al usuario: solo si tiene uno válido; si no, el movimiento queda guardado y se anota
    const sinCorreo = motivoCorreoInvalido(usuario.email);
    if (sinCorreo) console.warn(`[correo] Evento ${evento.lastInsertRowid} (usuario ${usuario.id}): no se enviará aviso, ${sinCorreo}. El movimiento sí quedó guardado.`);
    else avisarUsuario.run(evento.lastInsertRowid, fecha);
    return {
      respuesta: {
        resultado: tipo,
        color: usuario.estatus === 'externo' ? 'ambar' : 'verde',
        motivo: usuario.estatus === 'externo' ? 'externo' : null,
        usuario: vistaUsuario(usuario), fecha_hora: fecha,
        permiso: permisoDe(usuario)
      },
      notificar: Boolean(usuario.notificar_tutor && usuario.tutor_email) || !sinCorreo,
      // LinceTutores: solo entradas y salidas reales (nunca rechazos)
      avisoTutor: { eventoId: Number(evento.lastInsertRowid), usuarioId: usuario.id, tipo, fecha }
    };
  }

  const ejecutar = db.transaction(escanear);

  /** Avisa por Socket.IO, contesta al kiosco y dispara las notificaciones */
  function difundir(body, registro, res) {
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
    // LinceTutores: correo y aviso al celular de los tutores con vínculo aprobado (después de contestar)
    if (registro.avisoTutor && tutores) setImmediate(() => {
      const a = registro.avisoTutor;
      try { tutores.avisos?.preparar(a.eventoId, a.usuarioId); }
      catch (e) { console.error("No se pudo encolar el aviso al tutor:", e.message); }
      Promise.resolve(tutores.push?.(a.eventoId, a.usuarioId, a.tipo, a.fecha))
        .catch(e => console.error("Aviso push al tutor:", e.message));
    });
  }

  router.post('/scan', (req, res) => {
    const body = req.body || {};
    if (!['entrada', 'salida', 'mixto'].includes(body.modo) || typeof body.codigo !== 'string') {
      return res.status(400).json({ error: 'Se requieren codigo y modo (entrada, salida o mixto)' });
    }
    try {
      difundir(body, ejecutar.immediate(body), res);
    } catch (error) {
      console.error('Error en /api/scan:', error);
      res.status(500).json({ error: 'No se pudo procesar el escaneo' });
    }
  });

  // ---------------------------------------------------------------------
  // POST /api/scan-foto {foto_base64, kiosco_id, modo}
  // Respaldo cuando el código de barras no se leyó en ~3 s: el modelo de
  // visión lee el gafete y se busca por folio -> matrícula -> nombre.
  //   - Una sola coincidencia: mismo flujo que /api/scan (+ lectura, identificado_por).
  //   - 0 o varias: resultado "rechazado", color ámbar, motivo "confirmacion_manual"
  //     (el guardia decide; nunca se elige a alguien automáticamente).
  //   - No es un gafete LinceCode: {resultado: "sin_gafete"} (el kiosco sigue escaneando).
  // ---------------------------------------------------------------------
  router.post('/scan-foto', async (req, res) => {
    const body = req.body || {};
    if (!leerGafete) return res.status(503).json({ error: 'Lectura por foto no disponible: falta IA_API_KEY en .env' });
    if (!['entrada', 'salida', 'mixto'].includes(body.modo) || typeof body.foto_base64 !== 'string') {
      return res.status(400).json({ error: 'Se requieren foto_base64 y modo (entrada, salida o mixto)' });
    }
    // Acepta "data:image/jpeg;base64,..." o solo el base64
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s.exec(body.foto_base64);
    const mediaType = m ? m[1] : 'image/jpeg';
    const foto = m ? m[2] : body.foto_base64;
    if (!foto || foto.length > 4_000_000) return res.status(400).json({ error: 'Foto vacía o demasiado grande' });

    let lectura;
    try {
      lectura = await leerGafete(foto, mediaType);
    } catch (error) {
      console.error('Error leyendo el gafete por foto:', error.message);
      return res.status(502).json({ error: 'No se pudo leer la foto' });
    }
    if (!lectura.es_gafete_lincecode) return res.json({ resultado: 'sin_gafete', lectura });

    const kiosco = typeof body.kiosco_id === 'string' ? body.kiosco_id.slice(0, 80) : 'KIOSCO-01';
    // Lo que se leyó, para el registro en intentos (no hay columnas nuevas en el esquema)
    const resumen = 'FOTO ' + JSON.stringify({ folio: lectura.folio, matricula: lectura.matricula,
      folio_secundario: lectura.folio_secundario, nombre: lectura.nombre_impreso }).slice(0, 240);

    try {
      const encontrado = buscarPorLectura(db, lectura);
      if (!encontrado.usuario) {
        const fecha = fechaLocal();
        guardarIntento.run(resumen, null, 'confirmacion_manual', kiosco, fecha);
        const candidatos = encontrado.candidatos.map(id => vistaUsuario(buscarPorId.get(id)));
        const respuesta = { resultado: 'rechazado', color: 'ambar', motivo: 'confirmacion_manual', usuario: null,
          fecha_hora: fecha, permiso: null, lectura, candidatos };
        io.emit('alerta', {
          tipo: 'confirmacion_manual',
          mensaje: `Gafete leído por foto (${lectura.folio || 'sin folio'}): ` +
            (candidatos.length ? `${candidatos.length} personas coinciden` : 'nadie coincide') + ' — confirmar a mano',
          usuario: lectura.nombre_impreso || 'Nombre ilegible', fecha_hora: fecha
        });
        return res.json(respuesta);
      }

      const registro = ejecutar.immediate({ codigo: resumen, kiosco_id: kiosco, modo: body.modo }, encontrado.usuario);
      Object.assign(registro.respuesta, { lectura, identificado_por: encontrado.por, revision: lectura.revision });
      if (lectura.revision) {
        // Gafete sin matrícula ("Mat. Folio LC25-####"): pasa, pero queda para revisión
        guardarIntento.run(resumen, encontrado.usuario, 'revision_gafete', kiosco, registro.respuesta.fecha_hora);
        io.emit('alerta', {
          tipo: 'revision_gafete',
          mensaje: `Gafete sin matrícula (folio secundario ${lectura.folio_secundario}) — revisar`,
          usuario: registro.respuesta.usuario, fecha_hora: registro.respuesta.fecha_hora
        });
      }
      difundir({ kiosco_id: kiosco }, registro, res);
    } catch (error) {
      console.error('Error en /api/scan-foto:', error);
      res.status(500).json({ error: 'No se pudo procesar el escaneo' });
    }
  });
  return router;
}
module.exports = crearRutaScan;
