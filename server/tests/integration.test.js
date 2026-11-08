// Pruebas sin Gmail ni servicio de IA: SQLite temporal y API local de escaneo.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const crypto = require('node:crypto');

process.env.TZ = 'America/Mazatlan';
process.env.QR_SECRET = 'QR_SECRET_SOLO_PARA_TESTS_123456789_ABC';
const directorio = fs.mkdtempSync(path.join(os.tmpdir(), 'lincecode-test-'));
process.env.DB_PATH = path.join(directorio, 'temporal.db');
const { db, obtenerAforo, fechaLocal } = require('../db');
const { hashNip } = require('../seguridad');
const crearRutaScan = require('../scan');
const { crearQR } = require('../qr');
const configurarCierre = require('../cierre');

let eventos = [];
const io = { emit: (tipo, dato) => eventos.push({ tipo, dato }) };
const app = express();
app.use(express.json());
app.use('/api', crearRutaScan(db, io, async () => {}));
const http = app.listen(0, '127.0.0.1');
function url() { return `http://127.0.0.1:${http.address().port}`; }
async function scan(codigo, modo = 'mixto') {
  const response = await fetch(url() + '/api/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo, kiosco_id: 'PRUEBA', modo })
  });
  return response.json();
}

const nip = hashNip('1234');
db.prepare('INSERT INTO carreras (nombre) VALUES (?)').run('Tecnologías de la Información');
const insertar = db.prepare(`INSERT INTO usuarios
(matricula,codigo_credencial,nombre,tipo,carrera_id,grupo,estatus,foto_url,nip,tutor_email,notificar_tutor)
VALUES (?,?,'Usuario de prueba','alumno',1,'31',?,NULL,?,NULL,0)`);
insertar.run('M-1', 'IMP-1', 'activo', nip);
insertar.run('M-2', 'IMP-2', 'inactivo', nip);
insertar.run('M-3', 'IMP-3', 'externo', nip);
insertar.run('M-4', 'IMP-4', 'activo', nip);
insertar.run('M-5', 'IMP-5', 'activo', nip);
const ahora = fechaLocal();
// Sembrar ingreso anterior a 60 segundos para evaluar ya_dentro.
const haceCinco = fechaLocal(new Date(Date.now() - 5 * 60 * 1000));
if (haceCinco.slice(0, 10) === ahora.slice(0, 10)) {
  db.prepare('INSERT INTO eventos(usuario_id,tipo,origen,kiosco_id,fecha_hora) VALUES (4,\'ingreso\',\'kiosco\',\'PRUEBA\',?)').run(haceCinco);
}

after(() => {
  http.close();
  db.close();
  fs.rmSync(directorio, { recursive: true, force: true });
});

test('credencial desconocida, inactiva y antirrebote', async () => {
  assert.equal((await scan('NO-EXISTE')).motivo, 'no_registrada');
  assert.equal((await scan('IMP-2')).motivo, 'inactiva');
  assert.equal((await scan('IMP-1')).resultado, 'ingreso');
  const repetido = await scan('IMP-1');
  assert.equal(repetido.resultado, 'repetido');
  assert.equal(repetido.motivo, 'repetido');
  assert.equal(obtenerAforo().total >= 1, true);
});

test('externo en ámbar y modo de entrada ocupado', async () => {
  const externo = await scan('IMP-3');
  assert.equal(externo.resultado, 'ingreso');
  assert.equal(externo.color, 'ambar');
  if (haceCinco.slice(0, 10) === ahora.slice(0, 10)) {
    assert.equal((await scan('IMP-4', 'entrada')).motivo, 'ya_dentro');
  }
});

test('QR firmado, de un solo uso y firma inválida', async () => {
  const qr = crearQR(db, 'M-5', '1234');
  assert.equal(qr.expira_en, 30);
  assert.equal((await scan(qr.qr)).resultado, 'ingreso');
  assert.equal((await scan(qr.qr)).motivo, 'codigo_vencido');
  const partes = qr.qr.split('.');
  partes[3] = 'a'.repeat(64);
  assert.equal((await scan(partes.join('.'))).motivo, 'codigo_vencido');
});

test('historial inmutable y cierre manual sin duplicados', () => {
  const id = db.prepare('SELECT id FROM eventos LIMIT 1').get().id;
  assert.throws(() => db.prepare('UPDATE eventos SET tipo = ? WHERE id = ?').run('egreso', id));
  assert.throws(() => db.prepare('DELETE FROM eventos WHERE id = ?').run(id));
  const { cerrarDia } = configurarCierre(db, io, obtenerAforo, false);
  assert.ok(cerrarDia().cerrados >= 1);
  assert.equal(cerrarDia().cerrados, 0);
  assert.equal(obtenerAforo().total, 0);
});
