(function(){
  var b=document.getElementById("sizeBtn");
  function apply(large){
    if(large)document.documentElement.setAttribute("data-size","large");else document.documentElement.removeAttribute("data-size");
    if(b){b.textContent=large?"Texte normal":"Agrandir le texte";b.setAttribute("aria-pressed",String(large));}
    try{localStorage.setItem("sereina-size",large?"large":"normal");}catch(e){}
  }
  var large=false;try{large=localStorage.getItem("sereina-size")==="large";}catch(e){}
  apply(large);
  if(b)b.addEventListener("click",function(){large=!large;apply(large);});

  var links=[].slice.call(document.querySelectorAll(".toc a[href^='#']"));
  if(links.length&&"IntersectionObserver" in window){
    var secs=links.map(function(a){return document.getElementById(a.getAttribute("href").slice(1));}).filter(Boolean);
    var io=new IntersectionObserver(function(es){
      es.forEach(function(e){if(e.isIntersecting){links.forEach(function(a){a.classList.toggle("on",a.getAttribute("href")==="#"+e.target.id);});}});
    },{rootMargin:"-25% 0px -65% 0px"});
    secs.forEach(function(s){io.observe(s);});
  }
})();
(function(){
  // Application installable : enregistrement du service worker et proposition d'installation, discrète et refusable.
  if("serviceWorker" in navigator&&location.protocol!=="file:")window.addEventListener("load",function(){navigator.serviceWorker.register("/sw.js").catch(function(){});});
  var KEY="sereina-install",standalone=window.matchMedia("(display-mode: standalone)").matches||navigator.standalone;
  var seen=null;try{seen=localStorage.getItem(KEY);}catch(e){}
  if(standalone||seen||location.pathname.indexOf("/parler")===0)return;
  var deferred=null,ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
  function bar(text,act){
    var d=document.createElement("div");d.className="installbar";d.setAttribute("role","region");d.setAttribute("aria-label","Installer Sereina");
    var p=document.createElement("p");p.textContent=text;d.appendChild(p);
    var b=document.createElement(act?"button":"a");b.className="btn small";b.textContent="Installer";if(act){b.type="button";b.onclick=act;}else b.href="/application/";d.appendChild(b);
    var x=document.createElement("button");x.type="button";x.className="ghost small";x.textContent="Non merci";x.onclick=function(){d.remove();try{localStorage.setItem(KEY,"no")}catch(e){}};d.appendChild(x);
    document.body.appendChild(d);return d;
  }
  window.addEventListener("beforeinstallprompt",function(e){
    e.preventDefault();deferred=e;
    setTimeout(function(){var d=bar("Ajoutez Sereina sur votre écran d'accueil pour la retrouver en un geste.",function(){d.remove();deferred.prompt();deferred.userChoice.then(function(){try{localStorage.setItem(KEY,"done")}catch(e){}});});},20000);
  });
  if(ios)setTimeout(function(){bar("Sur iPhone, vous pouvez ajouter Sereina à votre écran d'accueil.",null);},20000);
})();
