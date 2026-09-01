if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("./sw.js?v=12", { updateViaCache: "none" });
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
  let scanner=null; let scannerRunning=false; let processingBarcode=false;
  const state=JSON.parse(localStorage.getItem(DB_KEY)||'{"products":[],"currentShopping":[],"currentShoppingName":"La mia spesa","history":[],"reminders":[]}');
  const $=id=>document.getElementById(id);
  const save=()=>localStorage.setItem(DB_KEY,JSON.stringify(state));
  const euro=v=>v===null||v===undefined||v===""?"":new Intl.NumberFormat("it-IT",{style:"currency",currency:"EUR"}).format(Number(v));
  const open=id=>{ $(id).classList.add("is-open"); $(id).setAttribute("aria-hidden","false"); document.body.style.overflow="hidden"; };
  const close=id=>{ $(id).classList.remove("is-open"); $(id).setAttribute("aria-hidden","true"); document.body.style.overflow=""; };
  const productImage=p=>p.photo?'<img class="product-thumb" src="'+p.photo+'" alt="">':'<span class="product-thumb product-thumb-placeholder">📦</span>';
  const renderShopping=()=>{
    $("shoppingTitle").textContent=state.currentShoppingName;
    const list=$("shoppingList"); const count=state.currentShopping.length;
    $("shoppingTotal").textContent=euro(state.currentShopping.reduce((s,p)=>s+(Number(p.price)||0),0));
    document.querySelector(".shopping-summary span").textContent=count+(count===1?" prodotto":" prodotti");
    list.innerHTML=count?state.currentShopping.map(p=>'<div class="shopping-item">'+productImage(p)+'<div class="shopping-item-name">'+p.name+'<small>Quantità: '+(p.quantity||1)+'</small></div><div class="shopping-item-price">'+(p.price!==""?euro(p.price):"—")+'</div></div>').join(""):'<div class="empty-state"><span>🛒</span><h2>La lista è vuota</h2><p>Aggiungi il primo prodotto dalla tua libreria.</p></div>';
  };
  const renderLibrary=(q="")=>{
    const products=state.products.filter(p=>p.name.toLowerCase().includes(q.toLowerCase()));
    $("libraryList").innerHTML=products.length?products.map(p=>'<div class="library-item">'+productImage(p)+'<div><strong>'+p.name+'</strong><small>Quantità: '+(p.quantity||1)+(p.price!==""?" · Prezzo: "+euro(p.price):"")+'</small></div><button data-id="'+p.id+'">Aggiungi</button></div>').join(""):'<div class="empty-state"><span>📦</span><h2>Nessun prodotto</h2><p>Aggiungi il primo prodotto alla tua libreria.</p></div>';
    [...$("libraryList").querySelectorAll("button[data-id]")].forEach(b=>b.onclick=()=>{const p=state.products.find(x=>x.id===b.dataset.id);state.currentShopping.push({...p});save();renderShopping();close("productPanel");});
  };
  $("newShoppingBtn").onclick=()=>{$("homeScreen").hidden=true;$("shoppingScreen").hidden=false;renderShopping();};
  $("backHomeBtn").onclick=()=>{$("shoppingScreen").hidden=true;$("homeScreen").hidden=false;};
  $("addProductBtn").onclick=()=>{renderLibrary();open("productPanel");};
  $("closeProducts").onclick=$("closeProductsBtn").onclick=()=>close("productPanel");
  $("newProductBtn").onclick=()=>open("newProductPanel");
  $("closeNewProduct").onclick=$("closeNewProductBtn").onclick=()=>close("newProductPanel");
  $("productSearch").oninput=e=>renderLibrary(e.target.value);
  $("productPhoto").onchange=e=>{const file=e.target.files&&e.target.files[0];if(!file){pendingPhoto="";$("photoPreview").hidden=true;return;}const reader=new FileReader();reader.onload=()=>{pendingPhoto=reader.result;$("photoPreviewImg").src=pendingPhoto;$("photoPreview").hidden=false;};reader.readAsDataURL(file);};
  const stopScanner=async()=>{if(scanner&&scannerRunning){try{await scanner.stop();}catch(e){}scannerRunning=false;}};

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

  const startScanner=async()=>{
    processingBarcode=false;
    open("scannerPanel");
    $("scannerStatus").textContent="Richiedo l'accesso alla fotocamera…";
    try{
      if(!window.Html5Qrcode)throw Error("Scanner non disponibile");

      // Configurazione volutamente semplice: su iPhone Safari il decoder
      // standard della libreria è più affidabile per i codici EAN lineari
      // rispetto al BarcodeDetector sperimentale.
      scanner=new Html5Qrcode("barcodeReader",{
        formatsToSupport:[
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.ITF
        ]
      },false);

      await scanner.start(
        {facingMode:"environment"},
        {
          fps:10,
          // Nessun ritaglio della videocamera: analizziamo l'intera immagine.
          // Questo aiuta soprattutto i codici a barre 1D su iPhone.
          disableFlip:false
        },
        (decodedText)=>lookupBarcode(decodedText),
        ()=>{}
      );

      scannerRunning=true;
      $("scannerStatus").textContent="Scanner pronto. Metti il codice al centro, riempi bene l'inquadratura e tieni fermo l'iPhone.";
    }catch(e){
      console.error("Errore scanner",e);
      try{if(scanner)await scanner.clear();}catch(x){}
      scanner=null;
      close("scannerPanel");
      alert("Impossibile avviare la scansione. Verifica i permessi della fotocamera e riprova.");
    }
  };
  $("scanProductBtn").onclick=startScanner;
  $("closeScanner").onclick=$("closeScannerBtn").onclick=async()=>{await stopScanner();close("scannerPanel");};
  $("newProductForm").onsubmit=e=>{e.preventDefault();const name=$("productName").value.trim();const price=$("productPrice").value.trim().replace(",",".");const quantity=Math.max(1,parseInt($("productQuantity").value,10)||1);if(!name)return;state.products.push({id:Date.now().toString(),name,price,quantity,photo:pendingPhoto,barcode:e.target.dataset.barcode||""});save();pendingPhoto="";$("photoPreview").hidden=true;delete e.target.dataset.barcode;e.target.reset();$("productQuantity").value=1;close("newProductPanel");renderLibrary();};
  $("remindersBtn").onclick=()=>open("remindersPanel");
  $("closeReminders").onclick=$("closeRemindersBtn").onclick=()=>close("remindersPanel");
});