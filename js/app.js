if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);

document.addEventListener("DOMContentLoaded", () => {
  const DB_KEY="listaSpesaDB";
  let pendingPhoto="";
  let scanner=null; let scannerRunning=false;
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
  const lookupBarcode=async code=>{ $("scannerStatus").textContent="Codice trovato. Cerco il prodotto…"; try{const local=state.products.find(p=>p.barcode===code);if(local){await stopScanner();close("scannerPanel");$("productName").value=local.name||"";$("productQuantity").value=local.quantity||1;$("productPrice").value=local.price||"";pendingPhoto=local.photo||"";if(pendingPhoto){$("photoPreviewImg").src=pendingPhoto;$("photoPreview").hidden=false;}return;}const response=await fetch("https://world.openfoodfacts.org/api/v2/product/"+encodeURIComponent(code)+".json?fields=code,product_name,brands,quantity,image_front_url,image_url");const data=await response.json();await stopScanner();close("scannerPanel");$("newProductForm").dataset.barcode=code;if(data.status===1&&data.product){const p=data.product;$("productName").value=p.product_name||p.brands||"";const qty=(p.quantity||"").match(/\d+/);if(qty)$("productQuantity").value=qty[0];pendingPhoto=p.image_front_url||p.image_url||"";if(pendingPhoto){$("photoPreviewImg").src=pendingPhoto;$("photoPreview").hidden=false;}}else alert("Prodotto non trovato online. Puoi completarlo manualmente.");}catch(e){await stopScanner();close("scannerPanel");alert("Non riesco a recuperare le informazioni online.");}};
  const startScanner=async()=>{open("scannerPanel");$("scannerStatus").textContent="Richiedo l'accesso alla fotocamera…";try{if(!window.Html5Qrcode)throw Error();scanner=new Html5Qrcode("barcodeReader");await scanner.start({facingMode:"environment"},{fps:10,qrbox:{width:280,height:160}},code=>lookupBarcode(code),()=>{});scannerRunning=true;$("scannerStatus").textContent="Inquadra il codice a barre";}catch(e){close("scannerPanel");alert("Impossibile aprire la fotocamera. Verifica i permessi.");}};
  $("scanProductBtn").onclick=startScanner;
  $("closeScanner").onclick=$("closeScannerBtn").onclick=async()=>{await stopScanner();close("scannerPanel");};
  $("newProductForm").onsubmit=e=>{e.preventDefault();const name=$("productName").value.trim();const price=$("productPrice").value.trim().replace(",",".");const quantity=Math.max(1,parseInt($("productQuantity").value,10)||1);if(!name)return;state.products.push({id:Date.now().toString(),name,price,quantity,photo:pendingPhoto,barcode:e.target.dataset.barcode||""});save();pendingPhoto="";$("photoPreview").hidden=true;delete e.target.dataset.barcode;e.target.reset();$("productQuantity").value=1;close("newProductPanel");renderLibrary();};
  $("remindersBtn").onclick=()=>open("remindersPanel");
  $("closeReminders").onclick=$("closeRemindersBtn").onclick=()=>close("remindersPanel");
});