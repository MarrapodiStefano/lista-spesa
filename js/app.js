if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js?v=97", { updateViaCache: "none" });
      await registration.update();

      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (sessionStorage.getItem("listaSpesaReloaded") === "1") return;
        sessionStorage.setItem("listaSpesaReloaded", "1");
        window.location.reload();
      });
    } catch (error) {
      console.error("Service Worker:", error);
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const DB_KEY="listaSpesaDB";
  const MASTER_API_URL="https://lista-spesa-master.stef976.workers.dev/master";
  const normalizeProductName=name=>String(name||"").trim().toLocaleLowerCase("it-IT").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ");
  // Un prodotto è duplicato solo se coincidono nome E formato.
  // Esempio: Nutella 200g e Nutella 300g sono due prodotti diversi.
  const getProductFormat=p=>{
    const weight=p?.weight??p?.quantity??"";
    const pieces=p?.pieces??"";
    return normalizeProductName(String(weight)+"|"+String(pieces));
  };
  const getProductDuplicateKey=p=>normalizeProductName(p?.name)+"||"+getProductFormat(p);
  const syncMasterLibrary=async({silent=false}={})=>{
    const btn=$("syncMasterLibraryBtn");
    if(btn){btn.disabled=true;btn.classList.add("is-syncing");btn.textContent="↻ Aggiornamento...";}
    try{
      const response=await fetch(MASTER_API_URL+"?v="+Date.now(),{cache:"no-store"});
      if(!response.ok)throw new Error("HTTP "+response.status);
      const payload=await response.json();
      if(!payload.success||!Array.isArray(payload.products))throw new Error(payload.error||"Formato non valido");
      const master=payload.products;
      const existing=new Set(state.products.map(getProductDuplicateKey));
      let added=0,skipped=0;
      master.forEach((raw,index)=>{
        if(!raw||!String(raw.name||"").trim())return;
        const key=getProductDuplicateKey(raw);
        if(existing.has(key)){skipped++;return;}
        state.products.push({id:raw.id||("master-"+Date.now()+"-"+index+"-"+Math.random().toString(36).slice(2,7)),name:String(raw.name).trim(),price:raw.price??"",promoPrice:raw.promoPrice??"",weight:raw.weight??raw.quantity??"",pieces:raw.pieces??1,store:raw.store??"",photo:raw.photo??"",barcode:raw.barcode??""});
        existing.add(key);added++;
      });
      save();
      if($("productPanel").getAttribute("aria-hidden")==="false")renderLibrary($("productSearch").value);
      if(!silent)alert("📦 Libreria Master aggiornata\n\n✅ "+added+" nuovi prodotti aggiunti\n⏭️ "+skipped+" prodotti già presenti");
      return {added,skipped};
    }catch(error){console.error("Errore Libreria Master:",error);if(!silent)alert("⚠️ Non riesco a scaricare la Libreria Master. Riprova.");return null;}
    finally{if(btn){btn.disabled=false;btn.classList.remove("is-syncing");btn.textContent="↻ Aggiorna libreria prodotti";}}
  };

  // Controllo automatico degli aggiornamenti della Libreria Master.
  // La firma viene calcolata dai prodotti stessi, senza dipendere da updatedAt del Worker.
  const MASTER_SIGNATURE_KEY="listaSpesaMasterSignatureV2";
  let masterCheckRunning=false;
  const checkMasterUpdate=async()=>{
    if(masterCheckRunning)return;
    masterCheckRunning=true;
    try{
      const response=await fetch(MASTER_API_URL+"?check="+Date.now(),{cache:"no-store"});
      if(!response.ok)throw new Error("HTTP "+response.status);
      const payload=await response.json();
      if(!payload.success||!Array.isArray(payload.products))return;

      const master=payload.products.filter(p=>p&&String(p.name||"").trim());
      const localKeys=new Set(state.products.map(getProductDuplicateKey));
      const missing=master.filter(p=>!localKeys.has(getProductDuplicateKey(p)));

      // Firma stabile: se il Worker restituisce gli stessi prodotti, la firma è identica.
      const signature=master
        .map(p=>getProductDuplicateKey(p))
        .sort()
        .join("§");

      const previous=localStorage.getItem(MASTER_SIGNATURE_KEY);

      // Avvisa quando esistono prodotti Master non presenti sul dispositivo.
      if(missing.length>0 && previous!==signature && !isAdminMode()){
        localStorage.setItem(MASTER_SIGNATURE_KEY,signature);
        setTimeout(()=>{
          alert("☁️ Nuovi prodotti disponibili!\n\nCi sono "+missing.length+" nuovi prodotti nella Libreria Master. Entra in “I miei prodotti” e premi “Aggiorna libreria prodotti” per importarli.");
        },500);
      }else if(missing.length===0){
        // Quando il dispositivo è allineato, questa versione diventa il riferimento.
        localStorage.setItem(MASTER_SIGNATURE_KEY,signature);
      }
    }catch(error){
      console.warn("Controllo aggiornamenti Libreria Master:",error);
    }finally{
      masterCheckRunning=false;
    }
  };

  let pendingPhoto="";
  let editingProductId=null;
  let editingShoppingId=null;
  let editingReminderId=null;
  let scanner=null; let scannerControls=null; let scannerRunning=false; let processingBarcode=false; let scanLoopId=null; let scannerStream=null;
  const DEFAULT_STATE={products:[],currentShopping:[],purchasedShopping:[],currentShoppingName:"La mia spesa",history:[],reminders:[]};
  const IDB_NAME="listaSpesaIndexedDB";
  const IDB_VERSION=1;
  const IDB_STORE="appState";
  const IDB_STATE_KEY="main";

  const openDatabase=()=>new Promise((resolve,reject)=>{
    const request=indexedDB.open(IDB_NAME,IDB_VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });

  const loadState=async()=>{
    try{
      const db=await openDatabase();
      const value=await new Promise((resolve,reject)=>{
        const request=db.transaction(IDB_STORE,"readonly").objectStore(IDB_STORE).get(IDB_STATE_KEY);
        request.onsuccess=()=>resolve(request.result);
        request.onerror=()=>reject(request.error);
      });
      db.close();
      return value&&typeof value==="object"?{...DEFAULT_STATE,...value}:structuredClone(DEFAULT_STATE);
    }catch(error){
      console.error("Errore apertura archivio IndexedDB",error);
      return structuredClone(DEFAULT_STATE);
    }
  };

  let state=await loadState();
  // Modalità amministratore: resta attiva solo su questo dispositivo.
  const ADMIN_PIN="6414";
  const ADMIN_KEY="listaSpesaAdminMode";
  const isAdminMode=()=>localStorage.getItem(ADMIN_KEY)==="true";
  const updateAdminUI=()=>{
    const exportBtn=$("exportMasterLibraryBtn");
    const syncBtn=$("syncMasterLibraryBtn");
    const exitBtn=$("exitAdminModeBtn");
    const admin=isAdminMode();

    // Solo l'amministratore può pubblicare la Libreria Master.
    if(exportBtn) exportBtn.hidden=!admin;

    // L'amministratore non deve vedere il pulsante di aggiornamento.
    if(syncBtn) syncBtn.hidden=admin;

    // Il pulsante di uscita è visibile solo in modalità amministratore.
    if(exitBtn) exitBtn.hidden=!admin;
  };

  const exitAdminMode=()=>{
    localStorage.removeItem(ADMIN_KEY);
    updateAdminUI();
    alert("🔒 Modalità amministratore disattivata. Questo dispositivo è tornato alla modalità utente.");
  };
  const openAdminLogin=()=>{
    $("adminPinInput").value="";
    $("adminLoginError").hidden=true;
    $("adminLoginModal").setAttribute("aria-hidden","false");
    setTimeout(()=>$("adminPinInput").focus(),50);
  };
  const closeAdminLogin=()=>$("adminLoginModal").setAttribute("aria-hidden","true");
  const confirmAdminLogin=()=>{
    if($("adminPinInput").value===ADMIN_PIN){
      localStorage.setItem(ADMIN_KEY,"true");
      updateAdminUI();
      closeAdminLogin();
      alert("👑 Modalità amministratore attivata su questo dispositivo.");
    }else{
      $("adminLoginError").hidden=false;
      $("adminPinInput").select();
    }
  };
  if(!Array.isArray(state.currentShopping)) state.currentShopping=[];
  if(!state.currentShoppingName) state.currentShoppingName="La mia spesa";
  if(state.currentShoppingStore===undefined) state.currentShoppingStore="";
  if(state.currentShoppingDate===undefined) state.currentShoppingDate="";
  if(!Array.isArray(state.purchasedShopping)) state.purchasedShopping=[];
  if(!Array.isArray(state.reminders)) state.reminders=[];
  const migrateProductFields=items=>items.forEach(p=>{
    if(p.weight===undefined||p.weight===null) p.weight=p.quantity??"";
    if(p.pieces===undefined||p.pieces===null) p.pieces=1;
    if(p.store===undefined||p.store===null) p.store="";
    if(p.promoPrice===undefined||p.promoPrice===null) p.promoPrice="";
    if(p.note===undefined||p.note===null) p.note="";
  });
  migrateProductFields(state.products);
  migrateProductFields(state.currentShopping);
  migrateProductFields(state.purchasedShopping);
  const ensureShoppingIds=items=>items.forEach((p,i)=>{if(!p._shoppingId)p._shoppingId="shop-"+Date.now()+"-"+i+"-"+Math.random().toString(36).slice(2,8);});
  const migrateShoppingPriceFields=items=>items.forEach(p=>{
    if(p.regularPrice===undefined||p.regularPrice===null) p.regularPrice=p.price??"";
    if(p.promoPrice===undefined||p.promoPrice===null) p.promoPrice="";
    if(p.usePromo===undefined||p.usePromo===null) p.usePromo=false;
    if(p.note===undefined||p.note===null) p.note="";
  });
  migrateShoppingPriceFields(state.currentShopping);
  migrateShoppingPriceFields(state.purchasedShopping);
  ensureShoppingIds(state.currentShopping);
  ensureShoppingIds(state.purchasedShopping);
  const $=id=>document.getElementById(id);
  $("syncMasterLibraryBtn").onclick=()=>syncMasterLibrary();

  // Accesso amministratore: tap prolungato sul vero titolo del pannello Libreria.
  let adminPressTimer=null;
  const adminTitle=$("productPanelTitle");
  if(adminTitle){
    const startAdminPress=e=>{
      // Evita la selezione del testo su iPhone durante il tap prolungato.
      e.preventDefault();
      if(adminPressTimer)clearTimeout(adminPressTimer);
      adminPressTimer=setTimeout(()=>{
        adminPressTimer=null;
        if(!isAdminMode())openAdminLogin();
      },750);
    };
    const cancelAdminPress=()=>{if(adminPressTimer){clearTimeout(adminPressTimer);adminPressTimer=null;}};
    adminTitle.addEventListener("pointerdown",startAdminPress,{passive:false});
    adminTitle.addEventListener("pointerup",cancelAdminPress);
    adminTitle.addEventListener("pointerleave",cancelAdminPress);
    adminTitle.addEventListener("pointercancel",cancelAdminPress);
    adminTitle.addEventListener("contextmenu",e=>e.preventDefault());
    adminTitle.addEventListener("selectstart",e=>e.preventDefault());
  }
  $("adminCancelBtn").onclick=closeAdminLogin;
  $("adminConfirmBtn").onclick=confirmAdminLogin;
  $("adminPinInput").addEventListener("keydown",e=>{if(e.key==="Enter")confirmAdminLogin();});
  $("adminLoginModal").addEventListener("click",e=>{if(e.target===$("adminLoginModal"))closeAdminLogin();});
  $("exitAdminModeBtn").onclick=exitAdminMode;
  updateAdminUI();

  // Solo l'amministratore può pubblicare la libreria locale nella Libreria Master.
  // La chiave del Worker non viene salvata sul telefono.
  $("exportMasterLibraryBtn").onclick=async()=>{
    if(!isAdminMode())return;
    const adminKey=prompt("Chiave amministratore per pubblicare la Libreria Master:");
    if(!adminKey)return;

    const master=state.products.map(({id,name,price,weight,pieces,store,photo,barcode})=>({
      id,name,price,weight,pieces,store,photo,barcode
    }));

    const btn=$("exportMasterLibraryBtn");
    btn.disabled=true;
    const originalText=btn.textContent;
    btn.textContent="☁️ Pubblicazione...";
    try{
      const response=await fetch(MASTER_API_URL,{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "X-Admin-Key":adminKey
        },
        body:JSON.stringify({products:master})
      });
      const result=await response.json().catch(()=>({success:false,error:"Risposta non valida"}));
      if(!response.ok||!result.success)throw new Error(result.error||"Pubblicazione non riuscita");

      localStorage.setItem(MASTER_SIGNATURE_KEY,result.updatedAt||JSON.stringify(master));
      alert("☁️ Libreria Master pubblicata correttamente su GitHub.");
    }catch(error){
      console.error("Pubblicazione Libreria Master:",error);
      alert("⚠️ Non riesco a pubblicare la Libreria Master. Controlla la chiave amministratore e riprova.");
    }finally{
      btn.disabled=false;
      btn.textContent=originalText;
    }
  };
  // Il controllo parte subito e viene ripetuto quando la PWA torna in primo piano.
  // Non importiamo automaticamente i prodotti: l'utente deve prima ricevere la notifica
  // e decidere quando aggiornare la propria libreria.
  checkMasterUpdate();
  window.addEventListener("pageshow",()=>{checkMasterUpdate();});
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="visible") checkMasterUpdate();
  });

  // Aggiornamento manuale della PWA: utile su iPhone dove non esiste il classico refresh.
  $("forceUpdateBtn").onclick=async()=>{
    const btn=$("forceUpdateBtn");
    if(btn.classList.contains("is-updating"))return;

    // Feedback visivo immediato: l'icona gira per tutta la durata
    // dell'operazione, prima del riavvio della PWA.
    btn.classList.add("is-updating");
    btn.disabled=true;
    btn.setAttribute("aria-label","Aggiornamento in corso");

    try{
      if("serviceWorker" in navigator){
        const registration=await navigator.serviceWorker.getRegistration();
        if(registration){
          await registration.update();
          if(registration.waiting)registration.waiting.postMessage({type:"SKIP_WAITING"});
        }
      }

      // Manteniamo l'animazione visibile abbastanza a lungo da rendere
      // chiaramente percepibile l'aggiornamento, anche se è molto rapido.
      await new Promise(resolve=>setTimeout(resolve,900));

      // Bypass della cache mantenendo intatti tutti i dati salvati in localStorage.
      const url=new URL(window.location.href);
      url.searchParams.set("_update",Date.now().toString());
      window.location.replace(url.toString());
    }catch(error){
      console.error("Aggiornamento manuale:",error);
      await new Promise(resolve=>setTimeout(resolve,500));
      window.location.reload();
    }
  };
  let saveTimer=null;
  let saveInProgress=Promise.resolve();

  const persistState=async snapshot=>{
    const db=await openDatabase();
    await new Promise((resolve,reject)=>{
      const request=db.transaction(IDB_STORE,"readwrite").objectStore(IDB_STORE).put(snapshot,IDB_STATE_KEY);
      request.onsuccess=()=>resolve();
      request.onerror=()=>reject(request.error);
    });
    db.close();
  };

  const save=()=>{
    // IndexedDB non ha il piccolo limite di localStorage e salva anche foto e librerie grandi.
    const snapshot=structuredClone(state);
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>{
      saveInProgress=saveInProgress
        .catch(()=>{})
        .then(()=>persistState(snapshot))
        .catch(error=>console.error("Errore nel salvataggio IndexedDB",error));
    },50);
    return true;
  };

  // Salvataggio immediato, usato quando l'app viene chiusa o passa in background.
  const saveNow=()=>{
    const snapshot=structuredClone(state);
    clearTimeout(saveTimer);
    saveInProgress=saveInProgress
      .catch(()=>{})
      .then(()=>persistState(snapshot))
      .catch(error=>console.error("Errore nel salvataggio IndexedDB",error));
    return saveInProgress;
  };

  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="hidden") saveNow();
  });
  window.addEventListener("pagehide",()=>{saveNow();});

  // Migrazione una tantum: comprime anche le foto già presenti nella libreria,
  // create prima dell'introduzione della compressione automatica.
  const recompressStoredPhoto=dataUrl=>new Promise(resolve=>{
    if(!dataUrl||!String(dataUrl).startsWith("data:image/")) return resolve(dataUrl);
    const img=new Image();
    img.onload=()=>{
      try{
        const MAX_SIDE=900;
        const scale=Math.min(1,MAX_SIDE/Math.max(img.width||1,img.height||1));
        const canvas=document.createElement("canvas");
        canvas.width=Math.max(1,Math.round(img.width*scale));
        canvas.height=Math.max(1,Math.round(img.height*scale));
        const ctx=canvas.getContext("2d",{alpha:false});
        ctx.fillStyle="#fff";
        ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img,0,0,canvas.width,canvas.height);
        let quality=.78;
        let output=canvas.toDataURL("image/jpeg",quality);
        while(output.length>600000&&quality>.35){
          quality-=.08;
          output=canvas.toDataURL("image/jpeg",quality);
        }
        resolve(output);
      }catch(error){
        console.error("Compressione foto esistente:",error);
        resolve(dataUrl);
      }
    };
    img.onerror=()=>resolve(dataUrl);
    img.src=dataUrl;
  });

  const migrateStoredPhotos=async()=>{
    const MIGRATION_KEY="listaSpesaPhotoMigrationV2_11";
    if(localStorage.getItem(MIGRATION_KEY)==="done") return;
    const lists=[state.products,state.currentShopping,state.purchasedShopping,state.reminders];
    const seen=new Map();
    lists.forEach(list=>(Array.isArray(list)?list:[]).forEach(item=>{
      if(item&&item.photo&&item.id&&!seen.has(item.id)) seen.set(item.id,item.photo);
    }));
    if(!seen.size){localStorage.setItem(MIGRATION_KEY,"done");return;}

    const compressed=new Map();
    for(const [id,photo] of seen) compressed.set(id,await recompressStoredPhoto(photo));
    let changed=false;
    lists.forEach(list=>(Array.isArray(list)?list:[]).forEach(item=>{
      if(item&&compressed.has(item.id)){
        const next=compressed.get(item.id);
        if(item.photo!==next){item.photo=next;changed=true;}
      }
    }));

    if(changed&&save()){
      console.log("Foto esistenti ottimizzate.");
      localStorage.setItem(MIGRATION_KEY,"done");
    }else if(!changed){
      localStorage.setItem(MIGRATION_KEY,"done");
    }
  };
  // Non blocca l'avvio dell'app: parte subito dopo il caricamento dell'interfaccia.
  // IndexedDB V3.2: non eseguiamo più la vecchia migrazione/compressione da localStorage.
  const renderHomeCurrentShopping=()=>{
    const btn=$("openCurrentShoppingBtn");
    const meta=$("currentShoppingHomeMeta");
    const totalEl=$("currentShoppingHomeTotal");
    if(!btn||!meta)return;
    const count=state.currentShopping.length+state.purchasedShopping.length;
    // La card verde compare solo quando esiste davvero una spesa attiva.
    const hasDetails=!!(state.currentShoppingStore||state.currentShoppingDate||(state.currentShoppingName&&state.currentShoppingName!=="La mia spesa"));
    const hasActive=count>0||hasDetails;
    btn.hidden=!hasActive;
    if(!hasActive)return;

    const bits=[];
    if(state.currentShoppingStore)bits.push(state.currentShoppingStore);
    if(state.currentShoppingDate)bits.push(state.currentShoppingDate.split("-").reverse().join("/"));
    bits.push(count+(count===1?" prodotto":" prodotti"));
    if(!count)bits.push("spesa in corso");
    meta.textContent=bits.join(" · ");

    if(totalEl){
      // Il totale della Home rappresenta ciò che resta da acquistare,
      // non ciò che è già stato spostato nel Carrello.
      const total=state.currentShopping.reduce(
        (sum,p)=>sum+(Number(p.price)||0)*(Number(p.pieces)||1),
        0
      );
      totalEl.textContent=euro(total)||"0,00 €";
    }
  };
  const openCurrentShopping=()=>{
    $("homeScreen").hidden=true;
    $("shoppingScreen").hidden=false;
    renderShopping();
  };
  const euro=v=>v===null||v===undefined||v===""?"":new Intl.NumberFormat("it-IT",{style:"currency",currency:"EUR"}).format(Number(v));
  const open=id=>{ $(id).classList.add("is-open"); $(id).setAttribute("aria-hidden","false"); document.body.style.overflow="hidden"; };
  const close=id=>{ $(id).classList.remove("is-open"); $(id).setAttribute("aria-hidden","true"); document.body.style.overflow=""; };
  const productImage=p=>p.photo?'<img class="product-thumb" src="'+p.photo+'" alt="">':'<span class="product-thumb product-thumb-placeholder">📦</span>';
  const shoppingItem=(p,acquired)=>'<div class="shopping-item'+(acquired?' is-acquired':'')+'" data-shopping-id="'+p._shoppingId+'" data-acquired="'+(acquired?'1':'0')+'">'+
      productImage(p)+
      '<div class="shopping-item-name">'+p.name+
        '<small>Peso: '+(p.weight||'—')+' · Pezzi: '+(p.pieces||1)+(p.store?' · Negozio: '+p.store:'')+'</small>'+
        '<span class="shopping-item-hint">'+(acquired?'Swipe per rimetterlo da acquistare':'Swipe per segnare come acquistato · Tieni premuto per altre azioni')+'</span>'+
      '</div>'+
      '<div class="shopping-item-price">'+(p.price!==""?euro(p.price):"—")+'</div>'+
    '</div>';

  const moveShoppingItem=(id,fromAcquired)=>{
    const from=fromAcquired?state.purchasedShopping:state.currentShopping;
    const to=fromAcquired?state.currentShopping:state.purchasedShopping;
    const index=from.findIndex(p=>p._shoppingId===id);
    if(index===-1)return;
    const [item]=from.splice(index,1);
    to.push(item);
    save();
    renderShopping();
  };

  const removeShoppingItem=id=>{
    const index=state.currentShopping.findIndex(p=>p._shoppingId===id);
    if(index===-1)return;
    const item=state.currentShopping[index];
    if(confirm('Rimuovere "'+item.name+'" da questa spesa?')){
      state.currentShopping.splice(index,1);
      save();
      renderShopping();
    }
  };

  let shoppingActionId=null;
  const closeShoppingActions=()=>{
    shoppingActionId=null;
    close("shoppingActionPanel");
  };
  const openShoppingActions=id=>{
    const item=state.currentShopping.find(p=>p._shoppingId===id);
    if(!item)return;
    shoppingActionId=id;
    $("shoppingActionName").textContent=item.name;
    open("shoppingActionPanel");
  };
  const moveShoppingItemToReminder=id=>{
    const index=state.currentShopping.findIndex(p=>p._shoppingId===id);
    if(index===-1)return closeShoppingActions();
    const item=state.currentShopping[index];
    const qty=Math.max(1,parseInt(item.pieces,10)||1);
    const existing=state.reminders.find(p=>p.id===item.id);
    if(existing){
      existing.reminderQuantity=Math.max(1,parseInt(existing.reminderQuantity,10)||0)+qty;
      if(item.price!==""&&item.price!==undefined)existing.price=item.price;
    }else{
      const reminder={...item};
      delete reminder._shoppingId;
      reminder.reminderQuantity=qty;
      state.reminders.push(reminder);
    }
    state.currentShopping.splice(index,1);
    save();
    closeShoppingActions();
    renderShopping();
    alert('✓ "'+item.name+'" è stato spostato nei Promemoria.');
  };

  const updatePurchasePromoPreview=()=>{
    const usePromo=$("purchaseUsePromo").checked;
    const regular=$("purchaseRegularPrice").value.trim();
    const promo=$("purchasePromoPrice").value.trim();
    $("purchasePriceInput").value=usePromo&&promo!==""?promo:regular;
  };

  const openPurchaseEditor=id=>{
    const item=state.currentShopping.find(p=>p._shoppingId===id);
    if(!item)return;
    editingShoppingId=id;
    $("purchaseEditName").textContent=item.name;
    $("purchasePiecesInput").value=Math.max(1,parseInt(item.pieces,10)||1);
    $("purchaseRegularPrice").value=item.regularPrice??item.price??"";
    $("purchasePromoPrice").value=item.promoPrice??"";
    $("purchaseUsePromo").checked=Boolean(item.usePromo&&item.promoPrice!==""&&item.promoPrice!==undefined);
    $("purchasePriceInput").value=item.price??item.regularPrice??"";
    $("purchaseNoteInput").value=item.note??"";
    $("purchasePromoWrap").hidden=!String(item.promoPrice??"").trim();
    updatePurchasePromoPreview();
    open("purchaseEditPanel");
  };

  const closePurchaseEditor=()=>{
    editingShoppingId=null;
    close("purchaseEditPanel");
  };

  const savePurchaseEditor=()=>{
    const item=state.currentShopping.find(p=>p._shoppingId===editingShoppingId);
    if(!item)return closePurchaseEditor();
    item.pieces=Math.max(1,parseInt($("purchasePiecesInput").value,10)||1);
    item.regularPrice=$("purchaseRegularPrice").value.trim().replace(",",".");
    item.promoPrice=$("purchasePromoPrice").value.trim().replace(",",".");
    item.usePromo=Boolean($("purchaseUsePromo").checked&&item.promoPrice!=="");
    item.price=(item.usePromo?item.promoPrice:item.regularPrice);
    item.note=$("purchaseNoteInput").value.trim();
    save();
    closePurchaseEditor();
    renderShopping();
  };

  const bindShoppingGestures=()=>{
    [...$("shoppingList").querySelectorAll(".shopping-item")].forEach(item=>{
      let startX=0,startY=0,startTime=0,longPress=null,moved=false;
      const clearLong=()=>{if(longPress){clearTimeout(longPress);longPress=null;}};
      item.addEventListener("touchstart",e=>{
        const t=e.touches[0];
        startX=t.clientX; startY=t.clientY; startTime=Date.now(); moved=false;
        const acquired=item.dataset.acquired==="1";
        if(!acquired){
          longPress=setTimeout(()=>{
            if(!moved){navigator.vibrate&&navigator.vibrate(20);openShoppingActions(item.dataset.shoppingId);}
          },650);
        }
      },{passive:true});
      item.addEventListener("touchmove",e=>{
        const t=e.touches[0];
        if(Math.abs(t.clientX-startX)>12||Math.abs(t.clientY-startY)>12){moved=true;clearLong();}
      },{passive:true});
      item.addEventListener("touchend",e=>{
        clearLong();
        const t=e.changedTouches[0];
        const dx=t.clientX-startX, dy=t.clientY-startY;
        const elapsed=Date.now()-startTime;
        // Su Safari lo swipe può durare più di 900 ms: conta la distanza reale,
        // non la velocità del gesto.
        if(Math.abs(dx)>50 && Math.abs(dx)>Math.abs(dy)*1.15){
          item.classList.add("is-swiping");
          moveShoppingItem(item.dataset.shoppingId,item.dataset.acquired==="1");
        }else if(!moved && elapsed<500 && item.dataset.acquired!=="1"){
          openPurchaseEditor(item.dataset.shoppingId);
        }
      },{passive:true});
      item.addEventListener("touchcancel",clearLong,{passive:true});
      item.addEventListener("contextmenu",e=>{
        if(item.dataset.acquired!=="1"){e.preventDefault();openShoppingActions(item.dataset.shoppingId);}
      });
    });
  };

  const renderShopping=()=>{
    const shoppingMeta=$("shoppingMeta");
    if(shoppingMeta){
      const store=state.currentShoppingStore||"";
      const date=state.currentShoppingDate?state.currentShoppingDate.split("-").reverse().join("/"):"";
      const name=(state.currentShoppingName && state.currentShoppingName!=="La mia spesa")?state.currentShoppingName:"";
      shoppingMeta.innerHTML=
        (store?'<span class="shopping-meta-store">'+store+'</span>':"")+
        (date?'<span class="shopping-meta-date">'+date+'</span>':"")+
        (name?'<span class="shopping-meta-name">'+name+'</span>':"");
    }
    const list=$("shoppingList");
    const pendingCount=state.currentShopping.length;
    const purchasedCount=state.purchasedShopping.length;
    const count=pendingCount+purchasedCount;
    // Il totale in alto riguarda solo i prodotti ancora da acquistare.
    const pendingTotal=state.currentShopping.reduce((s,p)=>s+((Number(p.price)||0)*(Number(p.pieces)||1)),0);
    // Il totale del Carrello resta invece separato nella sezione in basso.
    const cartTotal=state.purchasedShopping.reduce((s,p)=>s+((Number(p.price)||0)*(Number(p.pieces)||1)),0);
    $("shoppingTotal").textContent=euro(pendingTotal);
    $("cartTotal").textContent=euro(cartTotal);
    $("cartCount").textContent=purchasedCount;
    document.querySelector(".shopping-summary span").textContent=pendingCount+(pendingCount===1?" prodotto da acquistare":" prodotti da acquistare");
    if(!count){
      list.innerHTML='<div class="empty-state"><span>🛒</span><h2>La lista è vuota</h2><p>Aggiungi il primo prodotto dalla tua libreria.</p></div>';
      return;
    }
    let html="";
    if(pendingCount) html+='<div class="shopping-section"><div class="shopping-section-title">DA ACQUISTARE · '+pendingCount+'</div>'+state.currentShopping.map(p=>shoppingItem(p,false)).join("")+'</div>';
    if(purchasedCount) html+='<div class="shopping-section shopping-cart-section"><div class="shopping-section-title">🛒 CARRELLO · '+purchasedCount+'</div>'+state.purchasedShopping.map(p=>shoppingItem(p,true)).join("")+'</div>';
    list.innerHTML=html;
    bindShoppingGestures();
  };
  let expandedHistoryId=null;
  let historySortMode="date-desc";
  let historySearchQuery="";

  const historyDateValue=h=>{
    const value=h.date||h.completedAt||"";
    const time=new Date(value).getTime();
    return Number.isNaN(time)?0:time;
  };

  const sortedHistory=()=>{
    const items=[...(state.history||[])];
    return items.sort((a,b)=>{
      if(historySortMode==="store-asc")return String(a.store||"").localeCompare(String(b.store||""),"it");
      if(historySortMode==="store-desc")return String(b.store||"").localeCompare(String(a.store||""),"it");
      const diff=historyDateValue(a)-historyDateValue(b);
      return historySortMode==="date-asc"?diff:-diff;
    });
  };

  const deleteHistoryShopping=id=>{
    const h=(state.history||[]).find(x=>x.id===id);
    if(!h)return;
    const label=h.store||"questa spesa";
    if(!confirm('🗑️ Vuoi eliminare completamente la spesa "'+label+'" dallo Storico?\n\nQuesta operazione non può essere annullata.'))return;
    state.history=state.history.filter(x=>x.id!==id);
    if(expandedHistoryId===id)expandedHistoryId=null;
    save(); renderHistory();
  };

  const deleteHistoryProduct=(historyId,productIndex)=>{
    const h=(state.history||[]).find(x=>x.id===historyId);
    if(!h||!Array.isArray(h.products))return;
    const p=h.products[productIndex];
    if(!p)return;
    if(!confirm('🗑️ Vuoi eliminare "'+p.name+'" da questa spesa?\n\nVerrà rimosso solo questo prodotto dallo Storico.'))return;
    h.products.splice(productIndex,1);
    if(!h.products.length){
      state.history=state.history.filter(x=>x.id!==historyId);
      expandedHistoryId=null;
      save(); renderHistory();
      alert("La spesa non conteneva altri prodotti ed è stata rimossa dallo Storico.");
      return;
    }
    save(); renderHistory();
  };

  const bindHistoryLongPress=(element,callback)=>{
    if(!element)return;
    let timer=null;
    const clearTimer=()=>{if(timer){clearTimeout(timer);timer=null;}};
    const startPress=e=>{
      if(e.pointerType==="mouse"&&e.button!==0)return;
      clearTimer();
      timer=setTimeout(()=>{
        element.classList.add("history-long-pressing");
        if(navigator.vibrate)navigator.vibrate(35);
        callback();
        setTimeout(()=>element.classList.remove("history-long-pressing"),220);
      },650);
    };
    element.addEventListener("pointerdown",startPress);
    element.addEventListener("pointerup",clearTimer);
    element.addEventListener("pointerleave",clearTimer);
    element.addEventListener("pointercancel",clearTimer);
    element.addEventListener("contextmenu",e=>e.preventDefault());
  };

  const renderHistory=()=>{
    const list=$("historyList");
    if(!list)return;
    const query=historySearchQuery.trim().toLocaleLowerCase("it");
    const history=sortedHistory();
    const filtered=query ? history.filter(h=>(h.products||[]).some(p=>String(p.name||"").toLocaleLowerCase("it").includes(query))) : history;

    if(!Array.isArray(state.history)||!state.history.length){
      list.innerHTML='<div class="empty-state history-empty"><span>🕘</span><h2>Nessuna spesa salvata</h2><p>Quando concluderai una spesa, la troverai qui.</p></div>';
      return;
    }
    if(!filtered.length){
      list.innerHTML='<div class="empty-state history-empty history-search-empty"><span>🔎</span><h2>Nessun prodotto trovato</h2><p>Non abbiamo trovato acquisti che corrispondono a "<strong>'+historySearchQuery.replace(/</g,"&lt;").replace(/>/g,"&gt;")+'</strong>".</p></div>';
      return;
    }

    list.innerHTML=filtered.map(h=>{
      const date=h.date?h.date.split("-").reverse().join("/"):"";
      const total=(h.products||[]).reduce((s,p)=>s+((Number(p.price)||0)*(Number(p.pieces)||1)),0);
      const matchingProducts=(h.products||[]).map((p,index)=>({p,index})).filter(({p})=>!query||String(p.name||"").toLocaleLowerCase("it").includes(query));
      const isOpen=query||expandedHistoryId===h.id;
      const products=matchingProducts.map(({p,index})=>{
        const pieces=Math.max(1,Number(p.pieces)||1);
        const unit=Number(p.price)||0;
        return '<div class="history-product-row" data-history-product-index="'+index+'" title="Tieni premuto per eliminare">'+
          '<div><strong>'+p.name+'</strong><small>'+pieces+(pieces===1?' pezzo':' pezzi')+' · '+euro(unit)+' cad.</small></div>'+
          '<b>'+euro(unit*pieces)+'</b></div>';
      }).join("");

      const storeName=String(h.store||"Spesa").trim();
      const normalizedStore=storeName.toLocaleLowerCase("it");
      const storeClass=normalizedStore==="conad"?"store-conad":
        normalizedStore==="altro"?"store-altro":
        normalizedStore==="triscount"?"store-triscount":
        normalizedStore==="alimentarista"?"store-alimentarista":
        normalizedStore==="todis"?"store-todis":"store-default";
      const cartIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.1 10.2a2 2 0 0 0 2 1.6h8.7a2 2 0 0 0 1.9-1.4L21 8H6.2"/><circle cx="10" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/></svg>';

      return '<article class="history-card '+(isOpen?'is-expanded':'')+' '+(query?'history-search-result':'')+'" data-history-id="'+h.id+'">'+
        '<button class="history-card-summary" type="button" aria-expanded="'+isOpen+'" title="Tieni premuto per eliminare la spesa">'+
          '<span class="history-store-icon '+storeClass+'">'+cartIcon+'</span><span class="history-card-copy"><strong>'+storeName+'</strong><small>'+date+'</small></span>'+
          '<b class="history-card-total">'+euro(total)+'</b><span class="history-chevron">'+(isOpen?'⌃':'⌄')+'</span></button>'+
        (isOpen?'<div class="history-products">'+products+(query?'<div class="history-search-date"><span>✓ Acquistato il</span><strong>'+date+'</strong></div>':'')+'<div class="history-grand-total"><strong>Totale spesa</strong><b>'+euro(total)+'</b></div></div>':'')+
      '</article>';
    }).join("");

    list.querySelectorAll(".history-card").forEach(card=>{
      const id=card.dataset.historyId;
      const summary=card.querySelector(".history-card-summary");
      let suppressClick=false;
      bindHistoryLongPress(summary,()=>{suppressClick=true;deleteHistoryShopping(id);});
      summary.onclick=()=>{
        if(suppressClick){suppressClick=false;return;}
        if(historySearchQuery.trim())return;
        expandedHistoryId=expandedHistoryId===id?null:id;
        renderHistory();
      };
      card.querySelectorAll(".history-product-row").forEach(row=>{
        bindHistoryLongPress(row,()=>deleteHistoryProduct(id,Number(row.dataset.historyProductIndex)));
      });
    });
  };

  const finishShopping=()=>{
    const products=[...state.purchasedShopping];
    if(!products.length){
      alert("Il Carrello è vuoto. Sposta nel Carrello i prodotti acquistati prima di concludere la spesa.");
      return;
    }
    if(state.currentShopping.length){
      if(!confirm("Ci sono ancora "+state.currentShopping.length+" prodotti da acquistare. Vuoi comunque concludere e salvare nello Storico solo i prodotti nel Carrello?"))return;
    }else if(!confirm("Concludere questa spesa e salvarla nello Storico?"))return;
    state.history.unshift({
      id:"history-"+Date.now(),
      name:state.currentShoppingName||"La mia spesa",
      store:state.currentShoppingStore||"",
      date:state.currentShoppingDate||new Date().toISOString().slice(0,10),
      products:products.map(p=>({...p})),
      completedAt:new Date().toISOString()
    });
    state.currentShopping=[];
    state.purchasedShopping=[];
    state.currentShoppingName="La mia spesa";
    state.currentShoppingStore="";
    state.currentShoppingDate="";
    save();
    renderHomeCurrentShopping();
    $("shoppingScreen").hidden=true;
    $("homeScreen").hidden=false;
    alert("✓ Spesa salvata nello Storico.");
  };

  const renderLibrary=(q="")=>{
    const products=state.products.filter(p=>p.name.toLowerCase().includes(q.toLowerCase()));
    const libraryMode=$("productPanel").classList.contains("library-mode");
    $("libraryList").innerHTML=products.length
      ?products.map(p=>{
          const alreadyToBuy=state.currentShopping.some(x=>x.id===p.id);
          const alreadyInCart=state.purchasedShopping.some(x=>x.id===p.id);
          const exists=alreadyToBuy||alreadyInCart;
          const details='<strong>'+p.name+'</strong><small>Peso: '+(p.weight||'—')+' · Pezzi: '+(p.pieces||1)+(p.store?' · Negozio: '+p.store:'')+(p.price!==""?" · Prezzo: "+euro(p.price):"")+'</small>';
          const actions=libraryMode
            ?''
            :'<div class="library-actions"><button class="add-to-list shopping-add-control '+(exists?'is-added':'')+'" data-id="'+p.id+'" type="button" aria-label="'+(exists?'Già aggiunto':'Aggiungi '+p.name)+'">'+(exists?"✓":"＋")+'</button></div>';
          return '<div class="library-item">'+
            productImage(p)+
            '<button class="library-item-info library-name-btn" data-edit-id="'+p.id+'" type="button" aria-label="Modifica o elimina '+p.name+'">'+details+'</button>'+
            actions+
          '</div>';
        }).join("")
      :'<div class="empty-state"><span>📦</span><h2>Nessun prodotto</h2><p>Aggiungi il primo prodotto alla tua libreria.</p></div>';

    [...$("libraryList").querySelectorAll("button[data-id]")].forEach(b=>b.onclick=()=>{
      const p=state.products.find(x=>x.id===b.dataset.id);
      if(!p)return;

      const alreadyToBuy=state.currentShopping.some(x=>x.id===p.id);
      const alreadyInCart=state.purchasedShopping.some(x=>x.id===p.id);
      if(alreadyToBuy||alreadyInCart){
        const where=alreadyToBuy?"nella lista da acquistare":"nel Carrello";
        alert('⚠️ "'+p.name+'" è già presente '+where+'.');
        $("productSearch").value="";
        renderLibrary("");
        return;
      }

      state.currentShopping.push({...p,price:p.price??"",usePromo:false,note:"",_shoppingId:"shop-"+Date.now()+"-"+Math.random().toString(36).slice(2,8)});
      save();
      renderShopping();
      // Restiamo nella libreria: il + diventa immediatamente una ✓, come nei Promemoria.
      renderLibrary($("productSearch").value);
    });

    [...$("libraryList").querySelectorAll("button[data-edit-id]")].forEach(b=>b.onclick=()=>{
      const p=state.products.find(x=>x.id===b.dataset.editId);
      if(!p)return;
      editingProductId=p.id;
      $("productName").value=p.name||"";
      $("productPrice").value=p.price||"";
      $("productPromoPrice").value=p.promoPrice||"";
      $("productWeight").value=p.weight??p.quantity??"";
      $("productPieces").value=p.pieces||1;
      const knownStores=["Conad","Triscount","Alimentarista","Todis","Garanzia"];
      $("productStore").value=knownStores.includes(p.store) ? p.store : (p.store ? "Altro" : "");
      $("productCustomStore").value=knownStores.includes(p.store)||!p.store ? "" : p.store;
      $("customStoreWrap").hidden=$("productStore").value!=="Altro";
      pendingPhoto=p.photo||"";
      $("newProductForm").dataset.barcode=p.barcode||"";
      $("newProductForm").dataset.editing="1";
      $("newProductPanel").querySelector(".eyebrow").textContent="MODIFICA PRODOTTO";
      const editProductTitle=$("newProductPanel").querySelector(".panel-header h1");
      if(editProductTitle)editProductTitle.textContent="";
      const scanBtn=$("scanProductBtn");
      const scanNote=document.querySelector("#newProductPanel .scan-note");
      if(scanBtn)scanBtn.hidden=true;
      if(scanNote)scanNote.hidden=true;
      $("newProductForm").querySelector(".save-product-btn").textContent="Salva modifiche";
      $("deleteProductBtn").hidden=false;
      if(pendingPhoto){$("photoPreviewImg").src=pendingPhoto;$("photoPreview").hidden=false;}
      else $("photoPreview").hidden=true;
      open("newProductPanel");
    });
  };

  const resetProductForm=()=>{
    editingProductId=null;
    pendingPhoto="";
    const form=$("newProductForm");
    form.reset();
    delete form.dataset.barcode;
    delete form.dataset.editing;
    $("productWeight").value="";
    $("productPieces").value=1;
    $("productStore").value="";
    $("productCustomStore").value="";
    $("customStoreWrap").hidden=true;
    $("photoPreview").hidden=true;
    $("newProductPanel").querySelector(".eyebrow").textContent="NUOVO PRODOTTO";
    const newProductTitle=$("newProductPanel").querySelector(".panel-header h1");
    if(newProductTitle)newProductTitle.textContent="";
    // Ripristina la scansione quando si torna alla creazione di un nuovo prodotto.
    const scanBtn=$("scanProductBtn");
    const scanNote=document.querySelector("#newProductPanel .scan-note");
    if(scanBtn)scanBtn.hidden=false;
    if(scanNote)scanNote.hidden=false;
    form.querySelector(".save-product-btn").textContent="Salva prodotto";
    $("deleteProductBtn").hidden=true;
  };
  $("decreasePiecesBtn").onclick=()=>{
    const input=$("purchasePiecesInput");
    input.value=Math.max(1,(parseInt(input.value,10)||1)-1);
  };
  $("increasePiecesBtn").onclick=()=>{
    const input=$("purchasePiecesInput");
    input.value=Math.max(1,(parseInt(input.value,10)||1)+1);
  };
  $("closePurchaseEdit").onclick=$("closePurchaseEditBtn").onclick=closePurchaseEditor;
  $("savePurchaseEditBtn").onclick=savePurchaseEditor;
  $("purchaseUsePromo").onchange=updatePurchasePromoPreview;
  $("closeShoppingAction").onclick=$("closeShoppingActionBtn").onclick=closeShoppingActions;
  $("moveShoppingToReminderBtn").onclick=()=>{if(shoppingActionId)moveShoppingItemToReminder(shoppingActionId);};
  $("deleteShoppingItemBtn").onclick=()=>{const id=shoppingActionId;closeShoppingActions();if(id)removeShoppingItem(id);};

  const todayISO=()=>new Date().toISOString().slice(0,10);
  const openNewShopping=()=>{
    $("newShoppingForm").reset();
    $("newShoppingDate").value=todayISO();
    $("newShoppingCustomStoreWrap").hidden=true;
    open("newShoppingPanel");
  };
  $("newShoppingBtn").onclick=()=>{
    if(state.currentShopping.length||state.purchasedShopping.length){
      if(!confirm("Hai già una spesa in corso. Vuoi crearne una nuova e sostituire quella attuale?"))return;
    }
    delete $("newShoppingPanel").dataset.fromReminders;
    openNewShopping();
  };
  $("openCurrentShoppingBtn").onclick=openCurrentShopping;
  $("newShoppingStore").onchange=e=>{
    const other=e.target.value==="Altro";
    $("newShoppingCustomStoreWrap").hidden=!other;
    if(!other)$("newShoppingCustomStore").value="";
  };
  $("closeNewShopping").onclick=$("closeNewShoppingBtn").onclick=()=>close("newShoppingPanel");
  $("newShoppingForm").onsubmit=e=>{
    e.preventDefault();
    const name=$("newShoppingName").value.trim();
    const selected=$("newShoppingStore").value;
    const store=selected==="Altro"?$("newShoppingCustomStore").value.trim():selected;
    const date=$("newShoppingDate").value;
    if(!store||!date)return;
    const finalName=name||"La mia spesa";
    const fromReminders=$("newShoppingPanel").dataset.fromReminders==="1";
    const selectedReminders=fromReminders?selectedReminderItems():[];
    if(fromReminders && (state.currentShopping.length||state.purchasedShopping.length)){
      if(!confirm("Creando una nuova spesa, la lista attuale verrà sostituita dalla nuova lista. Vuoi continuare?"))return;
    }
    state.currentShoppingName=finalName;
    state.currentShoppingStore=store;
    state.currentShoppingDate=date;
    state.currentShopping=[];
    state.purchasedShopping=[];
    if(fromReminders){
      selectedReminders.forEach(p=>{
        const qty=Math.max(1,parseInt(p.reminderQuantity,10)||1);
        state.currentShopping.push({...p,pieces:qty,_shoppingId:"shop-"+Date.now()+"-"+Math.random().toString(36).slice(2,8)});
      });
      state.reminders=state.reminders.filter(p=>!selectedReminderIds.has(p.id));
      delete $("newShoppingPanel").dataset.fromReminders;
      finishReminderSelection();
    }
    save();
    renderHomeCurrentShopping();
    close("newShoppingPanel");
    $("homeScreen").hidden=true;$("shoppingScreen").hidden=false;
    renderShopping();
  };
  $("homeNewProductBtn").onclick=()=>{resetProductForm();open("newProductPanel");};
  $("guideBtn").onclick=()=>open("guidePanel");
  $("closeGuideBtn").onclick=()=>close("guidePanel");
  $("productsLibraryBtn").onclick=()=>{
    const panel=$("productPanel");
    panel.classList.add("library-mode");
    $("productPanelEyebrow").hidden=true;
    $("productPanelTitle").textContent="I miei prodotti";
    $("productSearch").value="";
    renderLibrary("");
    open("productPanel");
  };
  $("backHomeBtn").onclick=()=>{renderHomeCurrentShopping();$("shoppingScreen").hidden=true;$("homeScreen").hidden=false;};
  $("finishShoppingBtn").onclick=finishShopping;
  $("historyBtn").onclick=()=>{
    expandedHistoryId=null;
    historySearchQuery="";
    $("historySearch").value="";
    $("clearHistorySearch").hidden=true;
    historySortMode=$("historySort").value||"date-desc";
    renderHistory();
    open("historyPanel");
  };
  $("historySort").onchange=e=>{
    historySortMode=e.target.value;
    expandedHistoryId=null;
    renderHistory();
  };
  $("historySearch").oninput=e=>{
    historySearchQuery=e.target.value;
    $("clearHistorySearch").hidden=!historySearchQuery;
    expandedHistoryId=null;
    renderHistory();
  };
  $("clearHistorySearch").onclick=()=>{
    historySearchQuery="";
    $("historySearch").value="";
    $("clearHistorySearch").hidden=true;
    expandedHistoryId=null;
    renderHistory();
    $("historySearch").focus();
  };
  $("closeHistory").onclick=$("closeHistoryBtn").onclick=()=>close("historyPanel");
  $("addProductBtn").onclick=()=>{
    const panel=$("productPanel");
    panel.classList.remove("library-mode");
    $("productPanelEyebrow").hidden=false;
    $("productPanelTitle").textContent="Aggiungi prodotti";
    $("productSearch").value="";
    renderLibrary();
    open("productPanel");
  };
  $("closeProducts").onclick=$("closeProductsBtn").onclick=()=>{
    const panel=$("productPanel");
    panel.classList.remove("library-mode");
    $("productPanelEyebrow").hidden=false;
    $("productPanelTitle").textContent="Aggiungi prodotti";
    close("productPanel");
  };
  $("newProductBtn").onclick=()=>{resetProductForm();open("newProductPanel");};
  $("closeNewProduct").onclick=$("closeNewProductBtn").onclick=()=>{resetProductForm();close("newProductPanel");};
  $("productSearch").oninput=e=>renderLibrary(e.target.value);
  $("productStore").onchange=e=>{
    const isOther=e.target.value==="Altro";
    $("customStoreWrap").hidden=!isOther;
    if(!isOther)$("productCustomStore").value="";
  };
  // Le foto vengono ridotte prima di essere salvate. Su iPhone le immagini originali
  // possono occupare molti MB e saturare rapidamente lo spazio disponibile in localStorage.
  const compressProductPhoto=file=>new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error("Impossibile leggere la foto"));
    reader.onload=()=>{
      const img=new Image();
      img.onerror=()=>reject(new Error("Impossibile elaborare la foto"));
      img.onload=()=>{
        const MAX_SIDE=900;
        const scale=Math.min(1,MAX_SIDE/Math.max(img.width,img.height));
        const canvas=document.createElement("canvas");
        canvas.width=Math.max(1,Math.round(img.width*scale));
        canvas.height=Math.max(1,Math.round(img.height*scale));
        const ctx=canvas.getContext("2d",{alpha:false});
        ctx.fillStyle="#ffffff";
        ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img,0,0,canvas.width,canvas.height);

        let quality=.78;
        let result=canvas.toDataURL("image/jpeg",quality);
        // Manteniamo ogni foto entro circa 450 KB per lasciare spazio a molti prodotti.
        while(result.length>600000&&quality>.35){
          quality-=.08;
          result=canvas.toDataURL("image/jpeg",quality);
        }
        resolve(result);
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });

  $("productPhoto").onchange=async e=>{
    const file=e.target.files&&e.target.files[0];
    if(!file){
      pendingPhoto="";
      $("photoPreview").hidden=true;
      return;
    }
    try{
      const input=e.target;
      input.disabled=true;
      pendingPhoto=await compressProductPhoto(file);
      $("photoPreviewImg").src=pendingPhoto;
      $("photoPreview").hidden=false;
    }catch(error){
      console.error("Compressione foto:",error);
      pendingPhoto="";
      $("photoPreview").hidden=true;
      alert("⚠️ Non riesco a preparare questa foto. Prova a sceglierne un'altra.");
    }finally{
      e.target.disabled=false;
    }
  };
  let scannerTarget=null;

  const stopScanner=async()=>{
    try{ if(scanLoopId) cancelAnimationFrame(scanLoopId); }catch(e){}
    scanLoopId=null;
    try{if(scannerControls&&scannerControls.stop)scannerControls.stop();}catch(e){}
    scannerControls=null;
    scannerRunning=false;
    try{
      const video=$("barcodeReader").querySelector("video");
      const stream=scannerStream||(video&&video.srcObject);
      if(stream&&stream.getTracks)stream.getTracks().forEach(t=>t.stop());
    }catch(e){}
    scannerStream=null;
  };

  const lookupBarcode=async code=>{
    if(scannerTarget==="reminder"){
      if(processingBarcode)return;
      processingBarcode=true;
      $("scannerStatus").textContent="Codice trovato: "+code+". Cerco nella libreria…";
      const normalized=String(code||"").replace(/[^0-9A-Za-z]/g,"");
      const product=state.products.find(p=>String(p.barcode||"").replace(/[^0-9A-Za-z]/g,"")===normalized);
      await stopScanner();
      close("scannerPanel");
      scannerTarget=null;
      if(!product){
        alert("⚠️ Questo prodotto non è ancora presente nella libreria.");
        return;
      }
      if(state.reminders.some(p=>p.id===product.id)){
        alert("✓ "+product.name+" è già presente nei Promemoria.");
        return;
      }
      state.reminders.push({...product,reminderQuantity:1});
      save();
      renderReminders();
      alert("✓ "+product.name+" aggiunto ai Promemoria.");
      return;
    }
    if(processingBarcode)return;
    processingBarcode=true;
    $("scannerStatus").textContent="Codice trovato: "+code+". Cerco il prodotto…";
    try{
      const local=state.products.find(p=>p.barcode===code);
      if(local){
        await stopScanner(); close("scannerPanel");
        $("productName").value=local.name||"";
        $("productWeight").value=local.weight??local.quantity??"";
        $("productPieces").value=local.pieces||1;
        $("productPrice").value=local.price||"";
        $("productPromoPrice").value=local.promoPrice||"";
        pendingPhoto=local.photo||"";
        if(pendingPhoto){$("photoPreviewImg").src=pendingPhoto;$("photoPreview").hidden=false;}
        return;
      }
      const response=await fetch("https://world.openfoodfacts.org/api/v2/product/"+encodeURIComponent(code)+".json?fields=code,product_name,brands,quantity,image_front_url,image_url");
      const data=await response.json();
      await stopScanner(); close("scannerPanel");
      $("newProductForm").dataset.barcode=code;
      if(data.status===1&&data.product){
        const p=data.product;
        $("productName").value=p.product_name||p.brands||"";
        const qty=(p.quantity||"").match(/\d+/);
        if(qty)$("productWeight").value=qty[0];
        $("productPieces").value=1;
        pendingPhoto=p.image_front_url||p.image_url||"";
        if(pendingPhoto){$("photoPreviewImg").src=pendingPhoto;$("photoPreview").hidden=false;}
      }else alert("Codice letto correttamente, ma il prodotto non è presente nel database online. Puoi completarlo manualmente.");
    }catch(e){
      await stopScanner(); close("scannerPanel");
      alert("Il codice è stato letto, ma non riesco a recuperare le informazioni online.");
    }
  };

  const cameraConstraints={
    audio:false,
    video:{
      facingMode:{ideal:"environment"},
      width:{ideal:1280,max:1920},
      height:{ideal:720,max:1080}
    }
  };

  const startNativeScanner=async video=>{
    const formats=["ean_13","ean_8","upc_a","upc_e","code_128","code_39","itf","codabar"];
    const detector=new BarcodeDetector({formats});
    scannerStream=await navigator.mediaDevices.getUserMedia(cameraConstraints);
    video.srcObject=scannerStream;
    await video.play();
    scannerRunning=true;
    $("scannerStatus").textContent="Scanner V1.4.14 pronto. Puoi tenere il codice anche ruotato.";

    let lastScan=0;
    const scanFrame=async now=>{
      if(!scannerRunning||processingBarcode)return;
      if(now-lastScan>120){
        lastScan=now;
        try{
          const codes=await detector.detect(video);
          if(codes&&codes.length){
            const value=codes[0].rawValue;
            if(value){
              $("scannerStatus").textContent="✅ Codice rilevato: "+value;
              lookupBarcode(value);
              return;
            }
          }
        }catch(err){
          // Alcuni fotogrammi possono fallire durante l'autofocus: continuiamo.
        }
      }
      scanLoopId=requestAnimationFrame(scanFrame);
    };
    scanLoopId=requestAnimationFrame(scanFrame);
  };

  const startZXingScanner=async video=>{
    if(!window.ZXingBrowser)throw Error("ZXing non disponibile");
    scanner=new ZXingBrowser.BrowserMultiFormatReader();
    scannerControls=await scanner.decodeFromConstraints(
      cameraConstraints,
      video,
      (result,error)=>{
        if(result&&!processingBarcode){
          const code=result.getText();
          $("scannerStatus").textContent="✅ Codice rilevato: "+code;
          lookupBarcode(code);
        }
      }
    );
    scannerRunning=true;
    $("scannerStatus").textContent="Scanner V1.4.14 pronto. Inquadra il codice da qualsiasi orientamento.";
  };

  const startScanner=async()=>{
    processingBarcode=false;
    await stopScanner();
    open("scannerPanel");
    $("scannerStatus").textContent="Richiedo l'accesso alla fotocamera…";

    try{
      $("barcodeReader").innerHTML='<video id="zxingVideo" autoplay muted playsinline></video>';
      const video=$("zxingVideo");

      // V1.4.9: prima usiamo il lettore nativo dell'iPhone, più adatto ai codici
      // EAN dei prodotti. Se non è disponibile, torniamo automaticamente a ZXing.
      if("BarcodeDetector" in window){
        await startNativeScanner(video);
      }else{
        await startZXingScanner(video);
      }
    }catch(e){
      console.warn("Scanner nativo non disponibile, provo ZXing",e);
      try{
        await stopScanner();
        $("barcodeReader").innerHTML='<video id="zxingVideo" autoplay muted playsinline></video>';
        const video=$("zxingVideo");
        await startZXingScanner(video);
      }catch(fallbackError){
        console.error("Errore scanner",fallbackError);
        await stopScanner();
        $("barcodeReader").innerHTML="";
        close("scannerPanel");
        alert("Impossibile avviare lo scanner. Verifica il permesso della fotocamera e riprova.");
      }
    }
  };
  $("scanProductBtn").onclick=startScanner;
  $("closeScanner").onclick=$("closeScannerBtn").onclick=async()=>{await stopScanner();close("scannerPanel");};
  $("newProductForm").onsubmit=e=>{
    e.preventDefault();
    const name=$("productName").value.trim();
    const price=$("productPrice").value.trim().replace(",",".");
    const promoPrice=$("productPromoPrice").value.trim().replace(",",".");
    const weight=$("productWeight").value.trim().replace(",",".");
    const pieces=Math.max(1,parseInt($("productPieces").value,10)||1);
    const selectedStore=$("productStore").value;
    const store=selectedStore==="Altro" ? $("productCustomStore").value.trim() : selectedStore;
    if(!name)return;

    const product={
      id:editingProductId||Date.now().toString(),
      name,
      price,
      promoPrice,
      weight,
      pieces,
      store,
      photo:pendingPhoto,
      barcode:e.target.dataset.barcode||""
    };

    if(editingProductId){
      const index=state.products.findIndex(p=>p.id===editingProductId);
      if(index!==-1) state.products[index]=product;

      // La libreria contiene il prezzo di riferimento.
      // Promemoria e Spesa sono invece contesti indipendenti: quando un
      // prodotto è già stato inserito lì, il suo prezzo (e la quantità
      // scelta in quel contesto) non devono essere sovrascritti.
      state.currentShopping=state.currentShopping.map(p=>{
        if(p.id!==editingProductId)return p;
        return {...product,price:p.price,pieces:p.pieces,_shoppingId:p._shoppingId};
      });
      state.purchasedShopping=state.purchasedShopping.map(p=>{
        if(p.id!==editingProductId)return p;
        return {...product,price:p.price,pieces:p.pieces,_shoppingId:p._shoppingId};
      });
      state.reminders=state.reminders.map(p=>{
        if(p.id!==editingProductId)return p;
        return {...product,price:p.price,reminderQuantity:p.reminderQuantity};
      });
    }else{
      state.products.push(product);
    }

    // Salviamo prima di modificare l'interfaccia: così un eventuale errore
    // non fa sembrare il prodotto aggiunto quando in realtà non è stato memorizzato.
    if(!save())return;
    resetProductForm();
    close("newProductPanel");
    renderLibrary($("productSearch").value);
    renderShopping();
    renderReminders();
  };
  $("deleteProductBtn").onclick=()=>{
    if(!editingProductId)return;
    const product=state.products.find(p=>p.id===editingProductId);
    if(!product)return;
    if(!confirm('Vuoi eliminare definitivamente "'+product.name+'" dalla libreria?'))return;
    state.products=state.products.filter(p=>p.id!==editingProductId);
    save();
    resetProductForm();
    close("newProductPanel");
    renderLibrary($("productSearch").value);
  };

  const openReminderEditor=id=>{
    const item=state.reminders.find(p=>p.id===id);
    if(!item)return;
    editingReminderId=id;
    $("reminderEditName").textContent=item.name;
    $("reminderQuantityInput").value=Math.max(1,parseInt(item.reminderQuantity,10)||1);
    $("reminderPriceInput").value=item.price??"";
    open("reminderEditPanel");
  };
  const closeReminderEditor=()=>{
    editingReminderId=null;
    close("reminderEditPanel");
  };
  const saveReminderQuantity=()=>{
    const item=state.reminders.find(p=>p.id===editingReminderId);
    if(!item)return closeReminderEditor();
    item.reminderQuantity=Math.max(1,parseInt($("reminderQuantityInput").value,10)||1);
    item.price=$("reminderPriceInput").value.trim().replace(",",".");
    save();
    renderReminders();
    closeReminderEditor();
  };
  const removeReminder=id=>{
    const item=state.reminders.find(p=>p.id===id);
    if(!item)return;
    if(confirm('Rimuovere "'+item.name+'" dai Promemoria?')){
      state.reminders=state.reminders.filter(x=>x.id!==id);
      save();
      renderReminders();
    }
  };
  const bindReminderPress=(target,id)=>{
    let timer=null, longPressed=false;
    const clear=()=>{if(timer){clearTimeout(timer);timer=null;}};
    target.addEventListener("pointerdown",e=>{
      if(reminderSelectionMode)return;
      if(e.pointerType==="mouse"&&e.button!==0)return;
      longPressed=false;
      timer=setTimeout(()=>{
        longPressed=true;
        if(navigator.vibrate)navigator.vibrate(30);
        removeReminder(id);
      },650);
    });
    target.addEventListener("pointerup",clear);
    target.addEventListener("pointercancel",clear);
    target.addEventListener("pointerleave",clear);
    target.addEventListener("click",e=>{
      if(reminderSelectionMode)return;
      if(longPressed){e.preventDefault();return;}
      openReminderEditor(id);
    });
  };
  let reminderSelectionMode=false;
  const selectedReminderIds=new Set();

  const selectedReminderItems=()=>state.reminders.filter(p=>selectedReminderIds.has(p.id));
  const refreshReminderMoveButton=()=>{
    const btn=$("moveSelectedReminderBtn");
    if(!btn)return;
    const count=selectedReminderIds.size;
    btn.hidden=!reminderSelectionMode;
    btn.textContent=count ? "🛒 Sposta nella spesa ("+count+")" : "🛒 Sposta nella spesa";
    btn.disabled=!count;
  };
  const finishReminderSelection=()=>{
    reminderSelectionMode=false;
    selectedReminderIds.clear();
    updateReminderSelectButton();
    refreshReminderMoveButton();
    renderReminders();
  };
  const moveSelectedIntoCurrentShopping=()=>{
    const selected=selectedReminderItems();
    if(!selected.length)return;
    selected.forEach(p=>{
      const qty=Math.max(1,parseInt(p.reminderQuantity,10)||1);
      const existing=state.currentShopping.find(x=>x.id===p.id);
      if(existing){
        existing.pieces=Math.max(1,parseInt(existing.pieces,10)||0)+qty;
        if(p.price!==""&&p.price!==undefined)existing.price=p.price;
      }else{
        state.currentShopping.push({...p,pieces:qty,_shoppingId:"shop-"+Date.now()+"-"+Math.random().toString(36).slice(2,8)});
      }
    });
    state.reminders=state.reminders.filter(p=>!selectedReminderIds.has(p.id));
    save();
    finishReminderSelection();
    renderShopping();
    close("reminderTransferPanel");
    alert("✓ Prodotti spostati nella spesa.");
  };
  const moveSelectedIntoNewShopping=()=>{
    const selected=selectedReminderItems();
    if(!selected.length)return;
    close("reminderTransferPanel");
    $("newShoppingPanel").dataset.fromReminders="1";
    $("newShoppingForm").reset();
    $("newShoppingDate").value=todayISO();
    $("newShoppingCustomStoreWrap").hidden=true;
    open("newShoppingPanel");
  };

  const updateReminderSelectButton=()=>{
    const btn=$("reminderSelectBtn");
    if(!btn)return;
    btn.textContent=reminderSelectionMode ? "Fine" : "✓ Seleziona";
    btn.classList.toggle("is-active",reminderSelectionMode);
    refreshReminderMoveButton();
  };

  // Condivisione del Promemoria: viene creato un link che l'altra persona
  // può aprire direttamente nella propria installazione dell'app.
  let pendingSharedReminder=null;

  const toBase64Url=value=>{
    const bytes=new TextEncoder().encode(JSON.stringify(value));
    let binary="";
    bytes.forEach(b=>binary+=String.fromCharCode(b));
    return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  };

  const fromBase64Url=value=>{
    let base64=String(value||"").replace(/-/g,"+").replace(/_/g,"/");
    while(base64.length%4)base64+="=";
    const binary=atob(base64);
    const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  };

  const buildSharedReminder=()=>({
    v:1,
    products:state.reminders.map(p=>({
      name:String(p.name||"").trim(),
      price:p.price??"",
      weight:p.weight??"",
      pieces:p.pieces??1,
      store:p.store??"",
      reminderQuantity:Math.max(1,parseInt(p.reminderQuantity,10)||1),
      barcode:p.barcode||""
    })).filter(p=>p.name)
  });

  const shareReminder=async()=>{
    if(!state.reminders.length){
      alert("Il Promemoria è vuoto: aggiungi almeno un prodotto prima di condividerlo.");
      return;
    }
    const payload=toBase64Url(buildSharedReminder());
    const url=new URL(window.location.href);
    url.search="";
    url.hash="promemoria="+payload;
    const message="Ti ho inviato un promemoria della spesa. Apri questo link con La Mia Spesa per importare i prodotti:\n\n"+url.toString();
    try{
      // WhatsApp apre la scelta di un contatto e prepara già il messaggio.
      const whatsappUrl="https://wa.me/?text="+encodeURIComponent(message);
      window.location.href=whatsappUrl;
    }catch(error){
      console.error("Condivisione Promemoria:",error);
      alert("Non è stato possibile aprire WhatsApp.");
    }
  };

  const cleanSharedReminderUrl=()=>{
    const url=new URL(window.location.href);
    url.searchParams.delete("promemoria");
    if(String(url.hash||"").replace(/^#/,"").startsWith("promemoria="))url.hash="";
    history.replaceState({},document.title,url.pathname+(url.search||"")+url.hash);
  };

  const importSharedReminder=()=>{
    if(!pendingSharedReminder||!Array.isArray(pendingSharedReminder.products))return;
    let added=0, skipped=0;
    pendingSharedReminder.products.forEach(raw=>{
      const name=String(raw.name||"").trim();
      if(!name)return;
      const duplicate=state.reminders.some(existing=>
        String(existing.name||"").trim().toLocaleLowerCase("it")===name.toLocaleLowerCase("it")
      );
      if(duplicate){skipped++;return;}
      state.reminders.push({
        id:"shared-"+Date.now()+"-"+Math.random().toString(36).slice(2,9),
        name,
        price:raw.price??"",
        weight:raw.weight??"",
        pieces:Math.max(1,parseInt(raw.pieces,10)||1),
        store:raw.store??"",
        barcode:raw.barcode||"",
        reminderQuantity:Math.max(1,parseInt(raw.reminderQuantity,10)||1)
      });
      added++;
    });
    save();
    pendingSharedReminder=null;
    close("reminderImportPanel");
    cleanSharedReminderUrl();
    renderReminders();
    if(added&&skipped)alert("✓ Importati "+added+" prodotti. "+skipped+" erano già presenti nel tuo Promemoria.");
    else if(added)alert("✓ Importati "+added+(added===1?" prodotto nel tuo Promemoria.":" prodotti nel tuo Promemoria."));
    else alert("Tutti i prodotti ricevuti erano già presenti nel tuo Promemoria.");
  };

  // Legge sia i vecchi link con ?promemoria= sia i nuovi link con #promemoria=.
  const getSharedReminderPayload=()=>{
    const queryValue=new URLSearchParams(window.location.search).get("promemoria");
    if(queryValue)return queryValue;
    const hash=String(window.location.hash||"").replace(/^#/,"");
    return new URLSearchParams(hash).get("promemoria")||"";
  };

  const showSharedReminderImport=()=>{
    const encoded=getSharedReminderPayload();
    if(!encoded)return;
    try{
      const payload=fromBase64Url(encoded);
      if(!payload||payload.v!==1||!Array.isArray(payload.products)||!payload.products.length){
        throw new Error("Payload non valido");
      }

      // Importazione automatica: il destinatario non deve premere alcun altro pulsante.
      pendingSharedReminder=payload;
      importSharedReminder();
    }catch(error){
      console.error("Importazione Promemoria:",error);
      cleanSharedReminderUrl();
      alert("⚠️ Il Promemoria ricevuto non è valido o il link è incompleto.");
    }
  };

  // Condivisione della Spesa in corso: condividiamo i prodotti ancora da acquistare.
  // Il Carrello del mittente non viene inviato, perché contiene prodotti già acquistati.
  let pendingSharedShopping=null;

  const buildSharedShopping=()=>({
    v:1,
    store:state.currentShoppingStore||"",
    date:state.currentShoppingDate||"",
    name:state.currentShoppingName||"",
    products:state.currentShopping.map(p=>({
      name:String(p.name||"").trim(),
      price:p.price??"",
      weight:p.weight??"",
      pieces:Math.max(1,parseInt(p.pieces,10)||1),
      store:p.store??"",
      barcode:p.barcode||""
    })).filter(p=>p.name)
  });

  const shareShopping=()=>{
    if(!state.currentShopping.length){
      alert("La lista da acquistare è vuota: non ci sono prodotti da condividere.");
      return;
    }
    const payload=toBase64Url(buildSharedShopping());
    const url=new URL(window.location.href);
    url.search="";
    url.hash="";
    url.searchParams.set("spesa",payload);
    const label=state.currentShoppingStore||"la mia spesa";
    const message="Ti ho inviato "+label+". Apri questo link con La Mia Spesa per importare i prodotti nella tua spesa:\n\n"+url.toString();
    try{
      window.location.href="https://wa.me/?text="+encodeURIComponent(message);
    }catch(error){
      console.error("Condivisione Spesa:",error);
      alert("Non è stato possibile aprire WhatsApp.");
    }
  };

  const cleanSharedShoppingUrl=()=>{
    const url=new URL(window.location.href);
    if(!url.searchParams.has("spesa"))return;
    url.searchParams.delete("spesa");
    history.replaceState({},document.title,url.pathname+(url.search||"")+url.hash);
  };

  const importSharedShopping=()=>{
    if(!pendingSharedShopping||!Array.isArray(pendingSharedShopping.products))return;
    let added=0, skipped=0;
    pendingSharedShopping.products.forEach(raw=>{
      const name=String(raw.name||"").trim();
      if(!name)return;
      const duplicate=[...state.currentShopping,...state.purchasedShopping].some(existing=>
        String(existing.name||"").trim().toLocaleLowerCase("it")===name.toLocaleLowerCase("it")
      );
      if(duplicate){skipped++;return;}
      state.currentShopping.push({
        id:"shared-shopping-"+Date.now()+"-"+Math.random().toString(36).slice(2,9),
        _shoppingId:"shop-"+Date.now()+"-"+Math.random().toString(36).slice(2,9),
        name,
        price:raw.price??"",
        weight:raw.weight??"",
        pieces:Math.max(1,parseInt(raw.pieces,10)||1),
        store:raw.store??"",
        barcode:raw.barcode||""
      });
      added++;
    });

    // Se il destinatario non ha ancora una spesa attiva, eredita i dettagli della spesa ricevuta.
    const hasOwnDetails=!!(state.currentShoppingStore||state.currentShoppingDate||
      (state.currentShoppingName&&state.currentShoppingName!=="La mia spesa"));
    if(!hasOwnDetails){
      state.currentShoppingStore=pendingSharedShopping.store||"";
      state.currentShoppingDate=pendingSharedShopping.date||"";
      state.currentShoppingName=pendingSharedShopping.name||"La mia spesa";
    }

    save();
    pendingSharedShopping=null;
    close("shoppingImportPanel");
    cleanSharedShoppingUrl();
    renderHomeCurrentShopping();
    renderShopping();

    if(added&&skipped)alert("✓ Importati "+added+" prodotti. "+skipped+" erano già presenti nella tua spesa.");
    else if(added)alert("✓ Importati "+added+(added===1?" prodotto nella tua spesa.":" prodotti nella tua spesa."));
    else alert("Tutti i prodotti ricevuti erano già presenti nella tua spesa.");
  };

  const showSharedShoppingImport=()=>{
    const params=new URLSearchParams(window.location.search);
    const encoded=params.get("spesa");
    if(!encoded)return;
    try{
      const payload=fromBase64Url(encoded);
      if(!payload||payload.v!==1||!Array.isArray(payload.products)||!payload.products.length){
        throw new Error("Payload non valido");
      }
      pendingSharedShopping=payload;
      const meta=[payload.store,payload.date?String(payload.date).split("-").reverse().join("/"):null].filter(Boolean).join(" · ");
      $("shoppingImportNote").textContent="Hai ricevuto "+payload.products.length+(payload.products.length===1?" prodotto":" prodotti")+(meta?" per "+meta:"")+" da aggiungere alla tua spesa.";
      $("shoppingImportList").innerHTML=payload.products.slice(0,8).map(p=>{
        const pieces=Math.max(1,parseInt(p.pieces,10)||1);
        const safeName=String(p.name||"").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        return '<div><strong>'+safeName+'</strong><small>'+pieces+(pieces===1?" pezzo":" pezzi")+(p.price!==""&&p.price!==undefined?" · "+euro(p.price):"")+'</small></div>';
      }).join("")+(payload.products.length>8?'<p class="reminder-import-more">+ altri '+(payload.products.length-8)+' prodotti</p>':"");
      open("shoppingImportPanel");
    }catch(error){
      console.error("Importazione Spesa:",error);
      cleanSharedShoppingUrl();
      alert("⚠️ La spesa ricevuta non è valida o il link è incompleto.");
    }
  };

  const renderReminders=()=>{
    const list=$("remindersList"), empty=$("remindersEmpty");
    list.classList.toggle("is-selecting",reminderSelectionMode);
    list.innerHTML="";
    if(!state.reminders.length){ empty.hidden=false; return; }
    empty.hidden=true;
    state.reminders.forEach(p=>{
      if(!p.reminderQuantity)p.reminderQuantity=1;
      const item=document.createElement("div");
      item.className="library-item";
      item.innerHTML=productImage(p)+'<div class="library-item-info reminder-item-info"><strong>'+p.name+'</strong><small>Da acquistare: '+p.reminderQuantity+(p.reminderQuantity===1?' pezzo':' pezzi')+(p.price!==""&&p.price!==undefined?' · '+euro(p.price):"")+(p.store?' · '+p.store:'')+'</small></div><button class="reminder-select-control" type="button" aria-label="Seleziona '+p.name+'">✓</button>';
      const info=item.querySelector(".reminder-item-info");
      const selectControl=item.querySelector(".reminder-select-control");
      selectControl.classList.toggle("is-selected",selectedReminderIds.has(p.id));
      selectControl.onclick=(e)=>{
        e.stopPropagation();
        if(selectedReminderIds.has(p.id))selectedReminderIds.delete(p.id);
        else selectedReminderIds.add(p.id);
        selectControl.classList.toggle("is-selected",selectedReminderIds.has(p.id));
        refreshReminderMoveButton();
      };
      bindReminderPress(info,p.id);
      info.addEventListener("click",e=>{
        if(reminderSelectionMode)e.stopPropagation();
      },true);
      list.appendChild(item);
    });
  };
  const renderReminderLibrary=q=>{
    const list=$("reminderLibraryList"); const term=(q||"").toLowerCase();
    list.innerHTML="";
    state.products.filter(p=>p.name.toLowerCase().includes(term)).forEach(p=>{
      const exists=state.reminders.some(x=>x.id===p.id);
      const item=document.createElement("div"); item.className="library-item";
      item.innerHTML=productImage(p)+'<div class="library-item-info"><strong>'+p.name+'</strong><small>'+(p.store?'Negozio: '+p.store:'')+'</small></div><button class="add-to-list reminder-add-control '+(exists?'is-added':'')+'" type="button" aria-label="'+(exists?'Già aggiunto':'Aggiungi '+p.name)+'">'+(exists?"✓":"＋")+'</button>';
      const btn=item.querySelector("button");
      btn.onclick=()=>{
        if(state.reminders.some(x=>x.id===p.id)){
          alert('⚠️ "'+p.name+'" è già presente nei Promemoria.');
          // Anche qui puliamo la ricerca dopo l'avviso.
          $("reminderProductSearch").value="";
          renderReminderLibrary("");
          return;
        }
        state.reminders.push({...p,reminderQuantity:1});
        save();
        renderReminders();
        renderReminderLibrary($("reminderProductSearch").value);
      };
      list.appendChild(item);
    });
  };
  const addReminderByBarcode=async code=>{
    const normalized=String(code||"").replace(/[^0-9A-Za-z]/g,"");
    if(!normalized)return;
    const product=state.products.find(p=>String(p.barcode||"").replace(/[^0-9A-Za-z]/g,"")===normalized);
    if(!product){
      alert("⚠️ Questo prodotto non è ancora presente nella libreria.");
      return;
    }
    if(state.reminders.some(p=>p.id===product.id)){
      alert("✓ "+product.name+" è già presente nei Promemoria.");
      return;
    }
    state.reminders.push({...product,reminderQuantity:1});
    save();
    renderReminders();
    alert("✓ "+product.name+" aggiunto ai Promemoria.");
  };
  const scanReminderBarcode=async()=>{
    scannerTarget="reminder";
    await startScanner();
  };
  $("shareReminderBtn").onclick=shareReminder;
  $("shareShoppingBtn").onclick=shareShopping;
  $("confirmShoppingImportBtn").onclick=importSharedShopping;
  $("closeShoppingImportBtn").onclick=$("cancelShoppingImportBtn").onclick=()=>{
    pendingSharedShopping=null;
    close("shoppingImportPanel");
    cleanSharedShoppingUrl();
  };
  $("confirmReminderImportBtn").onclick=importSharedReminder;
  $("closeReminderImportBtn").onclick=$("cancelReminderImportBtn").onclick=()=>{
    pendingSharedReminder=null;
    close("reminderImportPanel");
    cleanSharedReminderUrl();
  };
  $("scanReminderBtn").onclick=scanReminderBarcode;
  $("reminderDecreaseBtn").onclick=()=>{$("reminderQuantityInput").value=Math.max(1,(parseInt($("reminderQuantityInput").value,10)||1)-1);};
  $("reminderIncreaseBtn").onclick=()=>{$("reminderQuantityInput").value=(parseInt($("reminderQuantityInput").value,10)||1)+1;};
  $("saveReminderEditBtn").onclick=saveReminderQuantity;
  $("closeReminderEdit").onclick=$("closeReminderEditBtn").onclick=closeReminderEditor;
  $("reminderSelectBtn").onclick=()=>{
    reminderSelectionMode=!reminderSelectionMode;
    if(!reminderSelectionMode)selectedReminderIds.clear();
    updateReminderSelectButton();
    refreshReminderMoveButton();
    renderReminders();
  };
  $("moveSelectedReminderBtn").onclick=()=>{
    if(!selectedReminderIds.size)return;
    const count=selectedReminderIds.size;
    $("reminderTransferCount").textContent=count+(count===1?" prodotto selezionato":" prodotti selezionati")+" verr"+(count===1?"à":"anno")+" spostati dal Promemoria.";
    const meta=[];
    if(state.currentShoppingStore)meta.push(state.currentShoppingStore);
    if(state.currentShoppingDate)meta.push(state.currentShoppingDate.split("-").reverse().join("/"));
    if(state.currentShoppingName&&state.currentShoppingName!=="La mia spesa")meta.push(state.currentShoppingName);
    $("transferCurrentMeta").textContent=meta.length?meta.join(" · "):"Aggiungi alla lista già aperta";
    open("reminderTransferPanel");
  };
  $("closeReminderTransfer").onclick=$("closeReminderTransferBtn").onclick=()=>close("reminderTransferPanel");
  $("transferToCurrentBtn").onclick=moveSelectedIntoCurrentShopping;
  $("transferToNewBtn").onclick=moveSelectedIntoNewShopping;
  $("remindersBtn").onclick=()=>{reminderSelectionMode=false;selectedReminderIds.clear();updateReminderSelectButton();renderReminders();open("remindersPanel");};
  $("closeReminders").onclick=$("closeRemindersBtn").onclick=()=>close("remindersPanel");
  $("addReminderBtn").onclick=()=>{renderReminderLibrary("");$("reminderProductSearch").value="";open("reminderProductPanel");};
  $("closeReminderProducts").onclick=$("closeReminderProductsBtn").onclick=()=>close("reminderProductPanel");
  $("reminderProductSearch").oninput=e=>renderReminderLibrary(e.target.value);
  $("newReminderProductBtn").onclick=()=>{close("reminderProductPanel");resetProductForm();$("newProductPanel").dataset.reminderMode="1";open("newProductPanel");};
  const originalProductSubmit=$("newProductForm").onsubmit;
  $("newProductForm").addEventListener("submit",()=>{
    if($("newProductPanel").dataset.reminderMode==="1"){
      setTimeout(()=>{
        const newest=state.products[state.products.length-1];
        if(newest&&!state.reminders.some(x=>x.id===newest.id)){state.reminders.push({...newest,reminderQuantity:1});save();}
        delete $("newProductPanel").dataset.reminderMode;
        renderReminders();
      },0);
    }
  });

  // Se l'app è stata aperta da un link condiviso, proponiamo subito l'importazione.
  showSharedReminderImport();
  showSharedShoppingImport();

  // Mostra subito dalla Home l'accesso alla spesa già aperta.
  renderHomeCurrentShopping();
});