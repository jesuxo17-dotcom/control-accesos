// Servidor principal. Ejecutar desde server/: node server.js
process.env.TZ = 'America/Mazatlan';
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { db, obtenerAforo, usuariosDentro, fechaLocal } = require('./db');
const crearPermisos = require('./permisos');
const { crearQR } = require('./qr');
const { exigirAdmin } = require('./seguridad');
const crearRutaScan = require('./scan');
const crearUsuarios = require('./usuarios');
const crearNotificaciones = require('./notificaciones');
const configurarCierre = require('./cierre');
const crearConsultas = require('./consultas');

const app = express();
const PORT = Number(process.env.PORT || 3000);
let servidor;
// HTTPS opcional: guardar certificados mkcert fuera de GitHub.
if (process.env.HTTPS_KEY_PATH && process.env.HTTPS_CERT_PATH) {
  servidor = https.createServer({
    key: fs.readFileSync(path.resolve(__dirname, process.env.HTTPS_KEY_PATH)),
    cert: fs.readFileSync(path.resolve(__dirname, process.env.HTTPS_CERT_PATH))
  }, app);
} else {
  servidor = http.createServer(app);
}
const io = new Server(servidor, { cors: { origin: '*' } });

// Middleware antes de registrar TODAS las rutas.
app.use(cors());
app.use(express.json({ limit: '3mb' }));
app.use('/fotos', express.static(path.join(__dirname, 'public', 'fotos')));
app.use('/kiosco', express.static(path.join(__dirname, '..', 'kiosco')));
// Chart.js para el dashboard SIN internet: se sirve desde node_modules
// (dependencia "chart.js" en package.json) en la ruta que espera dashboard/index.html.
app.get('/dashboard/vendor/chart.umd.min.js', (_req, res, next) => {
  // chart.js no exporta esa subruta, así que se ubica desde su archivo principal (dist/chart.cjs)
  try { res.sendFile(path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js')); }
  catch { next(); }
});
app.use('/dashboard', express.static(path.join(__dirname, '..', 'dashboard')));

// Persona 3: al copiar server/ia.js esta línea lo conectará sin cambiar la API.
// Se monta después de express.json() y recibe exactamente (db, io).
const archivoIA = path.join(__dirname, 'ia.js');
if (fs.existsSync(archivoIA)) {
  app.use(require('./ia')(db, io));
  console.log('Módulo de IA de Persona 3 conectado');
}

const procesarNotificaciones = crearNotificaciones(db);
const { cerrarDia } = configurarCierre(db, io, obtenerAforo);
const consultas = crearConsultas(db);
app.locals.db = db;
app.locals.io = io;
app.locals.consultasIA = consultas;

// La página principal abre el dashboard visual; las rutas /api/ siguen intactas.
app.get('/', (_req, res) => res.redirect('/dashboard/'));
// Conservamos la consulta JSON de estado en una ruta independiente.
app.get('/api/estado', (_req, res) => res.json({ mensaje: 'LinceCode 2026 funcionando', servidor: 'Express', base_datos: 'SQLite', fecha_hora: fechaLocal() }));
app.get('/api/aforo', (_req, res) => res.json(obtenerAforo()));
app.use('/api', crearRutaScan(db, io, procesarNotificaciones));

app.post('/api/mi-qr', (req, res) => {
  const { matricula, nip } = req.body || {};
  if (typeof matricula !== 'string' || typeof nip !== 'string') {
    return res.status(400).json({ error: 'Se requieren matricula y nip' });
  }
  try {
    const respuesta = crearQR(db, matricula, nip);
    if (!respuesta) return res.status(401).json({ error: 'Credenciales incorrectas o usuario inactivo' });
    res.json(respuesta);
  } catch (error) {
    console.error(error.message);
    res.status(503).json({ error: 'Configura QR_SECRET en .env' });
  }
});

app.get('/api/eventos', (req, res) => {
  const { desde, hasta, carrera, usuario_id } = req.query;
  let sql = `SELECT e.id, u.nombre, c.nombre AS carrera, e.tipo, e.origen, e.kiosco_id, e.fecha_hora
    FROM eventos e JOIN usuarios u ON u.id = e.usuario_id
    LEFT JOIN carreras c ON c.id = u.carrera_id WHERE 1 = 1`;
  const params = [];
  if (desde) { sql += ' AND e.fecha_hora >= ?'; params.push(String(desde)); }
  if (hasta) { sql += ' AND e.fecha_hora <= ?'; params.push(/^\d{4}-\d\d-\d\d$/.test(String(hasta)) ? hasta + ' 23:59:59' : String(hasta)); }
  if (carrera) { sql += ' AND c.nombre = ?'; params.push(String(carrera)); }
  if (usuario_id) {
    if (!/^\d+$/.test(String(usuario_id))) return res.status(400).json({ error: 'usuario_id inválido' });
    sql += ' AND u.id = ?'; params.push(Number(usuario_id));
  }
  sql += ' ORDER BY e.fecha_hora DESC, e.id DESC LIMIT 1000';
  res.json(db.prepare(sql).all(...params));
});
app.use('/api/usuarios', crearUsuarios(db));
// Permisos nocturnos: /api/permisos y /api/dentro-sin-permiso
app.use('/api', crearPermisos(db, usuariosDentro));
app.post('/api/cierre', exigirAdmin, (_req, res) => {
  try { res.json(cerrarDia()); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

// Respaldos para desarrollar sin ia.js. Cuando Persona 3 lo agregue, sus rutas toman prioridad.
app.get('/api/anomalias', (_req, res) => {
  const filas = db.prepare(`SELECT i.motivo AS tipo, i.fecha_hora, u.nombre AS nombre
    FROM intentos i LEFT JOIN usuarios u ON u.id = i.usuario_id
    ORDER BY i.fecha_hora DESC, i.id DESC LIMIT 100`).all();
  res.json(filas.map(r => ({ tipo: r.tipo, mensaje: `Escaneo rechazado: ${r.tipo}`, usuario: r.nombre || null, fecha_hora: r.fecha_hora })));
});
app.post('/api/chat', (_req, res) => res.status(501).json({ respuesta: 'El chat de IA quedará disponible cuando Persona 3 agregue server/ia.js.' }));

io.on('connection', socket => {
  console.log('Cliente conectado:', socket.id);
  socket.emit('aforo', obtenerAforo());
});
servidor.listen(PORT, '0.0.0.0', () => {
  console.log('=== Hackatón LinceCode 2026 ===');
  console.log(`Servidor: ${servidor instanceof https.Server ? 'https' : 'http'}://localhost:${PORT}`);
  console.log('Base de datos SQLite lista | Socket.IO activo');
});
module.exports = { app, servidor, io };
