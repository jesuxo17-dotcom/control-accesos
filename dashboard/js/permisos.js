/* =====================================================================
   permisos.js — Lógica de permisos.html
   - GET /api/permisos  -> tabla con estado (vigente / próximo / vencido)
   - POST /api/permisos {nombre, desde, hasta, usuario_ids?, carrera_id?, grupo?}
     Se manda SOLO uno de los tres alcances (personas, carrera o grupo);
     el servidor crea una fila por persona en la tabla permisos.
   ===================================================================== */

const $ = id => document.getElementById(id);
let usuarios = [];
let permisos = [];
let alcance = 'personas';
const seleccionados = new Set();

/** 'YYYY-MM-DDTHH:MM' (input datetime-local) -> 'YYYY-MM-DD HH:MM:00' (formato de la BD) */
const aBD = v => v.replace('T', ' ') + ':00';

/** Estado de un permiso respecto a la hora actual de Mazatlán */
function estado(p) {
  const ahora = ahoraLocal();
  if (aLocal(p.hasta) < ahora) return 'vencido';
  if (aLocal(p.desde) > ahora) return 'proximo';
  return 'vigente';
}
const ETIQUETA = { vigente: ['verde', 'Vigente'], proximo: ['ambar', 'Próximo'], vencido: ['rojo', 'Vencido'] };

// ---------- Carga inicial ----------
async function cargar() {
  try {
    [usuarios, permisos] = await Promise.all([API.usuarios(), API.permisos()]);
    llenarSelects();
    pintarPersonas();
    pintarTabla();
  } catch (e) {
    toast('Error cargando datos: ' + e.message, 'error');
  }
}

function llenarSelects() {
  // Carreras y grupos se deducen de los usuarios (la API no tiene /api/carreras)
  const carreras = new Map();
  const grupos = new Set();
  for (const u of usuarios) {
    if (u.carrera_id) carreras.set(Number(u.carrera_id), u.carrera || `Carrera ${u.carrera_id}`);
    if (u.grupo) grupos.add(u.grupo);
  }
  $('carrera_id').innerHTML = [...carreras].sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, n]) => `<option value="${id}">${esc(n)}</option>`).join('');
  $('grupo').innerHTML = [...grupos].sort().map(g => `<option>${esc(g)}</option>`).join('');
}

// ---------- Selector de personas ----------
function pintarPersonas() {
  const txt = $('buscar').value.trim().toLowerCase();
  const lista = usuarios
    .filter(u => u.estatus !== 'inactivo')
    .filter(u => !txt || `${u.nombre} ${u.matricula} ${u.grupo || ''}`.toLowerCase().includes(txt))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
  $('personas').innerHTML = lista.map(u => `
    <label><input type="checkbox" value="${u.id}" ${seleccionados.has(u.id) ? 'checked' : ''}>
      ${esc(u.nombre)} <span style="color:var(--suave)">· ${esc(u.carrera || '')} ${esc(u.grupo || '')}</span></label>`).join('')
    || '<div class="vacio">Sin resultados</div>';
  $('num-sel').textContent = `${seleccionados.size} seleccionada(s)`;
}
$('personas').addEventListener('change', e => {
  const id = Number(e.target.value);
  e.target.checked ? seleccionados.add(id) : seleccionados.delete(id);
  $('num-sel').textContent = `${seleccionados.size} seleccionada(s)`;
});
$('buscar').addEventListener('input', pintarPersonas);

// Botones de alcance: muestran solo la caja que corresponde
$('alcance').addEventListener('click', e => {
  const a = e.target.dataset.a;
  if (!a) return;
  alcance = a;
  $('alcance').querySelectorAll('button').forEach(b => b.classList.toggle('activo', b.dataset.a === a));
  for (const x of ['personas', 'carrera', 'grupo']) $('caja-' + x).hidden = x !== a;
});

// ---------- Tabla ----------
function pintarTabla() {
  const filtro = $('f-estado').value;
  const txt = $('f-texto').value.trim().toLowerCase();
  const nombreDe = id => usuarios.find(u => u.id === id)?.nombre;

  const filas = permisos
    .map(p => ({ ...p, _estado: estado(p), _persona: p.usuario || nombreDe(p.usuario_id) || `#${p.usuario_id}` }))
    .filter(p => !filtro || p._estado === filtro)
    .filter(p => !txt || `${p.nombre} ${p._persona}`.toLowerCase().includes(txt))
    .sort((a, b) => String(b.desde).localeCompare(String(a.desde)));

  $('tabla').innerHTML = filas.length ? filas.map(p => {
    const [color, texto] = ETIQUETA[p._estado];
    return `<tr>
      <td><span class="badge ${color}">${texto}</span></td>
      <td><b>${esc(p.nombre)}</b></td>
      <td>${esc(p._persona)}</td>
      <td>${esc(fechaCorta(p.desde))}</td>
      <td>${esc(fechaCorta(p.hasta))}</td>
      <td>${esc(p.autorizado_por || '—')}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="vacio">Sin permisos</td></tr>';
}
$('f-estado').addEventListener('input', pintarTabla);
$('f-texto').addEventListener('input', pintarTabla);

// ---------- Crear permiso ----------
$('form').addEventListener('submit', async e => {
  e.preventDefault();
  const desde = $('desde').value, hasta = $('hasta').value;
  if (hasta <= desde) return toast('"Hasta" debe ser después de "Desde"', 'error');

  const datos = { nombre: $('nombre').value.trim(), desde: aBD(desde), hasta: aBD(hasta) };
  if (alcance === 'personas') {
    if (!seleccionados.size) return toast('Selecciona al menos una persona', 'error');
    datos.usuario_ids = [...seleccionados];
  } else if (alcance === 'carrera') {
    datos.carrera_id = Number($('carrera_id').value);
  } else {
    datos.grupo = $('grupo').value;
  }

  $('btn-crear').disabled = true;
  try {
    const r = await API.crearPermiso(datos);
    toast(`Permiso creado${r && r.creados != null ? ` para ${r.creados} persona(s)` : ''}`, 'ok');
    $('form').reset();
    seleccionados.clear();
    valoresPorDefecto();
    await cargar();
  } catch (err) {
    toast('No se pudo crear: ' + err.message, 'error');
  } finally {
    $('btn-crear').disabled = false;
  }
});

/** Por defecto: hoy 18:00 -> mañana 08:00 (el caso típico de un evento nocturno) */
function valoresPorDefecto() {
  const manana = ahoraLocal(new Date(Date.now() + 24 * 3600e3)).slice(0, 10);
  $('desde').value = `${hoyLocal()}T18:00`;
  $('hasta').value = `${manana}T08:00`;
}

valoresPorDefecto();
cargar();
