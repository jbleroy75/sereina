(function(){
  // Formulaires d'inscription à la lettre et aux guides (double consentement : un e-mail de confirmation est envoyé).
  var forms=document.querySelectorAll("form.nlform");
  Array.prototype.forEach.call(forms,function(f){
    f.addEventListener("submit",function(e){
      e.preventDefault();
      var msg=f.querySelector(".nlmsg"),btn=f.querySelector("button[type=submit]"),email=f.querySelector("input[type=email]");
      var sel=f.querySelector("select[name=guide]");
      var body={email:email.value.trim(),guide:sel?sel.value:(f.getAttribute("data-guide")||""),source:f.getAttribute("data-source")||location.pathname,website:(f.querySelector("input[name=website]")||{}).value||""};
      btn.disabled=true;msg.className="nlmsg";msg.textContent="Envoi…";
      fetch("/api/newsletter",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify(body)})
        .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
        .then(function(x){
          if(!x.ok){msg.className="nlmsg err";msg.textContent=x.j.error||"L'inscription n'a pas abouti. Réessayez dans un instant.";btn.disabled=false;return;}
          msg.className="nlmsg ok";
          msg.textContent=x.j.already?"Vous êtes déjà inscrit : le guide vient de vous être envoyé par e-mail.":"C'est presque fini : ouvrez l'e-mail que nous venons de vous envoyer et cliquez sur le lien pour confirmer. Pensez à regarder dans les courriers indésirables.";
          email.value="";btn.disabled=false;
        })
        .catch(function(){msg.className="nlmsg err";msg.textContent="Le service ne répond pas pour le moment. Réessayez dans un instant.";btn.disabled=false;});
    });
  });
})();
