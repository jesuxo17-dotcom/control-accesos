/* =====================================================================
   reportes.js — Lógica de reportes.html
   - Llena los filtros (carreras y usuarios) con GET /api/aforo y
     GET /api/usuarios.
   - Consulta GET /api/eventos?desde=&hasta=&carrera=&usuario_id=
   - Exporta lo que se ve en la tabla a CSV (UTF-8 con BOM para que
     Excel respete los acentos).
   ===================================================================== */

const $ = id => document.getElementById(id);
let filas = [];   // último resultado, para exportar

async function llenarFiltros() {
  const hoy = hoyLocal();
  $('desde').value = hoy;
  $('hasta').value = hoy;
  try {
    const [aforo, usuarios] = await Promise.all([API.aforo(), API.usuarios()]);
    $('carrera').innerHTML += aforo.por_carrera
      .map(c => `<option value="${esc(c.carrera)}">${esc(c.carrera)}</option>`).join('');
    $('usuario_id').innerHTML += usuarios
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map(u => `<option value="${u.id}">${esc(u.nombre)} (${esc(u.matricula)})</option>`).join('');
  } catch (e) {
    toast('No se pudieron cargar los filtros: ' + e.message, 'error');
  }
}

async function buscar() {
  const filtros = {
    desde: $('desde').value, hasta: $('hasta').value,
    carrera: $('carrera').value, usuario_id: $('usuario_id').value
  };
  if (filtros.desde && filtros.hasta && filtros.desde > filtros.hasta) {
    return toast('"Desde" no puede ser mayor que "Hasta"', 'error');
  }
  $('tabla').innerHTML = '<tr><td colspan="6" class="vacio">Buscando…</td></tr>';
  try {
    filas = await API.eventos(filtros);
    pintar();
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

function pintar() {
  const n = t => filas.filter(f => f.tipo === t).length;
  const auto = filas.filter(f => f.origen === 'automatico').length;
  $('resumen').textContent = `${filas.length} registros · ${n('ingreso')} entradas · ${n('egreso')} salidas` +
    (auto ? ` (${auto} automáticas por cierre)` : '');

  $('tabla').innerHTML = filas.length ? filas.map(f => `
    <tr>
      <td>${esc(aLocal(f.fecha_hora))}</td>
      <td>${esc(f.nombre)}</td>
      <td>${esc(f.carrera || '')}</td>
      <td><span class="badge ${esc(f.tipo)}">${esc(f.tipo)}</span></td>
      <td>${f.origen === 'automatico' ? '<span class="badge automatico">automático</span>' : esc(f.origen)}</td>
      <td>${esc(f.kiosco_id || '—')}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="vacio">Sin registros en ese rango</td></tr>';
}

/** Genera y descarga el CSV con lo que hay en pantalla */
function exportarCSV() {
  if (!filas.length) return toast('No hay datos para exportar', 'error');
  const columnas = ['id', 'fecha_hora', 'nombre', 'carrera', 'tipo', 'origen', 'kiosco_id'];
  // Encerrar cada valor entre comillas y duplicar las comillas internas (estándar CSV)
  const celda = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lineas = [columnas.join(',')]
    .concat(filas.map(f => columnas.map(c => celda(c === 'fecha_hora' ? aLocal(f[c]) : f[c])).join(',')));

  const blob = new Blob(['﻿' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `accesos_${$('desde').value || 'inicio'}_a_${$('hasta').value || 'hoy'}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$('filtros').addEventListener('submit', e => { e.preventDefault(); buscar(); });
$('btn-csv').addEventListener('click', exportarCSV);

llenarFiltros().then(buscar);
