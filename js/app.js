if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js?v=19", { updateViaCache: "none" });
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
  let scanner=null; let scannerControls=null; let scannerRunning=false; let processingBarcode=false; let scanLoopId=null; let scannerStream=null;
  const state=JSON.parse(localStorage.getItem(DB_KEY)||'{"products":[],"currentShopping":[],"purchasedShopping":[],"currentShoppingName":"La mia spesa","history":[],"reminders":[]}');
  if(!Array.isArray(state.currentShopping)) state.currentShopping=[];
  if(!Array.isArray(state.purchasedShopping)) state.purchasedShopping=[];
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
        '<small>Quantità: '+(p.quantity||1)+'</small>'+
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
        if(Date.now()-startTime<900 && Math.abs(dx)>65 && Math.abs(dx)>Math.abs(dy)*1.25){
          item.classList.add("is-swiping");
          moveShoppingItem(item.dataset.shoppingId,item.dataset.acquired==="1");
        }
      },{passive:true});
      item.addEventListener("touchcancel",clearLong,{passive:true});
      item.addEventListener("contextmenu",e=>{
        if(item.dataset.acquired!=="1"){e.preventDefault();removeShoppingItem(item.dataset.shoppingId);}
      });
    });
  };

  const renderShopping=()=>{
    $("shoppingTitle").textContent=state.currentShoppingName;
    const list=$("shoppingList");
    const pendingCount=state.currentShopping.length;
    const purchasedCount=state.purchasedShopping.length;
    const count=pendingCount+purchasedCount;
    $("shoppingTotal").textContent=euro(state.currentShopping.reduce((s,p)=>s+(Number(p.price)||0),0));
    document.querySelector(".shopping-summary span").textContent=count+(count===1?" prodotto":" prodotti");
    if(!count){
      list.innerHTML='<div class="empty-state"><span>🛒</span><h2>La lista è vuota</h2><p>Aggiungi il primo prodotto dalla tua libreria.</p></div>';
      return;
    }
    let html="";
    if(pendingCount) html+='<div class="shopping-section"><div class="shopping-section-title">DA ACQUISTARE · '+pendingCount+'</div>'+state.currentShopping.map(p=>shoppingItem(p,false)).join("")+'</div>';
    if(purchasedCount) html+='<div class="shopping-section"><div class="shopping-section-title">ACQUISTATI · '+purchasedCount+'</div>'+state.purchasedShopping.map(p=>shoppingItem(p,true)).join("")+'</div>';
    list.innerHTML=html;
    bindShoppingGestures();
  };
  const renderLibrary=(q="")=>{
    const products=state.products.filter(p=>p.name.toLowerCase().includes(q.toLowerCase()));
    $("libraryList").innerHTML=products.length
      ?products.map(p=>'<div class="library-item">'+
          productImage(p)+
          '<div class="library-item-info"><strong>'+p.name+'</strong><small>Quantità: '+(p.quantity||1)+(p.price!==""?" · Prezzo: "+euro(p.price):"")+'</small></div>'+
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
      $("productQuantity").value=p.quantity||1;
      pendingPhoto=p.photo||"";
      $("newProductForm").dataset.barcode=p.barcode||"";
      $("newProductForm").dataset.editing="1";
      $("newProductPanel").querySelector(".eyebrow").textContent="MODIFICA PRODOTTO";
      $("newProductPanel").querySelector(".panel-header h1").textContent="Modifica prodotto";
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
    $("productQuantity").value=1;
    $("photoPreview").hidden=true;
    $("newProductPanel").querySelector(".eyebrow").textContent="NUOVO PRODOTTO";
    $("newProductPanel").querySelector(".panel-header h1").textContent="Aggiungi alla libreria";
    form.querySelector(".save-product-btn").textContent="Salva prodotto";
  };
  $("newShoppingBtn").onclick=()=>{$("homeScreen").hidden=true;$("shoppingScreen").hidden=false;renderShopping();};
  $("backHomeBtn").onclick=()=>{$("shoppingScreen").hidden=true;$("homeScreen").hidden=false;};
  $("addProductBtn").onclick=()=>{renderLibrary();open("productPanel");};
  $("closeProducts").onclick=$("closeProductsBtn").onclick=()=>close("productPanel");
  $("newProductBtn").onclick=()=>{resetProductForm();open("newProductPanel");};
  $("closeNewProduct").onclick=$("closeNewProductBtn").onclick=()=>{resetProductForm();close("newProductPanel");};
  $("productSearch").oninput=e=>renderLibrary(e.target.value);
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
        $("productQuantity").value=local.quantity||1;
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
        if(qty)$("productQuantity").value=qty[0];
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
    $("scannerStatus").textContent="Scanner V1.4.7 pronto. Puoi tenere il codice anche ruotato.";

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
    $("scannerStatus").textContent="Scanner V1.4.7 pronto. Inquadra il codice da qualsiasi orientamento.";
  };

  const startScanner=async()=>{
    processingBarcode=false;
    await stopScanner();
    open("scannerPanel");
    $("scannerStatus").textContent="Richiedo l'accesso alla fotocamera…";

    try{
      $("barcodeReader").innerHTML='<video id="zxingVideo" autoplay muted playsinline></video>';
      const video=$("zxingVideo");

      // V1.4.7: prima usiamo il lettore nativo dell'iPhone, più adatto ai codici
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
    const quantity=Math.max(1,parseInt($("productQuantity").value,10)||1);
    if(!name)return;

    const product={
      id:editingProductId||Date.now().toString(),
      name,
      price,
      quantity,
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