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
