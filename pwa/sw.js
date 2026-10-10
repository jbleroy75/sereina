// Service worker Sereina : application installable et page hors ligne.
// Pages : réseau d'abord (toujours la version à jour), copie de secours en cache. Fichiers statiques : cache d'abord.
// Jamais de cache pour /api/ et /admin/ (conversations, compte, paiements).
var V="sereina-__VERSION__",CORE=["/","/hors-ligne/","/urgence/","/static/style.css","/static/site.js","/static/icons/icon-192.png","/manifest.webmanifest"];
self.addEventListener("install",function(e){e.waitUntil(caches.open(V).then(function(c){return c.addAll(CORE)}).then(function(){return self.skipWaiting()}));});
self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==V}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}));});
self.addEventListener("fetch",function(e){
  var r=e.request,u=new URL(r.url);
  if(r.method!=="GET"||u.origin!==location.origin||u.pathname.indexOf("/api/")===0||u.pathname.indexOf("/admin")===0)return;
  if(r.mode==="navigate"){
    e.respondWith(fetch(r).then(function(res){if(res.ok&&u.pathname!=="/parler/"&&u.pathname!=="/mon-compte/"){var cp=res.clone();caches.open(V).then(function(c){c.put(r,cp)});}return res;})
      .catch(function(){return caches.match(r).then(function(m){return m||caches.match("/hors-ligne/")})}));
    return;
  }
  if(u.pathname.indexOf("/static/")===0){
    e.respondWith(caches.match(r).then(function(m){var net=fetch(r).then(function(res){if(res.ok){var cp=res.clone();caches.open(V).then(function(c){c.put(r,cp)});}return res;});return m||net;}));
  }
});
