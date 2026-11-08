// Lectura de gafetes LinceCode 2026: folio por código de barras y respaldo por foto.
// El modelo de visión se simula (no se gasta API); se prueban normalización y búsqueda.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.TZ = 'America/Mazatlan';
const directorio = fs.mkdtempSync(path.join(os.tmpdir(), 'lincecode-gafete-'));
process.env.DB_PATH = path.join(directorio, 'prueba.db');

const { db } = require('../db');
const { hashNip } = require('../seguridad');
const crearRutaScan = require('../scan');
const { normalizarFolio, claveNombre, normalizarLectura, extraerJSON, buscarPorLectura } = require('../gafete');

// Los 3 gafetes de prueba (casos del equipo). En la base el folio es codigo_credencial.
db.prepare('INSERT INTO carreras (nombre) VALUES (?)').run('Ingeniería de Software');
const alta = db.prepare(`INSERT INTO usuarios (matricula,codigo_credencial,nombre,tipo,carrera_id,grupo,estatus,nip,notificar_tutor)
  VALUES (?,?,?,'alumno',1,'02','activo',?,0)`);
const nip = hashNip('1234');
alta.run('25050821', 'LC26-4317', 'Jesus Adrian Aguirre Velazquez', nip);
alta.run('25050791', 'LC26-6276', 'Kevin José Ramírez Quiroz', nip);
alta.run('P-7144', 'LC26-7144', 'Antoine Sánchez Hernández', nip);   // sin matrícula real en el gafete
// Dos homónimos para probar que nunca se elige uno
alta.run('30000001', 'LC26-9001', 'Ana López', nip);
alta.run('30000002', 'LC26-9002', 'López Ana', nip);

// El modelo de visión simulado devuelve lo que pongamos en "siguiente"
let siguiente = null;
const visionFalsa = async () => normalizarLectura(siguiente);
const emitidos = [];
const io = { emit: (tipo, dato) => emitidos.push({ tipo, dato }) };

function app(vision) {
  const a = express();
  a.use(express.json({ limit: '6mb' }));
  a.use('/api', crearRutaScan(db, io, async () => {}, vision));
  return a.listen(0, '127.0.0.1');
}
const conVision = app(visionFalsa);
const sinVision = app(null);
const url = (srv, r) => `http://127.0.0.1:${srv.address().port}${r}`;
async function post(srv, ruta, cuerpo) {
  const r = await fetch(url(srv, ruta), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
  return { status: r.status, datos: await r.json() };
}
const foto = 'data:image/jpeg;base64,' + Buffer.from('foto de prueba').toString('base64');

after(() => { conVision.close(); sinVision.close(); db.close(); fs.rmSync(directorio, { recursive: true, force: true }); });

// ---------------- Paso 1: código de barras ----------------
test('folio: solo LC26-#### (y arregla el guion del lector USB en teclado español)', () => {
  assert.equal(normalizarFolio('LC26-4317'), 'LC26-4317');
  assert.equal(normalizarFolio("lc26'4317"), 'LC26-4317');
  assert.equal(normalizarFolio('LC264317'), 'LC26-4317');
  assert.equal(normalizarFolio('LC25-8860'), null);       // folio secundario: nunca es el principal
  assert.equal(normalizarFolio('7501234567890'), null);   // EAN falso
  assert.equal(normalizarFolio('LC26-43170'), null);
});

test('por código de barras los 3 gafetes dan su folio sin pasar por visión', async () => {
  for (const [folio, nombre] of [['LC26-4317', 'Jesus Adrian Aguirre Velazquez'],
    ['LC26-6276', 'Kevin José Ramírez Quiroz'], ['LC26-7144', 'Antoine Sánchez Hernández']]) {
    const { datos } = await post(sinVision, '/api/scan', { codigo: folio, kiosco_id: 'T', modo: 'entrada' });
    assert.equal(datos.resultado, 'ingreso', folio);
    assert.equal(datos.usuario.nombre, nombre);
  }
});

// ---------------- Paso 2: lectura por foto ----------------
const caso1 = { es_gafete_lincecode: true, folio: 'LC26-4317', nombre_impreso: 'Jesus Adrian Aguirre\nVelazquez',
  rol: 'INTEGRANTE', equipo: 'Equipo: Brigaditos', semestre: '3er', grupo: 'Gpo 02', matricula: '25050821',
  folio_secundario: null, campos_dudosos: [] };
const caso2 = { es_gafete_lincecode: true, folio: 'LC26-6276', nombre_impreso: 'Kevin jose Ramirez Quiroz',
  rol: 'INTEGRANTE', equipo: 'Brigaditos', semestre: 3, grupo: '02', matricula: '25050791',
  folio_secundario: null, campos_dudosos: [] };
const caso3 = { es_gafete_lincecode: true, folio: 'LC26-7144', nombre_impreso: 'Sánchez Hernandez Antoine',
  rol: 'INTEGRANTE', equipo: 'Brigaditos', semestre: 3, grupo: '02', matricula: null,
  folio_secundario: 'LC25-8860', campos_dudosos: [] };

test('normaliza la lectura: 2 líneas, prefijo "Equipo:", semestre y grupo', () => {
  const l = normalizarLectura(caso1);
  assert.equal(l.nombre_impreso, 'Jesus Adrian Aguirre Velazquez');
  assert.equal(l.equipo, 'Brigaditos');
  assert.equal(l.semestre, 3);
  assert.equal(l.grupo, '02');
  assert.equal(l.matricula, '25050821');
  assert.equal(l.revision, false);
});

test('caso 3: sin matrícula, folio_secundario LC25 y marcado para revisión', () => {
  const l = normalizarLectura(caso3);
  assert.equal(l.folio, 'LC26-7144');
  assert.equal(l.matricula, null);
  assert.equal(l.folio_secundario, 'LC25-8860');
  assert.equal(l.revision, true);
  // Si el modelo lo deja en "matricula" como "Folio LC25-8860", también se mueve
  const otra = normalizarLectura({ ...caso3, folio_secundario: null, matricula: 'Folio LC25-8860' });
  assert.equal(otra.matricula, null);
  assert.equal(otra.folio_secundario, 'LC25-8860');
  // Un LC25 NUNCA se acepta como folio principal
  const confundido = normalizarLectura({ ...caso3, folio: 'LC25-8860', folio_secundario: null });
  assert.equal(confundido.folio, null);
  assert.equal(confundido.folio_secundario, 'LC25-8860');
  assert.ok(confundido.campos_dudosos.includes('folio'));
});

test('nombre: sin acentos, sin mayúsculas y sin importar el orden', () => {
  assert.equal(claveNombre('Sánchez Hernandez Antoine'), claveNombre('Antoine Sánchez Hernández'));
  assert.equal(claveNombre('Kevin jose Ramirez Quiroz'), claveNombre('Kevin José Ramírez Quiroz'));
  assert.notEqual(claveNombre('Kevin Ramirez'), claveNombre('Kevin José Ramírez Quiroz'));
});

test('búsqueda: folio -> matrícula -> nombre', () => {
  assert.deepEqual(buscarPorLectura(db, normalizarLectura(caso1)).por, 'folio');
  // folio dudoso: se usa la matrícula
  assert.equal(buscarPorLectura(db, normalizarLectura({ ...caso2, campos_dudosos: ['folio'] })).por, 'matricula');
  // caso 3 con folio dudoso y sin matrícula: por nombre en otro orden
  const r = buscarPorLectura(db, normalizarLectura({ ...caso3, campos_dudosos: ['folio'] }));
  assert.equal(r.por, 'nombre');
  assert.equal(db.prepare('SELECT codigo_credencial c FROM usuarios WHERE id = ?').get(r.usuario).c, 'LC26-7144');
});

test('POST /api/scan-foto: caso 3 se identifica y queda para revisión', async () => {
  siguiente = { ...caso3, campos_dudosos: ['folio'] };
  const { datos } = await post(conVision, '/api/scan-foto', { foto_base64: foto, kiosco_id: 'T', modo: 'salida' });
  assert.equal(datos.usuario.nombre, 'Antoine Sánchez Hernández');
  // Lo escaneó el código de barras hace un instante: por foto aplican las mismas
  // reglas, incluido el antirrebote de 60 s
  assert.equal(datos.resultado, 'repetido');
  assert.equal(datos.identificado_por, 'nombre');
  assert.equal(datos.revision, true);
  assert.equal(datos.lectura.folio_secundario, 'LC25-8860');
  assert.ok(emitidos.some(e => e.tipo === 'alerta' && e.dato.tipo === 'revision_gafete'));
  const intento = db.prepare("SELECT codigo_leido FROM intentos WHERE motivo = 'revision_gafete'").get();
  assert.match(intento.codigo_leido, /LC25-8860/);
});

test('POST /api/scan-foto: homónimos o nadie -> confirmación manual (no elige)', async () => {
  siguiente = { es_gafete_lincecode: true, folio: null, nombre_impreso: 'Ana López', matricula: null,
    folio_secundario: null, campos_dudosos: ['folio'] };
  let r = await post(conVision, '/api/scan-foto', { foto_base64: foto, kiosco_id: 'T', modo: 'entrada' });
  assert.equal(r.datos.motivo, 'confirmacion_manual');
  assert.equal(r.datos.usuario, null);
  assert.equal(r.datos.candidatos.length, 2);

  siguiente = { ...siguiente, nombre_impreso: 'Persona Que No Existe' };
  r = await post(conVision, '/api/scan-foto', { foto_base64: foto, kiosco_id: 'T', modo: 'entrada' });
  assert.equal(r.datos.motivo, 'confirmacion_manual');
  assert.equal(r.datos.candidatos.length, 0);
});

test('POST /api/scan-foto: no es gafete -> sigue escaneando; sin IA -> 503', async () => {
  siguiente = { es_gafete_lincecode: false };
  assert.equal((await post(conVision, '/api/scan-foto', { foto_base64: foto, kiosco_id: 'T', modo: 'entrada' })).datos.resultado, 'sin_gafete');
  assert.equal((await post(sinVision, '/api/scan-foto', { foto_base64: foto, kiosco_id: 'T', modo: 'entrada' })).status, 503);
});

test('extrae el JSON aunque el modelo agregue texto alrededor', () => {
  assert.deepEqual(extraerJSON('Aquí está:\n{"folio":"LC26-4317"}\n'), { folio: 'LC26-4317' });
  assert.throws(() => extraerJSON('sin json'));
});
