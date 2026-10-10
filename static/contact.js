document.getElementById("contactForm").addEventListener("submit",function(e){
  e.preventDefault();var f=e.target,d={};new FormData(f).forEach(function(v,k){d[k]=v});
  f.querySelector("button").disabled=true;
  fetch("/api/contact",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)}).then(function(r){
    document.getElementById("contactMsg").textContent=r.ok?"Merci, votre message a bien été envoyé.":"L'envoi a échoué. Réessayez plus tard.";
    if(r.ok)f.reset();}).catch(function(){document.getElementById("contactMsg").textContent="L'envoi a échoué. Réessayez plus tard."})
    .finally(function(){f.querySelector("button").disabled=false});
});
