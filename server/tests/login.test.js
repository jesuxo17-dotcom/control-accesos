// Pruebas del inicio de sesión del panel (server/seguridad.js).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.ADMIN_KEY = 'ADMIN_KEY_SOLO_PARA_TESTS_1234567890_XYZ';
process.env.CLAVE_SEGURIDAD = 'lince seguridad 2026';
const { login, logout, exigirAdmin } = require('../seguridad');

const app = express();
app.use(express.json());
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/privado', exigirAdmin, (_req, res) => res.json({ ok: true }));
const http = app.listen(0, '127.0.0.1');
after(() => http.close());
const url = r => `http://127.0.0.1:${http.address().port}${r}`;
const pedir = async (metodo, ruta, cuerpo, headers = {}) => {
  if (!http.listening) await require('node:events').once(http, 'listening');
  const r = await fetch(url(ruta), { method: metodo, headers: { 'Content-Type': 'application/json', ...headers }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  return { status: r.status, datos: await r.json() };
};

test('sin sesión no se ve la información', async () => {
  assert.equal((await pedir('GET', '/api/privado')).status, 403);
  assert.equal((await pedir('GET', '/api/privado', null, { Authorization: 'Bearer inventado' })).status, 403);
});

test('con la clave de seguridad se obtiene una sesión que abre la API; al salir se cierra', async () => {
  const r = await pedir('POST', '/api/login', { clave: 'lince seguridad 2026' });
  assert.equal(r.status, 200);
  assert.match(r.datos.token, /^[0-9a-f]{64}$/);
  const auth = { Authorization: 'Bearer ' + r.datos.token };
  assert.equal((await pedir('GET', '/api/privado', null, auth)).status, 200);
  await pedir('POST', '/api/logout', null, auth);
  assert.equal((await pedir('GET', '/api/privado', null, auth)).status, 403);
});

test('la cabecera x-admin-key sigue sirviendo', async () => {
  assert.equal((await pedir('GET', '/api/privado', null, { 'x-admin-key': process.env.ADMIN_KEY })).status, 200);
});

test('5 claves equivocadas bloquean el login un minuto (aunque después llegue la buena)', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await pedir('POST', '/api/login', { clave: 'mala' + i })).status, 401);
  assert.equal((await pedir('POST', '/api/login', { clave: 'lince seguridad 2026' })).status, 429);
});
