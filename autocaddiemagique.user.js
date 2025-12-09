// ==UserScript==
// @name         Auto-Caddies-Magiques
// @namespace    http://tampermonkey.net/
// @version      17.0
// @description  Increments sequenceNumber for each item line to avoid 409 Conflicts.
// @author       Developer
// @match        https://dc.kfplc.com/*
// @connect      dc.dps.kd.kfplc.com
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const MOCK_DATA = [
        { ean: "3281346610000", qty: 4, discountAmount: 150 },
        { ean: "3281346610130", qty: 2, discountAmount: 50  },
        { ean: "3138522095055", qty: 1, discountAmount: 20  }
    ];

    const CAPTURED = {
        deviceId: null,
        workstationId: null,
        storeCode: null,
        tenantId: null,
        opCompany: null
    };

    let activeBasketId = null;

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
        if (k === 'kits-device-id') { CAPTURED.deviceId = value; updateUI(); }
        if (k === 'kits-workstation-id') { CAPTURED.workstationId = value; updateUI(); }
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
            "Accept": "application/json",
            "Content-Type": "application/json",
            "kits-device-id": CAPTURED.deviceId,
            "kits-workstation-id": CAPTURED.workstationId,
            "kits-store-code": CAPTURED.storeCode || "1502",
            "kits-tenant-id": CAPTURED.tenantId || "CAFR",
            "kits-operating-company": CAPTURED.opCompany || "CF01",
            "kits-app-version": "2.0.0",
            "kits-application-name": "DigitalColleague",
            "kits-device-type": "desktop",
            "kits-process-name": "Default",
            "kits-release-version": "CHG0175940",
            "Cookie": cookieStr
        };

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: method,
                url: url,
                headers: headers,
                data: data ? JSON.stringify(data) : null,
                onload: (response) => {
                    if (response.status === 409) {
                        try {
                            const json = JSON.parse(response.responseText);
                            reject({ status: 409, data: json.data });
                        } catch(e) { reject(`Status 409: ${response.responseText}`); }
                    }
                    else if (response.status >= 200 && response.status < 300) {
                        if(response.status === 204) resolve(true);
                        else resolve(JSON.parse(response.responseText));
                    } else {
                        console.error("FAIL:", response.responseText);
                        reject(`Status ${response.status}`);
                    }
                },
                onerror: () => reject("Network Error")
            });
        });
    }

    // ==========================================
    // LOGIC
    // ==========================================
    async function runBatch() {
        const btn = document.getElementById('kf-run');
        const logBox = document.getElementById('kf-log');
        btn.innerText = "Running...";
        btn.disabled = true;

        activeBasketId = null;

        const log = (msg, color="#ccc") => {
            logBox.innerHTML += `<div style="color:${color}">> ${msg}</div>`;
            logBox.scrollTop = logBox.scrollHeight;
        };

        // LOOP through items
        for (let i = 0; i < MOCK_DATA.length; i++) {
            const item = MOCK_DATA[i];

            // SEQUENCE LOGIC: 1-based index (1, 2, 3...)
            const currentSequence = i + 1;

            try {
                log(`Processing Item ${currentSequence} (${item.ean})...`);

                // PAYLOAD
                let payload = {
                    "conditions": { "agePrompted": false, "pricePrompted": false, "qtyPrompted": true, "measurementPrompted": false, "salePrompted": false },
                    "item": { "entryMethod": "selected", "ean": item.ean, "qty": item.qty, "fulfilmentRoute": "takeaway", "totalQtyAfterChange": item.qty }
                };

                if (activeBasketId) payload.basketId = activeBasketId;

                let res;
                try {
                    res = await apiRequest('POST', '/basket/items', payload);
                } catch (err) {
                    if (err.status === 409 && err.data && err.data.basketId) {
                        activeBasketId = err.data.basketId;
                        log(`Found Active Basket: ...${activeBasketId.substr(-5)}`, "#fa0");
                        payload.basketId = activeBasketId;
                        res = await apiRequest('POST', '/basket/items', payload);
                    } else {
                        throw err;
                    }
                }

                if(res.basket && res.basket.id) {
                    activeBasketId = res.basket.id;
                    log(`Added to Basket.`, "#0f0");
                }

                // DISCOUNT
                if (activeBasketId) {
                    // Using currentSequence (1, 2, 3) for each distinct item
                    await apiRequest('POST', `/basket/${activeBasketId}/items/${item.ean}/discount`, {
                        "qty": item.qty,
                        "type": "Amount",
                        "reason": "333",
                        "amount": item.discountAmount,
                        "sequenceNumber": currentSequence, // <--- THE FIX
                        "managerId": "ARNAUD.DERHAN@CASTORAMA.FR"
                    });
                    log(`Discount Applied (Seq ${currentSequence}).`, "#0f0");
                }

            } catch(e) {
                log(`Error: ${e.status || e}`, "#f55");
                console.error(e);
            }
        }
        btn.innerText = "DONE";
    }

    // ==========================================
    // UI
    // ==========================================
    function createUI() {
        if(document.getElementById('kf-v17')) return;
        const div = document.createElement('div');
        div.id = 'kf-v17';
        div.style.cssText = "position:fixed; bottom:20px; right:20px; width:300px; background:#111; color:#fff; padding:10px; z-index:999999; border:1px solid #444; font-family:monospace; font-size:11px;";
        div.innerHTML = `
            <div style="border-bottom:1px solid #444; margin-bottom:5px; padding-bottom:5px; font-weight:bold; color:#0af;">SEQUENCE BATCH v17</div>
            <div id="kf-ids" style="margin-bottom:10px;">
                <div>IDs: <span id="val-ids" style="color:#f55;">Waiting...</span></div>
            </div>
            <div id="kf-log" style="height:100px; overflow:auto; border:1px solid #333; background:#000; padding:5px; margin-bottom:5px;"></div>
            <button id="kf-run" disabled style="width:100%; padding:8px; background:#333; color:#777; border:none; cursor:not-allowed;">RUN AUTOMATION</button>
        `;
        document.body.appendChild(div);
        document.getElementById('kf-run').onclick = runBatch;
    }

    function updateUI() {
        const idEl = document.getElementById('val-ids');
        const btn = document.getElementById('kf-run');
        if(CAPTURED.deviceId && CAPTURED.workstationId) {
            idEl.innerText = "CAPTURED";
            idEl.style.color = "#0f0";
            btn.disabled = false;
            btn.style.background = "#0d6efd";
            btn.style.color = "#fff";
            btn.style.cursor = "pointer";
        }
    }

    window.addEventListener('load', () => setTimeout(createUI, 500));
})();
