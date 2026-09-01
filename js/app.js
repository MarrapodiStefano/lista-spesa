if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js?v=60", { updateViaCache: "none" });
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

document.addEventListener("DOMContentLoaded", () => {
  const DB_KEY="listaSpesaDB";
  let pendingPhoto="";
  let editingProductId=null;
  let editingShoppingId=null;
  let editingReminderId=null;
  let scanner=null; let scannerControls=null; let scannerRunning=false; let processingBarcode=false; let scanLoopId=null; let scannerStream=null;
  const state=JSON.parse(localStorage.getItem(DB_KEY)||'{"products":[],"currentShopping":[],"purchasedShopping":[],"currentShoppingName":"La mia spesa","history":[],"reminders":[]}');
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
  });
  migrateProductFields(state.products);
  migrateProductFields(state.currentShopping);
  migrateProductFields(state.purchasedShopping);
  const ensureShoppingIds=items=>items.forEach((p,i)=>{if(!p._shoppingId)p._shoppingId="shop-"+Date.now()+"-"+i+"-"+Math.random().toString(36).slice(2,8);});
  ensureShoppingIds(state.currentShopping);
  ensureShoppingIds(state.purchasedShopping);
  const $=id=>document.getElementById(id);
  const save=()=>localStorage.setItem(DB_KEY,JSON.stringify(state));
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

  const openPurchaseEditor=id=>{
    const item=state.currentShopping.find(p=>p._shoppingId===id);
    if(!item)return;
    editingShoppingId=id;
    $("purchaseEditName").textContent=item.name;
    $("purchasePiecesInput").value=Math.max(1,parseInt(item.pieces,10)||1);
    $("purchasePriceInput").value=item.price??"";
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
    item.price=$("purchasePriceInput").value.trim().replace(",",".");
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
  const renderHistory=()=>{
    const list=$("historyList");
    if(!list)return;
    if(!Array.isArray(state.history)||!state.history.length){
      list.innerHTML='<div class="empty-state"><span>🕘</span><h2>Nessuna spesa salvata</h2><p>Quando concluderai una spesa, la troverai qui.</p></div>';
      return;
    }
    list.innerHTML=state.history.map(h=>{
      const date=h.date?h.date.split("-").reverse().join("/"):"";
      const total=(h.products||[]).reduce((s,p)=>s+((Number(p.price)||0)*(Number(p.pieces)||1)),0);
      return '<article class="history-card">'+
        '<div class="history-card-head"><div><strong>'+((h.name&&h.name!=="La mia spesa")?h.name:(h.store||"Spesa"))+'</strong><small>'+[h.store,date].filter(Boolean).join(" · ")+'</small></div><b>'+euro(total)+'</b></div>'+
        '<div class="history-products">'+(h.products||[]).map(p=>'<div><span>'+p.name+' · '+(p.pieces||1)+'</span><b>'+euro((Number(p.price)||0)*(Number(p.pieces)||1))+'</b></div>').join("")+'</div>'+
      '</article>';
    }).join("");
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
    $("libraryList").innerHTML=products.length
      ?products.map(p=>'<div class="library-item">'+
          productImage(p)+
          '<div class="library-item-info"><strong>'+p.name+'</strong><small>Peso: '+(p.weight||'—')+' · Pezzi: '+(p.pieces||1)+(p.store?' · Negozio: '+p.store:'')+(p.price!==""?" · Prezzo: "+euro(p.price):"")+'</small></div>'+
          '<div class="library-actions"><button class="library-add-btn" data-id="'+p.id+'">Aggiungi</button><button class="library-edit-btn" data-edit-id="'+p.id+'" aria-label="Modifica '+p.name+'">✎</button></div>'+
        '</div>').join("")
      :'<div class="empty-state"><span>📦</span><h2>Nessun prodotto</h2><p>Aggiungi il primo prodotto alla tua libreria.</p></div>';

    [...$("libraryList").querySelectorAll("button[data-id]")].forEach(b=>b.onclick=()=>{
      const p=state.products.find(x=>x.id===b.dataset.id);
      if(!p)return;

      // Evita duplicati: lo stesso prodotto può stare una sola volta
      // nella spesa, sia "Da acquistare" sia nel "Carrello".
      const alreadyToBuy=state.currentShopping.some(x=>x.id===p.id);
      const alreadyInCart=state.purchasedShopping.some(x=>x.id===p.id);
      if(alreadyToBuy||alreadyInCart){
        const where=alreadyToBuy?"nella lista da acquistare":"nel Carrello";
        alert('⚠️ "'+p.name+'" è già presente '+where+'.');
        // Dopo l'avviso azzeriamo la ricerca, così non resta il testo precedente.
        $("productSearch").value="";
        renderLibrary("");
        return;
      }

      state.currentShopping.push({...p,_shoppingId:"shop-"+Date.now()+"-"+Math.random().toString(36).slice(2,8)});
      save();renderShopping();close("productPanel");
    });

    [...$("libraryList").querySelectorAll("button[data-edit-id]")].forEach(b=>b.onclick=()=>{
      const p=state.products.find(x=>x.id===b.dataset.editId);
      if(!p)return;
      editingProductId=p.id;
      $("productName").value=p.name||"";
      $("productPrice").value=p.price||"";
      $("productWeight").value=p.weight??p.quantity??"";
      $("productPieces").value=p.pieces||1;
      const knownStores=["Conad","Triscount","Alimentarista","Todis"];
      $("productStore").value=knownStores.includes(p.store) ? p.store : (p.store ? "Altro" : "");
      $("productCustomStore").value=knownStores.includes(p.store)||!p.store ? "" : p.store;
      $("customStoreWrap").hidden=$("productStore").value!=="Altro";
      pendingPhoto=p.photo||"";
      $("newProductForm").dataset.barcode=p.barcode||"";
      $("newProductForm").dataset.editing="1";
      $("newProductPanel").querySelector(".eyebrow").textContent="MODIFICA PRODOTTO";
      const editProductTitle=$("newProductPanel").querySelector(".panel-header h1");
      if(editProductTitle)editProductTitle.textContent="";
      // In modifica non serve la scansione: resta disponibile solo quando si crea un nuovo prodotto.
      const scanBtn=$("scanProductBtn");
      const scanNote=document.querySelector("#newProductPanel .scan-note");
      if(scanBtn)scanBtn.hidden=true;
      if(scanNote)scanNote.hidden=true;
      $("newProductForm").querySelector(".save-product-btn").textContent="Salva modifiche";
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
  $("historyBtn").onclick=()=>{renderHistory();open("historyPanel");};
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
  $("productPhoto").onchange=e=>{const file=e.target.files&&e.target.files[0];if(!file){pendingPhoto="";$("photoPreview").hidden=true;return;}const reader=new FileReader();reader.onload=()=>{pendingPhoto=reader.result;$("photoPreviewImg").src=pendingPhoto;$("photoPreview").hidden=false;};reader.readAsDataURL(file);};
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
    const weight=$("productWeight").value.trim().replace(",",".");
    const pieces=Math.max(1,parseInt($("productPieces").value,10)||1);
    const selectedStore=$("productStore").value;
    const store=selectedStore==="Altro" ? $("productCustomStore").value.trim() : selectedStore;
    if(!name)return;

    const product={
      id:editingProductId||Date.now().toString(),
      name,
      price,
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

    save();
    resetProductForm();
    close("newProductPanel");
    renderLibrary($("productSearch").value);
    renderShopping();
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
      item.innerHTML=productImage(p)+'<div class="library-item-info"><strong>'+p.name+'</strong><small>'+(p.store?'Negozio: '+p.store:'')+'</small></div><button class="add-to-list" type="button">'+(exists?"✓":"＋")+'</button>';
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

  // Mostra subito dalla Home l'accesso alla spesa già aperta.
  renderHomeCurrentShopping();
});