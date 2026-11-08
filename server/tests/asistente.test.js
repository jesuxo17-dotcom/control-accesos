// Pruebas del asistente de IA del panel (server/asistente.js).
// Usa su propia base SQLite temporal (no toca server/lincecode.db).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.TZ = 'America/Mazatlan';
process.env.ADMIN_KEY = 'ADMIN_KEY_SOLO_PARA_TESTS_1234567890_XYZ';
delete process.env.IA_API_KEY;
const directorio = fs.mkdtempSync(path.join(os.tmpdir(), 'lincecode-asistente-'));
process.env.DB_PATH = path.join(directorio, 'prueba.db');

const { db, fechaLocal } = require('../db');
const crearAsistente = require('../asistente');
const { crearHerramientas, SYSTEM_PROMPT } = crearAsistente;

// ---------- Datos de prueba: 4 carreras (3 ingenierías) ----------
const carrera = n => db.prepare('INSERT INTO carreras (nombre) VALUES (?)').run(n).lastInsertRowid;
const SIS = carrera('Ingeniería en Sistemas Computacionales');
const IND = carrera('Ingeniería Industrial');
const MEC = carrera('Ingeniería Mecatrónica');
const DER = carrera('Licenciatura en Derecho');

const alta = db.prepare(`INSERT INTO usuarios
  (matricula,codigo_credencial,nombre,tipo,carrera_id,grupo,estatus,nip,semestre,equipo)
  VALUES (?,?,?,?,?,?,'activo','x',?,?)`);
const u = (n, tipo, c, sem, equipo) => alta.run(`M-${n}`, `LC26-000${n}`, `Persona ${n}`, tipo, c, 'G31', sem, equipo).lastInsertRowid;
const p1 = u(1, 'alumno', SIS, 3, 'Brigaditos');   // adentro
const p2 = u(2, 'alumno', SIS, 5, 'Linces');       // adentro
const p3 = u(3, 'alumno', SIS, 3, 'Brigaditos');   // ENTRÓ y SALIÓ: no cuenta
const p4 = u(4, 'alumno', IND, 3, 'Brigaditos');   // adentro
u(5, 'alumno', DER, 1, null);                      // nunca entró
const p6 = u(6, 'docente', SIS, null, null);       // adentro (docente)
u(7, 'alumno', MEC, 3, null);                      // nunca entró

const hoy = fechaLocal().slice(0, 10);
const ev = db.prepare(`INSERT INTO eventos (usuario_id,tipo,origen,kiosco_id,fecha_hora) VALUES (?,?,'kiosco','PRUEBA',?)`);
for (const id of [p1, p2, p3, p4, p6]) ev.run(id, 'ingreso', `${hoy} 00:00:01`);
ev.run(p3, 'egreso', `${hoy} 00:00:02`);

const H = crearHerramientas(db);

// ---------- Servidor de prueba: modo SIN IA (reglas) ----------
function servidor(opciones) {
  const app = express();
  app.use(express.json());
  app.use(crearAsistente(db, opciones));
  const http = app.listen(0, '127.0.0.1');
  return { http, url: () => `http://127.0.0.1:${http.address().port}/api/chat` };
}
const sinIA = servidor({ cliente: null });
async function chat(pregunta, { clave = process.env.ADMIN_KEY, srv = sinIA, historial } = {}) {
  if (!srv.http.listening) await require('node:events').once(srv.http, 'listening');
  const r = await fetch(srv.url(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(clave ? { 'x-admin-key': clave } : {}) },
    body: JSON.stringify({ pregunta, historial })
  });
  return { status: r.status, datos: await r.json() };
}

const servidores = [sinIA];
after(() => { servidores.forEach(s => s.http.close()); db.close(); fs.rmSync(directorio, { recursive: true, force: true }); });

// ===================== Herramientas =====================
test('listar_carreras devuelve nombres exactos y participantes', () => {
  const r = H.ejecutar('listar_carreras');
  assert.match(r.actualizado_a, /^\d\d:\d\d$/);
  assert.deepEqual(r.carreras.find(c => c.carrera === 'Ingeniería en Sistemas Computacionales'),
    { carrera: 'Ingeniería en Sistemas Computacionales', participantes: 4 });
});

test('contar_adentro: Sistemas = 3 (quien entró y salió no cuenta)', () => {
  const r = H.ejecutar('contar_adentro', { filtros: { carrera: 'Ingeniería en Sistemas Computacionales' } });
  assert.equal(r.total, 3);
  assert.match(r.actualizado_a, /^\d\d:\d\d$/);
  assert.equal(H.ejecutar('contar_adentro', {}).total, 4);
  assert.equal(H.ejecutar('contar_adentro', { filtros: { carrera: 'Ingeniería en Sistemas Computacionales', rol: 'alumno' } }).total, 2);
});

test('el filtro de carrera exige el nombre exacto (no LIKE con lo que escribió el admin)', () => {
  assert.throws(() => H.ejecutar('contar_adentro', { filtros: { carrera: 'sistemas' } }),
    e => e instanceof H.ErrorFiltro && /listar_carreras/.test(e.message) && /Ingeniería Industrial/.test(e.message));
});

test('filtros de semestre, equipo (sin importar mayúsculas) y rol', () => {
  assert.equal(H.ejecutar('contar_adentro', { filtros: { semestre: 3 } }).total, 2);       // p1 y p4 (p3 salió)
  assert.equal(H.ejecutar('contar_adentro', { filtros: { equipo: 'brigaditos' } }).total, 2);
  assert.equal(H.ejecutar('contar_adentro', { filtros: { rol: 'docente' } }).total, 1);
  assert.throws(() => H.ejecutar('contar_adentro', { filtros: { equipo: 'Fantasmas' } }), /No existe el equipo/);
  assert.equal(H.ejecutar('contar_adentro', { filtros: { carrera: 'Ingeniería Mecatrónica' } }).total, 0);
});

test('desglose_adentro por carrera y listar_adentro', () => {
  const d = H.ejecutar('desglose_adentro', { agrupar_por: 'carrera' });
  assert.equal(d.total, 4);
  assert.deepEqual(d.grupos, [
    { carrera: 'Ingeniería en Sistemas Computacionales', adentro: 3 },
    { carrera: 'Ingeniería Industrial', adentro: 1 }]);
  const l = H.ejecutar('listar_adentro', { filtros: { equipo: 'Brigaditos' } });
  assert.deepEqual(l.personas.map(p => p.nombre), ['Persona 1', 'Persona 4']);
  assert.deepEqual(Object.keys(l.personas[0]).sort(), ['carrera', 'equipo', 'folio', 'hora_entrada', 'nombre', 'semestre']);
  assert.throws(() => H.ejecutar('desglose_adentro', { agrupar_por: 'matricula' }), /agrupar_por/);
  assert.throws(() => H.ejecutar('borrar_usuario', {}), /no permitida/);
});

// ===================== Los 6 casos pedidos (modo sin IA) =====================
test('1) "¿cuántos de sistemas están adentro?" -> 3 con el nombre exacto', async () => {
  const { status, datos } = await chat('¿cuántos de sistemas están adentro?');
  assert.equal(status, 200);
  assert.match(datos.respuesta, /^Hay 3 personas de Ingeniería en Sistemas Computacionales adentro \(corte \d\d:\d\d\)\.$/);
  assert.match((await chat('¿Cuántos del equipo Brigaditos siguen aquí?')).datos.respuesta, /^Hay 2 personas del equipo Brigaditos/);
  assert.match((await chat('¿Cuántos de Mecatrónica de 3er semestre hay ahorita?')).datos.respuesta,
    /No hay personas de Ingeniería Mecatrónica de 3\.º semestre adentro.*0/);
});

test('2) quien tiene ENTRADA y luego SALIDA no cuenta como adentro', async () => {
  const { datos } = await chat('¿Quiénes de sistemas están adentro?');
  assert.match(datos.respuesta, /Hay 3 personas/);
  assert.doesNotMatch(datos.respuesta, /Persona 3/);
});

test('3) término ambiguo ("ingeniería") -> pregunta cuál carrera', async () => {
  const { datos } = await chat('¿Cuántos de ingeniería están adentro?');
  assert.match(datos.respuesta, /varias carreras/);
  for (const c of ['Ingeniería en Sistemas Computacionales', 'Ingeniería Industrial', 'Ingeniería Mecatrónica']) assert.ok(datos.respuesta.includes(c));
  assert.doesNotMatch(datos.respuesta, /\bHay \d/);
});

test('4) carrera que no existe -> lo dice y muestra las disponibles', async () => {
  const { datos } = await chat('¿Cuántos de medicina están adentro?');
  assert.match(datos.respuesta, /No hay ninguna carrera "medicina"/);
  assert.ok(datos.respuesta.includes('Licenciatura en Derecho'));
});

test('5) "Borra a X" -> se niega', async () => {
  const { datos } = await chat('Borra a Persona 1');
  assert.match(datos.respuesta, /Solo puedo consultar.*desde el panel/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM usuarios').get().n, 7);
});

test('6) sin clave de admin (o con una incorrecta) el endpoint responde 403', async () => {
  assert.equal((await chat('¿cuántos hay?', { clave: null })).status, 403);
  assert.equal((await chat('¿cuántos hay?', { clave: 'clave-equivocada' })).status, 403);
});

// ===================== Bucle con el modelo (cliente simulado) =====================
test('con IA: el modelo solo llama herramientas y recibe los números de ellas', async () => {
  const llamadas = [];
  const guion = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'listar_carreras', input: {} }] },
    // Primero intenta con el texto del admin: la herramienta lo rechaza con las opciones
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'contar_adentro', input: { filtros: { carrera: 'sistemas' } } }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't3', name: 'contar_adentro', input: { filtros: { carrera: 'Ingeniería en Sistemas Computacionales' } } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hay 3 personas de Ingeniería en Sistemas Computacionales adentro.' }] }
  ];
  const cliente = { beta: { messages: { create: async req => { llamadas.push(structuredClone(req)); return guion[llamadas.length - 1]; } } } };
  const srv = servidor({ cliente });
  servidores.push(srv);

  const { datos } = await chat('¿cuántos de sistemas están adentro?', { srv, historial: [{ rol: 'admin', texto: 'hola' }, { rol: 'asistente', texto: '¿En qué te ayudo?' }] });
  assert.equal(datos.modo, 'ia');
  assert.equal(llamadas.length, 4);
  assert.equal(llamadas[0].system[0].text, SYSTEM_PROMPT);   // el prompt acordado va tal cual
  assert.deepEqual(llamadas[0].tools.map(t => t.name), ['listar_carreras', 'contar_adentro', 'desglose_adentro', 'listar_adentro']);
  assert.deepEqual(llamadas[0].messages.map(m => m.role), ['user', 'assistant', 'user']);
  const resultado = id => llamadas.at(-1).messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(b => b.tool_use_id === id);
  assert.equal(resultado('t2').is_error, true);
  assert.match(resultado('t2').content, /nombre exacto/);
  assert.equal(JSON.parse(resultado('t3').content).total, 3);
});

test('con IA: si el modelo falla, responde el modo por reglas (nunca se queda sin respuesta)', async () => {
  const cliente = { beta: { messages: { create: async () => { throw Object.assign(new Error('sin red'), { status: 503 }); } } } };
  const srv = servidor({ cliente });
  servidores.push(srv);
  const { datos } = await chat('Dame cuántos hay adentro por carrera', { srv });
  assert.equal(datos.modo, 'reglas');
  assert.match(datos.respuesta, /Hay 4 adentro: Ingeniería en Sistemas Computacionales 3, Ingeniería Industrial 1/);
});

test('pregunta fuera de tema -> lo dice y explica qué sí puede consultar', async () => {
  const { datos } = await chat('¿Qué clima hace mañana?');
  assert.match(datos.respuesta, /Solo puedo responder sobre la asistencia/);
});

test('charla básica: saludos, fecha y hora (sin tocar la base)', async () => {
  assert.match((await chat('hola')).datos.respuesta, /^Buen(os|as) (días|tardes|noches), ¿en qué te ayudo\?/);
  assert.match((await chat('¿Qué día es hoy?')).datos.respuesta, /^Hoy es \p{L}+, \d{1,2} de \w+ de \d{4}\.$/u);
  assert.match((await chat('¿qué hora es?')).datos.respuesta, /^Son las /);
  assert.match((await chat('gracias')).datos.respuesta, /De nada/);
  // Saludo + pregunta: responde la pregunta
  assert.match((await chat('hola, ¿cuántos de sistemas están adentro?')).datos.respuesta, /^Hay 3 personas/);
});
