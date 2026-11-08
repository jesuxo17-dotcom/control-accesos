/* =====================================================================
   sesion.js — Sesión del panel. Va PRIMERO en cada página del dashboard.
   - Sin sesión guardada en esta pestaña: manda a login.html (y regresa
     a la página después de entrar).
   - Pone el botón "Salir" en la barra de arriba.
   La sesión se guarda en sessionStorage: al cerrar el navegador hay que
   volver a entrar. El servidor la da con POST /api/login (12 h).
   ===================================================================== */
const Sesion = (() => {
  const LLAVE = 'sesion_panel';
  const leer = () => { try { return JSON.parse(sessionStorage.getItem(LLAVE) || 'null'); } catch { return null; } };
  const vigente = s => s && s.token && Date.parse(s.expira) > Date.now();
  const enLogin = /login\.html$/.test(location.pathname);
  const sinServidor = new URLSearchParams(location.search).get('mock') === '1' || location.protocol === 'file:';

  function irALogin(motivo) {
    if (enLogin) return;
    const volver = location.pathname.split('/').pop() + location.search + location.hash;
    location.replace('login.html?volver=' + encodeURIComponent(volver || 'index.html') + (motivo ? '&motivo=' + motivo : ''));
  }

  // Sin sesión: fuera (salvo en la propia página de login o en modo demo sin servidor)
  if (!enLogin && !sinServidor && !vigente(leer())) irALogin();

  function salir() {
    const s = leer();
    try { sessionStorage.removeItem(LLAVE); } catch {}
    if (s?.token) fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + s.token } }).catch(() => {});
    location.replace('login.html');
  }

  // Botón "Salir" en la barra de arriba
  document.addEventListener('DOMContentLoaded', () => {
    const barra = document.querySelector('header.barra');
    if (!barra || enLogin) return;
    barra.insertAdjacentHTML('beforeend', `<button id="btn-salir" type="button" title="Cerrar sesión">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span>Salir</span></button>`);
    document.getElementById('btn-salir').addEventListener('click', salir);
  });

  return {
    token: () => leer()?.token || '',
    cabecera: () => { const t = leer()?.token; return t ? { Authorization: 'Bearer ' + t } : {}; },
    guardar: datos => { try { sessionStorage.setItem(LLAVE, JSON.stringify(datos)); } catch {} },
    vencida: () => { try { sessionStorage.removeItem(LLAVE); } catch {} irALogin('vencida'); },
    salir
  };
})();
