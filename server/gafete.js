// Lectura de gafetes del Hackatón LinceCode 2026.
//
// Paso 1 (en el kiosco): código de barras Code 128 con el folio "LC26-####".
//         Es la clave principal: se busca en usuarios.codigo_credencial.
// Paso 2 (aquí, si el código no se leyó en ~3 s): foto -> modelo de visión
//         -> JSON -> búsqueda por folio, luego matrícula, luego nombre.
//         0 o varias coincidencias = confirmación manual (nunca se elige).
//
// No cambia el esquema: lo que no cabe en usuarios (folio_secundario,
// "para revisión") viaja en la respuesta, en la alerta al guardia y en
// la tabla intentos (codigo_leido + motivo).

// Folio principal del gafete. Un LC25-#### (folio secundario) NUNCA es esto.
const FOLIO = /^LC26-\d{4}$/;
const FOLIO_CUALQUIERA = /^LC\d{2}-\d{4}$/;

// Prompt para el modelo de visión: TAL CUAL lo definió el equipo.
const PROMPT_VISION = `Analiza la foto de un gafete del Hackatón LinceCode 2026 (UAdeO). Lee SOLO el gafete: ignora el teclado, las etiquetas, los otros códigos y los reflejos de la funda de plástico.
Responde SOLO con un JSON válido, sin texto extra:
- es_gafete_lincecode (boolean)
- folio (string o null): el texto rojo debajo del código de barras, formato LC26-####
- nombre_impreso (string o null): el nombre tal como aparece, con sus mayúsculas y acentos. Si ocupa 2 líneas, únelas con un espacio. No reordenes ni corrijas.
- rol (string o null): el texto de la etiqueta roja
- equipo (string o null): sin el prefijo "Equipo:"
- semestre (number o null): "3er Semestre" -> 3
- grupo (string o null): "Gpo 02" -> "02"
- matricula (string o null): solo si después de "Mat." viene un número; solo dígitos
- folio_secundario (string o null): si después de "Mat." viene un folio (ej. "Folio LC25-8860"), ponlo aquí y deja matricula en null
- campos_dudosos (array de strings): los campos que leíste con poca seguridad

Reglas: si algo no se lee con claridad, ponlo en null y agrégalo a campos_dudosos. Nunca inventes ni completes datos. Si no es un gafete de LinceCode 2026, responde es_gafete_lincecode: false y pon el resto en null.`;

/** "lc26 4317", "LC26'4317" (lector USB con teclado en español) -> "LC26-4317"; si no, null */
function normalizarFolio(texto) {
  const t = String(texto ?? '').trim().toUpperCase();
  if (FOLIO.test(t)) return t;
  const m = /^LC26[^0-9A-Z]?(\d{4})$/.exec(t);
  return m ? `LC26-${m[1]}` : null;
}

/** Nombre para comparar: sin acentos, minúsculas, palabras ordenadas (el orden impreso varía) */
function claveNombre(nombre) {
  return String(nombre ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}

const texto = v => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null);

/**
 * Limpia y valida el JSON del modelo. Nunca inventa: lo que no cuadra queda
 * en null y se agrega a campos_dudosos.
 */
function normalizarLectura(crudo) {
  const r = crudo && typeof crudo === 'object' ? crudo : {};
  const dudosos = new Set(Array.isArray(r.campos_dudosos) ? r.campos_dudosos.filter(x => typeof x === 'string') : []);
  const lectura = {
    es_gafete_lincecode: r.es_gafete_lincecode === true,
    folio: null, nombre_impreso: texto(r.nombre_impreso), rol: texto(r.rol),
    equipo: texto(r.equipo)?.replace(/^equipo\s*:\s*/i, '') || null,
    semestre: null, grupo: null, matricula: null, folio_secundario: null,
    campos_dudosos: []
  };

  // Folio principal: solo LC26-####. Si el modelo puso ahí un LC25-#### es el secundario.
  const folio = texto(r.folio)?.toUpperCase() || null;
  if (folio && FOLIO.test(folio)) lectura.folio = folio;
  else if (folio) {
    if (FOLIO_CUALQUIERA.test(folio) && !r.folio_secundario) lectura.folio_secundario = folio;
    dudosos.add('folio');
  }

  // Folio secundario ("Mat. Folio LC25-8860"): nunca puede ser el principal LC26.
  const sec = texto(r.folio_secundario)?.toUpperCase().replace(/^FOLIO\s*/, '') || null;
  if (sec) {
    if (FOLIO_CUALQUIERA.test(sec) && !FOLIO.test(sec)) lectura.folio_secundario = sec;
    else dudosos.add('folio_secundario');
  }

  // Matrícula: solo dígitos (8 en los gafetes). Si trae un folio, es secundario.
  const mat = texto(typeof r.matricula === 'number' ? String(r.matricula) : r.matricula);
  if (mat) {
    const sinFolio = mat.toUpperCase().replace(/^FOLIO\s*/, '');
    if (/^\d{8}$/.test(mat)) lectura.matricula = mat;
    else if (FOLIO_CUALQUIERA.test(sinFolio) && !FOLIO.test(sinFolio)) {
      lectura.folio_secundario = lectura.folio_secundario || sinFolio;
    } else dudosos.add('matricula');
  }

  // Semestre: solo el número ("3er" -> 3, "2do" -> 2)
  const sem = typeof r.semestre === 'number' ? r.semestre : parseInt(String(r.semestre ?? '').replace(/\D+/g, ''), 10);
  if (Number.isInteger(sem) && sem >= 1 && sem <= 12) lectura.semestre = sem;
  else if (r.semestre != null) dudosos.add('semestre');

  // Grupo: "Gpo 02" -> "02"
  const gpo = texto(r.grupo == null ? null : String(r.grupo))?.replace(/^gpo\.?\s*/i, '') || null;
  lectura.grupo = gpo;

  lectura.campos_dudosos = [...dudosos];
  // Sin matrícula pero con folio secundario -> el gafete se marca para revisión
  lectura.revision = !lectura.matricula && Boolean(lectura.folio_secundario);
  return lectura;
}

/** Saca el primer objeto JSON del texto del modelo (por si agrega algo alrededor) */
function extraerJSON(textoModelo) {
  const s = String(textoModelo || '');
  const ini = s.indexOf('{'), fin = s.lastIndexOf('}');
  if (ini < 0 || fin <= ini) throw new Error('El modelo no devolvió JSON');
  return JSON.parse(s.slice(ini, fin + 1));
}

/**
 * Busca a la persona en la base, en este orden:
 *   1. folio (si se leyó con seguridad)  2. matrícula  3. nombre normalizado
 * Devuelve {usuario, por} con UNA coincidencia, o {usuario:null, candidatos, por}
 * para confirmación manual (0 o varias).
 */
function buscarPorLectura(db, lectura) {
  const dudoso = c => lectura.campos_dudosos.includes(c);
  if (lectura.folio && !dudoso('folio')) {
    const u = db.prepare('SELECT id FROM usuarios WHERE codigo_credencial = ?').get(lectura.folio);
    if (u) return { usuario: u.id, por: 'folio', candidatos: [] };
  }
  if (lectura.matricula && !dudoso('matricula')) {
    const u = db.prepare('SELECT id FROM usuarios WHERE matricula = ?').get(lectura.matricula);
    if (u) return { usuario: u.id, por: 'matricula', candidatos: [] };
  }
  if (lectura.nombre_impreso && !dudoso('nombre_impreso')) {
    const clave = claveNombre(lectura.nombre_impreso);
    const iguales = db.prepare('SELECT id, nombre FROM usuarios').all().filter(u => claveNombre(u.nombre) === clave);
    if (iguales.length === 1) return { usuario: iguales[0].id, por: 'nombre', candidatos: [] };
    return { usuario: null, por: 'nombre', candidatos: iguales.map(u => u.id) };
  }
  return { usuario: null, por: null, candidatos: [] };
}

/**
 * Manda la foto al modelo de visión y devuelve la lectura ya normalizada.
 * cliente = instancia de Anthropic (la crea server.js con IA_API_KEY).
 */
async function leerGafeteConVision(cliente, fotoBase64, mediaType = 'image/jpeg') {
  const r = await cliente.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    output_config: { effort: 'low' },               // lectura rápida en el kiosco
    betas: ['server-side-fallback-2026-07-01'],     // si el modelo rechaza, el servidor reintenta con otro
    fallbacks: 'default',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: fotoBase64 } },
        { type: 'text', text: PROMPT_VISION }
      ]
    }]
  });
  if (r.stop_reason === 'refusal') throw new Error('El modelo no procesó la imagen');
  const textoModelo = r.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return normalizarLectura(extraerJSON(textoModelo));
}

module.exports = {
  FOLIO, PROMPT_VISION, normalizarFolio, claveNombre, normalizarLectura,
  extraerJSON, buscarPorLectura, leerGafeteConVision
};
