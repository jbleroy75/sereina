(function(){
  var $=function(s){return document.querySelector(s)};
  var params=new URLSearchParams(location.search),back=params.get("retour")||"";
  if(!/^\/[a-z0-9\-\/?=&]*$/i.test(back)||back.indexOf("//")===0)back="";
  function post(u,b){return fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify(b||{})}).then(function(r){return r.json().catch(function(){return{}}).then(function(j){j._ok=r.ok;return j})});}
  function render(m){
    $("#accCredits").textContent=m.credits+(m.credits>1?" crédits":" crédit")+" (1 crédit = 1 message)";
    $("#accFree").textContent=m.trial_denied?"Déjà utilisés sur cet appareil ou avec cette adresse":m.free_exhausted?"Utilisés":(m.free_minutes+" minutes ou "+m.free_messages+" messages, le premier atteint.");
    var auto=$("#accAuto");auto.innerHTML="";
    var lab=document.createElement("label");lab.className="check";var ck=document.createElement("input");ck.type="checkbox";ck.checked=m.auto_recharge;ck.disabled=!m.can_auto&&!m.auto_recharge;
    var pk=(m.packs.find(function(p){return p.key===m.auto_pack})||m.packs[0]);
    lab.appendChild(ck);lab.appendChild(document.createTextNode(m.can_auto||m.auto_recharge?" Racheter automatiquement le pack « "+pk.label+" » ("+pk.credits+" crédits, "+pk.price+") quand mes crédits sont épuisés.":" Disponible après un premier achat par carte."));
    auto.appendChild(lab);
    ck.onchange=function(){post("/api/me/auto",{enabled:ck.checked}).catch(function(){})};
    $("#portalBtn").hidden=!m.has_customer;
    if(m.purchases&&m.purchases.length){$("#purchases").innerHTML="";m.purchases.forEach(function(p){var li=document.createElement("li");li.textContent=new Date(p.date).toLocaleDateString("fr-FR")+" : "+p.credits+" crédits, "+p.price+(p.kind==="auto"?" (recharge automatique)":"");$("#purchases").appendChild(li)});}
    // Adresse e-mail
    $("#mailOut").hidden=!!m.email;$("#mailIn").hidden=!m.email;
    if(m.email){$("#mailShown").textContent=m.email;$("#mkCk").checked=!!m.marketing_optin;}
  }
  function load(){return fetch("/api/me",{credentials:"same-origin"}).then(function(r){return r.json()}).then(render).catch(function(){$("#accCredits").textContent="Le service ne répond pas pour le moment."});}
  load();

  var step=1,emailVal="";
  $("#mailForm").addEventListener("submit",function(e){
    e.preventDefault();var msg=$("#mailMsg"),btn=$("#mailBtn");btn.disabled=true;msg.className="sub";
    if(step===1){
      emailVal=$("#mailEmail").value.trim();msg.textContent="Envoi du code…";
      post("/api/auth/request-code",{email:emailVal}).then(function(j){
        btn.disabled=false;
        if(!j._ok){msg.className="sub err";msg.textContent=j.error||"Impossible d'envoyer le code.";return;}
        step=2;$("#codeRow").hidden=false;$("#mailEmail").readOnly=true;btn.textContent="Valider le code";$("#mailCode").focus();
        msg.textContent="Un code à 6 chiffres vient de vous être envoyé à "+emailVal+". Il est valable 10 minutes. Pensez à regarder dans les courriers indésirables.";
      }).catch(function(){btn.disabled=false;msg.textContent="Le service ne répond pas pour le moment.";});
    }else{
      msg.textContent="Vérification…";
      post("/api/auth/verify",{email:emailVal,code:$("#mailCode").value.replace(/\D/g,""),marketing:$("#mailMk").checked}).then(function(j){
        btn.disabled=false;
        if(!j._ok){msg.className="sub err";msg.textContent=j.error||"Code incorrect.";return;}
        msg.className="sub ok";msg.textContent=j.merged?"C'est fait : vous avez retrouvé votre espace. Vos crédits et vos conversations de cet appareil y ont été ajoutés.":j.created?"C'est fait : votre espace est maintenant rattaché à votre adresse e-mail.":"Vous êtes connecté.";
        if(back){setTimeout(function(){location.href=back},1200);return;}
        step=1;$("#codeRow").hidden=true;$("#mailEmail").readOnly=false;$("#mailCode").value="";$("#mailBtn").textContent="Recevoir un code";load();
      }).catch(function(){btn.disabled=false;msg.textContent="Le service ne répond pas pour le moment.";});
    }
  });
  $("#mailChange").addEventListener("click",function(){step=1;$("#codeRow").hidden=true;$("#mailEmail").readOnly=false;$("#mailBtn").textContent="Recevoir un code";$("#mailMsg").textContent="";$("#mailEmail").focus();});
  $("#mkCk").addEventListener("change",function(){post("/api/me/marketing",{enabled:this.checked});});
  $("#logoutBtn").addEventListener("click",function(){post("/api/auth/logout").then(function(){try{localStorage.removeItem("sereina-consent")}catch(e){}location.reload();});});

  $("#deleteBtn").onclick=function(){$("#deleteModal").hidden=false};
  $("#deleteNo").onclick=function(){$("#deleteModal").hidden=true};
  $("#deleteOk").onclick=function(){
    fetch("/api/me/delete",{method:"POST",credentials:"same-origin"}).then(function(){$("#deleteModal").hidden=true;$("#deleteMsg").textContent="Vos données ont été supprimées.";$("#accCredits").textContent="0 crédit";$("#accFree").textContent="";$("#accAuto").textContent="Désactivée";$("#mailIn").hidden=true;$("#mailOut").hidden=false;try{localStorage.removeItem("sereina-consent")}catch(e){}});
  };
})();
