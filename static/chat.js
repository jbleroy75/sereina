(function(){
  var PORTRAITS={};try{var sc=document.querySelector("script[data-portraits]");if(sc)PORTRAITS=JSON.parse(sc.getAttribute("data-portraits"));}catch(e){}
  var GUIDES={clara:["Clara","Anxiété et stress"],samuel:["Samuel","Sommeil et fatigue"],ines:["Inès","Couple et famille"],theo:["Théo","Épuisement au travail"],maya:["Maya","Deuil et séparation"],jeanne:["Jeanne","Solitude, retraite, avancée en âge"]};
  var $=function(s){return document.querySelector(s)};
  var log=$("#log"),input=$("#input"),sendBtn=$("#sendBtn"),stopBtn=$("#stopBtn"),composer=$("#composer"),sel=$("#guide"),quota=$("#quota");
  var params=new URLSearchParams(location.search);
  var guide=(params.get("avec")||"clara").toLowerCase();if(!GUIDES[guide])guide="clara";
  sel.value=guide;
  var busy=false,ctl=null,me=null,consent=false,pending=null;
  var CRISIS=/suicid|me tuer|en finir|plus envie de vivre|me faire du mal|mourir|disparaître|scarif/i;
  try{consent=localStorage.getItem("sereina-consent")==="1";}catch(e){}

  function add(cls,who,text){var d=document.createElement("div");d.className="turn "+cls;if(who){var b=document.createElement("b");b.textContent=who;d.appendChild(b);}d.appendChild(document.createTextNode(text));log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
  function setText(el,t){el.lastChild.nodeValue=t;log.scrollTop=log.scrollHeight;}
  function head(){var im=$("#headImg");if(im&&PORTRAITS[guide])im.src=PORTRAITS[guide];$("#headName").textContent=GUIDES[guide][0];$("#headRole").textContent=GUIDES[guide][1];var pg=document.querySelectorAll(".payGuide");for(var i=0;i<pg.length;i++)pg[i].textContent=GUIDES[guide][0];}
  function welcome(){log.innerHTML="";add("",GUIDES[guide][0],"Bonjour, je suis "+GUIDES[guide][0]+". Je vous écoute, prenez le temps qu'il vous faut. Qu'est-ce qui vous amène aujourd'hui ?");}
  function crisis(){if(log.querySelector(".crisis"))return;add("crisis","","Si vous pensez à vous faire du mal, vous n'êtes pas seul : appelez le 3114 (gratuit, 24 h/24) ou le 15. Un humain vous répondra.");}
  function setBusy(b){busy=b;sendBtn.disabled=b;stopBtn.hidden=!b;input.disabled=b;}
  function showQuota(){
    if(!me||!quota)return;
    if(me.free_exhausted){quota.textContent=me.credits>0?(me.credits+(me.credits>1?" crédits":" crédit")+(me.auto_recharge?" · recharge auto":"")):"Plus de crédits";return;}
    quota.textContent=me.free_started?"Essai gratuit en cours":"Essai gratuit : "+me.free_minutes+" min";
  }
  function loadMe(){return fetch("/api/me",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(m){me=m;showQuota();if(m.consent)consent=true;}).catch(function(){});}

  // Fenêtres
  var consentModal=$("#consentModal"),payModal=$("#payModal");
  function updateConsentBtn(){$("#consentOk").disabled=!($("#ck18").checked&&$("#ckData").checked);}
  $("#ck18").addEventListener("change",updateConsentBtn);$("#ckData").addEventListener("change",updateConsentBtn);
  $("#consentOk").addEventListener("click",function(){
    consent=true;try{localStorage.setItem("sereina-consent","1");}catch(e){}
    fetch("/api/consent",{method:"POST",credentials:"same-origin"}).catch(function(){});
    consentModal.hidden=true;if(pending){var t=pending;pending=null;send(t);}else input.focus();
  });
  $("#payLater").addEventListener("click",function(){payModal.hidden=true;});
  function buyLink(){var r=document.querySelector('input[name="pack"]:checked');var pack=r?r.value:"";$("#buyBtn").href="/api/checkout?pack="+encodeURIComponent(pack)+"&auto="+($("#autoCk").checked?"1":"0");}
  var radios=document.querySelectorAll('input[name="pack"]');
  for(var i=0;i<radios.length;i++)radios[i].addEventListener("change",function(){var ps=document.querySelectorAll(".pack");for(var j=0;j<ps.length;j++)ps[j].classList.toggle("sel",ps[j].querySelector("input").checked);buyLink();});
  $("#autoCk").addEventListener("change",buyLink);buyLink();
  document.addEventListener("keydown",function(e){if(e.key==="Escape"){payModal.hidden=true;}});

  head();welcome();loadMe();
  if(params.get("paid")==="1"){add("sys","","Merci, vos crédits ont été ajoutés. Vous pouvez continuer à écrire.");history.replaceState(null,"","/parler/?avec="+guide);}

  sel.addEventListener("change",function(){if(busy&&ctl)ctl.abort();guide=sel.value;head();welcome();history.replaceState(null,"","/parler/?avec="+guide);});
  $("#resetBtn").addEventListener("click",function(){if(busy&&ctl)ctl.abort();welcome();});
  stopBtn.addEventListener("click",function(){if(ctl)ctl.abort();});
  input.addEventListener("input",function(){input.style.height="auto";input.style.height=Math.min(input.scrollHeight,220)+"px";});

  async function send(forced){
    var text=forced||input.value.trim();if(!text||busy)return;
    if(!consent){pending=text;input.value="";consentModal.hidden=false;$("#ck18").focus();return;}
    if(me&&me.paywalled&&!me.auto_recharge){payModal.hidden=false;return;}
    input.value="";input.style.height="auto";add("me","Vous",text);if(CRISIS.test(text))crisis();
    var el=add("thinking",GUIDES[guide][0],"Réfléchit…");
    setBusy(true);ctl=new AbortController();
    try{
      var r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",signal:ctl.signal,body:JSON.stringify({guide:guide,message:text})});
      if(r.status===402){el.remove();if(me)me.paywalled=true;showQuota();payModal.hidden=false;return;}
      if(r.status===403){el.remove();consent=false;try{localStorage.removeItem("sereina-consent");}catch(e){}pending=text;consentModal.hidden=false;return;}
      if(r.status===429){el.remove();add("sys","","Trop de messages d'un coup. Attendez un instant, puis réessayez.");return;}
      if(!r.ok||!r.body){el.remove();add("sys","","Le service ne répond pas pour le moment. Réessayez dans quelques instants. En cas d'urgence : 15 ou 3114.");return;}
      var reader=r.body.getReader(),dec=new TextDecoder(),buf="",full="";
      while(true){
        var c=await reader.read();if(c.done)break;
        buf+=dec.decode(c.value,{stream:true});var lines=buf.split("\n");buf=lines.pop();
        for(var i=0;i<lines.length;i++){
          var line=lines[i];if(line.indexOf("data: ")!==0)continue;var ev;try{ev=JSON.parse(line.slice(6));}catch(e){continue}
          if(ev.delta){if(!full){el.classList.remove("thinking");}full+=ev.delta;setText(el,full);}
          if(ev.error)add("sys","",ev.error);
          if(ev.done&&me){if(typeof ev.credits==="number")me.credits=ev.credits;if(!ev.free){me.free_exhausted=true;}me.paywalled=me.free_exhausted&&me.credits<=0;showQuota();if(me.free_exhausted&&me.credits===0&&!me.auto_recharge)add("sys","","C'était votre dernier crédit. Vous pourrez en racheter au prochain message.");}
          if(ev.risk==="rouge")crisis();
        }
      }
      if(!full)el.remove();else if(CRISIS.test(full))crisis();
      if(me){me.free_started=true;showQuota();}
    }catch(e){
      if(e.name==="AbortError"){if(el.classList.contains("thinking"))el.remove();}
      else{el.remove();add("sys","","La connexion a été interrompue. Vous pouvez renvoyer votre message.");}
    }finally{setBusy(false);ctl=null;input.focus();}
  }
  composer.addEventListener("submit",function(e){e.preventDefault();send();});
  input.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}});
})();
