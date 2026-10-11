(function(){
  // Affiche les avis publiés (validés par l'équipe, avec l'accord de leur auteur). Sans avis, la section reste masquée.
  var box=document.querySelector("[data-reviews]");if(!box||!window.fetch)return;
  var GUIDES={clara:"Clara",samuel:"Samuel",ines:"Inès",theo:"Théo",maya:"Maya",jeanne:"Jeanne"};
  var guide=box.getAttribute("data-guide")||"";
  fetch("/api/reviews"+(guide?"?guide="+encodeURIComponent(guide):""),{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(d){
    var list=d&&d.reviews||[];if(!list.length)return;
    var ul=box.querySelector(".reviews");
    list.forEach(function(r){
      var li=document.createElement("li"),fig=document.createElement("figure"),st=document.createElement("div"),bq=document.createElement("blockquote"),cap=document.createElement("figcaption");
      st.className="rv-stars";st.setAttribute("role","img");st.setAttribute("aria-label","Note : "+r.rating+" sur 5");st.textContent="★★★★★".slice(0,r.rating)+"☆☆☆☆☆".slice(0,5-r.rating);
      bq.textContent=r.comment;
      cap.textContent=(r.name?r.name:"Une personne ayant utilisé Sereina")+(r.guide&&GUIDES[r.guide]&&!guide?" · avec "+GUIDES[r.guide]:"");
      fig.appendChild(st);fig.appendChild(bq);fig.appendChild(cap);li.appendChild(fig);ul.appendChild(li);
    });
    box.hidden=false;
  }).catch(function(){});
})();
