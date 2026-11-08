/* =====================================================================
   tutores.js — Solicitudes de vínculo de LinceTutores.
   GET  /api/tutores/pendientes            -> [{id, alumno_nombre, matricula, tutor, telefono, creada_en}]
   POST /api/tutores/hijos/:id/aprobar     {identidad_y_parentesco_verificados: true}
   POST /api/tutores/hijos/:id/rechazar
   El servidor vuelve a comprobar que nombre y matrícula coincidan con el padrón.
   ===================================================================== */
const $ = id => document.getElementById(id);

// Dirección completa de la app de tutores (sirve para compartirla por el túnel o la red local)
$('url-app').textContent = location.origin + '/tutores/';

/** "526691112233" -> "669 111 2233" */
const telefono = t => { const s = String(t || '').replace(/^52/, ''); return s.length === 10 ? `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}` : s; };

async function cargar() {
  const caja = $('lista');
  try {
    const lista = await API.tutoresPendientes();
    $('num-pendientes').textContent = lista.length;
    if (!lista.length) { caja.innerHTML = '<p class="vacio">No hay solicitudes pendientes.</p>'; return; }
    caja.innerHTML = lista.map(s => { const c = s.coincidencia || {}; const a = c.alumno; const ok = c.estado === 'ok'; return `
      <article class="solicitud" data-id="${s.id}">
        <div>
          <h3>${esc(s.alumno_nombre || 'Sin nombre')} <span class="badge">${esc(s.matricula || 'sin matrícula')}</span></h3>
          <div class="datos">
            <span>Tutor: <b>${esc(s.tutor)}</b></span>
            <span>Teléfono: <b>${esc(telefono(s.telefono))}</b></span>
            <span>Pidió el ${esc(fechaCorta(s.creada_en))}</span>
          </div>
          <p class="coincide ${ok ? 'si' : 'no'}">${ok
            ? `En el padrón: <b>${esc(a.nombre)}</b> · matrícula ${esc(a.matricula)} · gafete ${esc(a.gafete)}${a.carrera ? ' · ' + esc(a.carrera) : ''}${a.grupo ? ' · ' + esc(a.grupo) : ''}`
            : esc(c.motivo || 'No se encontró en el padrón')}</p>
        </div>
        <div class="acciones">
          <label class="check"><input type="checkbox" data-verificado ${ok ? '' : 'disabled'}> Verifiqué identidad y parentesco</label>
          <button class="primario" data-aprobar disabled>Aprobar vínculo</button>
          <button class="peligro" data-rechazar>Rechazar</button>
        </div>
      </article>`; }).join('');
  } catch (e) {
    caja.innerHTML = `<p class="vacio">No se pudieron cargar las solicitudes: ${esc(e.message)}</p>`;
  }
}

// Aprobar solo se habilita al marcar la verificación (el servidor también la exige)
$('lista').addEventListener('change', e => {
  if (!e.target.matches('[data-verificado]')) return;
  e.target.closest('.solicitud').querySelector('[data-aprobar]').disabled = !e.target.checked;
});

$('lista').addEventListener('click', async e => {
  const boton = e.target.closest('[data-aprobar], [data-rechazar]');
  if (!boton) return;
  const tarjeta = boton.closest('.solicitud');
  const id = Number(tarjeta.dataset.id);
  const aprobar = boton.hasAttribute('data-aprobar');
  if (!aprobar && !confirm('¿Rechazar esta solicitud? El tutor tendrá que pedir el vínculo otra vez.')) return;
  tarjeta.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    if (aprobar) await API.aprobarVinculo(id);
    else await API.rechazarVinculo(id);
    toast(aprobar ? 'Vínculo aprobado: el tutor ya ve los movimientos reales' : 'Solicitud rechazada', aprobar ? 'ok' : 'info');
    tarjeta.classList.add('saliendo');
    tarjeta.addEventListener('animationend', cargar, { once: true });
  } catch (err) {
    toast(err.message, 'error');
    tarjeta.querySelectorAll('button').forEach(b => { b.disabled = false; });
    tarjeta.querySelector('[data-aprobar]').disabled = !tarjeta.querySelector('[data-verificado]').checked;
  }
});

$('btn-recargar').addEventListener('click', cargar);
cargar();
setInterval(cargar, 60000);
