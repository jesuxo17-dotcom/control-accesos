// LinceTutores + kiosco: un escaneo real encola el correo SOLO para tutores con vínculo
// aprobado, correo verificado y avisos activados. Sin Gmail configurado nada se envía.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.TZ = 'America/Mazatlan';
process.env.ANTIRREBOTE_SEGUNDOS = '0';
delete process.env.GMAIL_USER; delete process.env.GMAIL_APP_PASSWORD;
const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'lince-tutores-scan-'));
process.env.DB_PATH = path.join(carpeta, 'prueba.db');

const { db, fechaLocal } = require('../db');
const crearRutaScan = require('../scan');
const crearRutasTutores = require('../tutores');
const crearGestorAvisos = require('../tutor_avisos');
const { hashNip } = require('../seguridad');

crearRutasTutores(db);                       // crea las tablas tutores_*
const avisos = crearGestorAvisos(db);
const app = express();
app.use(express.json());
app.use('/api', crearRutaScan(db, { emit() {} }, async () => {}, null, { avisos }));
const http = app.listen(0, '127.0.0.1');
after(() => { http.close(); db.close(); fs.rmSync(carpeta, { recursive: true, force: true }); });

async function scan(codigo) {
  if (!http.listening) await require('node:events').once(http, 'listening');
  const r = await fetch(`http://127.0.0.1:${http.address().port}/api/scan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo, kiosco_id: 'PRUEBA', modo: 'mixto' })
  });
  return r.json();
}

// Dos alumnos; dos tutores: uno con todo en regla, otro con el vínculo aún pendiente
const alta = db.prepare(`INSERT INTO usuarios (matricula,codigo_credencial,nombre,tipo,estatus,nip,notificar_tutor)
  VALUES (?,?,?,'alumno','activo',?,0)`);
const nip = hashNip('1234');
const hijo = alta.run('L2026A', 'LC26-1111', 'Ana Prueba Uno', nip).lastInsertRowid;
const otro = alta.run('L2026B', 'LC26-2222', 'Beto Prueba Dos', nip).lastInsertRowid;
const cuenta = db.prepare(`INSERT INTO tutores_cuentas (nombre,telefono,clave_hash,creada_en,email,email_verificado,avisos_permitidos,avisos_email)
  VALUES (?,?,'x',?,?,?,1,1)`);
const ahora = fechaLocal();
const t1 = cuenta.run('Tutora En Regla', '526690000001', ahora, 'tutora@escuela.mx', 1).lastInsertRowid;
const t2 = cuenta.run('Tutor Pendiente', '526690000002', ahora, 'tutor@escuela.mx', 1).lastInsertRowid;
const vinculo = db.prepare(`INSERT INTO tutores_hijos (tutor_id,alumno_nombre,matricula,usuario_id,estado,creada_en,actualizada_en)
  VALUES (?,?,?,?,?,?,?)`);
vinculo.run(t1, 'Ana Prueba Uno', 'L2026A', hijo, 'aprobada', ahora, ahora);
vinculo.run(t2, 'Beto Prueba Dos', 'L2026B', otro, 'pendiente', ahora, ahora);

const enCola = () => db.prepare('SELECT tutor_id, destinatario, estado FROM tutores_envios').all();
const esperar = () => new Promise(r => setTimeout(r, 50));

test('la entrada de un hijo con vínculo aprobado encola el correo a su tutora', async () => {
  const r = await scan('LC26-1111');
  assert.equal(r.resultado, 'ingreso');
  await esperar();
  assert.deepEqual(enCola(), [{ tutor_id: Number(t1), destinatario: 'tutora@escuela.mx', estado: 'pendiente' }]);
});

test('un vínculo pendiente no recibe avisos', async () => {
  const r = await scan('LC26-2222');
  assert.equal(r.resultado, 'ingreso');
  await esperar();
  assert.equal(enCola().filter(x => x.tutor_id === Number(t2)).length, 0);
});

test('un rechazo (credencial inexistente) no encola nada', async () => {
  const antes = enCola().length;
  await scan('LC26-9999');
  await esperar();
  assert.equal(enCola().length, antes);
});
