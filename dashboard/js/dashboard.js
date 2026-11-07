/* =====================================================================
   dashboard.js — Lógica de index.html
   1) Pide el aforo inicial (GET /api/aforo) y lo pinta.
   2) Escucha Socket.IO: "aforo" -> contador y gráficas,
      "evento" -> feed y alertas, "alerta" -> panel de alertas.
   3) Arma la gráfica de entradas por hora con GET /api/eventos de hoy.
   4) Consulta GET /api/anomalias cada minuto.
   5) Botón "Ejecutar cierre ahora" -> POST /api/cierre (solo cierra a
      quien NO tiene permiso nocturno vigente).
   6) Lista "Dentro sin permiso" (GET /api/dentro-sin-permiso) para la
      revisión de las 23:30, y el dato con_permiso junto al contador.
   ===================================================================== */

// Textos legibles para los motivos que manda POST /api/scan
const MOTIVOS = {
  no_registrada: 'Credencial no registrada',
  inactiva: 'Credencial inactiva',
  externo: 'Externo (pendiente de confirmar)',
  repetido: 'Lectura repetida (< 60 s)',
  ya_dentro: 'Ya está dentro (kiosco de entrada)'
};
// Textos para las alertas que llegan por Socket.IO / anomalías
const TIPOS_ALERTA = {
  permiso_vencido: 'Permiso vencido',
  noche_sin_permiso: 'Salida automática sin permiso',
  horario_nocturno: 'Acceso nocturno',
  estancia_larga: 'Más de 14 h dentro',
  kioscos_distintos: 'Dos kioscos en < 2 min'
};
const MAX_FEED = 25;     // cuántos accesos se muestran
const MAX_ALERTAS = 30;

const $ = id => document.getElementById(id);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------------------------------------------------------------------
// GRÁFICAS (Chart.js)
// ---------------------------------------------------------------------
let gCarrera, gGrupo, gHoras;
const entradasPorHora = new Array(24).fill(0);

function crearGraficas() {
  Chart.defaults.color = css('--suave');
  Chart.defaults.borderColor = css('--borde');
  Chart.defaults.font.family = 'system-ui, Arial, sans-serif';
  const base = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    plugins: { legend: { display: false } },
    scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
  };

  // Barras horizontales: los nombres de carrera son largos y así caben en el celular
  gCarrera = new Chart($('g-carrera'), {
    type: 'bar',
    data: { labels: [], datasets: [{ data: [], backgroundColor: css('--primario'), borderRadius: 6 }] },
    options: { ...base, indexAxis: 'y', scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
  });

  gGrupo = new Chart($('g-grupo'), {
    type: 'bar',
    data: { labels: [], datasets: [{ data: [], backgroundColor: css('--verde'), borderRadius: 6 }] },
    options: base
  });

  gHoras = new Chart($('g-horas'), {
    type: 'line',
    data: {
      labels: entradasPorHora.map((_, h) => h + 'h'),
      datasets: [{ data: entradasPorHora, borderColor: css('--ambar'), backgroundColor: css('--ambar-bg'),
        fill: true, tension: .35, pointRadius: 2 }]
    },
    options: base
  });
}

/** Pinta contador + gráficas con la forma de GET /api/aforo */
function pintarAforo(a) {
  const num = $('total');
  if (num.textContent !== String(a.total)) {
    num.textContent = a.total;
    num.classList.add('pulso');
    setTimeout(() => num.classList.remove('pulso'), 200);
  }
  $('actualizado').textContent = 'Actualizado ' + horaDe(ahoraLocal());
  // Campo nuevo: cuántos de los que están dentro tienen permiso nocturno vigente
  $('con-permiso').textContent = a.con_permiso ? `🌙 ${a.con_permiso} con permiso nocturno` : '';

  gCarrera.data.labels = a.por_carrera.map(x => x.carrera);
  gCarrera.data.datasets[0].data = a.por_carrera.map(x => x.dentro);
  gCarrera.update();

  gGrupo.data.labels = a.por_grupo.map(x => x.grupo || 'Sin grupo');
  gGrupo.data.datasets[0].data = a.por_grupo.map(x => x.dentro);
  gGrupo.update();
}

/** Entradas por hora: se calcula con los eventos de hoy */
async function cargarHorasPico() {
  const hoy = hoyLocal();
  const eventos = await API.eventos({ desde: hoy, hasta: hoy });
  entradasPorHora.fill(0);
  for (const e of eventos) {
    if (e.tipo === 'ingreso' && aLocal(e.fecha_hora).startsWith(hoy)) entradasPorHora[horaNum(e.fecha_hora)]++;
  }
  gHoras.update();
}

// ---------------------------------------------------------------------
// FEED DE ACCESOS
// ---------------------------------------------------------------------
function agregarAlFeed(ev) {
  const lista = $('feed');
  lista.querySelector('.vacio')?.remove();

  const u = ev.usuario;
  const titulo = { ingreso: 'Entrada', egreso: 'Salida', rechazado: 'Rechazado', repetido: 'Repetido' }[ev.resultado] || ev.resultado;
  const detalle = [u?.carrera, u?.grupo, ev.motivo ? MOTIVOS[ev.motivo] || ev.motivo : null, ev.kiosco_id]
    .filter(Boolean).map(esc).join(' · ') +
    // Campo nuevo de /api/scan: permiso: null | {nombre, hasta}
    (ev.permiso ? ` <span class="badge ambar">🌙 ${esc(ev.permiso.nombre)} hasta ${esc(fechaCorta(ev.permiso.hasta))}</span>` : '');

  const li = document.createElement('li');
  li.className = ev.color || 'verde';
  li.innerHTML = `
    ${imgUsuario(u || { nombre: '?' })}
    <div class="info">
      <div class="nombre">${esc(u?.nombre || 'Credencial desconocida')}</div>
      <div class="detalle"><span class="badge ${esc(ev.color)}">${esc(titulo)}</span> ${detalle}</div>
    </div>
    <div class="hora">${horaDe(ev.fecha_hora)}</div>`;
  lista.prepend(li);
  while (lista.children.length > MAX_FEED) lista.lastElementChild.remove();
}

// ---------------------------------------------------------------------
// ALERTAS
// ---------------------------------------------------------------------
const alertasVistas = new Set();   // evita duplicados (anomalías se consultan cada minuto)
let totalAlertas = 0;

/** alerta = {tipo, mensaje, usuario, fecha_hora, color?} */
function agregarAlerta(al) {
  const clave = `${al.tipo}|${al.usuario}|${al.fecha_hora}`;
  if (alertasVistas.has(clave)) return;
  alertasVistas.add(clave);

  const lista = $('alertas');
  lista.querySelector('.vacio')?.remove();
  const li = document.createElement('li');
  li.className = al.color || 'rojo';
  li.innerHTML = `
    <div class="info">
      <div class="nombre">${esc(al.mensaje)}</div>
      <div class="detalle">${esc(al.usuario || '')} · ${esc(TIPOS_ALERTA[al.tipo] || al.tipo)}</div>
    </div>
    <div class="hora">${horaDe(al.fecha_hora)}</div>`;
  lista.prepend(li);
  while (lista.children.length > MAX_ALERTAS) lista.lastElementChild.remove();

  $('num-alertas').textContent = ++totalAlertas;
  if (navigator.vibrate && li.className === 'rojo') navigator.vibrate(150);  // aviso en el celular
}

/** Convierte un "evento" de escaneo en alerta si es rechazo, repetido o externo */
function alertaDesdeEvento(ev) {
  const esAlerta = ev.resultado === 'rechazado' || ev.resultado === 'repetido' || ev.motivo === 'externo';
  if (!esAlerta) return;
  agregarAlerta({
    tipo: ev.motivo || ev.resultado,
    mensaje: MOTIVOS[ev.motivo] || ev.resultado,
    usuario: ev.usuario?.nombre || 'Credencial desconocida',
    fecha_hora: ev.fecha_hora,
    color: ev.color === 'ambar' ? 'ambar' : 'rojo'
  });
}

async function cargarAnomalias() {
  try {
    const lista = await API.anomalias();
    // Las más viejas primero para que la más reciente quede arriba
    lista.slice().reverse().forEach(a => agregarAlerta({ ...a, color: 'ambar' }));
  } catch (e) { console.warn('Anomalías:', e.message); }
}

// ---------------------------------------------------------------------
// DENTRO SIN PERMISO (revisión de las 23:30)
// GET /api/dentro-sin-permiso -> lista de quién sigue dentro sin permiso
// ---------------------------------------------------------------------
async function cargarSinPermiso() {
  try {
    const lista = await API.dentroSinPermiso();
    $('num-sin-permiso').textContent = lista.length;
    $('sin-permiso').innerHTML = lista.length ? lista.map(u => `
      <li class="ambar">
        ${imgUsuario(u)}
        <div class="info">
          <div class="nombre">${esc(u.nombre)}</div>
          <div class="detalle">${[u.carrera, u.grupo, u.tipo].filter(Boolean).map(esc).join(' · ')}</div>
        </div>
        <div class="hora">${u.desde ? 'desde ' + horaDe(u.desde).slice(0, 5) : ''}</div>
      </li>`).join('') : '<li class="vacio">Nadie dentro sin permiso 👍</li>';
    // De 23:00 a 00:00 la tarjeta se resalta para que el guardia la revise
    const h = horaNum(ahoraLocal());
    $('tarjeta-sin-permiso').style.outline = (h === 23 && lista.length) ? '3px solid var(--ambar)' : '';
  } catch (e) { console.warn('Dentro sin permiso:', e.message); }
}
$('btn-sin-permiso').addEventListener('click', cargarSinPermiso);

// ---------------------------------------------------------------------
// CIERRE MANUAL
// ---------------------------------------------------------------------
$('btn-cierre').addEventListener('click', async (e) => {
  const n = $('num-sin-permiso').textContent;
  if (!confirm(`Se registrará la SALIDA automática de las ${n} persona(s) que siguen dentro SIN permiso nocturno. ` +
               'Quienes tienen permiso vigente se quedan dentro. ¿Continuar?')) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await API.cierre();
    toast(`Cierre ejecutado: ${r.cerrados} salida(s) registradas`, 'ok');
    pintarAforo(await API.aforo());
    cargarSinPermiso();
  } catch (err) {
    toast('No se pudo ejecutar el cierre: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------
// ARRANQUE
// ---------------------------------------------------------------------
(async function iniciar() {
  crearGraficas();
  try {
    pintarAforo(await API.aforo());   // esta primera llamada también detecta si hay servidor
    await cargarHorasPico();
  } catch (e) {
    toast('Error cargando datos: ' + e.message, 'error');
  }
  cargarAnomalias();
  setInterval(cargarAnomalias, 60000);
  cargarSinPermiso();
  setInterval(cargarSinPermiso, 60000);

  API.conectar({
    estado: ok => $('conexion').classList.toggle('ok', ok),
    aforo: pintarAforo,
    evento: ev => {
      agregarAlFeed(ev);
      alertaDesdeEvento(ev);
      if (ev.resultado === 'ingreso') { entradasPorHora[horaNum(ev.fecha_hora)]++; gHoras.update(); }
    },
    alerta: al => agregarAlerta({ ...al, color: 'ambar' })
  });

  // Si el servidor se reinicia o el celular se bloquea, re-sincronizamos al volver
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      try { pintarAforo(await API.aforo()); await cargarHorasPico(); } catch {}
    }
  });
})();
