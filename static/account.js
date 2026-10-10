(function(){
  var $=function(s){return document.querySelector(s)};
  function render(m){
    $("#accCredits").textContent=m.credits+(m.credits>1?" crédits":" crédit")+" (1 crédit = 1 message)";
    $("#accFree").textContent=m.free_exhausted?"Utilisés":(m.free_minutes+" minutes ou "+m.free_messages+" messages, le premier atteint.");
    var auto=$("#accAuto");auto.innerHTML="";
    var lab=document.createElement("label");lab.className="check";var ck=document.createElement("input");ck.type="checkbox";ck.checked=m.auto_recharge;ck.disabled=!m.can_auto&&!m.auto_recharge;
    var pk=(m.packs.find(function(p){return p.key===m.auto_pack})||m.packs[0]);
    lab.appendChild(ck);lab.appendChild(document.createTextNode(m.can_auto||m.auto_recharge?" Racheter automatiquement le pack « "+pk.label+" » ("+pk.credits+" crédits, "+pk.price+") quand mes crédits sont épuisés.":" Disponible après un premier achat par carte."));
    auto.appendChild(lab);
    ck.onchange=function(){fetch("/api/me/auto",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({enabled:ck.checked})}).catch(function(){})};
    $("#portalBtn").hidden=!m.has_customer;
    if(m.purchases&&m.purchases.length){$("#purchases").innerHTML="";m.purchases.forEach(function(p){var li=document.createElement("li");li.textContent=new Date(p.date).toLocaleDateString("fr-FR")+" : "+p.credits+" crédits, "+p.price+(p.kind==="auto"?" (recharge automatique)":"");$("#purchases").appendChild(li)});}
  }
  fetch("/api/me",{credentials:"same-origin"}).then(function(r){return r.json()}).then(render).catch(function(){$("#accCredits").textContent="Le service ne répond pas pour le moment."});
  $("#deleteBtn").onclick=function(){$("#deleteModal").hidden=false};
  $("#deleteNo").onclick=function(){$("#deleteModal").hidden=true};
  $("#deleteOk").onclick=function(){
    fetch("/api/me/delete",{method:"POST",credentials:"same-origin"}).then(function(){$("#deleteModal").hidden=true;$("#deleteMsg").textContent="Vos données ont été supprimées.";$("#accCredits").textContent="0 crédit";$("#accFree").textContent="";$("#accAuto").textContent="Désactivée";try{localStorage.removeItem("sereina-consent")}catch(e){}});
  };
})();
