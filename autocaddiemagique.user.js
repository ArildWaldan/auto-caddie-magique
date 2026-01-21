// ==UserScript==
// @name         Auto-Caddies-Magiques (Native UI v24)
// @namespace    http://tampermonkey.net/
// @version      24.0
// @description  Native Sidebar Integration -> CSV Import -> Basket Creation -> % Discount -> Auto Redirect
// @author       Developer
// @match        https://dc.kfplc.com/*
// @connect      dc.dps.kd.kfplc.com
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // CONFIGURATION
    // ==========================================
    const CSV_INDEX_EAN = 0;          // A: Code Art EAN
    const CSV_INDEX_PERCENT = 8;      // I: % de remise
    const CSV_INDEX_QTY = 9;          // J: Quantité

    const CAPTURED = {
        deviceId: null, workstationId: null, storeCode: null, tenantId: null, opCompany: null
    };

    let activeBasketId = null;
    let BASKET_DATA = [];
    let modalRef = null;
    let logContainerRef = null;

    // ==========================================
    // SNIFFER
    // ==========================================
    const realSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        try { analyzeHeader(header, value); } catch(e) {}
        return realSetHeader.apply(this, arguments);
    };

    const realFetch = window.fetch;
    window.fetch = function(input, init) {
        try {
            if (init && init.headers) {
                if (init.headers instanceof Headers) init.headers.forEach((val, key) => analyzeHeader(key, val));
                else for (let key in init.headers) analyzeHeader(key, init.headers[key]);
            }
        } catch(e) {}
        return realFetch.apply(this, arguments);
    };

    function analyzeHeader(key, value) {
        if (!key || typeof key !== 'string') return;
        const k = key.toLowerCase().trim();
        if (k === 'kits-device-id') CAPTURED.deviceId = value;
        if (k === 'kits-workstation-id') CAPTURED.workstationId = value;
        if (k === 'kits-store-code') CAPTURED.storeCode = value;
        if (k === 'kits-tenant-id') CAPTURED.tenantId = value;
        if (k === 'kits-operating-company') CAPTURED.opCompany = value;
    }

    // ==========================================
    // NETWORK
    // ==========================================
    function getCookies() {
        return new Promise((resolve) => {
            GM_cookie.list({ url: "https://dc.dps.kd.kfplc.com" }, (cookies, error) => {
                resolve(!error && cookies ? cookies.map(c => `${c.name}=${c.value}`).join('; ') : document.cookie);
            });
        });
    }

    async function apiRequest(method, endpoint, data) {
        const url = `https://dc.dps.kd.kfplc.com${endpoint}`;
        const cookieStr = await getCookies();

        const headers = {
            "Accept": "application/json", "Content-Type": "application/json",
            "kits-device-id": CAPTURED.deviceId, "kits-workstation-id": CAPTURED.workstationId,
            "kits-store-code": CAPTURED.storeCode || "1502", "kits-tenant-id": CAPTURED.tenantId || "CAFR",
            "kits-operating-company": CAPTURED.opCompany || "CF01", "kits-app-version": "2.0.0",
            "kits-application-name": "DigitalColleague", "kits-device-type": "desktop",
            "kits-process-name": "Default", "kits-release-version": "CHG0175940",
            "Cookie": cookieStr
        };

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: method, url: url, headers: headers, data: data ? JSON.stringify(data) : null,
                onload: (response) => {
                    // Check specifically for 409 Conflict
                    if (response.status === 409) {
                        try {
                            const json = JSON.parse(response.responseText);
                            reject({ status: 409, data: json.data || json });
                        } catch(e) { reject({ status: 409, message: response.responseText }); }
                    } else if (response.status >= 200 && response.status < 300) {
                        if(response.status === 204) resolve(true);
                        else resolve(JSON.parse(response.responseText));
                    } else {
                        reject({ status: response.status, message: response.responseText });
                    }
                },
                onerror: () => reject({ status: 0, message: "Network Error" })
            });
        });
    }

    // ==========================================
    // CSV PARSING
    // ==========================================
    function parseCSV(text) {
        const lines = text.split(/\r?\n/);
        const parsedData = [];
        let skippedCount = 0;

        lines.forEach((line) => {
            if (!line.trim()) return;
            const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            const cleanCols = cols.map(c => c.trim().replace(/^"|"$/g, '').trim());

            if (cleanCols.length <= CSV_INDEX_QTY) { skippedCount++; return; }

            let ean = cleanCols[CSV_INDEX_EAN].replace(/\s/g, '');
            if (!/^\d{8,14}$/.test(ean)) { skippedCount++; return; }

            let qty = parseFloat(cleanCols[CSV_INDEX_QTY]);
            let percentStr = cleanCols[CSV_INDEX_PERCENT] || "";
            let percentVal = parseFloat(percentStr.replace(/[%"\s]/g, '').replace(',', '.')) || 0;
            percentVal = Math.abs(percentVal);
            percentVal = Math.round(percentVal * 100) / 100;

            if (!isNaN(qty) && qty > 0) {
                parsedData.push({ ean: ean, qty: qty, percent: percentVal });
            } else { skippedCount++; }
        });

        return { data: parsedData, skipped: skippedCount };
    }

    // ==========================================
    // LOGIC & UI INTEGRATION
    // ==========================================

    function isDarkMode() {
        const rgb = window.getComputedStyle(document.body).backgroundColor;
        const sep = rgb.indexOf(",") > -1 ? "," : " ";
        const rgbVals = rgb.substr(4).split(")")[0].split(sep);
        const r = parseInt(rgbVals[0]), g = parseInt(rgbVals[1]), b = parseInt(rgbVals[2]);
        const brightness = Math.round(((parseInt(r) * 299) + (parseInt(g) * 587) + (parseInt(b) * 114)) / 1000);
        return brightness < 125;
    }

    function logToModal(msg, type = "info") {
        if (!logContainerRef) return;
        const div = document.createElement('div');
        div.style.marginBottom = "4px";
        div.style.borderBottom = "1px solid rgba(128,128,128,0.1)";
        div.style.paddingBottom = "2px";

        if (type === "success") div.style.color = "#28a745";
        else if (type === "error") div.style.color = "#dc3545";
        else if (type === "warn") div.style.color = "#ffc107";
        else div.style.color = "inherit";

        div.innerHTML = msg;
        logContainerRef.appendChild(div);
        logContainerRef.scrollTop = logContainerRef.scrollHeight;
    }

    async function runBatch() {
        if(!CAPTURED.deviceId) {
            logToModal("⚠️ ERREUR: ID Device non capturé. Naviguez un peu sur le site et réessayez.", "error");
            return;
        }

        activeBasketId = null;
        // Tracking variables for the specific 409 condition
        let countDiscountTries = 0;
        let countDiscount409 = 0;

        logToModal("🚀 Démarrage du traitement...", "info");

        for (let i = 0; i < BASKET_DATA.length; i++) {
            const item = BASKET_DATA[i];
            const seq = i + 1;
            let itemAdded = false;

            // 1. ADD ITEM
            try {
                let payload = {
                    "conditions": { "agePrompted": false, "pricePrompted": false, "qtyPrompted": true, "measurementPrompted": false, "salePrompted": false },
                    "item": { "entryMethod": "selected", "ean": item.ean, "qty": item.qty, "fulfilmentRoute": "takeaway", "totalQtyAfterChange": item.qty }
                };
                if (activeBasketId) payload.basketId = activeBasketId;

                let res;
                try {
                    res = await apiRequest('POST', '/basket/items', payload);
                } catch (err) {
                    // Handle Basket ID conflict/recovery
                    if (err.status === 409 && err.data && err.data.basketId) {
                        activeBasketId = err.data.basketId;
                        payload.basketId = activeBasketId;
                        res = await apiRequest('POST', '/basket/items', payload);
                        logToModal(`♻️ Session récupérée`, "warn");
                    } else { throw err; }
                }

                if(res.basket && res.basket.id) activeBasketId = res.basket.id;
                logToModal(`✅ [${seq}/${BASKET_DATA.length}] Ajouté: ${item.ean} (x${item.qty})`, "success");
                itemAdded = true;

            } catch(e) {
                logToModal(`❌ [${seq}/${BASKET_DATA.length}] Erreur Ajout ${item.ean}: ${e.message || e.status}`, "error");
            }

            // 2. APPLY DISCOUNT (Only if item was added and percent > 0)
            if (itemAdded && activeBasketId && item.percent > 0) {
                countDiscountTries++;
                try {
                    await apiRequest('POST', `/basket/${activeBasketId}/items/${item.ean}/discount`, {
                        "qty": item.qty,
                        "type": "Percent",
                        "reason": "333",
                        "amount": item.percent,
                        "sequenceNumber": seq,
                        "managerId": "ARNAUD.DERHAN@CASTORAMA.FR"
                    });
                    logToModal(`   ↳ Remise appliquée: ${item.percent}%`, "info");
                } catch (err) {
                    if (err.status === 409) {
                        countDiscount409++;
                        logToModal(`   ↳ ⚠️ Echec Remise (Conflit 409)`, "warn");
                    } else {
                        logToModal(`   ↳ ❌ Erreur Remise: ${err.status || err.message}`, "error");
                    }
                }
            }
        } // End Loop

        logToModal("<hr>🏁 <b>TRAITEMENT TERMINÉ</b>", "info");

        // CHECK GOAL 2: 100% 409 Failure on discounts
        if (countDiscountTries > 0 && countDiscountTries === countDiscount409) {
            // If all attempted discounts failed with 409, show specific message and DO NOT redirect automatically
            logToModal("🚫 <b>ATTENTION:</b> Echec des remises (409).", "error");
            logToModal("⚠️ <b>Merci de vider complètement le panier BV, puis recommencer.</b>", "error");
            return; // Stop here, no redirect
        }

        // CHECK GOAL 1: Redirect to Basket
        if (activeBasketId) {
            logToModal("⏱️ Redirection vers le panier...", "success");
            setTimeout(() => {
                window.location.href = `https://dc.kfplc.com/basket/${activeBasketId}`;
            }, 1500);
        } else {
            logToModal("⚠️ Aucun panier actif détecté, pas de redirection.", "warn");
        }
    }

    // Modal for logs
    function showModal() {
        if (document.getElementById('magic-modal-overlay')) return;

        const darkMode = isDarkMode();
        const styles = {
            overlay: "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:999999; display:flex; align-items:center; justify-content:center;",
            modal: `width: 500px; max-width:90%; height: 400px; display:flex; flex-direction:column; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); font-family: sans-serif; overflow: hidden; ${darkMode ? 'background:#2b2b2b; color:#eee;' : 'background:#fff; color:#333;'}`,
            header: `padding: 15px; font-weight:bold; font-size:16px; border-bottom: 1px solid ${darkMode ? '#444' : '#ddd'}; display:flex; justify-content:space-between; align-items:center;`,
            content: "flex:1; padding: 15px; overflow-y: auto; font-family: monospace; font-size: 12px; line-height: 1.5;",
            footer: `padding: 10px 15px; border-top: 1px solid ${darkMode ? '#444' : '#ddd'}; text-align:right;`,
            btn: "padding: 6px 12px; border:none; border-radius:4px; cursor:pointer; font-weight:bold; background:#6c757d; color:white;"
        };

        const overlay = document.createElement('div');
        overlay.id = 'magic-modal-overlay';
        overlay.style.cssText = styles.overlay;

        const modal = document.createElement('div');
        modal.style.cssText = styles.modal;

        const header = document.createElement('div');
        header.style.cssText = styles.header;
        header.innerHTML = `<span>Caddie Magique</span><span id="magic-close" style="cursor:pointer;">&times;</span>`;

        const content = document.createElement('div');
        content.id = 'magic-log-container';
        content.style.cssText = styles.content;
        logContainerRef = content;

        const footer = document.createElement('div');
        footer.style.cssText = styles.footer;
        const closeBtn = document.createElement('button');
        closeBtn.innerText = "Fermer";
        closeBtn.style.cssText = styles.btn;
        closeBtn.onclick = () => { document.body.removeChild(overlay); logContainerRef = null; };

        footer.appendChild(closeBtn);
        modal.appendChild(header);
        modal.appendChild(content);
        modal.appendChild(footer);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        document.getElementById('magic-close').onclick = () => { document.body.removeChild(overlay); logContainerRef = null; };
    }

    function handleFileSelect(evt) {
        const file = evt.target.files[0];
        if (!file) return;

        evt.target.value = '';
        showModal();
        logToModal("📂 Lecture du fichier CSV...", "info");

        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target.result;
            const res = parseCSV(text);
            BASKET_DATA = res.data;

            logToModal(`📊 ${res.data.length} articles trouvés (${res.skipped} lignes ignorées).`, "info");
            if(BASKET_DATA.length > 0) {
                runBatch();
            } else {
                logToModal("⚠️ Aucune donnée valide trouvée.", "error");
            }
        };
        reader.readAsText(file);
    }

    // ==========================================
    // SIDEBAR BUTTON INJECTION
    // ==========================================
    function injectSidebarButton() {
        if (document.getElementById('magic-menu-item')) return;
        const resumeLink = document.querySelector('a[href="/basket/resume"]');
        if (resumeLink) {
            const parentLi = resumeLink.parentNode;
            const ulContainer = parentLi.parentNode;
            const newLi = document.createElement('li');
            newLi.id = 'magic-menu-item';
            const newLink = document.createElement('a');
            newLink.href = "#";
            newLink.className = "menu__nav-link";
            newLink.textContent = "Caddie magique";
            newLink.setAttribute('tabindex', '0');
            newLink.addEventListener('click', (e) => {
                e.preventDefault();
                document.getElementById('magic-file-input').click();
            });
            newLi.appendChild(newLink);
            if (parentLi.nextSibling) {
                ulContainer.insertBefore(newLi, parentLi.nextSibling);
            } else {
                ulContainer.appendChild(newLi);
            }
        }
    }

    function init() {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'magic-file-input';
        fileInput.accept = '.csv';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', handleFileSelect);
        document.body.appendChild(fileInput);

        const observer = new MutationObserver(() => {
            injectSidebarButton();
        });

        observer.observe(document.body, { childList: true, subtree: true });
        injectSidebarButton();
    }

    window.addEventListener('load', init);

})();
