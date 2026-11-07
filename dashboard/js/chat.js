/* =====================================================================
   chat.js — Ventana flotante de chat con la IA.
   Envía la pregunta a POST /api/chat {pregunta} y muestra {respuesta}.
   La IA vive en el servidor (server/ia.js); aquí solo hay interfaz,
   así la clave IA_API_KEY nunca llega al navegador.
   ===================================================================== */

(function () {
  const ventana = document.getElementById('chat-ventana');
  const mensajes = document.getElementById('chat-mensajes');
  const form = document.getElementById('chat-form');
  const texto = document.getElementById('chat-texto');

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
      const r = await API.chat(p);
      espera.classList.remove('esperando');
      espera.textContent = r.respuesta || 'Sin respuesta.';
    } catch (e) {
      espera.classList.remove('esperando');
      espera.textContent = '⚠️ No pude responder: ' + e.message;
    } finally {
      form.querySelector('button').disabled = false;
      texto.focus();
    }
  }

  form.addEventListener('submit', e => { e.preventDefault(); preguntar(texto.value); });
  // Botones de preguntas sugeridas (útiles para la demo)
  document.querySelectorAll('.sugerencias button').forEach(b => b.onclick = () => preguntar(b.dataset.p));
})();
