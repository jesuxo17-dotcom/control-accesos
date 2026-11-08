/* Service Worker: solo recursos estáticos públicos. Nunca cachea datos privados. */
const CACHE='lince-tutores-static-v10-nombre-o-matricula';
const FILES=['/tutores/','/tutores/index.html','/tutores/styles.css','/tutores/app.js','/tutores/icons/icon-192.png','/tutores/icons/icon-512.png','/tutores/icons/logo-uadeo.jpeg','/tutores/icons/logo-lince.png','/tutores/sounds/ingreso.wav','/tutores/sounds/egreso.wav'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(x=>x!==CACHE).map(x=>caches.delete(x)))));
  self.clients.claim();
});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET'||new URL(req.url).pathname.startsWith('/api/')) return;
  if(new URL(req.url).origin!==self.location.origin) return;
  event.respondWith(fetch(req).then(resp=>{
    if(resp.ok){const copia=resp.clone();caches.open(CACHE).then(c=>c.put(req,copia));}
    return resp;
  }).catch(()=>caches.match(req)));
});
self.addEventListener('push',event=>{
  let d={titulo:'LinceTutores',cuerpo:'Nuevo movimiento registrado.',url:'/tutores/'};
  try{if(event.data)d={...d,...event.data.json()};}catch{}
  event.waitUntil(self.registration.showNotification(d.titulo,{body:d.cuerpo,icon:'/tutores/icons/icon-192.png',badge:'/tutores/icons/icon-192.png',tag:'lince-acceso-'+(d.evento_id||Date.now()),renotify:true,data:{url:d.url}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url||'/tutores/'));
});
