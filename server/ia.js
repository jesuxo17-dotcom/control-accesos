/* =====================================================================
   server/ia.js — Módulo de "inteligencia" del sistema (Persona 3)

   Expone dos rutas:
     GET  /api/anomalias  -> detección de comportamientos raros por reglas
     POST /api/chat       -> asistente en lenguaje natural con IA

   SEGURIDAD DEL CHAT: la IA NUNCA escribe ni ejecuta SQL. Solo puede
   pedir una de tres funciones fijas (aforo_por_carrera, usuarios_dentro,
   entradas_en_rango). Cada función usa consultas preparadas escritas
   aquí por nosotros; la IA solo aporta parámetros, que se validan antes
   de usarse. Así es imposible una inyección SQL "por prompt".

   USO (en el server.js de Persona 1, DESPUÉS de app.use(express.json())):
       const rutasIA = require('./ia');
       app.use(rutasIA(db, io));      // db = better-sqlite3, io = Socket.IO (opcional)

   Dependencia extra:  npm install @anthropic-ai/sdk
   Variable en .env:   IA_API_KEY=sk-ant-...

   SUPUESTO DE FORMATO: eventos.fecha_hora e intentos.fecha_hora se
   guardan como texto 'YYYY-MM-DD HH:MM:SS' en hora local de Mazatlán.
   (Si Persona 1 usa otro formato, solo hay que ajustar aDate/ahoraLocal.)
   ===================================================================== */

const express = require('express');
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.Anthropic || sdk.default || sdk;

const ZONA = 'America/Mazatlan';
const OFFSET = '-07:00';            // Sinaloa: UTC-7 todo el año (sin horario de verano)
const MODELO = 'claude-opus-5-5';

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
/** Quita acentos y pasa a minúsculas, para comparar "sistemas" con "Sistemas Computacionales" */
const normal = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

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

    carreras: db.prepare(`SELECT nombre FROM carreras ORDER BY nombre`),

    // Eventos desde una fecha, con datos del usuario (para anomalías)
    eventosDesde: db.prepare(`
      SELECT e.id, e.usuario_id, e.tipo, e.origen, e.kiosco_id, e.fecha_hora, u.nombre
      FROM eventos e JOIN usuarios u ON u.id = e.usuario_id
      WHERE e.fecha_hora >= ?
      ORDER BY e.usuario_id, e.fecha_hora, e.id`),

    // Ingresos en un rango (para el chat)
    ingresosRango: db.prepare(`
      SELECT e.fecha_hora, u.tipo, c.nombre AS carrera
      FROM eventos e JOIN usuarios u ON u.id = e.usuario_id
      LEFT JOIN carreras c ON c.id = u.carrera_id
      WHERE e.tipo = 'ingreso' AND e.fecha_hora >= ? AND e.fecha_hora <= ?`)
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
  // 2) CHAT CON IA (function calling)
  // ===================================================================

  // ---------- Las 3 funciones que la IA puede pedir ----------
  function aforoPorCarrera() {
    const dentro = dentroAhora();
    const conteo = Object.fromEntries(sql.carreras.all().map(c => [c.nombre, 0]));
    for (const u of dentro) conteo[u.carrera || 'Sin carrera'] = (conteo[u.carrera || 'Sin carrera'] || 0) + 1;
    return { total: dentro.length, con_permiso: dentro.filter(u => u.permiso).length,
      por_carrera: Object.entries(conteo).map(([carrera, n]) => ({ carrera, dentro: n })) };
  }

  function usuariosDentro({ carrera, tipo, grupo, con_permiso } = {}) {
    let lista = dentroAhora();
    if (carrera) lista = lista.filter(u => normal(u.carrera).includes(normal(carrera)));
    if (tipo)    lista = lista.filter(u => u.tipo === tipo);
    if (grupo)   lista = lista.filter(u => normal(u.grupo) === normal(grupo));
    if (typeof con_permiso === 'boolean') lista = lista.filter(u => !!u.permiso === con_permiso);
    return {
      total: lista.length,
      // Máximo 30 nombres para no saturar la respuesta
      personas: lista.slice(0, 30).map(u => ({ nombre: u.nombre, tipo: u.tipo, carrera: u.carrera, grupo: u.grupo,
        dentro_desde: u.desde, permiso: u.permiso ? { nombre: u.permiso, hasta: u.permiso_hasta } : null })),
      truncado: lista.length > 30
    };
  }

  function entradasEnRango({ desde, hasta, carrera, tipo } = {}) {
    let filas = sql.ingresosRango.all(desde, hasta);
    if (carrera) filas = filas.filter(f => normal(f.carrera).includes(normal(carrera)));
    if (tipo)    filas = filas.filter(f => f.tipo === tipo);
    const porHora = {};
    for (const f of filas) { const h = horaDe(f.fecha_hora); porHora[h] = (porHora[h] || 0) + 1; }
    return { desde, hasta, total_entradas: filas.length,
      por_hora: Object.entries(porHora).map(([hora, entradas]) => ({ hora: Number(hora), entradas })) };
  }

  // ---------- Validación de los parámetros que manda la IA ----------
  const TIPOS = ['alumno', 'docente', 'administrativo'];
  const FECHA = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;
  const texto = (v, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

  function ejecutarHerramienta(nombre, entrada = {}) {
    const tipo = TIPOS.includes(entrada.tipo) ? entrada.tipo : undefined;
    switch (nombre) {
      case 'aforo_por_carrera':
        return aforoPorCarrera();
      case 'usuarios_dentro':
        return usuariosDentro({ carrera: texto(entrada.carrera), tipo, grupo: texto(entrada.grupo, 10),
          con_permiso: typeof entrada.con_permiso === 'boolean' ? entrada.con_permiso : undefined });
      case 'entradas_en_rango': {
        if (!FECHA.test(entrada.desde || '') || !FECHA.test(entrada.hasta || '')) {
          throw new Error('desde y hasta deben tener formato "YYYY-MM-DD HH:MM"');
        }
        // Completar a 'YYYY-MM-DD HH:MM:SS' para comparar como texto
        const completar = (s, fin) => s.length === 10 ? s + (fin ? ' 23:59:59' : ' 00:00:00') : (s.length === 16 ? s + (fin ? ':59' : ':00') : s);
        return entradasEnRango({ desde: completar(entrada.desde, false), hasta: completar(entrada.hasta, true),
          carrera: texto(entrada.carrera), tipo });
      }
      default:
        throw new Error('Herramienta no permitida: ' + nombre);
    }
  }

  // ---------- Definición de herramientas que ve la IA ----------
  const HERRAMIENTAS = [
    {
      name: 'aforo_por_carrera',
      description: 'Devuelve el total de personas dentro del plantel AHORA, cuántas de ellas tienen permiso nocturno vigente (con_permiso) y cuántas hay por carrera.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'usuarios_dentro',
      description: 'Lista y cuenta las personas que están dentro AHORA, con su permiso nocturno si lo tienen. Filtros opcionales por carrera (texto parcial, ej. "Sistemas"), tipo, grupo y si tienen o no permiso nocturno.',
      input_schema: {
        type: 'object',
        properties: {
          carrera: { type: 'string', description: 'Nombre o parte del nombre de la carrera' },
          tipo: { type: 'string', enum: TIPOS },
          grupo: { type: 'string', description: 'Ej. "5A"' },
          con_permiso: { type: 'boolean', description: 'true = solo quienes tienen permiso nocturno vigente; false = solo quienes NO lo tienen' }
        },
        additionalProperties: false
      }
    },
    {
      name: 'entradas_en_rango',
      description: 'Cuenta las ENTRADAS (ingresos) registradas entre dos fechas/horas locales, con desglose por hora. Sirve para horas pico y comparaciones.',
      input_schema: {
        type: 'object',
        properties: {
          desde: { type: 'string', description: 'Inicio, formato "YYYY-MM-DD HH:MM" (hora de Mazatlán)' },
          hasta: { type: 'string', description: 'Fin, formato "YYYY-MM-DD HH:MM" (hora de Mazatlán)' },
          carrera: { type: 'string' },
          tipo: { type: 'string', enum: TIPOS }
        },
        required: ['desde', 'hasta'],
        additionalProperties: false
      }
    }
  ];

  const cliente = process.env.IA_API_KEY
    ? new Anthropic({ apiKey: process.env.IA_API_KEY, timeout: 30000, maxRetries: 1 })
    : null;

  /** Respuesta de respaldo SIN IA (si no hay clave o falla internet en la demo) */
  function respuestaSinIA(pregunta) {
    const a = aforoPorCarrera();
    // La carrera cuyo nombre comparte más palabras con la pregunta (ignorando
    // "de", "la"...); así "Ingeniería de Software" no se confunde con "Ingeniería Industrial".
    const palabras = new Set(normal(pregunta).split(/[^a-z0-9]+/).filter(p => p.length > 3));
    const puntos = x => normal(x.carrera).split(/[^a-z0-9]+/).filter(p => p.length > 3 && palabras.has(p)).length;
    const c = a.por_carrera.map(x => [x, puntos(x)]).filter(([, n]) => n > 0)
      .sort((p, q) => q[1] - p[1])[0]?.[0];
    if (c) return `En ${c.carrera} hay ${c.dentro} persona(s) dentro ahora mismo.`;
    return `Ahora hay ${a.total} personas dentro. ` +
      a.por_carrera.filter(x => x.dentro).map(x => `${x.carrera}: ${x.dentro}`).join(', ') + '.';
  }

  router.post('/api/chat', async (req, res) => {
    const pregunta = String(req.body?.pregunta || '').trim().slice(0, 500);
    if (!pregunta) return res.status(400).json({ error: 'Falta la pregunta' });
    if (!cliente) return res.json({ respuesta: respuestaSinIA(pregunta) + ' (modo sin IA)' });

    const system =
      `Eres el asistente del sistema de control de accesos de una universidad. ` +
      `Fecha y hora actual en Mazatlán: ${ahoraLocal()}. ` +
      `Responde SIEMPRE en español, en 1 a 3 oraciones, con números concretos. ` +
      `Para cualquier dato usa ÚNICAMENTE las herramientas disponibles; nunca inventes cifras ni escribas SQL. ` +
      `Si la pregunta no se puede responder con las herramientas, dilo amablemente. ` +
      `"Hoy" significa desde las 00:00 de la fecha actual hasta ahora. ` +
      `Algunas personas tienen permiso nocturno para quedarse después de las 00:00; a quien no lo tiene se le marca salida automática.`;

    const mensajes = [{ role: 'user', content: pregunta }];

    try {
      // Bucle de function calling: máximo 5 vueltas para no quedarse colgado en la demo
      for (let vuelta = 0; vuelta < 5; vuelta++) {
        const r = await cliente.beta.messages.create({
          model: MODELO,
          max_tokens: 2000,
          system,
          tools: HERRAMIENTAS,
          messages: mensajes,
          output_config: { effort: 'low' },              // respuestas rápidas
          betas: ['server-side-fallback-2026-07-01'],     // si el modelo rechaza, el servidor reintenta con otro
          fallbacks: 'default'
        });

        if (r.stop_reason === 'refusal') {
          return res.json({ respuesta: 'No puedo responder esa pregunta.' });
        }

        if (r.stop_reason !== 'tool_use') {
          const txt = r.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
          return res.json({ respuesta: txt || respuestaSinIA(pregunta) });
        }

        // La IA pidió una o varias herramientas: las ejecutamos NOSOTROS y devolvemos el resultado
        mensajes.push({ role: 'assistant', content: r.content });
        const resultados = [];
        for (const b of r.content.filter(b => b.type === 'tool_use')) {
          try {
            const salida = ejecutarHerramienta(b.name, b.input);
            console.log(`[ia] herramienta ${b.name}`, JSON.stringify(b.input));
            resultados.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(salida) });
          } catch (e) {
            resultados.push({ type: 'tool_result', tool_use_id: b.id, content: e.message, is_error: true });
          }
        }
        mensajes.push({ role: 'user', content: resultados });   // todos los resultados en UN mensaje
      }
      res.json({ respuesta: respuestaSinIA(pregunta) });
    } catch (e) {
      console.error('[ia] chat:', e.status || '', e.message);
      // En la demo nunca dejamos al usuario sin respuesta
      res.json({ respuesta: respuestaSinIA(pregunta) + ' (la IA no respondió; dato calculado directo)' });
    }
  });

  return router;
};
