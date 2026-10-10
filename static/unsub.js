(function(){
  // Désinscription : on demande un clic de confirmation (les robots des messageries ouvrent parfois les liens).
  var p=new URLSearchParams(location.search),$=function(s){return document.querySelector(s)};
  var t=p.get("t"),id=p.get("id"),s=p.get("s");
  if(!t||!id||!s){$("#unsubAsk").hidden=true;$("#unsubErr").hidden=false;return;}
  $("#unsubWhat").textContent=t==="n"?"la lettre Sereina et ses guides":"les messages de suivi de Sereina (nouvelles, rappels)";
  $("#unsubBtn").addEventListener("click",function(){
    var b=this;b.disabled=true;
    fetch("/api/unsubscribe",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({t:t,id:id,s:s})})
      .then(function(r){$("#unsubAsk").hidden=true;if(r.ok)$("#unsubOk").hidden=false;else $("#unsubErr").hidden=false;})
      .catch(function(){b.disabled=false;$("#unsubMsg").textContent="Le service ne répond pas pour le moment. Réessayez dans un instant.";});
  });
})();
