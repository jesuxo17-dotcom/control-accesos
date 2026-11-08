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
  ya_dentro: 'Ya está dentro (kiosco de entrada)',
  codigo_vencido: 'QR dinámico vencido o ya usado',
  sin_ingreso: 'Intentó salir sin entrada registrada'
};
// Textos para las alertas que llegan por Socket.IO / anomalías
const TIPOS_ALERTA = {
  permiso_vencido: 'Permiso vencido',
  noche_sin_permiso: 'Salida automática sin permiso',
  horario_nocturno: 'Acceso nocturno',
  estancia_larga: 'Más de 14 h dentro',
  kioscos_distintos: 'Dos kioscos en < 2 min',
  ...MOTIVOS
};
// Anomalías "de vigilancia" (ámbar); los rechazos del kiosco van en rojo
const ALERTAS_AMBAR = ['permiso_vencido', 'horario_nocturno', 'estancia_larga', 'kioscos_distintos', 'externo', 'repetido',
  'confirmacion_manual', 'revision_gafete'];   // gafete leído por foto: el guardia confirma o revisa
TIPOS_ALERTA.confirmacion_manual = 'Confirmar identidad a mano';
TIPOS_ALERTA.revision_gafete = 'Gafete para revisión';
// Icono SVG (estilo Lucide) para permisos nocturnos; texto fijo, no viene de la BD
const ICONO_LUNA = '<svg class="ico" style="width:12px;height:12px;vertical-align:-1px" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';
const MAX_FEED = 25;    // cuántos accesos se muestran
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
  Chart.defaults.font.family = css('--fuente') || 'system-ui, Arial, sans-serif';
  Chart.defaults.font.size = 12;
  // Sin animación si el usuario pidió movimiento reducido
  const reducido = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const primario = css('--primario');
  // Colores de la sección del canvas (una banda oscura usa sus propios tonos)
  const tema = id => {
    const st = getComputedStyle($(id));
    const v = (n, d) => st.getPropertyValue(n).trim() || d;
    return { color: v('--g-texto', css('--suave')), linea: v('--g-linea', css('--borde')),
      barra: v('--g-barra', primario), relleno: v('--g-relleno', css('--primario-suave')) };
  };
  const conTema = (id, opts) => {
    const t = tema(id);
    const sc = {};
    for (const [k, ax] of Object.entries(opts.scales || {})) sc[k] = { ...ax, ticks: { ...(ax.ticks || {}), color: t.color },
      grid: ax.grid?.display === false ? ax.grid : { ...(ax.grid || {}), color: t.linea } };
    return { ...opts, color: t.color, scales: sc };
  };
  // Ejes discretos (estilo suizo): solo líneas guía del eje de valores, sin bordes
  const ejeValor = { beginAtZero: true, ticks: { precision: 0 }, border: { display: false }, grid: { color: css('--borde') } };
  const ejeCat = { grid: { display: false }, border: { display: false } };
  const base = {
    responsive: true, maintainAspectRatio: false, animation: { duration: reducido ? 0 : 250 },
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: '#1c1917', padding: 10, cornerRadius: 8, displayColors: false,
        titleFont: { weight: '600' }, callbacks: { label: c => `${c.formattedValue} personas` } }
    },
    scales: { x: ejeCat, y: ejeValor }
  };

  // Barras horizontales: los nombres de carrera son largos y así caben en el celular
  gCarrera = new Chart($('g-carrera'), {
    type: 'bar',
    data: { labels: [], datasets: [{ data: [], backgroundColor: tema('g-carrera').barra, borderRadius: 6, maxBarThickness: 26 }] },
    options: conTema('g-carrera', { ...base, indexAxis: 'y', scales: { x: ejeValor, y: { ...ejeCat, ticks: {
      // En celular, los nombres largos se recortan con … en vez de salirse de la tarjeta
      callback(v) { const t = this.getLabelForValue(v); const max = innerWidth < 600 ? 16 : 34; return t.length > max ? t.slice(0, max - 1) + '…' : t; } } } } })
  });

  gGrupo = new Chart($('g-grupo'), {
    type: 'bar',
    data: { labels: [], datasets: [{ data: [], backgroundColor: tema('g-grupo').barra, borderRadius: 6, maxBarThickness: 32 }] },
    options: conTema('g-grupo', base)
  });

  gHoras = new Chart($('g-horas'), {
    type: 'line',
    data: {
      labels: entradasPorHora.map((_, h) => h + 'h'),
      datasets: [{ data: entradasPorHora, borderColor: tema('g-horas').barra, borderWidth: 2,
        backgroundColor: tema('g-horas').relleno, fill: true, cubicInterpolationMode: 'monotone',   // curva suave sin bajar de 0
        pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 12 }]
    },
    options: conTema('g-horas', { ...base, interaction: { mode: 'index', intersect: false },
      plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip,
        callbacks: { label: c => `${c.formattedValue} entradas` } } },
      scales: { x: { ...ejeCat, ticks: { maxTicksLimit: 8 } }, y: ejeValor } })
  });
}

/** Pinta contador + gráficas con la forma de GET /api/aforo */
function pintarAforo(a) {
  const num = $('total');
  if (!num.dataset.contado && !matchMedia('(prefers-reduced-motion: reduce)').matches && a.total > 0) {
    // primera carga: cuenta de 0 a la cifra en 600 ms (ease-out)
    num.dataset.contado = '1';
    const t0 = performance.now(), fin = a.total;
    const paso = t => { const p = Math.min(1, (t - t0) / 600); num.textContent = Math.round(fin * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(paso); };
    requestAnimationFrame(paso);
  } else if (num.textContent !== String(a.total)) {
    num.dataset.contado = '1';
    num.textContent = a.total;
    num.classList.add('pulso');
    setTimeout(() => num.classList.remove('pulso'), 200);
  }
  $('actualizado').textContent = ($('actualizado').dataset.prefijo ?? 'Actualizado ') + horaDe(ahoraLocal());
  // Campo nuevo: cuántos de los que están dentro tienen permiso nocturno vigente
  // (el icono de luna lo pone el CSS de .chip-permiso; si queda vacío, el chip se oculta)
  $('con-permiso').textContent = a.con_permiso ? `${a.con_permiso} con permiso nocturno` : '';
  if ($('personas')) $('personas').textContent = a.total === 1 ? 'persona' : 'personas';

  gCarrera.data.labels = a.por_carrera.map(x => x.carrera);
  gCarrera.data.datasets[0].data = a.por_carrera.map(x => x.dentro);
  gCarrera.update();

  gGrupo.data.labels = a.por_grupo.map(x => x.grupo || 'Sin grupo');
  gGrupo.data.datasets[0].data = a.por_grupo.map(x => x.dentro);
  gGrupo.update();
}

/** Sin entradas en el día: un mensaje en lugar de una gráfica en blanco */
function mostrarHorasVacia() {
  const p = $('horas-vacia');
  if (p) p.hidden = entradasPorHora.some(n => n > 0);
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
  mostrarHorasVacia();
  // La línea de tiempo arranca con lo más reciente de hoy (sin animar: ya estaba ahí)
  const feed = $('feed');
  if (feed && !feed.querySelector('.ent')) {
    // Pasada la medianoche todavía no hay lecturas de hoy: también se muestran las de ayer
    const ayer = ahoraLocal(new Date(Date.now() - 864e5)).slice(0, 10);
    const previos = eventos.length >= 8 ? eventos : await API.eventos({ desde: ayer, hasta: hoy }).catch(() => eventos);
    const recientes = [...previos].sort((a, b) => String(a.fecha_hora).localeCompare(String(b.fecha_hora))).slice(-8);
    for (const e of recientes) agregarAlFeed({
      usuario: { nombre: e.nombre, carrera: e.carrera, grupo: e.grupo, foto_url: e.foto_url },
      resultado: e.tipo, color: e.tipo === 'ingreso' ? 'verde' : 'salida', fecha_hora: e.fecha_hora, kiosco_id: e.kiosco_id
    }, false);
  }
}

// ---------------------------------------------------------------------
// FEED DE ACCESOS
// ---------------------------------------------------------------------
/** "hace 3 min", "hace 2 h", "ayer 21:30" (hora de Mazatlán) */
function haceCuanto(fh) {
  const t = Date.parse(aLocal(fh).replace(' ', 'T') + '-07:00');
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (!Number.isFinite(s)) return horaDe(fh).slice(0, 5);
  if (s < 50) return 'ahora';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 6 * 3600) return `hace ${Math.floor(s / 3600)} h`;
  return (aLocal(fh).slice(0, 10) === hoyLocal() ? 'hoy ' : 'ayer ') + horaDe(fh).slice(0, 5);
}
function iniciales(nombre = '?') {
  return nombre.split(' ').filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '?';
}
// Tonos de la paleta UAdeO para el círculo de iniciales (todos con blanco a 4.5:1 o más)
const TONOS = ['#8b1d46', '#6b1535', '#5f1830', '#7a5a00', '#9c2c50'];

/** Una tarjeta de la línea de tiempo. nueva = llegó en vivo (se anima); si no, es de la carga inicial */
function agregarAlFeed(ev, nueva = true) {
  const lista = $('feed');
  lista.querySelector('.vacio')?.remove();

  const u = ev.usuario || {};
  const nombre = u.nombre || 'Credencial desconocida';
  const tipo = { ingreso: 'Entró', egreso: 'Salió', rechazado: 'Rechazado', repetido: 'Repetido' }[ev.resultado] || ev.resultado;
  // Los mismos datos que el correo: nombre de la BD, movimiento, hora exacta guardada y kiosco
  const area = [u.carrera || (u.tipo && u.tipo !== 'alumno' ? u.tipo : null), u.grupo, ev.kiosco_id].filter(Boolean).map(esc).join(' · ') || 'Sin carrera registrada';
  let h = 0; for (const c of nombre) h = (h * 31 + c.charCodeAt(0)) % 997;
  const cara = u.foto_url
    ? `<img class="ent__foto" src="${esc(u.foto_url)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ent__ini',textContent:'${esc(iniciales(nombre))}'}))">`
    : `<span class="ent__ini" style="background:${TONOS[h % TONOS.length]}" aria-hidden="true">${esc(iniciales(nombre))}</span>`;

  const li = document.createElement('li');
  li.className = `ent ent--${esc(ev.color || 'verde')}${nueva ? ' ent--nueva' : ''}`;
  li.innerHTML = `
    ${cara}
    <div class="ent__info">
      <p class="ent__nombre">${esc(nombre)}</p>
      <p class="ent__area">${area}</p>
    </div>
    <div class="ent__lado">
      <span class="ent__tipo">${esc(tipo)} ${horaDe(ev.fecha_hora)}</span>
      <time class="ent__hace" datetime="${esc(aLocal(ev.fecha_hora))}" data-fh="${esc(ev.fecha_hora)}">${haceCuanto(ev.fecha_hora)}</time>
    </div>`;
  lista.prepend(li);
  if (nueva) li.addEventListener('animationend', () => li.classList.remove('ent--nueva'), { once: true });
  while (lista.children.length > MAX_FEED) lista.lastElementChild.remove();
}
// "hace X min" se mantiene al día
setInterval(() => document.querySelectorAll('.ent__hace[data-fh]').forEach(t => { t.textContent = haceCuanto(t.dataset.fh); }), 30000);

// ---------------------------------------------------------------------
// ALERTAS
// ---------------------------------------------------------------------
const alertasVistas = new Set();   // evita duplicados (anomalías se consultan cada minuto)
let totalAlertas = 0;

/** alerta = {tipo, mensaje, usuario, fecha_hora, color?}
    Ojo: en las alertas de /api/scan "usuario" es un objeto {id,nombre,...} (o null);
    en las de anomalías es solo el nombre. Aquí se normaliza a texto. */
function agregarAlerta(alerta) {
  const al = { ...alerta };
  if (al.usuario && typeof al.usuario === 'object') al.usuario = al.usuario.nombre;
  if (!al.usuario) al.usuario = 'Credencial desconocida';
  // El servidor manda "Escaneo rechazado: no_registrada"; mostramos el texto legible
  if (/^Escaneo /.test(al.mensaje || '') && MOTIVOS[al.tipo]) al.mensaje = MOTIVOS[al.tipo];
  if (al.tipo === 'rechazado' && /sin_ingreso/.test(al.mensaje || '')) al.mensaje = MOTIVOS.sin_ingreso;
  al.color = al.color || (ALERTAS_AMBAR.includes(al.tipo) ? 'ambar' : 'rojo');
  const clave = `${al.tipo}|${al.usuario}|${al.fecha_hora}`;
  if (alertasVistas.has(clave)) return;
  alertasVistas.add(clave);

  const lista = $('alertas');
  lista.querySelector('.vacio')?.remove();
  const li = document.createElement('li');
  li.className = al.color || 'rojo';
  // La etiqueta del tipo solo se agrega si dice algo distinto al mensaje
  const etiqueta = TIPOS_ALERTA[al.tipo] || al.tipo;
  const detalle = [al.usuario, etiqueta !== al.mensaje && al.tipo !== 'rechazado' ? etiqueta : null].filter(Boolean);
  li.innerHTML = `
    <div class="info">
      <div class="nombre">${esc(al.mensaje)}</div>
      <div class="detalle">${detalle.map(esc).join(' · ')}</div>
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
    lista.slice().reverse().forEach(a => agregarAlerta(a));
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
      </li>`).join('') : '<li class="vacio">Nadie dentro sin permiso</li>';
    // De 23:00 a 00:00 la tarjeta se resalta para que el guardia la revise
    const h = horaNum(ahoraLocal());
    $('tarjeta-sin-permiso').classList.toggle('urgente', h === 23 && lista.length > 0);
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
  // Las gráficas miden sus etiquetas: esperar a que cargue la fuente (máx. 1.5 s)
  // para que no se corten ("Tecnologías de la Información").
  if (document.fonts?.ready) await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1500))]);
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
    estado: ok => { const c = $('conexion'); c.classList.toggle('ok', ok); if (c.textContent.trim()) c.textContent = ok ? 'En vivo' : 'Sin conexión'; },
    aforo: pintarAforo,
    evento: ev => {
      agregarAlFeed(ev);
      alertaDesdeEvento(ev);
      if (ev.resultado === 'ingreso') { entradasPorHora[horaNum(ev.fecha_hora)]++; gHoras.update(); mostrarHorasVacia(); }
    },
    alerta: al => agregarAlerta(al)
  });

  // Si el servidor se reinicia o el celular se bloquea, re-sincronizamos al volver
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      try { pintarAforo(await API.aforo()); await cargarHorasPico(); } catch {}
    }
  });
})();
