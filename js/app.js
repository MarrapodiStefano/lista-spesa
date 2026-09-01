/* ==========================================
   LA MIA SPESA - CERVELLO DELL'APP
   Tutti i dati restano salvati sul dispositivo.
   ========================================== */

(() => {
    "use strict";

    const STORAGE_KEY = "laMiaSpesaDataV1";

    const $ = (id) => document.getElementById(id);

    const els = {
        shoppingName: $("shoppingName"),
        renameButton: $("renameButton"),
        tabs: [...document.querySelectorAll(".tab")],
        pages: {
            shopping: $("shoppingPage"),
            products: $("productsPage"),
            history: $("historyPage")
        },
        todoList: $("todoList"),
        boughtList: $("boughtList"),
        todoCounter: $("todoCounter"),
        boughtCounter: $("boughtCounter"),
        total: $("total"),
        addProductButton: $("addProductButton"),
        closeShoppingButton: $("closeShoppingButton"),
        productDialog: $("productDialog"),
        productForm: $("productForm"),
        productDialogTitle: $("productDialogTitle"),
        productName: $("productName"),
        productPrice: $("productPrice"),
        productQuantity: $("productQuantity"),
        productNote: $("productNote"),
        cancelProductButton: $("cancelProductButton"),
        productDetailDialog: $("productDetailDialog"),
        detailProductName: $("detailProductName"),
        detailProductPrice: $("detailProductPrice"),
        detailProductQuantity: $("detailProductQuantity"),
        detailProductNote: $("detailProductNote"),
        closeDetailButton: $("closeDetailButton"),
        editProductButton: $("editProductButton"),
        productSearch: $("productSearch"),
        productsList: $("productsList"),
        newProductButton: $("newProductButton"),
        historyList: $("historyList"),
        historyTotal: $("historyTotal"),
        historyDetailDialog: $("historyDetailDialog"),
        historyDetailName: $("historyDetailName"),
        historyDetailContent: $("historyDetailContent"),
        closeHistoryDetailButton: $("closeHistoryDetailButton")
    };

    function todayName() {
        return "Spesa " + new Intl.DateTimeFormat("it-IT", {
            day: "numeric",
            month: "long",
            year: "numeric"
        }).format(new Date());
    }

    function createInitialState() {
        return {
            currentShopping: {
                id: makeId(),
                name: todayName(),
                createdAt: new Date().toISOString(),
                todo: [],
                bought: []
            },
            productArchive: [],
            history: []
        };
    }

    function makeId() {
        return window.crypto?.randomUUID?.() ||
            (Date.now().toString(36) + Math.random().toString(36).slice(2));
    }

    function loadState() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (!saved) return createInitialState();

            const parsed = JSON.parse(saved);

            if (!parsed.currentShopping) {
                return createInitialState();
            }

            parsed.currentShopping.todo ||= [];
            parsed.currentShopping.bought ||= [];
            parsed.productArchive ||= [];
            parsed.history ||= [];

            return parsed;
        } catch {
            return createInitialState();
        }
    }

    let state = loadState();
    let selectedProductId = null;
    let editingProductId = null;

    function saveState() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function money(value) {
        return new Intl.NumberFormat("it-IT", {
            style: "currency",
            currency: "EUR"
        }).format(Number(value) || 0);
    }

    function parsePrice(value) {
        const raw = String(value).trim();

        // In italiano la virgola è normalmente il separatore decimale.
        // Accettiamo comunque anche il punto per chi preferisce digitarlo.
        const normalized = raw.includes(",")
            ? raw.replace(/\./g, "").replace(",", ".")
            : raw;

        const price = Number(normalized);
        return Number.isFinite(price) && price >= 0 ? price : NaN;
    }

    function productTotal(product) {
        return Number(product.price) * Number(product.quantity);
    }

    function productInfo(product) {
        const quantity = Number(product.quantity) || 1;
        return quantity > 1
            ? quantity + " × " + money(product.price) + " = " + money(productTotal(product))
            : money(product.price);
    }

    function countLabel(count) {
        return count + (count === 1 ? " prodotto" : " prodotti");
    }

    function renderProduct(product, location) {
        const item = document.createElement("article");
        item.className = "product";
        item.dataset.id = product.id;
        item.dataset.location = location;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "product-content";

        const left = document.createElement("div");

        const name = document.createElement("div");
        name.className = "product-name";
        name.textContent = product.name;

        const info = document.createElement("div");
        info.className = "product-info";
        info.textContent = productInfo(product);

        left.append(name, info);

        const price = document.createElement("div");
        price.className = "product-price";
        price.textContent = money(productTotal(product));

        button.append(left, price);
        button.addEventListener("click", () => openProductDetail(product.id, location));

        item.append(button);

        attachSwipe(item, product.id, location);

        return item;
    }

    function renderShopping() {
        const shopping = state.currentShopping;

        els.shoppingName.textContent = shopping.name;

        els.todoCounter.textContent = countLabel(shopping.todo.length);
        els.boughtCounter.textContent = countLabel(shopping.bought.length);

        els.todoList.innerHTML = "";
        els.boughtList.innerHTML = "";

        if (shopping.todo.length === 0) {
            els.todoList.innerHTML = '<div class="empty">Nessun prodotto da prendere.</div>';
        } else {
            shopping.todo.forEach((product) => {
                els.todoList.append(renderProduct(product, "todo"));
            });
        }

        if (shopping.bought.length === 0) {
            els.boughtList.innerHTML = '<div class="empty">Nessun prodotto acquistato.</div>';
        } else {
            shopping.bought.forEach((product) => {
                els.boughtList.append(renderProduct(product, "bought"));
            });
        }

        const total = shopping.bought.reduce(
            (sum, product) => sum + productTotal(product),
            0
        );

        els.total.textContent = money(total);
    }

    function renderProducts() {
        const query = (els.productSearch.value || "").trim().toLowerCase();

        const products = state.productArchive
            .filter((product) => product.name.toLowerCase().includes(query))
            .sort((a, b) => a.name.localeCompare(b.name, "it"));

        els.productsList.innerHTML = "";

        if (products.length === 0) {
            els.productsList.innerHTML =
                '<div class="empty">Nessun prodotto nell\'archivio.</div>';
            return;
        }

        products.forEach((product) => {
            const card = document.createElement("article");
            card.className = "product";

            const button = document.createElement("button");
            button.type = "button";
            button.className = "product-content";

            const left = document.createElement("div");

            const name = document.createElement("div");
            name.className = "product-name";
            name.textContent = product.name;

            const info = document.createElement("div");
            info.className = "product-info";
            info.textContent = "Ultimo prezzo: " + money(product.price);

            left.append(name, info);

            const add = document.createElement("div");
            add.className = "product-price";
            add.textContent = "＋";

            button.append(left, add);
            button.addEventListener("click", () => {
                addArchivedProductToShopping(product);
                switchPage("shopping");
            });

            card.append(button);
            els.productsList.append(card);
        });
    }

    function renderHistory() {
        els.historyList.innerHTML = "";

        if (state.history.length === 0) {
            els.historyList.innerHTML =
                '<div class="empty">Nessuna spesa archiviata.</div>';
            els.historyTotal.textContent = "Totale: €0,00";
            return;
        }

        const total = state.history.reduce(
            (sum, shopping) => sum + Number(shopping.total || 0),
            0
        );

        els.historyTotal.textContent = "Totale: " + money(total);

        [...state.history]
            .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
            .forEach((shopping) => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "history-item";

                const top = document.createElement("div");
                top.className = "history-top";

                const name = document.createElement("strong");
                name.textContent = shopping.name;

                const amount = document.createElement("span");
                amount.className = "history-total";
                amount.textContent = money(shopping.total);

                top.append(name, amount);

                const date = document.createElement("div");
                date.className = "history-date";
                date.textContent =
                    countLabel(shopping.bought.length) + " acquistati";

                button.append(top, date);
                button.addEventListener("click", () => openHistoryDetail(shopping.id));

                els.historyList.append(button);
            });
    }

    function renderAll() {
        renderShopping();
        renderProducts();
        renderHistory();
    }

    function openNewProductDialog() {
        editingProductId = null;
        els.productDialogTitle.textContent = "Nuovo prodotto";
        els.productForm.reset();
        els.productQuantity.value = "1";
        els.productDialog.showModal();

        setTimeout(() => els.productName.focus(), 50);
    }

    function closeProductDialog() {
        els.productDialog.close();
    }

    function saveProduct(event) {
        event.preventDefault();

        const name = els.productName.value.trim();
        const price = parsePrice(els.productPrice.value);
        const quantity = Math.max(1, Number.parseInt(els.productQuantity.value, 10) || 1);
        const note = els.productNote.value.trim();

        if (!name) {
            els.productName.focus();
            return;
        }

        if (!Number.isFinite(price)) {
            alert("Inserisci un prezzo valido.");
            els.productPrice.focus();
            return;
        }

        if (editingProductId) {
            updateProduct(editingProductId, { name, price, quantity, note });
        } else {
            const product = {
                id: makeId(),
                name,
                price,
                quantity,
                note,
                createdAt: new Date().toISOString()
            };

            state.currentShopping.todo.push(product);
            upsertArchiveProduct(product);
        }

        saveState();
        renderAll();
        closeProductDialog();
    }

    function upsertArchiveProduct(product) {
        const existing = state.productArchive.find(
            (item) => item.name.trim().toLowerCase() === product.name.trim().toLowerCase()
        );

        const archived = {
            id: existing?.id || makeId(),
            name: product.name,
            price: Number(product.price),
            note: product.note || "",
            updatedAt: new Date().toISOString()
        };

        if (existing) {
            Object.assign(existing, archived);
        } else {
            state.productArchive.push(archived);
        }
    }

    function addArchivedProductToShopping(archived) {
        const product = {
            id: makeId(),
            name: archived.name,
            price: Number(archived.price),
            quantity: 1,
            note: archived.note || "",
            createdAt: new Date().toISOString()
        };

        state.currentShopping.todo.push(product);
        saveState();
        renderAll();
    }

    function findProduct(id) {
        const todo = state.currentShopping.todo.find((p) => p.id === id);
        if (todo) return { product: todo, location: "todo" };

        const bought = state.currentShopping.bought.find((p) => p.id === id);
        if (bought) return { product: bought, location: "bought" };

        return null;
    }

    function openProductDetail(id, location) {
        const found = findProduct(id);
        if (!found) return;

        selectedProductId = id;

        const product = found.product;

        els.detailProductName.textContent = product.name;
        els.detailProductPrice.textContent = "Prezzo unitario: " + money(product.price);
        els.detailProductQuantity.textContent =
            "Quantità: " + product.quantity + " — Totale: " + money(productTotal(product));
        els.detailProductNote.textContent = product.note || "Nessuna nota.";

        els.editProductButton.textContent = "Modifica";
        els.productDetailDialog.dataset.location = location;
        els.productDetailDialog.showModal();
    }

    function editSelectedProduct() {
        const found = findProduct(selectedProductId);
        if (!found) return;

        editingProductId = selectedProductId;

        els.productDialogTitle.textContent = "Modifica prodotto";
        els.productName.value = found.product.name;
        els.productPrice.value = String(found.product.price).replace(".", ",");
        els.productQuantity.value = String(found.product.quantity);
        els.productNote.value = found.product.note || "";

        els.productDetailDialog.close();
        els.productDialog.showModal();

        setTimeout(() => els.productName.focus(), 50);
    }

    function updateProduct(id, changes) {
        const found = findProduct(id);
        if (!found) return;

        Object.assign(found.product, changes);
        upsertArchiveProduct(found.product);
    }

    function moveToBought(id) {
        const index = state.currentShopping.todo.findIndex((p) => p.id === id);
        if (index === -1) return;

        const [product] = state.currentShopping.todo.splice(index, 1);
        product.boughtAt = new Date().toISOString();

        state.currentShopping.bought.unshift(product);

        saveState();
        renderAll();
    }

    function moveBackToTodo(id) {
        const index = state.currentShopping.bought.findIndex((p) => p.id === id);
        if (index === -1) return;

        const [product] = state.currentShopping.bought.splice(index, 1);
        delete product.boughtAt;

        state.currentShopping.todo.unshift(product);

        saveState();
        renderAll();
    }

    function attachSwipe(element, id, location) {
        let startX = 0;
        let currentX = 0;
        let dragging = false;

        element.addEventListener("pointerdown", (event) => {
            startX = event.clientX;
            currentX = startX;
            dragging = true;
            element.setPointerCapture?.(event.pointerId);
        });

        element.addEventListener("pointermove", (event) => {
            if (!dragging) return;

            currentX = event.clientX;
            const delta = currentX - startX;

            if (delta < 0) {
                element.style.transform = "translateX(" + Math.max(delta, -110) + "px)";
            }
        });

        const finish = () => {
            if (!dragging) return;

            dragging = false;
            const delta = currentX - startX;

            if (delta < -75) {
                element.style.transform = "translateX(-110%)";
                setTimeout(() => {
                    if (location === "todo") {
                        moveToBought(id);
                    } else {
                        moveBackToTodo(id);
                    }
                }, 140);
            } else {
                element.style.transform = "";
            }
        };

        element.addEventListener("pointerup", finish);
        element.addEventListener("pointercancel", finish);
    }

    function renameShopping() {
        const newName = prompt("Come vuoi chiamare questa spesa?", state.currentShopping.name);
        if (newName === null) return;

        const cleanName = newName.trim();
        if (!cleanName) return;

        state.currentShopping.name = cleanName;
        saveState();
        renderShopping();
    }

    function closeShopping() {
        const shopping = state.currentShopping;

        if (shopping.todo.length > 0) {
            const proceed = confirm(
                "Ci sono ancora " + countLabel(shopping.todo.length) +
                " da prendere. Vuoi comunque chiudere la spesa?"
            );
            if (!proceed) return;
        }

        if (shopping.bought.length === 0) {
            alert("Non ci sono prodotti acquistati da archiviare.");
            return;
        }

        const total = shopping.bought.reduce(
            (sum, product) => sum + productTotal(product),
            0
        );

        state.history.push({
            id: shopping.id,
            name: shopping.name,
            createdAt: shopping.createdAt,
            closedAt: new Date().toISOString(),
            bought: shopping.bought,
            total
        });

        state.currentShopping = {
            id: makeId(),
            name: todayName(),
            createdAt: new Date().toISOString(),
            todo: [],
            bought: []
        };

        saveState();
        renderAll();
        switchPage("history");
    }

    function openHistoryDetail(id) {
        const shopping = state.history.find((item) => item.id === id);
        if (!shopping) return;

        els.historyDetailName.textContent = shopping.name;
        els.historyDetailContent.innerHTML = "";

        const total = document.createElement("div");
        total.className = "total-box";
        total.style.marginTop = "0";
        total.innerHTML =
            '<span class="total-label">Totale</span>' +
            '<span class="total">' + money(shopping.total) + "</span>";

        els.historyDetailContent.append(total);

        shopping.bought.forEach((product) => {
            els.historyDetailContent.append(renderHistoryProduct(product));
        });

        els.historyDetailDialog.showModal();
    }

    function renderHistoryProduct(product) {
        const item = document.createElement("div");
        item.className = "history-item";
        item.style.marginTop = "8px";

        const top = document.createElement("div");
        top.className = "history-top";

        const name = document.createElement("strong");
        name.textContent = product.name;

        const amount = document.createElement("span");
        amount.className = "history-total";
        amount.textContent = money(productTotal(product));

        top.append(name, amount);

        const info = document.createElement("div");
        info.className = "history-date";
        info.textContent =
            "Quantità: " + product.quantity +
            " · Prezzo unitario: " + money(product.price);

        item.append(top, info);

        return item;
    }

    function switchPage(page) {
        Object.entries(els.pages).forEach(([name, element]) => {
            element.classList.toggle("hidden", name !== page);
        });

        els.tabs.forEach((tab) => {
            tab.classList.toggle("active", tab.dataset.page === page);
        });
    }

    els.tabs.forEach((tab) => {
        tab.addEventListener("click", () => switchPage(tab.dataset.page));
    });

    els.addProductButton.addEventListener("click", openNewProductDialog);
    els.newProductButton.addEventListener("click", openNewProductDialog);
    els.cancelProductButton.addEventListener("click", closeProductDialog);
    els.productForm.addEventListener("submit", saveProduct);

    els.closeDetailButton.addEventListener("click", () => els.productDetailDialog.close());
    els.editProductButton.addEventListener("click", editSelectedProduct);

    els.renameButton.addEventListener("click", renameShopping);
    els.closeShoppingButton.addEventListener("click", closeShopping);

    els.productSearch.addEventListener("input", renderProducts);

    els.closeHistoryDetailButton.addEventListener("click", () => {
        els.historyDetailDialog.close();
    });

    renderAll();
})();