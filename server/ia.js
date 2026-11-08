/* =====================================================================
   server/ia.js — Módulo de "inteligencia" del sistema (Persona 3)

   Expone dos rutas:
     GET  /api/anomalias  -> detección de comportamientos raros por reglas
     POST /api/chat       -> asistente en lenguaje natural con IA

   El chat vive en server/asistente.js (ver ahí sus reglas de seguridad).

   USO (en el server.js de Persona 1, DESPUÉS de app.use(express.json())):
       const rutasIA = require('./ia');
       app.use(rutasIA(db, io));      // db = better-sqlite3, io = Socket.IO (opcional)

   Variable en .env:   IA_API_KEY=sk-ant-...

   SUPUESTO DE FORMATO: eventos.fecha_hora e intentos.fecha_hora se
   guardan como texto 'YYYY-MM-DD HH:MM:SS' en hora local de Mazatlán.
   (Si Persona 1 usa otro formato, solo hay que ajustar aDate/ahoraLocal.)
   ===================================================================== */

const express = require('express');

const ZONA = 'America/Mazatlan';
const OFFSET = '-07:00';            // Sinaloa: UTC-7 todo el año (sin horario de verano)

// ---------------------------------------------------------------------
// Utilidades de fecha (todo en hora local de Mazatlán)
// ---------------------------------------------------------------------
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});
/** Date -> 'YYYY-MM-DD HH:MM:SS' local */
const ahoraLocal = (d = new Date()) => fmt.format(d).replace('T', ' ');
/** 'YYYY-MM-DD HH:MM:SS' local -> Date */
const aDate = s => new Date(String(s).replace(' ', 'T').slice(0, 19) + OFFSET);
/** Hora (0-23) de una fecha local */
const horaDe = s => parseInt(String(s).slice(11, 13), 10);

module.exports = function crearRutasIA(db, io) {
  const router = express.Router();

  // -------------------------------------------------------------------
  // Consultas preparadas (las ÚNICAS que usa este módulo)
  // -------------------------------------------------------------------
  const sql = {
    // Quién está dentro: su ÚLTIMO evento es ingreso y además
    //   - ese ingreso fue HOY (regla 7), o
    //   - entró antes de hoy pero tiene un permiso nocturno que lo cubrió
    //     (por eso el cierre de las 00:00 no le marcó salida).
    // También trae el permiso vigente AHORA (o null) para contar con_permiso.
    dentro: db.prepare(`
      SELECT u.id, u.nombre, u.tipo, u.grupo, u.estatus, c.nombre AS carrera, e.fecha_hora AS desde,
             pv.nombre AS permiso, pv.hasta AS permiso_hasta
      FROM usuarios u
      JOIN eventos e ON e.id = (
        SELECT e2.id FROM eventos e2
        WHERE e2.usuario_id = u.id
        ORDER BY e2.fecha_hora DESC, e2.id DESC LIMIT 1)
      LEFT JOIN carreras c ON c.id = u.carrera_id
      LEFT JOIN permisos pv ON pv.id = (
        SELECT p.id FROM permisos p
        WHERE p.usuario_id = u.id AND p.desde <= @ahora AND p.hasta >= @ahora
        ORDER BY p.hasta DESC LIMIT 1)
      WHERE e.tipo = 'ingreso'
        AND (substr(e.fecha_hora, 1, 10) = @hoy
             OR EXISTS (SELECT 1 FROM permisos p
                        WHERE p.usuario_id = u.id AND p.hasta >= e.fecha_hora AND p.desde <= @ahora))`),

    // ¿Tenía permiso en ese momento? (para no marcar como anomalía el acceso nocturno con permiso)
    permisoEn: db.prepare(`
      SELECT 1 FROM permisos WHERE usuario_id = ? AND desde <= ? AND hasta >= ? LIMIT 1`),

    // Permiso que ya venció después de que la persona entró (y sigue dentro)
    permisoVencido: db.prepare(`
      SELECT nombre, hasta FROM permisos
      WHERE usuario_id = ? AND hasta >= ? AND hasta < ?
      ORDER BY hasta DESC LIMIT 1`),


    // Eventos desde una fecha, con datos del usuario (para anomalías)
    eventosDesde: db.prepare(`
      SELECT e.id, e.usuario_id, e.tipo, e.origen, e.kiosco_id, e.fecha_hora, u.nombre
      FROM eventos e JOIN usuarios u ON u.id = e.usuario_id
      WHERE e.fecha_hora >= ?
      ORDER BY e.usuario_id, e.fecha_hora, e.id`)
  };

  /** Lista de quién está dentro ahora (usa la consulta "dentro") */
  const dentroAhora = () => {
    const ahora = ahoraLocal();
    return sql.dentro.all({ ahora, hoy: ahora.slice(0, 10) });
  };

  // ===================================================================
  // 1) ANOMALÍAS
  // ===================================================================
  function detectarAnomalias() {
    const ahora = new Date();
    const hace24h = ahoraLocal(new Date(ahora - 24 * 3600e3));
    const hace48h = ahoraLocal(new Date(ahora - 48 * 3600e3));
    const ahoraTxt = ahoraLocal(ahora);
    const resultado = [];

    // Eventos de las últimas 48 h, ya ordenados por usuario y fecha
    const eventos = sql.eventosDesde.all(hace48h);
    const porUsuario = new Map();
    for (const e of eventos) {
      if (!porUsuario.has(e.usuario_id)) porUsuario.set(e.usuario_id, []);
      porUsuario.get(e.usuario_id).push(e);
    }

    for (const lista of porUsuario.values()) {
      for (let i = 0; i < lista.length; i++) {
        const e = lista[i];
        const reciente = e.fecha_hora >= hace24h;

        // Regla A: acceso entre 22:00 y 06:00 (solo lecturas reales de kiosco),
        // EXCEPTO si en ese momento tenía permiso nocturno
        const h = horaDe(e.fecha_hora);
        if (reciente && e.origen === 'kiosco' && (h >= 22 || h < 6) &&
            !sql.permisoEn.get(e.usuario_id, e.fecha_hora, e.fecha_hora)) {
          resultado.push({
            tipo: 'horario_nocturno',
            mensaje: `${e.tipo === 'ingreso' ? 'Entrada' : 'Salida'} a las ${e.fecha_hora.slice(11, 16)} (fuera de 06:00–22:00)`,
            usuario: e.nombre, fecha_hora: e.fecha_hora
          });
        }

        // Regla B: más de 14 h dentro (ingreso -> siguiente egreso),
        // EXCEPTO si un permiso nocturno cubrió parte de esa estancia
        if (e.tipo === 'ingreso') {
          const sig = lista.slice(i + 1).find(x => x.tipo === 'egreso');
          const fin = sig ? aDate(sig.fecha_hora) : ahora;   // si no ha salido, se mide hasta ahora
          const horas = (fin - aDate(e.fecha_hora)) / 3600e3;
          const finTxt = sig ? sig.fecha_hora : ahoraTxt;
          const conPermiso = sql.permisoEn.get(e.usuario_id, finTxt, e.fecha_hora); // desde<=fin y hasta>=ingreso
          if (horas > 14 && !conPermiso && (sig ? sig.fecha_hora >= hace24h : true)) {
            resultado.push({
              tipo: 'estancia_larga',
              mensaje: `${horas.toFixed(1)} h dentro (entró ${e.fecha_hora.slice(0, 16)}` +
                       (sig ? `, salida ${sig.origen === 'automatico' ? 'automática' : 'en kiosco'})` : ', sigue dentro)'),
              usuario: e.nombre, fecha_hora: sig ? sig.fecha_hora : ahoraLocal()
            });
          }
        }

        // Regla C: dos kioscos distintos en menos de 2 minutos (posible credencial clonada/prestada)
        const ant = lista[i - 1];
        if (reciente && ant && ant.kiosco_id && e.kiosco_id && ant.kiosco_id !== e.kiosco_id &&
            ant.origen === 'kiosco' && e.origen === 'kiosco') {
          const seg = (aDate(e.fecha_hora) - aDate(ant.fecha_hora)) / 1000;
          if (seg < 120) {
            resultado.push({
              tipo: 'kioscos_distintos',
              mensaje: `Leída en ${ant.kiosco_id} y ${e.kiosco_id} con ${Math.round(seg)} s de diferencia`,
              usuario: e.nombre, fecha_hora: e.fecha_hora
            });
          }
        }
      }
    }

    // (La regla de "3 códigos vencidos" se eliminó: ya no existe el QR dinámico.)

    // Regla D: permiso_vencido -> el permiso terminó y la persona sigue dentro
    for (const u of dentroAhora()) {
      if (u.permiso) continue;                       // tiene otro permiso vigente: todo bien
      const p = sql.permisoVencido.get(u.id, u.desde, ahoraTxt);
      if (p) {
        resultado.push({
          tipo: 'permiso_vencido',
          mensaje: `Su permiso "${p.nombre}" venció ${p.hasta.slice(5, 16)} y sigue dentro`,
          usuario: u.nombre, fecha_hora: p.hasta
        });
      }
    }
    // Nota: "noche_sin_permiso" la emite /api/scan (Persona 1), porque solo ahí
    // se conoce el modo del kiosco; el dashboard ya la muestra al recibirla.

    // Más recientes primero
    return resultado.sort((a, b) => String(b.fecha_hora).localeCompare(String(a.fecha_hora)));
  }

  router.get('/api/anomalias', (req, res) => {
    try {
      res.json(detectarAnomalias());
    } catch (e) {
      console.error('[ia] anomalías:', e);
      res.status(500).json({ error: 'No se pudieron calcular las anomalías' });
    }
  });

  // Si nos pasan Socket.IO, revisamos cada minuto y avisamos SOLO las nuevas por "alerta"
  if (io) {
    const avisadas = new Set();
    setInterval(() => {
      try {
        for (const a of detectarAnomalias()) {
          const clave = `${a.tipo}|${a.usuario}|${a.fecha_hora}`;
          if (avisadas.has(clave)) continue;
          avisadas.add(clave);
          io.emit('alerta', a);
        }
      } catch (e) { console.error('[ia] revisión periódica:', e.message); }
    }, 60 * 1000);
  }

  // ===================================================================
  // 2) CHAT CON IA -> server/asistente.js (solo admin, herramientas de solo lectura)
  // ===================================================================
  router.use(require('./asistente')(db));

  return router;
};
