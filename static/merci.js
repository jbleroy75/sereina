(function(){
  var p=new URLSearchParams(location.search),$=function(s){return document.querySelector(s)};
  var dl=p.get("dl")||"",g=p.get("g")||"";
  if(p.get("erreur")){$("#okBox").hidden=true;$("#errBox").hidden=false;return;}
  if(/^\/api\/guides\/[a-z0-9-]+\.pdf\?/.test(dl)){
    var a=$("#dlBtn");a.href=dl;a.hidden=false;
    var t=document.querySelector('[data-guide-title="'+g.replace(/[^a-z0-9-]/g,"")+'"]');if(t)$("#dlName").textContent="« "+t.getAttribute("data-title")+" »";
  }
})();
