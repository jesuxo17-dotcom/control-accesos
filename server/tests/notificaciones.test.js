// Correo de entrada/salida: cada aviso va al correo de ESA persona y dice lo mismo que la
// base de datos y que la pantalla. Base SQLite temporal y un enviador falso: no sale
// ningún correo real.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.TZ = 'America/Mazatlan';
process.env.ANTIRREBOTE_SEGUNDOS = '0.001';   // 0 cuenta como "sin valor" (60 s); 1 ms deja probar entrada y salida seguidas
const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'lince-correos-'));
process.env.DB_PATH = path.join(carpeta, 'prueba.db');

const { db } = require('../db');
const crearRutaScan = require('../scan');
const crearNotificaciones = require('../notificaciones');
const { hashNip } = require('../seguridad');

// Enviador falso y log capturado
const enviados = [];
const anotados = [];
const procesar = crearNotificaciones(db, {
  automatico: false,
  enviador: { listo: () => true, enviar: async c => { enviados.push(c); } },
  log: m => anotados.push(m)
});
// Lo que recibe la pantalla (Socket.IO 'evento')
const pantalla = [];
const io = { emit: (tipo, dato) => { if (tipo === 'evento') pantalla.push(dato); } };

const app = express();
app.use(express.json());
app.use('/api', crearRutaScan(db, io, procesar));
const http = app.listen(0, '127.0.0.1');
after(() => { http.close(); db.close(); fs.rmSync(carpeta, { recursive: true, force: true }); });

async function scan(codigo, kiosco) {
  if (!http.listening) await require('node:events').once(http, 'listening');
  const r = await fetch(`http://127.0.0.1:${http.address().port}/api/scan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo, kiosco_id: kiosco, modo: 'mixto' })
  });
  return r.json();
}

// Usuarios de prueba (nombres con acentos y parecidos entre sí a propósito)
db.prepare('INSERT INTO carreras (nombre) VALUES (?)').run('Ingeniería de Software');
const alta = db.prepare(`INSERT INTO usuarios (matricula,codigo_credencial,nombre,tipo,carrera_id,grupo,estatus,nip,notificar_tutor,email)
  VALUES (?,?,?,'alumno',1,'G31','activo',?,0,?)`);
const nip = hashNip('1234');
const personas = [
  { folio: 'LC26-0101', nombre: 'María José Pérez Ávila', email: 'maria.perez@alumnos.uadeo.mx', kiosco: 'K-PUERTA1' },
  { folio: 'LC26-0102', nombre: 'María Pérez Ávila', email: 'mperez@alumnos.uadeo.mx', kiosco: 'K-PUERTA2' },
  { folio: 'LC26-0103', nombre: 'Ángel Núñez Ruíz', email: 'angel.nunez@alumnos.uadeo.mx', kiosco: 'K-PUERTA1' }
];
for (const [i, p] of personas.entries()) p.id = Number(alta.run(`M-${i}`, p.folio, p.nombre, nip, p.email).lastInsertRowid);
const sinCorreo = Number(alta.run('M-8', 'LC26-0108', 'Persona Sin Correo', nip, null).lastInsertRowid);
const correoMalo = Number(alta.run('M-9', 'LC26-0109', 'Persona Correo Malo', nip, 'esto-no-es-un-correo').lastInsertRowid);

const eventoDe = id => db.prepare(`SELECT e.id, e.tipo, e.fecha_hora, e.kiosco_id, u.nombre, u.email
  FROM eventos e JOIN usuarios u ON u.id = e.usuario_id WHERE e.id = ?`).get(id);

test('3 usuarios: entrada y salida de cada uno; cada correo va a su dueño con los datos de la BD', async () => {
  for (const p of personas) {
    assert.equal((await scan(p.folio, p.kiosco)).resultado, 'ingreso');
    assert.equal((await scan(p.folio, p.kiosco)).resultado, 'egreso');
  }
  await procesar();
  assert.equal(enviados.length, 6);

  const avisos = db.prepare(`SELECT n.evento_id, n.estado FROM notificaciones n WHERE n.canal = 'correo_usuario' ORDER BY n.id`).all();
  assert.equal(avisos.length, 6);
  for (const [i, aviso] of avisos.entries()) {
    assert.equal(aviso.estado, 'enviado');
    const ev = eventoDe(aviso.evento_id);       // la verdad: la base de datos
    const correo = enviados[i];
    assert.equal(correo.to, ev.email, 'llega al correo registrado de esa persona');
    assert.match(correo.subject, new RegExp(`^${ev.tipo === 'ingreso' ? 'Entrada' : 'Salida'} registrada · ${ev.nombre} ·`));
    assert.ok(correo.text.includes(`Nombre:      ${ev.nombre}\n`), 'nombre exacto como está registrado');
    assert.ok(correo.text.includes(`Movimiento:  ${ev.tipo === 'ingreso' ? 'Entrada' : 'Salida'}\n`));
    assert.ok(correo.text.includes(`Hora:        ${ev.fecha_hora.slice(11, 19)} (hora de Sinaloa)`), 'hora del registro, no la del envío');
    assert.ok(correo.text.includes(`Lugar:       kiosco ${ev.kiosco_id}`));
  }
  // Nadie recibe el correo de otro (los dos "María Pérez" incluidos)
  for (const p of personas) {
    const suyos = enviados.filter(c => c.to === p.email);
    assert.equal(suyos.length, 2);
    assert.ok(suyos.every(c => c.text.includes(`Nombre:      ${p.nombre}\n`)));
  }
});

test('la pantalla recibe los mismos datos que la base y que el correo', () => {
  assert.equal(pantalla.length, 6);
  const filas = db.prepare(`SELECT e.tipo, e.fecha_hora, e.kiosco_id, u.id AS usuario_id, u.nombre
    FROM eventos e JOIN usuarios u ON u.id = e.usuario_id ORDER BY e.id`).all();
  pantalla.forEach((m, i) => {
    assert.equal(m.usuario.id, filas[i].usuario_id);
    assert.equal(m.usuario.nombre, filas[i].nombre);
    assert.equal(m.resultado, filas[i].tipo);
    assert.equal(m.fecha_hora, filas[i].fecha_hora);
    assert.equal(m.kiosco_id, filas[i].kiosco_id);
  });
});

test('sin correo o con correo inválido: se guarda el movimiento, no se envía y queda en el log', async () => {
  const antes = enviados.length;
  const avisosAntes = db.prepare("SELECT COUNT(*) n FROM notificaciones WHERE canal = 'correo_usuario'").get().n;
  const warn = console.warn; const consola = []; console.warn = (...a) => consola.push(a.join(' '));
  try {
    assert.equal((await scan('LC26-0108', 'K-PUERTA1')).resultado, 'ingreso');
    assert.equal((await scan('LC26-0109', 'K-PUERTA1')).resultado, 'ingreso');
  } finally { console.warn = warn; }
  await procesar();
  assert.equal(enviados.length, antes, 'no se manda nada');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notificaciones WHERE canal = 'correo_usuario'").get().n, avisosAntes);
  const guardados = db.prepare('SELECT usuario_id FROM eventos WHERE usuario_id IN (?, ?)').all(sinCorreo, correoMalo);
  assert.equal(guardados.length, 2, 'los dos movimientos sí quedaron en la base');
  assert.ok(consola.some(l => l.includes(`usuario ${sinCorreo}`) && l.includes('sin correo registrado')));
  assert.ok(consola.some(l => l.includes(`usuario ${correoMalo}`) && l.includes('formato inválido')));
});

test('el correo se lee de la base al enviar (si cambió después del escaneo, se usa el nuevo)', async () => {
  const p = personas[2];
  // Un evento con su aviso en cola, como lo deja /api/scan
  const ev = db.prepare("INSERT INTO eventos (usuario_id,tipo,origen,kiosco_id,fecha_hora) VALUES (?, 'ingreso', 'kiosco', 'K-PUERTA3', '2026-11-08 09:15:42')").run(p.id).lastInsertRowid;
  db.prepare("INSERT INTO notificaciones (evento_id,canal,estado,fecha_hora) VALUES (?, 'correo_usuario', 'pendiente', '2026-11-08 09:15:42')").run(ev);
  db.prepare('UPDATE usuarios SET email = ? WHERE id = ?').run('angel.nuevo@alumnos.uadeo.mx', p.id);
  await procesar();
  const ultimo = enviados.at(-1);
  assert.equal(ultimo.to, 'angel.nuevo@alumnos.uadeo.mx');
  assert.ok(ultimo.text.includes('Hora:        09:15:42 (hora de Sinaloa)'));
  assert.ok(ultimo.text.includes('Fecha:       domingo 8 de noviembre de 2026'));
  assert.ok(ultimo.text.includes('Lugar:       kiosco K-PUERTA3'));
});
