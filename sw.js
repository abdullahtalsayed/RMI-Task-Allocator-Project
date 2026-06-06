// bump this string on every deploy to force-refresh clients
const CACHE='rmi-v2.4.9';

self.addEventListener('install',e=>{
  self.skipWaiting(); // activate new SW immediately
});

self.addEventListener('activate',e=>{
  e.waitUntil((async()=>{
    // delete every old cache
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));
    await self.clients.claim(); // take control of open pages now
  })());
});

self.addEventListener('fetch',e=>{
  const req=e.request;
  // only handle same-origin GET
  if(req.method!=='GET'||new URL(req.url).origin!==self.location.origin)return;
  // NETWORK-FIRST: always try fresh, fall back to cache only when offline
  e.respondWith((async()=>{
    try{
      const fresh=await fetch(req,{cache:'no-store'});
      const cache=await caches.open(CACHE);
      cache.put(req,fresh.clone());
      return fresh;
    }catch(err){
      const cached=await caches.match(req);
      return cached||caches.match('./index.html');
    }
  })());
});
