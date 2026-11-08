// Pruebas de app de tutores. Ejecución independiente con base SQLite temporal.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'lince-tutores-test-'));
const Database = require('better-sqlite3');
const db = new Database(path.join(carpeta, 'demo.db'));
db.pragma('foreign_keys=ON');
db.exec(fs.readFileSync(path.join(__dirname,'../schema.sql'),'utf8'));
process.env.ADMIN_KEY = 'ADMIN_TEST_123456789_ABC_DEMO';
const rutas = require('../tutores');
const app = express();
app.use(express.json());
app.use('/api/tutores', rutas(db));
const server = app.listen(0, '127.0.0.1');
const url = () => 'http://127.0.0.1:' + server.address().port;
let cookie='';
async function req(verb,path,body,admin=false) {
  const r = await fetch(url()+'/api/tutores'+path,{method:verb,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(admin?{'x-admin-key':process.env.ADMIN_KEY}:{})},body:body?JSON.stringify(body):undefined});
  const c=r.headers.get('set-cookie'); if(c) cookie=c.split(';')[0];
  return {status:r.status,body:await r.json()};
}
after(async () => {await new Promise(resolve=>server.close(resolve)); db.close(); fs.rmSync(carpeta,{recursive:true,force:true});});

test('una cuenta guarda varios hijos y solicita autorización del plantel', async()=>{
  const register=await req('POST','/registro',{nombre:'Persona Tutora Ejemplo',telefono:'6691112233',password:'clave-larga-de-prueba'});
  assert.equal(register.status,201);
  assert.equal((await req('GET','/cuenta')).status,200);
  const a=await req('POST','/hijos',{nombre:'Hijo Prueba Uno',matricula:'L20260001'});
  const b=await req('POST','/hijos',{nombre:'Hija Prueba Dos',matricula:'L20260002'});
  assert.equal(a.status,202);assert.equal(b.status,202);
  const lista=await req('GET','/hijos');
  assert.equal(lista.body.hijos.length,2);
  assert(lista.body.hijos.every(h=>h.estado==='pendiente'&&!h.ultimo_movimiento));
  assert.equal((await req('GET',`/hijos/${a.body.id}/movimientos`)).status,403);
  assert.equal((await req('POST',`/hijos/${a.body.id}/aprobar`,{identidad_y_parentesco_verificados:true})).status,403);
  const save=await req('PUT',`/hijos/${a.body.id}/emergencia`,{nombre:'Contacto Emergencia Ejemplo',parentesco:'Madre',telefono:'6693334455'});
  assert.equal(save.status,200);
  assert.equal((await req('GET','/hijos')).body.hijos.find(h=>h.id===a.body.id).emergencia_nombre,'Contacto Emergencia Ejemplo');
});

test('no hay historial antes de aprobación; la aprobación requiere identidad verificada',async()=>{
  db.prepare('INSERT INTO carreras(nombre) VALUES (?)').run('TI');
  db.prepare(`INSERT INTO usuarios(matricula,codigo_credencial,nombre,tipo,carrera_id,grupo,estatus,nip) VALUES ('L20260001','LINCE-01','Hijo Prueba Uno','alumno',1,'31','activo','TEST_NIP')`).run();
  db.prepare(`INSERT INTO eventos(usuario_id,tipo,origen,kiosco_id,fecha_hora) VALUES(1,'ingreso','kiosco','K01','2026-11-07 08:00:00')`).run();
  const id = db.prepare("SELECT id FROM tutores_hijos WHERE matricula='L20260001'").get().id;
  assert.equal((await req('POST',`/hijos/${id}/aprobar`,{identidad_y_parentesco_verificados:false},true)).status,400);
  assert.equal((await req('POST',`/hijos/${id}/aprobar`,{identidad_y_parentesco_verificados:true},true)).body.estado,'aprobada');
  assert.equal((await req('GET',`/hijos/${id}/movimientos`)).body.movimientos.length,1);
});

// ---------- Nombre O matrícula (con aprobación del plantel) ----------
const pendienteDe = id => req('GET', '/pendientes', null, true).then(r => r.body.find(p => p.id === id));

test('con solo la matrícula: el panel ve al alumno del padrón y al aprobar se guardan sus datos', async () => {
  db.prepare(`INSERT INTO usuarios(matricula,codigo_credencial,nombre,tipo,carrera_id,grupo,estatus,nip) VALUES ('25050791','LC26-6276','Kevin jose Ramirez Quiroz','alumno',1,'02','activo','TEST_NIP')`).run();
  const r = await req('POST', '/hijos', { nombre: '', matricula: '25050791' });
  assert.equal(r.status, 202);
  // al tutor no se le revela el nombre del padrón
  assert.equal((await req('GET', '/hijos')).body.hijos.find(h => h.id === r.body.id).nombre, '');
  const p = await pendienteDe(r.body.id);
  assert.equal(p.coincidencia.estado, 'ok');
  assert.equal(p.coincidencia.alumno.gafete, 'LC26-6276');
  assert.equal((await req('POST', `/hijos/${r.body.id}/aprobar`, { identidad_y_parentesco_verificados: true }, true)).body.estado, 'aprobada');
  const h = db.prepare('SELECT alumno_nombre, matricula, usuario_id FROM tutores_hijos WHERE id=?').get(r.body.id);
  assert.deepEqual(h, { alumno_nombre: 'Kevin jose Ramirez Quiroz', matricula: '25050791', usuario_id: db.prepare("SELECT id FROM usuarios WHERE matricula='25050791'").get().id });
});

test('con solo el nombre (sin acentos ni mayúsculas exactas, en otro orden) encuentra al alumno', async () => {
  db.prepare(`INSERT INTO usuarios(matricula,codigo_credencial,nombre,tipo,carrera_id,grupo,estatus,nip) VALUES ('25050821','LC26-4317','Jesús Adrián Aguirre Velázquez','alumno',1,'02','activo','TEST_NIP')`).run();
  const r = await req('POST', '/hijos', { nombre: 'aguirre velazquez jesus adrian', matricula: '' });
  assert.equal(r.status, 202);
  assert.equal((await req('GET', '/hijos')).body.hijos.find(h => h.id === r.body.id).matricula, '');
  const p = await pendienteDe(r.body.id);
  assert.equal(p.coincidencia.estado, 'ok');
  assert.equal(p.coincidencia.alumno.matricula, '25050821');
});

test('sin coincidencia, con nombre repetido o con datos de dos personas distintas no se puede aprobar', async () => {
  const nadie = await req('POST', '/hijos', { nombre: 'Alumno Que No Existe', matricula: '' });
  assert.equal((await pendienteDe(nadie.body.id)).coincidencia.estado, 'no_encontrado');
  assert.equal((await req('POST', `/hijos/${nadie.body.id}/aprobar`, { identidad_y_parentesco_verificados: true }, true)).status, 409);

  db.prepare(`INSERT INTO usuarios(matricula,codigo_credencial,nombre,tipo,carrera_id,grupo,estatus,nip) VALUES ('99000001','LC26-9001','Ana Lopez Diaz','alumno',1,'02','activo','TEST_NIP'),('99000002','LC26-9002','Ana López Díaz','alumno',1,'03','activo','TEST_NIP')`).run();
  const dos = await req('POST', '/hijos', { nombre: 'Ana Lopez Diaz', matricula: '' });
  assert.equal((await pendienteDe(dos.body.id)).coincidencia.estado, 'varios');

  const mezcla = await req('POST', '/hijos', { nombre: 'Ana Lopez Diaz', matricula: '25050821' });
  const p = await pendienteDe(mezcla.body.id);
  assert.equal(p.coincidencia.estado, 'conflicto');
  assert.equal((await req('POST', `/hijos/${mezcla.body.id}/aprobar`, { identidad_y_parentesco_verificados: true }, true)).status, 409);
});

test('sin nombre ni matrícula se rechaza', async () => {
  assert.equal((await req('POST', '/hijos', { nombre: '', matricula: '' })).status, 400);
});
