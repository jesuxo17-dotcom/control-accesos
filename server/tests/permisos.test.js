// Pruebas de permisos nocturnos: aforo, cierre, escaneo y rutas /api/permisos.
// Usa su propia base SQLite temporal (no toca server/lincecode.db).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.TZ = 'America/Mazatlan';
process.env.ADMIN_KEY = 'ADMIN_KEY_SOLO_PARA_TESTS_1234567890_XYZ';
const directorio = fs.mkdtempSync(path.join(os.tmpdir(), 'lincecode-permisos-'));
process.env.DB_PATH = path.join(directorio, 'prueba.db');

const { db, obtenerAforo, usuariosDentro, fechaLocal } = require('../db');
const { hashNip } = require('../seguridad');
const crearRutaScan = require('../scan');
const crearPermisos = require('../permisos');
const crearUsuarios = require('../usuarios');
const configurarCierre = require('../cierre');

const emitidos = [];
const io = { emit: (tipo, dato) => emitidos.push({ tipo, dato }) };
const app = express();
app.use(express.json());
app.use('/api', crearRutaScan(db, io, async () => {}));
app.use('/api/usuarios', crearUsuarios(db));
app.use('/api', crearPermisos(db, usuariosDentro));
const http = app.listen(0, '127.0.0.1');
const url = ruta => `http://127.0.0.1:${http.address().port}${ruta}`;
async function pedir(metodo, ruta, cuerpo, admin = true) {
  const r = await fetch(url(ruta), {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(admin ? { 'x-admin-key': process.env.ADMIN_KEY } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  return { status: r.status, datos: await r.json() };
}

// Datos: P-1 entró AYER con permiso que sigue vigente; P-2 entró ayer SIN permiso;
// P-3 está dentro hoy sin permiso; P-4 está fuera.
db.prepare('INSERT INTO carreras (nombre) VALUES (?)').run('Sistemas');
const insertar = db.prepare(`INSERT INTO usuarios
  (matricula,codigo_credencial,nombre,tipo,carrera_id,grupo,estatus,nip,notificar_tutor)
  VALUES (?,?,?,'alumno',1,'5A','activo',?,0)`);
const nip = hashNip('1234');
for (let i = 1; i <= 4; i++) insertar.run(`P-${i}`, `PERM-${i}`, `Persona ${i}`, nip);
const hace = h => fechaLocal(new Date(Date.now() - h * 3600e3));
const dentroDe = h => fechaLocal(new Date(Date.now() + h * 3600e3));
const evento = db.prepare(`INSERT INTO eventos (usuario_id,tipo,origen,kiosco_id,fecha_hora) VALUES (?,'ingreso','kiosco','PRUEBA',?)`);
evento.run(1, hace(30));   // ayer (30 h antes), con permiso
evento.run(2, hace(30));   // ayer, sin permiso: ya no cuenta como dentro
const ahoraTxt = fechaLocal();
const haceUnRato = hace(0.05);   // 3 minutos (fuera del antirrebote de 60 s)
if (haceUnRato.slice(0, 10) === ahoraTxt.slice(0, 10)) evento.run(3, haceUnRato);
db.prepare(`INSERT INTO permisos (usuario_id,nombre,desde,hasta,autorizado_por,creado) VALUES (1,'Hackatón',?,?,'Test',?)`)
  .run(hace(31), dentroDe(5), ahoraTxt);

after(() => { http.close(); db.close(); fs.rmSync(directorio, { recursive: true, force: true }); });

test('aforo: cuenta a quien entró ayer con permiso vigente, no al que no tiene', () => {
  const a = obtenerAforo();
  const ids = usuariosDentro().map(u => u.id);
  assert.ok(ids.includes(1), 'P-1 (permiso) debe estar dentro');
  assert.ok(!ids.includes(2), 'P-2 (ayer sin permiso) no debe contar');
  assert.equal(a.con_permiso, 1);
});

test('dentro-sin-permiso excluye a quien tiene permiso', async () => {
  const { datos } = await pedir('GET', '/api/dentro-sin-permiso');
  assert.ok(!datos.some(u => u.id === 1));
  if (haceUnRato.slice(0, 10) === ahoraTxt.slice(0, 10)) assert.ok(datos.some(u => u.id === 3));
});

test('escaneo: salida de P-1 a la mañana siguiente sí se acepta y trae el permiso', async () => {
  const { datos } = await pedir('POST', '/api/scan', { codigo: 'PERM-1', kiosco_id: 'PRUEBA', modo: 'salida' });
  assert.equal(datos.resultado, 'egreso');
  assert.equal(datos.permiso.nombre, 'Hackatón');
});

test('POST /api/permisos exige clave y crea uno por persona', async () => {
  // En el futuro (pasado mañana), para que no afecte al test de cierre
  const cuerpo = { nombre: 'Feria', desde: dentroDe(48), hasta: dentroDe(60), grupo: '5A' };
  assert.equal((await pedir('POST', '/api/permisos', cuerpo, false)).status, 403);
  const r = await pedir('POST', '/api/permisos', cuerpo);
  assert.equal(r.status, 201);
  assert.equal(r.datos.creados, 4);
  const lista = (await pedir('GET', '/api/permisos')).datos;
  assert.ok(lista.some(p => p.nombre === 'Feria' && p.usuario === 'Persona 2'));
});

test('reponer credencial: código nuevo y el anterior queda no_registrada', async () => {
  const r = await pedir('POST', '/api/usuarios/4/reponer', {});
  assert.match(r.datos.codigo_credencial, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const viejo = await pedir('POST', '/api/scan', { codigo: 'PERM-4', kiosco_id: 'PRUEBA', modo: 'mixto' });
  assert.equal(viejo.datos.motivo, 'no_registrada');
});

test('alta de usuario sin NIP (el dashboard no lo pide)', async () => {
  const r = await pedir('POST', '/api/usuarios', { matricula: 'P-9', codigo_credencial: 'NUEVO-9', nombre: 'Sin NIP' });
  assert.equal(r.status, 201);
  assert.equal(r.datos.nip, undefined);
});

test('cierre: respeta el permiso vigente y cierra al resto', () => {
  const { cerrarDia } = configurarCierre(db, io, obtenerAforo, false);
  const { cerrados } = cerrarDia();
  assert.ok(cerrados >= 1);
  // P-1 salió en el test de escaneo; volvemos a meterlo y su permiso lo protege
  evento.run(1, fechaLocal());
  assert.equal(cerrarDia().cerrados, 0);
  assert.ok(usuariosDentro().some(u => u.id === 1));
});
