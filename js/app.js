if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js?v=33", { updateViaCache: "none" });
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
  let scanner=null; let scannerControls=null; let scannerRunning=false; let processingBarcode=false; let scanLoopId=null; let scannerStream=null;
  const state=JSON.parse(localStorage.getItem(DB_KEY)||'{"products":[],"currentShopping":[],"purchasedShopping":[],"currentShoppingName":"La mia spesa","history":[],"reminders":[]}');
  if(!Array.isArray(state.currentShopping)) state.currentShopping=[];
  if(!state.currentShoppingName) state.currentShoppingName="La mia spesa";
  if(state.currentShoppingStore===undefined) state.currentShoppingStore="";
  if(state.currentShoppingDate===undefined) state.currentShoppingDate="";
  if(!Array.isArray(state.purchasedShopping)) state.purchasedShopping=[];
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
  const euro=v=>v===null||v===undefined||v===""?"":new Intl.NumberFormat("it-IT",{style:"currency",currency:"EUR"}).format(Number(v));
  const open=id=>{ $(id).classList.add("is-open"); $(id).setAttribute("aria-hidden","false"); document.body.style.overflow="hidden"; };
  const close=id=>{ $(id).classList.remove("is-open"); $(id).setAttribute("aria-hidden","true"); document.body.style.overflow=""; };
  const productImage=p=>p.photo?'<img class="product-thumb" src="'+p.photo+'" alt="">':'<span class="product-thumb product-thumb-placeholder">📦</span>';
  const shoppingItem=(p,acquired)=>'<div class="shopping-item'+(acquired?' is-acquired':'')+'" data-shopping-id="'+p._shoppingId+'" data-acquired="'+(acquired?'1':'0')+'">'+
      productImage(p)+
      '<div class="shopping-item-name">'+p.name+
        '<small>Peso: '+(p.weight||'—')+' · Pezzi: '+(p.pieces||1)+(p.store?' · Negozio: '+p.store:'')+'</small>'+
        '<span class="shopping-item-hint">'+(acquired?'Swipe per rimetterlo da acquistare':'Swipe per segnare come acquistato · Tieni premuto per rimuovere')+'</span>'+
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
            if(!moved){navigator.vibrate&&navigator.vibrate(20);removeShoppingItem(item.dataset.shoppingId);}
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
        if(elapsed<900 && Math.abs(dx)>65 && Math.abs(dx)>Math.abs(dy)*1.25){
          item.classList.add("is-swiping");
          moveShoppingItem(item.dataset.shoppingId,item.dataset.acquired==="1");
        }else if(!moved && elapsed<500 && item.dataset.acquired!=="1"){
          openPurchaseEditor(item.dataset.shoppingId);
        }
      },{passive:true});
      item.addEventListener("touchcancel",clearLong,{passive:true});
      item.addEventListener("contextmenu",e=>{
        if(item.dataset.acquired!=="1"){e.preventDefault();removeShoppingItem(item.dataset.shoppingId);}
      });
    });
  };

  const renderShopping=()=>{
    const shoppingMeta=$("shoppingMeta");
    const shoppingInfo=[];
    if(state.currentShoppingStore) shoppingInfo.push(state.currentShoppingStore);
    if(state.currentShoppingDate) shoppingInfo.push(state.currentShoppingDate.split("-").reverse().join("/"));
    if(state.currentShoppingName && state.currentShoppingName!=="La mia spesa") shoppingInfo.push(state.currentShoppingName);
    if(shoppingMeta) shoppingMeta.textContent=shoppingInfo.join(" · ");
    const list=$("shoppingList");
    const pendingCount=state.currentShopping.length;
    const purchasedCount=state.purchasedShopping.length;
    const count=pendingCount+purchasedCount;
    const cartTotal=state.purchasedShopping.reduce((s,p)=>s+((Number(p.price)||0)*(Number(p.pieces)||1)),0);
    $("shoppingTotal").textContent=euro(cartTotal);
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

  const todayISO=()=>new Date().toISOString().slice(0,10);
  const openNewShopping=()=>{
    $("newShoppingForm").reset();
    $("newShoppingDate").value=todayISO();
    $("newShoppingCustomStoreWrap").hidden=true;
    open("newShoppingPanel");
  };
  $("newShoppingBtn").onclick=openNewShopping;
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
    state.currentShoppingName=finalName;
    state.currentShoppingStore=store;
    state.currentShoppingDate=date;
    state.currentShopping=[];
    state.purchasedShopping=[];
    save();
    close("newShoppingPanel");
    $("homeScreen").hidden=true;$("shoppingScreen").hidden=false;
    renderShopping();
  };
  $("homeNewProductBtn").onclick=()=>{resetProductForm();open("newProductPanel");};
  $("backHomeBtn").onclick=()=>{$("shoppingScreen").hidden=true;$("homeScreen").hidden=false;};
  $("addProductBtn").onclick=()=>{renderLibrary();open("productPanel");};
  $("closeProducts").onclick=$("closeProductsBtn").onclick=()=>close("productPanel");
  $("newProductBtn").onclick=()=>{resetProductForm();open("newProductPanel");};
  $("closeNewProduct").onclick=$("closeNewProductBtn").onclick=()=>{resetProductForm();close("newProductPanel");};
  $("productSearch").oninput=e=>renderLibrary(e.target.value);
  $("productStore").onchange=e=>{
    const isOther=e.target.value==="Altro";
    $("customStoreWrap").hidden=!isOther;
    if(!isOther)$("productCustomStore").value="";
  };
  $("productPhoto").onchange=e=>{const file=e.target.files&&e.target.files[0];if(!file){pendingPhoto="";$("photoPreview").hidden=true;return;}const reader=new FileReader();reader.onload=()=>{pendingPhoto=reader.result;$("photoPreviewImg").src=pendingPhoto;$("photoPreview").hidden=false;};reader.readAsDataURL(file);};
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
      state.currentShopping=state.currentShopping.map(p=>p.id===editingProductId?{...product,_shoppingId:p._shoppingId}:p);
      state.purchasedShopping=state.purchasedShopping.map(p=>p.id===editingProductId?{...product,_shoppingId:p._shoppingId}:p);
    }else{
      state.products.push(product);
    }

    save();
    resetProductForm();
    close("newProductPanel");
    renderLibrary($("productSearch").value);
    renderShopping();
  };
  $("remindersBtn").onclick=()=>open("remindersPanel");
  $("closeReminders").onclick=$("closeRemindersBtn").onclick=()=>close("remindersPanel");
});