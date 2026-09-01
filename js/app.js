if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);

document.addEventListener("DOMContentLoaded", () => {
  const DB_KEY="listaSpesaDB";
  const state=JSON.parse(localStorage.getItem(DB_KEY)||'{"products":[],"currentShopping":[],"currentShoppingName":"La mia spesa","history":[],"reminders":[]}');
  const $=id=>document.getElementById(id);
  const save=()=>localStorage.setItem(DB_KEY,JSON.stringify(state));
  const euro=v=>v===null||v===undefined||v===""?"":new Intl.NumberFormat("it-IT",{style:"currency",currency:"EUR"}).format(Number(v));
  const open=id=>{ $(id).classList.add("is-open"); $(id).setAttribute("aria-hidden","false"); document.body.style.overflow="hidden"; };
  const close=id=>{ $(id).classList.remove("is-open"); $(id).setAttribute("aria-hidden","true"); document.body.style.overflow=""; };
  const renderShopping=()=>{
    $("shoppingTitle").textContent=state.currentShoppingName;
    const list=$("shoppingList"); const count=state.currentShopping.length;
    $("shoppingTotal").textContent=euro(state.currentShopping.reduce((s,p)=>s+(Number(p.price)||0),0));
    document.querySelector(".shopping-summary span").textContent=count+(count===1?" prodotto":" prodotti");
    list.innerHTML=count?state.currentShopping.map(p=>'<div class="shopping-item"><span>🛒</span><div class="shopping-item-name">'+p.name+'</div><div class="shopping-item-price">'+(p.price!==""?euro(p.price):"—")+'</div></div>').join(""):'<div class="empty-state"><span>🛒</span><h2>La lista è vuota</h2><p>Aggiungi il primo prodotto dalla tua libreria.</p></div>';
  };
  const renderLibrary=(q="")=>{
    const products=state.products.filter(p=>p.name.toLowerCase().includes(q.toLowerCase()));
    $("libraryList").innerHTML=products.length?products.map(p=>'<div class="library-item"><span>📦</span><div><strong>'+p.name+'</strong><small>'+ (p.price!==""?"Prezzo: "+euro(p.price):"Nessun prezzo salvato")+'</small></div><button data-id="'+p.id+'">Aggiungi</button></div>').join(""):'<div class="empty-state"><span>📦</span><h2>Nessun prodotto</h2><p>Aggiungi il primo prodotto alla tua libreria.</p></div>';
    [...$("libraryList").querySelectorAll("button[data-id]")].forEach(b=>b.onclick=()=>{const p=state.products.find(x=>x.id===b.dataset.id);state.currentShopping.push({...p});save();renderShopping();close("productPanel");});
  };
  $("newShoppingBtn").onclick=()=>{$("homeScreen").hidden=true;$("shoppingScreen").hidden=false;renderShopping();};
  $("backHomeBtn").onclick=()=>{$("shoppingScreen").hidden=true;$("homeScreen").hidden=false;};
  $("addProductBtn").onclick=()=>{renderLibrary();open("productPanel");};
  $("closeProducts").onclick=$("closeProductsBtn").onclick=()=>close("productPanel");
  $("newProductBtn").onclick=()=>open("newProductPanel");
  $("closeNewProduct").onclick=$("closeNewProductBtn").onclick=()=>close("newProductPanel");
  $("productSearch").oninput=e=>renderLibrary(e.target.value);
  $("newProductForm").onsubmit=e=>{e.preventDefault();const name=$("productName").value.trim();const price=$("productPrice").value.trim().replace(",",".");if(!name)return;state.products.push({id:Date.now().toString(),name,price});save();e.target.reset();close("newProductPanel");renderLibrary();};
  $("remindersBtn").onclick=()=>open("remindersPanel");
  $("closeReminders").onclick=$("closeRemindersBtn").onclick=()=>close("remindersPanel");
});