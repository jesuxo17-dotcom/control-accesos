/* =====================================================================
   server/asistente.js — Asistente de IA del panel de administrador.

   POST /api/chat  { pregunta, historial? }  ->  { respuesta }
   Solo para administradores (cabecera x-admin-key); la API key de la IA
   vive aquí en el backend y nunca llega al navegador.

   REGLAS DE DISEÑO
   - El modelo NO escribe SQL: solo llama 4 herramientas. Cada una ejecuta
     consultas FIJAS, preparadas al arrancar, parametrizadas y de solo
     lectura (se verifica stmt.readonly al prepararlas).
   - Los números salen siempre de las herramientas.
   - El filtro de carrera usa el nombre EXACTO de la tabla carreras; si el
     modelo manda otro texto, la herramienta lo rechaza y le da las opciones.

   "ADENTRO": el último evento de la persona es un ingreso (no hay egreso
   después) y ese ingreso fue hoy, o un permiso nocturno lo cubre. Es la
   misma regla de db.js/usuariosDentro (el cierre de las 00:00 marca
   salida automática a quien no tiene permiso).

   Sin IA_API_KEY (o si la IA falla) responde un intérprete por reglas que
   usa las MISMAS herramientas y las mismas reglas del system prompt.
   ===================================================================== */

const express = require('express');
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.Anthropic || sdk.default || sdk;
const { fechaLocal } = require('./fecha');
const { exigirAdmin } = require('./seguridad');

const MODELO = 'claude-opus-5-5';
const MAX_VUELTAS = 6;

// System prompt acordado (tal cual)
const SYSTEM_PROMPT = `Eres el asistente de asistencia del Hackatón LinceCode 2026. Respondes las preguntas del administrador sobre cuántas personas están dentro del evento en este momento.
Reglas:
- Saca cada número de tus herramientas. Nunca inventes ni estimes cifras, y no sumes por tu cuenta si una herramienta puede dar el total.
- Para filtrar por carrera, llama primero a listar_carreras y usa el nombre exacto de la base. Si el término del admin coincide con varias carreras o con ninguna, pregunta antes de contar.
- "Adentro" significa que el último escaneo de la persona fue una entrada.
- Responde en español, en una o dos frases, con el nombre completo de la carrera y la hora de corte (actualizado_a). Ejemplo: "Hay 23 alumnos de Ingeniería en Sistemas Computacionales adentro (corte 21:40)."
- Si el resultado es 0, dilo claramente: no es un error.
- Comparte nombres o matrículas solo si el admin los pide.
- Solo puedes consultar. Si te piden registrar, modificar o borrar algo, di que eso se hace desde el panel.
- Si te preguntan algo que no tiene que ver con la asistencia al evento, dilo amablemente y di qué sí puedes consultar.`;

const ROLES = ['alumno', 'docente', 'administrativo'];
const AGRUPACIONES = { carrera: 'carrera', semestre: 'semestre', equipo: 'equipo', rol: 'rol' };

/** Quita acentos, minúsculas, sin espacios extra (solo para comparar, nunca para filtrar en SQL) */
const normal = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------
// Herramientas (consultas fijas)
// ---------------------------------------------------------------------
function crearHerramientas(db) {
  // Base común: personas adentro AHORA con sus datos. Mismo criterio que db.js.
  const DENTRO = `
    WITH ultimo AS (
      SELECT e.usuario_id, e.tipo, e.fecha_hora,
             ROW_NUMBER() OVER (PARTITION BY e.usuario_id ORDER BY e.fecha_hora DESC, e.id DESC) AS rn
      FROM eventos e WHERE e.fecha_hora <= @ahora
    ),
    dentro AS (
      SELECT u.nombre, u.matricula, u.codigo_credencial AS folio, u.tipo AS rol, u.grupo,
             u.semestre, u.equipo, c.nombre AS carrera, x.fecha_hora AS hora_entrada
      FROM ultimo x
      JOIN usuarios u ON u.id = x.usuario_id
      LEFT JOIN carreras c ON c.id = u.carrera_id
      WHERE x.rn = 1 AND x.tipo = 'ingreso'
        AND (substr(x.fecha_hora, 1, 10) = @hoy
             OR EXISTS (SELECT 1 FROM permisos p
                        WHERE p.usuario_id = u.id AND p.hasta >= x.fecha_hora AND p.desde <= @ahora))
    ),
    filtrado AS (
      SELECT * FROM dentro
      WHERE (@carrera  IS NULL OR carrera  = @carrera)
        AND (@semestre IS NULL OR semestre = @semestre)
        AND (@grupo    IS NULL OR grupo    = @grupo)
        AND (@equipo   IS NULL OR equipo   = @equipo)
        AND (@rol      IS NULL OR rol      = @rol)
    )`;

  const preparar = sql => {
    const st = db.prepare(sql);
    if (!st.readonly) throw new Error('El asistente solo puede usar consultas de lectura');
    return st;
  };

  const sql = {
    carreras: preparar(`
      SELECT c.nombre AS carrera, COUNT(u.id) AS participantes
      FROM carreras c LEFT JOIN usuarios u ON u.carrera_id = c.id
      GROUP BY c.id ORDER BY c.nombre`),
    grupos: preparar(`SELECT DISTINCT grupo FROM usuarios WHERE grupo IS NOT NULL AND grupo <> '' ORDER BY grupo`),
    equipos: preparar(`SELECT DISTINCT equipo FROM usuarios WHERE equipo IS NOT NULL AND equipo <> '' ORDER BY equipo`),
    conSemestre: preparar(`SELECT COUNT(*) AS n FROM usuarios WHERE semestre IS NOT NULL`),
    contar: preparar(`${DENTRO} SELECT COUNT(*) AS total FROM filtrado`),
    listar: preparar(`${DENTRO}
      SELECT nombre, folio, carrera, semestre, equipo, hora_entrada FROM filtrado
      ORDER BY nombre LIMIT @limite`),
    // Una consulta fija por cada agrupación permitida (la columna no viene del modelo)
    desglose: Object.fromEntries(Object.keys(AGRUPACIONES).map(k => [k, preparar(`${DENTRO}
      SELECT ${AGRUPACIONES[k]} AS valor, COUNT(*) AS adentro FROM filtrado
      GROUP BY ${AGRUPACIONES[k]} ORDER BY adentro DESC, valor`)]))
  };

  const corte = () => {
    const ahora = fechaLocal();
    return { ahora, hoy: ahora.slice(0, 10), actualizado_a: ahora.slice(11, 16) };
  };

  class ErrorFiltro extends Error {}

  /** Valida los filtros del modelo y los convierte a valores EXACTOS de la base */
  function resolverFiltros(f = {}) {
    if (f === null || typeof f !== 'object' || Array.isArray(f)) throw new ErrorFiltro('filtros debe ser un objeto');
    const p = { carrera: null, semestre: null, grupo: null, equipo: null, rol: null };
    const avisos = [];

    if (f.carrera != null && f.carrera !== '') {
      const nombres = sql.carreras.all().map(c => c.carrera);
      if (!nombres.includes(f.carrera)) {
        throw new ErrorFiltro(`La carrera "${f.carrera}" no es un nombre exacto de la base. ` +
          `Llama a listar_carreras y usa uno de estos: ${nombres.join(' | ')}`);
      }
      p.carrera = f.carrera;
    }
    if (f.semestre != null && f.semestre !== '') {
      const s = Number(f.semestre);
      if (!Number.isInteger(s) || s < 1 || s > 12) throw new ErrorFiltro('semestre debe ser un entero de 1 a 12');
      if (!sql.conSemestre.get().n) avisos.push('semestre');
      p.semestre = s;
    }
    if (f.grupo != null && f.grupo !== '') {
      const g = sql.grupos.all().map(x => x.grupo).find(x => normal(x) === normal(f.grupo));
      if (!g) throw new ErrorFiltro(`No existe el grupo "${f.grupo}". Grupos: ${sql.grupos.all().map(x => x.grupo).join(' | ')}`);
      p.grupo = g;
    }
    if (f.equipo != null && f.equipo !== '') {
      const lista = sql.equipos.all().map(x => x.equipo);
      if (!lista.length) avisos.push('equipo');
      else {
        const e = lista.find(x => normal(x) === normal(f.equipo));
        if (!e) throw new ErrorFiltro(`No existe el equipo "${f.equipo}". Equipos: ${lista.join(' | ')}`);
        p.equipo = e;
      }
      if (!lista.length) p.equipo = String(f.equipo);
    }
    if (f.rol != null && f.rol !== '') {
      if (!ROLES.includes(f.rol)) throw new ErrorFiltro(`rol debe ser uno de: ${ROLES.join(', ')}`);
      p.rol = f.rol;
    }
    return { p, avisos };
  }

  /** Aviso cuando se filtra por un dato que nadie tiene capturado (no es un 0 real) */
  const sinDatos = avisos => avisos.length ? {
    sin_datos: avisos,
    nota: `Ningún participante tiene ${avisos.join(' ni ')} registrado en la base; no se puede filtrar por eso todavía.`
  } : {};

  const herramientas = {
    listar_carreras() {
      const { actualizado_a } = corte();
      return { carreras: sql.carreras.all(), actualizado_a };
    },
    contar_adentro({ filtros } = {}) {
      const { p, avisos } = resolverFiltros(filtros);
      const c = corte();
      const { total } = sql.contar.get({ ...p, ahora: c.ahora, hoy: c.hoy });
      return { total, filtros: limpiar(p), actualizado_a: c.actualizado_a, ...sinDatos(avisos) };
    },
    desglose_adentro({ agrupar_por, filtros } = {}) {
      if (!AGRUPACIONES[agrupar_por]) throw new ErrorFiltro(`agrupar_por debe ser: ${Object.keys(AGRUPACIONES).join(', ')}`);
      const { p, avisos } = resolverFiltros(filtros);
      if (agrupar_por === 'semestre' && !sql.conSemestre.get().n) avisos.push('semestre');
      if (agrupar_por === 'equipo' && !sql.equipos.all().length) avisos.push('equipo');
      const c = corte();
      const grupos = sql.desglose[agrupar_por].all({ ...p, ahora: c.ahora, hoy: c.hoy })
        .map(g => ({ [agrupar_por]: g.valor ?? `Sin ${agrupar_por}`, adentro: g.adentro }));
      const total = sql.contar.get({ ...p, ahora: c.ahora, hoy: c.hoy }).total;
      return { agrupar_por, grupos, total, filtros: limpiar(p), actualizado_a: c.actualizado_a, ...sinDatos([...new Set(avisos)]) };
    },
    listar_adentro({ filtros, limite = 50 } = {}) {
      const { p, avisos } = resolverFiltros(filtros);
      const lim = Math.min(Math.max(Number.parseInt(limite, 10) || 50, 1), 200);
      const c = corte();
      const total = sql.contar.get({ ...p, ahora: c.ahora, hoy: c.hoy }).total;
      const personas = sql.listar.all({ ...p, ahora: c.ahora, hoy: c.hoy, limite: lim })
        .map(x => ({ ...x, hora_entrada: x.hora_entrada.slice(11, 16) }));
      return { total, mostrados: personas.length, personas, filtros: limpiar(p), actualizado_a: c.actualizado_a, ...sinDatos(avisos) };
    }
  };

  const limpiar = p => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null));

  /** Ejecuta una herramienta por nombre. Lanza ErrorFiltro con un mensaje útil para el modelo. */
  function ejecutar(nombre, entrada) {
    if (!Object.hasOwn(herramientas, nombre)) throw new ErrorFiltro('Herramienta no permitida: ' + nombre);
    return herramientas[nombre](entrada && typeof entrada === 'object' ? entrada : {});
  }

  return { ejecutar, herramientas, ErrorFiltro };
}

// Esquema que ve el modelo
const FILTROS = {
  type: 'object',
  description: 'Filtros opcionales. Omite los que no apliquen.',
  properties: {
    carrera: { type: 'string', description: 'Nombre EXACTO tal como lo devolvió listar_carreras' },
    semestre: { type: 'integer', minimum: 1, maximum: 12 },
    grupo: { type: 'string', description: 'Ej. "G31"' },
    equipo: { type: 'string', description: 'Nombre del equipo del hackatón' },
    rol: { type: 'string', enum: ROLES }
  },
  additionalProperties: false
};
const DEFINICIONES = [
  {
    name: 'listar_carreras',
    description: 'Lista las carreras tal como están escritas en la base, con cuántos participantes registrados tiene cada una. Llámala antes de filtrar por carrera para traducir lo que escribió el admin ("sistemas", "ISC", "meca") al nombre exacto.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'contar_adentro',
    description: 'Cuenta cuántas personas están adentro del evento AHORA (su último escaneo fue una entrada). Devuelve total y actualizado_a (hora de corte). Si devuelve sin_datos, ese filtro no está capturado: dilo en vez de reportar 0.',
    input_schema: { type: 'object', properties: { filtros: FILTROS }, additionalProperties: false }
  },
  {
    name: 'desglose_adentro',
    description: 'Cuenta las personas adentro AHORA agrupadas por carrera, semestre, equipo o rol. Incluye el total y actualizado_a.',
    input_schema: {
      type: 'object',
      properties: { agrupar_por: { type: 'string', enum: Object.keys(AGRUPACIONES) }, filtros: FILTROS },
      required: ['agrupar_por'],
      additionalProperties: false
    }
  },
  {
    name: 'listar_adentro',
    description: 'Lista a las personas adentro AHORA: nombre, folio, carrera, semestre, equipo y hora de entrada. Úsala SOLO si el admin pide nombres o quiénes son.',
    input_schema: {
      type: 'object',
      properties: { filtros: FILTROS, limite: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      additionalProperties: false
    }
  }
];

// ---------------------------------------------------------------------
// Intérprete por reglas (sin IA): mismas herramientas, mismas reglas
// ---------------------------------------------------------------------
const ACCION_ESCRITURA = /\b(borra|borrar|borre|elimina|eliminar|quita|quitar|registra|registrar|agrega|agregar|anade|da de alta|dar de alta|modifica|modificar|cambia|cambiar|actualiza|actualizar|edita|editar|marca|marcar|saca|sacar)\b/;
const ALIAS = { isc: 'sistemas computacionales', compu: 'computacion', ti: 'tecnologias de la informacion', meca: 'mecatronica', conta: 'contaduria', admin: 'administracion' };
const NO_CARRERA = new Set(['adentro', 'dentro', 'aqui', 'ahorita', 'ahora', 'semestre', 'equipo', 'grupo', 'carrera', 'hoy', 'todos', 'evento', 'alumnos', 'docentes', 'personas', 'gente', 'cuantos', 'cuantas', 'quienes', 'siguen', 'estan', 'hay', 'participantes']);
const VACIAS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'en', 'y', 'a', 'que', 'por', 'hay', 'cuantos', 'cuantas', 'quienes', 'estan', 'esta', 'adentro', 'dentro', 'ahorita', 'ahora', 'siguen', 'aqui', 'dame', 'son', 'me', 'dime', 'hoy', 'carrera', 'alumnos', 'alumno', 'personas', 'gente', 'participantes', 'ingenieria', 'licenciatura', 'lic', 'ing', 'semestre', 'equipo', 'grupo', 'todos']);

/** Carreras de la base que corresponden a lo que escribió el admin */
function carrerasQueCoinciden(pregunta, carreras) {
  let txt = ` ${normal(pregunta).replace(/[^a-z0-9 ]/g, ' ')} `;
  for (const [a, real] of Object.entries(ALIAS)) txt = txt.replace(new RegExp(` ${a} `, 'g'), ` ${real} `);
  const palabras = txt.split(' ').filter(p => p.length >= 4);
  const significativas = palabras.filter(p => !VACIAS.has(p));
  const puntos = c => {
    const pal = normal(c).split(/[^a-z0-9]+/);
    return significativas.filter(p => pal.some(w => w.startsWith(p) || p.startsWith(w) && w.length >= 5)).length;
  };
  const conPuntos = carreras.map(c => [c, puntos(c)]).filter(([, n]) => n > 0);
  if (conPuntos.length) {
    const max = Math.max(...conPuntos.map(([, n]) => n));
    return { candidatas: conPuntos.filter(([, n]) => n === max).map(([c]) => c), menciona: true };
  }
  // Término genérico que coincide con varias ("ingeniería", "licenciatura")
  const genericas = ['ingenieria', 'licenciatura'].filter(g => palabras.includes(g));
  if (genericas.length) {
    const c = carreras.filter(x => genericas.some(g => normal(x).includes(g)));
    return { candidatas: c, menciona: true };
  }
  // ¿Mencionó algo que parece carrera pero no existe? ("de mecatrónica", "los de medicina")
  const m = normal(pregunta).match(/\b(?:de|los de|las de)\s+(?:la\s+|los\s+|las\s+)?([a-z]{4,})/g) || [];
  const termino = m.map(x => x.split(' ').pop()).find(p => !NO_CARRERA.has(p) && !VACIAS.has(p));
  return { candidatas: [], menciona: Boolean(termino), termino };
}

const ZONA = 'America/Mazatlan';
const QUE_PUEDO = 'Puedo decirte cuántas personas están adentro ahora, por carrera, semestre, grupo o rol, y quiénes son si me lo pides.';

/** Saludos, despedidas, fecha y hora. Devuelve la respuesta o null si no es charla básica. */
function charlaBasica(q, ahora = new Date()) {
  const fecha = ahora.toLocaleDateString('es-MX', { timeZone: ZONA, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hora = ahora.toLocaleTimeString('es-MX', { timeZone: ZONA, hour: '2-digit', minute: '2-digit' });
  const h = Number(ahora.toLocaleString('en-US', { timeZone: ZONA, hour: 'numeric', hourCycle: 'h23' }));
  const saludo = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
  if (/\b(que|cual)\s+(dia|fecha)\b|\bfecha de hoy\b|\bque dia es\b|\bhoy es\b/.test(q)) return 'Hoy es ' + fecha + '.';
  if (/\bque hora\b|\bhora es\b/.test(q)) return 'Son las ' + hora + ' (hora de Mazatlán).';
  if (/\b(gracias|grax|thank)/.test(q)) return '¡De nada! Aquí estoy si necesitas otro dato de la asistencia.';
  if (/\b(adios|bye|hasta luego|nos vemos|hasta pronto)\b/.test(q)) return '¡Hasta luego! ' + saludo.replace('Buenos días', 'Que tengas buen día').replace('Buenas tardes', 'Que tengas buena tarde').replace('Buenas noches', 'Que descanses') + '.';
  if (/\b(como estas|que tal|como te va)\b/.test(q)) return '¡Muy bien, gracias! ' + QUE_PUEDO;
  if (/\b(quien eres|que eres|que puedes hacer|que haces|ayuda|help)\b/.test(q)) return 'Soy el asistente de asistencia del Hackatón LinceCode 2026. ' + QUE_PUEDO;
  if (/\b(hola|buen(os|as)? (dias|tardes|noches)|buenas|hey|saludos|que onda)\b/.test(q)) return saludo + ', ¿en qué te ayudo? ' + QUE_PUEDO;
  return null;
}

function interpretarSinIA(pregunta, H) {
  const q = normal(pregunta);
  if (ACCION_ESCRITURA.test(q)) {
    return 'Solo puedo consultar la asistencia; registrar, modificar o borrar personas o escaneos se hace desde el panel (Usuarios y Permisos).';
  }
  if (!/\b(cuant[oa]s?|quien(es)?|adentro|dentro|aqui|siguen|nombres?|lista(do)?|carreras?|equipos?|semestres?|desglos\w*|hay)\b/.test(q)) {
    return charlaBasica(q) || 'Solo puedo responder sobre la asistencia al evento. ' + QUE_PUEDO;
  }
  const carreras = H.ejecutar('listar_carreras').carreras.map(c => c.carrera);
  const filtros = {};
  const sem = q.match(/\b(\d{1,2})\s*(?:er|ro|do|to|vo|no|mo|o|°|º)?\s*semestre\b/) || q.match(/\bsemestre\s*(\d{1,2})\b/);
  if (sem) filtros.semestre = Number(sem[1]);
  const eq = pregunta.match(/equipo\s+["“]?([\p{L}\p{N} _-]{2,40}?)["”]?(?:\s+(?:sigue|siguen|est|hay|adentro|dentro|ahorita)|[?.!,]|$)/iu);
  if (eq) filtros.equipo = eq[1].trim();
  if (/\b(alumnos?|estudiantes?)\b/.test(q)) filtros.rol = 'alumno';
  else if (/\b(docentes?|maestros?|profes?(ores)?)\b/.test(q)) filtros.rol = 'docente';

  const porCarrera = /por carrera|cada carrera|desglos/.test(q);
  if (!porCarrera && !eq) {
    const { candidatas, menciona, termino } = carrerasQueCoinciden(pregunta, carreras);
    if (candidatas.length > 1) {
      return `"${termino || 'Ese término'}" coincide con varias carreras: ${candidatas.join(', ')}. ¿De cuál quieres el dato?`
        .replace('"Ese término"', 'Tu pregunta');
    }
    if (candidatas.length === 1) filtros.carrera = candidatas[0];
    else if (menciona) {
      return `No hay ninguna carrera "${termino}" en la base. Las carreras registradas son: ${carreras.join(', ')}. ¿Cuál quieres consultar?`;
    }
  }
  const rotulo = (n, f) => {
    const quien = f.rol === 'alumno' ? (n === 1 ? 'alumno' : 'alumnos') : f.rol === 'docente' ? (n === 1 ? 'docente' : 'docentes') : (n === 1 ? 'persona' : 'personas');
    const partes = [];
    if (f.carrera) partes.push(`de ${f.carrera}`);
    if (f.semestre) partes.push(`de ${f.semestre}.º semestre`);
    if (f.equipo) partes.push(`del equipo ${f.equipo}`);
    return `${quien} ${partes.join(' ')}`.trim();
  };

  try {
    if (porCarrera) {
      const r = H.ejecutar('desglose_adentro', { agrupar_por: 'carrera', filtros });
      if (!r.total) return `Ahora no hay nadie adentro (corte ${r.actualizado_a}).`;
      return `Hay ${r.total} adentro: ${r.grupos.map(g => `${g.carrera} ${g.adentro}`).join(', ')} (corte ${r.actualizado_a}).`;
    }
    if (/\b(quienes|quien|nombres|lista|listado)\b/.test(q)) {
      const r = H.ejecutar('listar_adentro', { filtros });
      if (r.sin_datos) return r.nota;
      if (!r.total) return `No hay ${rotulo(2, filtros)} adentro en este momento (corte ${r.actualizado_a}).`;
      const nombres = r.personas.map(p => `${p.nombre} (${p.hora_entrada})`).join(', ');
      return `Hay ${r.total} ${rotulo(r.total, filtros)} adentro: ${nombres}${r.total > r.mostrados ? '…' : ''} (corte ${r.actualizado_a}).`;
    }
    const r = H.ejecutar('contar_adentro', { filtros });
    if (r.sin_datos) return r.nota;
    if (!r.total) return `No hay ${rotulo(2, filtros)} adentro en este momento: el conteo da 0 (corte ${r.actualizado_a}).`;
    return `Hay ${r.total} ${rotulo(r.total, filtros)} adentro (corte ${r.actualizado_a}).`;
  } catch (e) {
    if (e instanceof H.ErrorFiltro) return e.message.split('. Llama')[0] + '.';
    throw e;
  }
}

// ---------------------------------------------------------------------
// Ruta
// ---------------------------------------------------------------------
/** Convierte el historial del navegador (solo texto) a mensajes válidos para la API */
function armarMensajes(historial, pregunta) {
  const previos = (Array.isArray(historial) ? historial : []).slice(-10)
    .filter(m => m && typeof m.texto === 'string' && m.texto.trim() && ['admin', 'asistente'].includes(m.rol))
    .map(m => ({ role: m.rol === 'admin' ? 'user' : 'assistant', content: m.texto.trim().slice(0, 1500) }));
  // Debe empezar con user y alternar
  const limpios = [];
  for (const m of previos) {
    if (!limpios.length && m.role !== 'user') continue;
    if (limpios.length && limpios.at(-1).role === m.role) limpios[limpios.length - 1] = m;
    else limpios.push(m);
  }
  if (limpios.length && limpios.at(-1).role === 'user') limpios.pop();
  limpios.push({ role: 'user', content: pregunta });
  return limpios;
}

function crearAsistente(db, opciones = {}) {
  const H = crearHerramientas(db);
  const cliente = 'cliente' in opciones ? opciones.cliente
    : (process.env.IA_API_KEY ? new Anthropic({ apiKey: process.env.IA_API_KEY, timeout: 30000, maxRetries: 1 }) : null);
  const router = express.Router();

  async function responderConIA(mensajes) {
    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      const r = await cliente.beta.messages.create({
        model: MODELO,
        max_tokens: 2000,
        system: [
          { type: 'text', text: SYSTEM_PROMPT },
          { type: 'text', text: 'Además puedes contestar saludos, despedidas y agradecimientos con una frase breve y amable, ' +
            'y decir la fecha o la hora. Ahora es ' + new Date().toLocaleString('es-MX', { timeZone: ZONA, dateStyle: 'full', timeStyle: 'short' }) + ' (hora de Mazatlán).' }
        ],
        tools: DEFINICIONES,
        messages: mensajes,
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default'
      });
      if (r.stop_reason === 'refusal') return 'No puedo responder esa pregunta. Puedo decirte cuántas personas están adentro, por carrera, semestre, grupo, equipo o rol.';
      if (r.stop_reason !== 'tool_use') {
        const txt = r.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        return txt || null;
      }
      mensajes.push({ role: 'assistant', content: r.content });
      const resultados = [];
      for (const b of r.content.filter(x => x.type === 'tool_use')) {
        try {
          const salida = H.ejecutar(b.name, b.input);
          console.log(`[asistente] ${b.name}`, JSON.stringify(b.input));
          resultados.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(salida) });
        } catch (e) {
          if (!(e instanceof H.ErrorFiltro)) console.error('[asistente] herramienta:', e);
          resultados.push({ type: 'tool_result', tool_use_id: b.id, is_error: true,
            content: e instanceof H.ErrorFiltro ? e.message : 'Error interno al consultar' });
        }
      }
      mensajes.push({ role: 'user', content: resultados });
    }
    return null;
  }

  router.post('/api/chat', exigirAdmin, async (req, res) => {
    const pregunta = String(req.body?.pregunta || '').trim().slice(0, 500);
    if (!pregunta) return res.status(400).json({ error: 'Falta la pregunta' });
    try {
      if (cliente) {
        try {
          const txt = await responderConIA(armarMensajes(req.body?.historial, pregunta));
          if (txt) return res.json({ respuesta: txt, modo: 'ia' });
        } catch (e) {
          console.error('[asistente] IA:', e.status || '', e.message);
        }
      }
      res.json({ respuesta: interpretarSinIA(pregunta, H), modo: 'reglas' });
    } catch (e) {
      console.error('[asistente]', e);
      res.status(500).json({ error: 'No se pudo consultar la asistencia' });
    }
  });

  return router;
}

module.exports = crearAsistente;
module.exports.crearHerramientas = crearHerramientas;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.DEFINICIONES = DEFINICIONES;
