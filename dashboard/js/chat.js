/* =====================================================================
   chat.js — Ventana flotante de chat con la IA.
   Envía la pregunta a POST /api/chat {pregunta, historial} y muestra {respuesta}.
   El historial (solo texto, últimos turnos) deja que el asistente pregunte
   "¿cuál carrera?" y entienda la respuesta del admin.
   Se incluye en las 4 páginas del dashboard.
   La IA vive en el servidor (server/ia.js); aquí solo hay interfaz,
   así la clave IA_API_KEY nunca llega al navegador.
   ===================================================================== */

(function () {
  // El botón y la ventana se crean aquí para que el asistente aparezca en TODAS las páginas
  if (!document.getElementById('chat-boton')) {
    const barra = document.querySelector('header.barra');
    (barra || document.body).insertAdjacentHTML('beforeend', `
  <button id="chat-boton" aria-label="Abrir asistente de IA" title="Preguntar al asistente de IA">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg><span>Asistente IA</span>
  </button>`);
  }
  if (!document.getElementById('chat-ventana')) {
    document.body.insertAdjacentHTML('beforeend', `
  <div id="chat-ventana" role="dialog" aria-label="Asistente de aforo">
    <header>
      <span><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>Asistente de aforo</span>
      <button id="chat-cerrar" aria-label="Cerrar asistente"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
    </header>
    <div id="chat-mensajes" aria-live="polite">
      <div class="msg ia">Hola, pregúntame quién está adentro. Ej.: “¿Cuántos de Industrial están adentro?”</div>
    </div>
    <div class="sugerencias">
      <button data-p="Dame cuántos hay adentro por carrera">Adentro por carrera</button>
      <button data-p="¿Cuántos de Industrial están adentro?">Industrial adentro</button>
      <button data-p="¿Quiénes de Software están adentro?">Quiénes de Software</button>
    </div>
    <form id="chat-form">
      <input id="chat-texto" placeholder="Escribe tu pregunta…" autocomplete="off" aria-label="Pregunta para el asistente">
      <button class="primario" aria-label="Enviar"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg></button>
    </form>
  </div>

`);
  }
  const ventana = document.getElementById('chat-ventana');
  const mensajes = document.getElementById('chat-mensajes');
  const form = document.getElementById('chat-form');
  const texto = document.getElementById('chat-texto');
  const historial = [];   // [{rol:'admin'|'asistente', texto}]

  function abrirCerrar(abrir) {
    ventana.classList.toggle('abierto', abrir);
    if (abrir) texto.focus();
  }
  document.getElementById('chat-boton').onclick = () => abrirCerrar(!ventana.classList.contains('abierto'));
  document.getElementById('chat-cerrar').onclick = () => abrirCerrar(false);

  function burbuja(txt, quien, extra = '') {
    const d = document.createElement('div');
    d.className = `msg ${quien} ${extra}`;
    d.textContent = txt;            // textContent: nunca se interpreta como HTML
    mensajes.appendChild(d);
    mensajes.scrollTop = mensajes.scrollHeight;
    return d;
  }

  async function preguntar(p) {
    p = p.trim();
    if (!p) return;
    burbuja(p, 'yo');
    texto.value = '';
    const espera = burbuja('Consultando…', 'ia', 'esperando');
    form.querySelector('button').disabled = true;
    try {
      const r = await API.chat(p, historial.slice(-10));
      espera.classList.remove('esperando');
      espera.textContent = r.respuesta || 'Sin respuesta.';
      if (r.respuesta) historial.push({ rol: 'admin', texto: p }, { rol: 'asistente', texto: r.respuesta });
    } catch (e) {
      espera.classList.remove('esperando');
      espera.textContent = 'No pude responder: ' + e.message;
    } finally {
      form.querySelector('button').disabled = false;
      texto.focus();
    }
  }

  form.addEventListener('submit', e => { e.preventDefault(); preguntar(texto.value); });
  // Botones de preguntas sugeridas (útiles para la demo)
  document.querySelectorAll('.sugerencias button').forEach(b => b.onclick = () => preguntar(b.dataset.p));
})();
