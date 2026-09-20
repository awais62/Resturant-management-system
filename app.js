// =====================================================================
// MIAN FOODS POS - Full App Logic
// Desi Swad, Fast Food | Nisar Colony St # 16 Near Ahmad Chicken
// =====================================================================

// ─── STATE ────────────────────────────────────────────────────────────
const STATE = {
    menu: [],
    cart: [],
    orders: [],
    categories: [],
    inventory: [],
    pendingTabletOrders: [],
    currentView: 'billing',
    shopSettings: {
        brandName: 'Mian Foods',
        subtitle: 'Desi Swad, Fast Food',
        logoUrl: 'logo.png',
        address: 'Nisar Colony St # 16 Near Ahmad Chicken',
        contact: 'Tel: 0309-5549555 | 0302-5543094'
    }
};
// ─── MIAN FOODS FULL MENU (A to Z from flyer) ─────────────────────────
// (INITIAL_MENU is now loaded from menu.js)

// ─── INIT ──────────────────────────────────────────────────────────────
async function init() {
    loadSupabaseSettings();

    // Step 1: Check license FIRST before loading anything
    const isLicensed = await verifyLicense();
    if (!isLicensed) return; // Stop if no valid license

    await loadData();
    setupEventListeners();
    renderBilling();
    renderReports();
    updateOrderId();
    renderInventoryTable();

    // Start periodic license watcher (checks every 5 min)
    startLicenseWatch();

    // Start Real-Time Cloud Order Watcher (listens for orders from online/Vercel tablet apps)
    startCloudOrderWatcher();

    // Start daily Storage backup scheduler (uploads JSON to backups/{license_key}/)
    scheduleStorageBackup();

    // Load saved local backup folder and update UI
    loadBackupDirHandle().then(handle => {
        if (handle) {
            _localBackupDirHandle = handle;
            const el = document.getElementById('local-backup-folder-name');
            if (el) el.textContent = '✅ Folder: ' + handle.name + ' (auto-saving)';
        }
    });

    // ── Tablet App Integration ──
    if (window.electronAPI) {
        window.electronAPI.onTabletOrder((orderData) => {
            // Push incoming order to the queue instead of processing it directly
            const queuedOrder = {
                queuedId: 'T-' + Date.now().toString().slice(-6),
                receivedAt: new Date(),
                ...orderData
            };
            STATE.pendingTabletOrders.push(queuedOrder);
            saveTabletOrders();
            updateTabletOrdersBadge();
            if (document.getElementById('tablet-orders-modal').style.display === 'flex') {
                renderTabletOrdersQueue();
            }
            
            // Optional: Play a sound or show notification
            alert(`New Order received from Tablet (${orderData.customer || 'Guest'})! Total: Rs ${orderData.total}`);
        });
    }

    // ── Browser-based Tablet Integration (Fallback if not in Electron) ──
    // Listens to localStorage changes from tablet running in same browser
    window.addEventListener('storage', (e) => {
        if (e.key === 'mf_pending_orders' && e.newValue) {
            const pending = JSON.parse(e.newValue);
            if (pending.length > 0) {
                pending.forEach(orderData => {
                    const queuedOrder = {
                        queuedId: 'T-' + Date.now().toString().slice(-6) + Math.floor(Math.random()*100),
                        receivedAt: new Date(),
                        ...orderData
                    };
                    STATE.pendingTabletOrders.push(queuedOrder);
                    
                    // Alert cashier
                    alert(`New Order received from Tablet (${orderData.customer || 'Guest'})! Total: Rs ${orderData.total}`);
                });
                
                // Clear the intermediate storage immediately
                localStorage.setItem('mf_pending_orders', '[]');
                
                // Save to state and update UI
                saveTabletOrders();
                updateTabletOrdersBadge();
                if (document.getElementById('tablet-orders-modal').style.display === 'flex') {
                    renderTabletOrdersQueue();
                }
            }
        }
    });
}

// ─── LICENSE KEY SYSTEM ────────────────────────────────────────────────

// Format input to allow letters, numbers, and dashes
window.formatLicenseKey = function(input) {
    // Sirf allow karein: A-Z, 0-9 aur dash (-)
    let val = input.value.replace(/[^A-Za-z0-9-]/g, '');
    input.value = val;
};

function showLicenseScreen() {
    const screen = document.getElementById('license-activation-screen');
    if (screen) screen.style.display = 'flex';
}

function hideLicenseScreen() {
    const screen = document.getElementById('license-activation-screen');
    if (screen) screen.style.display = 'none';
}

function lockApp(reason = 'expired') {
    const lockScreen = document.getElementById('license-lock-screen');
    const title    = document.getElementById('lock-title');
    const subtitle = document.getElementById('lock-subtitle');
    if (reason === 'disabled') {
        if (title)    title.textContent    = 'License Disable Kar Di Gayi';
        if (subtitle) subtitle.textContent = 'License Disabled by Developer';
    } else {
        if (title)    title.textContent    = 'License Expire Ho Gayi';
        if (subtitle) subtitle.textContent = 'License Expired';
    }
    if (lockScreen) {
        lockScreen.style.display = 'flex';
        document.addEventListener('keydown', e => e.preventDefault(), true);
    }
}

// Called when user clicks "Activate"
window.activateLicense = async function() {
    const keyInput = document.getElementById('license-key-input');
    const errorMsg = document.getElementById('license-error-msg');
    const btn      = document.getElementById('activate-btn');
    const key = (keyInput?.value || '').trim();

    if (!key || key.length < 5) {
        errorMsg.textContent = '❌ Valid license key enter karein.';
        return;
    }

    btn.textContent = '⏳ Check ho raha hai...';
    btn.disabled = true;
    errorMsg.textContent = '';

    const result = await validateKeyWithSupabase(key);

    if (result.valid) {
        localStorage.setItem('mf_license_key', key);
        hideLicenseScreen();
        // Boot the app now
        await loadData();
        setupEventListeners();
        renderBilling();
        renderReports();
        updateOrderId();
        renderInventoryTable();
        startLicenseWatch();
    } else {
        errorMsg.textContent = '❌ ' + result.message;
        btn.textContent = '🔓 Software Activate Karein';
        btn.disabled = false;
    }
};

// Validate a license key against Supabase
async function validateKeyWithSupabase(key) {
    if (!SUPABASE_CLIENT) return { valid: false, message: 'Internet connection nahi hai.' };
    try {
        const { data, error } = await SUPABASE_CLIENT
            .from('licenses')
            .select('status, expires_at, client_name')
            .ilike('license_key', key)
            .limit(1)
            .single();

        if (error) return { valid: false, message: 'DB Error: ' + error.message };
        if (!data) return { valid: false, message: 'License key galat hai ya exist nahi karti.' };

        if (data.status === 'disabled') return { valid: false, message: 'Yeh license disable kar di gayi hai.' };
        if (data.status === 'expired')  return { valid: false, message: 'Yeh license expire ho chuki hai.' };

        if (data.expires_at) {
            const expiry = new Date(data.expires_at);
            if (new Date() > expiry) {
                // Auto-expire in DB
                await SUPABASE_CLIENT.from('licenses').update({ status: 'expired' }).eq('license_key', key);
                return { valid: false, message: 'License ki miati khatam ho gayi.' };
            }
        }

        return { valid: true, clientName: data.client_name };
    } catch(e) {
        return { valid: false, message: 'Server se rabta nahi ho saka.' };
    }
}

// On startup: check saved key, if none → show activation screen
async function verifyLicense() {
    // 1. Hamesha pehle lock screen dikhayein
    showLicenseScreen();
    const savedKey = localStorage.getItem('mf_license_key');
    const keyInput = document.getElementById('license-key-input');
    const errorMsg = document.getElementById('license-error-msg');
    const btn      = document.getElementById('activate-btn');

    if (!savedKey) {
        // Agar key save nahi hai, user ka wait karein
        return false;
    }

    // 2. Automatically check karein agar key save hai
    if (keyInput) keyInput.value = savedKey;
    if (btn) {
        btn.textContent = '⏳ Checking License...';
        btn.disabled = true;
    }
    
    // Validate saved key
    const result = await validateKeyWithSupabase(savedKey);
    
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-unlock"></i> Software Activate Karein';
        btn.disabled = false;
    }

    // If valid or offline
    if (result.valid || (!navigator.onLine && result.message !== 'Internet connection nahi hai.')) {
        hideLicenseScreen();
        return true;
    }

    // Invalid/expired
    if (errorMsg) errorMsg.textContent = '❌ ' + result.message;
    localStorage.removeItem('mf_license_key'); // Remove invalid key
    return false;
}

// Check periodically every 5 minutes
async function checkLicense() {
    const savedKey = localStorage.getItem('mf_license_key');
    if (!savedKey || !navigator.onLine) return;

    const result = await validateKeyWithSupabase(savedKey);
    if (!result.valid) {
        lockApp(result.message.includes('disable') ? 'disabled' : 'expired');
    }
}

function startLicenseWatch() {
    setInterval(checkLicense, 5 * 60 * 1000); // every 5 minutes
}

// ─── PERSISTENCE (Offline-First) ──────────────────────────────────────
async function loadData() {

    // 1. Load instantly from local storage (Offline First)
    const savedMenu        = localStorage.getItem('mf_menu');
    const savedOrders      = localStorage.getItem('mf_orders');
    const savedInventory   = localStorage.getItem('mf_inventory');
    const savedSettings    = localStorage.getItem('mf_shop_settings');
    const savedCustomCats  = localStorage.getItem('mf_custom_categories');
    const savedTabletOrders = localStorage.getItem('mf_pending_tablet_orders');
    const savedPurchases   = localStorage.getItem('mf_purchases');
    
    STATE.menu      = savedMenu      ? JSON.parse(savedMenu)      : INITIAL_MENU;
    STATE.orders    = savedOrders    ? JSON.parse(savedOrders)    : [];
    STATE.inventory = savedInventory ? JSON.parse(savedInventory) : [];
    STATE.purchases = savedPurchases ? JSON.parse(savedPurchases) : [];
    STATE.pendingTabletOrders = savedTabletOrders ? JSON.parse(savedTabletOrders) : [];
    if (savedSettings) STATE.shopSettings = { ...STATE.shopSettings, ...JSON.parse(savedSettings) };

    // Build categories: from menu items + any custom empty categories
    const menuCats   = [...new Set(STATE.menu.map(i => i.category))];
    const customCats = savedCustomCats ? JSON.parse(savedCustomCats) : [];
    STATE.categories = [...new Set([...menuCats, ...customCats])];
    
    applyBranding();

    // Push initial menu to Tablet App backend
    if (window.electronAPI && window.electronAPI.updateMenu) {
        window.electronAPI.updateMenu(STATE.menu);
    }

    // 2. Try to sync with Cloud in background
    if (SUPABASE_CLIENT && navigator.onLine) {
        try {
            await syncAllToCloud();
        } catch (e) {
            console.warn("Offline: Could not sync with cloud on startup.");
        }
    }
}

// ─── BRANDING SYSTEM ──────────────────────────────────────────────────
function applyBranding() {
    const { brandName, subtitle, logoUrl, address, contact } = STATE.shopSettings;

    // Update Sidebar
    const sideName = document.getElementById('sidebar-brand-name');
    const sideSub  = document.getElementById('sidebar-brand-subtitle');
    const sideLogo = document.getElementById('sidebar-brand-logo');
    if (sideName) sideName.textContent = brandName;
    if (sideSub)  sideSub.textContent  = subtitle;
    if (sideLogo) {
        sideLogo.src = logoUrl;
        sideLogo.style.display = 'block';
    }

    // Update Receipt Template
    const recName = document.getElementById('receipt-brand-name');
    const recSub  = document.getElementById('receipt-brand-subtitle');
    const recLogo = document.getElementById('receipt-brand-logo');
    const recAddr = document.getElementById('receipt-brand-address');
    const recCont = document.getElementById('receipt-brand-contact');
    
    if (recName) recName.textContent = brandName;
    if (recSub)  recSub.textContent  = subtitle;
    if (recLogo) {
        recLogo.src = logoUrl;
        recLogo.style.display = 'inline-block';
    }
    if (recAddr) recAddr.textContent = address || '';
    if (recCont) recCont.textContent = contact || '';

    // Update Settings Inputs
    const setName = document.getElementById('setting-brand-name');
    const setSub  = document.getElementById('setting-brand-subtitle');
    const setAddr = document.getElementById('setting-brand-address');
    const setCont = document.getElementById('setting-brand-contact');
    const setLogo = document.getElementById('setting-logo-preview');
    
    if (setName) setName.value = brandName;
    if (setSub)  setSub.value  = subtitle;
    if (setAddr) setAddr.value = address || '';
    if (setCont) setCont.value = contact || '';
    if (setLogo) {
        setLogo.src = logoUrl;
        setLogo.style.display = 'block';
    }

    // Notify backend (for Tablet app)
    if (window.electronAPI && window.electronAPI.updateSettings) {
        window.electronAPI.updateSettings(STATE.shopSettings);
    }
}

window.saveBrandingSettings = function() {
    const nameInput = document.getElementById('setting-brand-name').value.trim();
    const subInput  = document.getElementById('setting-brand-subtitle').value.trim();
    const addrInput = document.getElementById('setting-brand-address').value.trim();
    const contInput = document.getElementById('setting-brand-contact').value.trim();
    const logoFile  = document.getElementById('setting-brand-logo').files[0];

    STATE.shopSettings.brandName = nameInput || 'Mian Foods';
    STATE.shopSettings.subtitle  = subInput || 'Desi Swad, Fast Food';
    STATE.shopSettings.address   = addrInput;
    STATE.shopSettings.contact   = contInput;

    if (logoFile) {
        const reader = new FileReader();
        reader.onload = function(e) {
            STATE.shopSettings.logoUrl = e.target.result; // Base64
            finalizeSettingsSave();
        };
        reader.readAsDataURL(logoFile);
    } else {
        finalizeSettingsSave();
    }
};

function finalizeSettingsSave() {
    localStorage.setItem('mf_shop_settings', JSON.stringify(STATE.shopSettings));
    applyBranding();
    alert('Shop branding updated successfully!');
}

function saveMenu() { 
    localStorage.setItem('mf_menu', JSON.stringify(STATE.menu));
    // Rebuild categories from menu + custom empty cats
    const menuCats   = [...new Set(STATE.menu.map(i => i.category))];
    const customCats = JSON.parse(localStorage.getItem('mf_custom_categories') || '[]');
    STATE.categories = [...new Set([...menuCats, ...customCats])];
    renderMenuGrid();
    renderCategories();
    if (window.electronAPI && window.electronAPI.updateMenu) {
        window.electronAPI.updateMenu(STATE.menu);
    }
}
function saveOrders()     { localStorage.setItem('mf_orders', JSON.stringify(STATE.orders)); renderReports(); renderOrderHistory(); syncAllToCloud(); triggerLocalBackup(); }
function saveCategories() { renderCategories(); }
function saveInventory()  { localStorage.setItem('mf_inventory', JSON.stringify(STATE.inventory)); renderInventoryTable(); syncAllToCloud(); triggerLocalBackup(); }

// ─── AUDIT LOG ─────────────────────────────────────────────────────────
function logAudit(action, originalData) {
    try {
        const existing = JSON.parse(localStorage.getItem('mf_audit_log') || '[]');
        const entry = {
            id: `${new Date().toISOString()}_${Math.floor(Math.random()*1000)}`,
            timestamp: new Date().toISOString(),
            action,
            data: originalData
        };
        existing.push(entry);
        localStorage.setItem('mf_audit_log', JSON.stringify(existing.slice(-1000)));
        syncAuditToCloud(entry);
    } catch (err) {}
}

function getAuditLog() {
    return JSON.parse(localStorage.getItem('mf_audit_log') || '[]');
}

// ─── NAVIGATION ───────────────────────────────────────────────────────
function setupEventListeners() {
    document.querySelectorAll('.nav-links li').forEach(link => {
        link.addEventListener('click', () => {
            document.querySelectorAll('.nav-links li').forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            switchView(link.getAttribute('data-view'));
        });
    });

    document.getElementById('category-tabs').addEventListener('click', (e) => {
        if (e.target.classList.contains('filter-btn')) {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            renderMenuGrid(e.target.getAttribute('data-category'));
        }
    });

    document.getElementById('menu-search').addEventListener('input', (e) => { renderMenuGrid('all', e.target.value); });

    const adminSearch = document.getElementById('admin-search');
    if (adminSearch) adminSearch.addEventListener('input', (e) => { renderAdminTable(e.target.value); });

    const invSearch = document.getElementById('inventory-search');
    if (invSearch) invSearch.addEventListener('input', () => { renderInventoryTable(); });
    
    const invFromDate = document.getElementById('inventory-from-date');
    if (invFromDate) invFromDate.addEventListener('change', () => { renderInventoryTable(); });
    
    const invToDate = document.getElementById('inventory-to-date');
    if (invToDate) invToDate.addEventListener('change', () => { renderInventoryTable(); });

    const reportFilter = document.getElementById('report-filter');
    if (reportFilter) reportFilter.addEventListener('change', () => renderReports());

    document.getElementById('cancel-btn').addEventListener('click', clearCart);
    document.getElementById('checkout-btn').addEventListener('click', processCheckout);
    document.getElementById('add-item-btn').addEventListener('click', () => openModal());
    const closeBtn = document.querySelector('.close-modal');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    document.getElementById('item-form').addEventListener('submit', handleItemSave);
    document.getElementById('inventory-form').addEventListener('submit', handleInventorySave);
}

function switchView(viewName) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const el = document.getElementById(`${viewName}-view`);
    if (el) el.classList.add('active');
    if (viewName === 'admin')     renderAdminTable();
    if (viewName === 'orders')    renderOrderHistory();
    if (viewName === 'reports')   renderReports();
    if (viewName === 'inventory') renderInventoryTable();
    if (viewName === 'settings')  loadSettingsView();
}

// ─── BILLING ──────────────────────────────────────────────────────────
function renderBilling() { renderCategories(); renderMenuGrid(); }

function renderCategories() {
    const categories = [...new Set(STATE.menu.map(i => i.category))];
    const container = document.getElementById('category-tabs');
    container.innerHTML = '<button class="filter-btn active" data-category="all">All</button>';
    categories.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = 'filter-btn';
        btn.textContent = cat;
        btn.setAttribute('data-category', cat);
        container.appendChild(btn);
    });
}

function renderMenuGrid(filterCategory = 'all', searchQuery = '') {
    const grid = document.getElementById('menu-grid');
    grid.innerHTML = '';
    let items = STATE.menu;
    if (filterCategory !== 'all') items = items.filter(i => i.category === filterCategory);
    if (searchQuery) { const q = searchQuery.toLowerCase(); items = items.filter(i => i.name.toLowerCase().includes(q)); }

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'menu-item' + (item.category === 'Deals' ? ' deal-card' : '');

        const variants = item.variants || [];
        const priceHtml = variants.map(v => {
            const label = v.label ? v.label : '';
            return `<div class="price-tag" onclick="addToCart(${item.id}, '${v.label}', ${v.price})">
                        <span>${label || 'Add'}</span>
                        <span>Rs ${v.price}</span>
                    </div>`;
        }).join('');

        const descHtml = item.desc
            ? `<div class="item-desc">${item.desc}</div>`
            : '';

        div.innerHTML = `
            <div class="item-name">${item.name}</div>
            ${descHtml}
            <div class="item-prices">${priceHtml}</div>
        `;
        grid.appendChild(div);
    });
}

function addToCart(itemId, variantLabel, price) {
    const item = STATE.menu.find(i => i.id === itemId);
    const key = `${itemId}_${variantLabel}`;
    const existing = STATE.cart.find(i => i._key === key);
    if (existing) {
        existing.qty++;
    } else {
        STATE.cart.push({
            _key: key,
            id: itemId,
            name: item.name,
            variant: variantLabel,
            price,
            qty: 1,
            desc: item.desc || ''   // ← save deal contents
        });
    }
    renderCart();
}

function renderCart() {
    const container = document.getElementById('cart-items');
    container.innerHTML = '';
    if (STATE.cart.length === 0) {
        container.innerHTML = `<div class="empty-cart-msg"><i class="fa-solid fa-basket-shopping"></i><p>No items added</p></div>`;
        updateTotals(); return;
    }
    STATE.cart.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'cart-item';
        div.innerHTML = `
            <div class="cart-item-info">
                <span class="cart-item-title">${item.name}</span>
                <span class="cart-item-variant">${item.variant ? item.variant + ' @ ' : ''}Rs ${item.price}</span>
            </div>
            <div class="cart-item-controls">
                <button class="qty-btn" onclick="updateQty(${index}, -1)">-</button>
                <span>${item.qty}</span>
                <button class="qty-btn" onclick="updateQty(${index}, 1)">+</button>
            </div>
            <div style="width:70px; text-align:right; font-weight:600;">Rs ${item.price * item.qty}</div>
            <button class="action-btn delete-btn" onclick="removeFromCart(${index})"><i class="fa-solid fa-trash"></i></button>
        `;
        container.appendChild(div);
    });
    updateTotals();
}

function updateQty(index, change) {
    if (STATE.cart[index].qty + change > 0) { STATE.cart[index].qty += change; renderCart(); }
}
function removeFromCart(index) { STATE.cart.splice(index, 1); renderCart(); }
function clearCart() {
    STATE.cart = [];
    const discInput = document.getElementById('discount-input');
    const taxInput  = document.getElementById('tax-input');
    if (discInput) discInput.value = '';
    if (taxInput)  taxInput.value  = '';
    const discAmt = document.getElementById('discount-amount');
    const taxAmtEl = document.getElementById('tax-amount');
    if (discAmt)  discAmt.textContent  = '- Rs 0';
    if (taxAmtEl) taxAmtEl.textContent = '+ Rs 0';
    renderCart();
}

function updateTotals() {
    const subtotal  = STATE.cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const discPct   = parseFloat(document.getElementById('discount-input')?.value || 0);
    const taxPct    = parseFloat(document.getElementById('tax-input')?.value || 0);
    const discAmt   = Math.round(subtotal * discPct / 100);
    const afterDisc = subtotal - discAmt;
    const taxAmt    = Math.round(afterDisc * taxPct / 100);
    const total     = afterDisc + taxAmt;

    document.getElementById('subtotal-price').textContent  = `Rs ${subtotal}`;
    document.getElementById('discount-amount').textContent = `- Rs ${discAmt}`;
    document.getElementById('tax-amount').textContent      = `+ Rs ${taxAmt}`;
    document.getElementById('total-price').textContent     = `Rs ${total}`;
}

// Called every time discount% or tax% changes
window.applyDiscount = function() {
    const discInput = document.getElementById('discount-input');
    const taxInput  = document.getElementById('tax-input');
    let d = parseFloat(discInput.value); if (isNaN(d)||d<0) d=0; if(d>100) d=100; discInput.value=d||'';
    let t = parseFloat(taxInput.value);  if (isNaN(t)||t<0) t=0; if(t>100) t=100; taxInput.value=t||'';
    updateTotals();
};

function updateOrderId() {
    const ids = STATE.orders.map(o => parseInt(o.id)).filter(n => !isNaN(n));
    const maxId = ids.length > 0 ? Math.max(...ids) : 0;
    document.getElementById('new-order-id').textContent = (maxId + 1).toString();
}

function processCheckout() {
    if (STATE.cart.length === 0) return alert('Cart is empty!');
    const orderId   = document.getElementById('new-order-id').textContent;
    const customer  = document.getElementById('customer-name').value.trim() || 'Guest';
    const subtotal  = STATE.cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const discPct   = parseFloat(document.getElementById('discount-input')?.value || 0);
    const taxPct    = parseFloat(document.getElementById('tax-input')?.value || 0);
    const discAmt   = Math.round(subtotal * discPct / 100);
    const afterDisc = subtotal - discAmt;
    const taxAmt    = Math.round(afterDisc * taxPct / 100);
    const total     = afterDisc + taxAmt;
    const order     = {
        id: orderId,
        date: new Date().toISOString(),
        customerVal: customer,
        items: [...STATE.cart],
        subtotal,
        discountPct: discPct,
        discountAmt: discAmt,
        taxPct,
        taxAmt,
        total
    };
    STATE.orders.push(order);
    saveOrders();
    printReceipt(order);
    clearCart();
    document.getElementById('customer-name').value = '';
    updateOrderId();
    syncToCloud();
}

function printReceipt(order) {
    const template = document.getElementById('receipt-template');
    if (!template) return;

    template.querySelector('#receipt-order-id').textContent = order.id;

    // Format date: 11-Jun-26 16:29
    const d = new Date(order.date);
    const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
    const timeStr = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    template.querySelector('#receipt-date').textContent = `${dateStr} ${timeStr}`;

    template.querySelector('#receipt-customer').textContent     = order.customerVal || 'Walk-in';
    template.querySelector('#receipt-gross-total').textContent  = (order.subtotal ?? order.total).toFixed(2);
    template.querySelector('#receipt-discount-pct').textContent = (order.discountPct ?? 0);
    template.querySelector('#receipt-discount-amt').textContent = (order.discountAmt ?? 0).toFixed(2);
    template.querySelector('#receipt-tax-pct').textContent      = (order.taxPct ?? 0);
    template.querySelector('#receipt-tax-amt').textContent      = (order.taxAmt ?? 0).toFixed(2);
    template.querySelector('#receipt-total').textContent        = order.total.toFixed(2);

    const tbody = template.querySelector('#receipt-body');
    tbody.innerHTML = '';

    order.items.forEach(item => {
        // ── Main item row ──
        const tr = document.createElement('tr');
        const nameHtml = item.name.toUpperCase()
            + (item.variant ? `<br><small style="font-size:0.68rem;color:#555;">${item.variant}</small>` : '');
        tr.innerHTML = `
            <td>${nameHtml}</td>
            <td style="text-align:center;font-weight:700;">${item.qty}</td>
            <td style="text-align:right;">${item.price.toFixed(2)}</td>
            <td style="text-align:right;font-weight:700;">${(item.price * item.qty).toFixed(2)}</td>
        `;
        tbody.appendChild(tr);

        // ── Deal contents sub-row ──
        if (item.desc && item.desc.trim()) {
            // Strip HTML tags from desc for clean print output
            const cleanDesc = item.desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const subTr = document.createElement('tr');
            subTr.innerHTML = `
                <td colspan="4" style="
                    font-size: 0.68rem;
                    color: #444;
                    padding: 0 2px 4px 8px;
                    border-bottom: 1px dashed #ccc;
                    line-height: 1.5;
                    white-space: pre-wrap;
                ">  ↳ ${cleanDesc}</td>
            `;
            tbody.appendChild(subTr);
        }
    });

    // Instead of printing immediately, show custom preview
    const receiptHtml = template.innerHTML;
    const previewArea = document.getElementById('preview-render-area');
    if (previewArea) {
        previewArea.innerHTML = receiptHtml;
    }
    document.getElementById('receipt-preview-modal').classList.add('open');
}

window.closeReceiptPreview = function() {
    document.getElementById('receipt-preview-modal').classList.remove('open');
    const previewArea = document.getElementById('preview-render-area');
    if (previewArea) previewArea.innerHTML = '';
};

window.executePrint = function() {
    window.print();
    closeReceiptPreview();
};

// ─── ADMIN ────────────────────────────────────────────────────────────
function renderAdminTable(searchQuery = '') {
    const tbody = document.getElementById('admin-menu-table');
    tbody.innerHTML = '';
    let items = STATE.menu;
    if (searchQuery) { const q = searchQuery.toLowerCase(); items = items.filter(i => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)); }
    items.forEach(item => {
        const variantStr = (item.variants || []).map(v => (v.label ? v.label+': ' : '') + 'Rs '+v.price).join(' | ');
        const descHtml = item.desc ? `<br><small style="color:var(--text-muted); font-size: 0.75rem;">${item.desc}</small>` : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${item.name}${descHtml}</td>
            <td>${item.category}</td>
            <td style="font-size:0.82rem;">${variantStr}</td>
            <td>
                <button class="action-btn edit-btn" onclick="editItem(${item.id})"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn delete-btn" onclick="deleteItem(${item.id})"><i class="fa-solid fa-trash"></i></button>
            </td>`;
        tbody.appendChild(tr);
    });
}

// Tracks deal builder items [{qty, name}]
let _dealItems = [];

function openModal(item = null) {
    const modal = document.getElementById('item-modal');
    modal.classList.add('open');

    // Populate category dropdown from STATE.categories (includes custom empty cats too)
    const select = document.getElementById('item-category');
    select.innerHTML = '';
    STATE.categories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat; opt.textContent = cat;
        select.appendChild(opt);
    });

    // Reset deal builder
    _dealItems = [];
    renderDealItemsList();
    document.getElementById('deal-autocomplete-dropdown').style.display = 'none';

    if (item) {
        document.getElementById('modal-title').textContent    = 'Edit Item';
        document.getElementById('modal-subtitle').textContent = 'Editing: ' + item.name;
        document.getElementById('modal-icon').className       = 'fa-solid fa-pen-to-square';
        document.getElementById('edit-item-id').value         = item.id;
        document.getElementById('item-name').value            = item.name;
        document.getElementById('item-category').value        = item.category;
        document.getElementById('item-prices-input').value    = (item.variants||[]).map(v => v.label ? `${v.label}:${v.price}` : v.price).join(', ');

        // If item is a Deal, parse desc into builder pills
        if (item.category === 'Deals' && item.desc) {
            item.desc.split('+').forEach(part => {
                part = part.trim();
                const match = part.match(/^(\d+)x?\s+(.+)$/i);
                if (match) {
                    _dealItems.push({ qty: parseInt(match[1]), name: match[2].trim() });
                } else if (part) {
                    _dealItems.push({ qty: 1, name: part });
                }
            });
        } else {
            document.getElementById('item-desc').value = item.desc || '';
        }
    } else {
        document.getElementById('modal-title').textContent    = 'Add Menu Item';
        document.getElementById('modal-subtitle').textContent = 'Fill in the details below';
        document.getElementById('modal-icon').className       = 'fa-solid fa-utensils';
        document.getElementById('item-form').reset();
        document.getElementById('edit-item-id').value         = '';
    }

    // Trigger section visibility
    onCategoryChange();
}

window.onCategoryChange = function() {
    const cat = document.getElementById('item-category').value;
    const isDeals = cat === 'Deals';
    document.getElementById('deal-builder-section').style.display = isDeals ? 'block' : 'none';
    document.getElementById('manual-desc-section').style.display  = isDeals ? 'none'  : 'block';
    if (isDeals) {
        document.getElementById('modal-icon').className       = 'fa-solid fa-star';
        document.getElementById('modal-subtitle').textContent = 'Build your deal below';
    } else {
        document.getElementById('modal-icon').className       = 'fa-solid fa-utensils';
        document.getElementById('modal-subtitle').textContent = 'Fill in the details below';
    }
};

window.addDealItem = function() {
    const qtyEl  = document.getElementById('deal-item-qty');
    const nameEl = document.getElementById('deal-item-name');
    const qty    = parseInt(qtyEl.value) || 1;
    const name   = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    _dealItems.push({ qty, name });
    nameEl.value = '';
    qtyEl.value  = '1';
    document.getElementById('deal-autocomplete-dropdown').style.display = 'none';
    nameEl.focus();
    renderDealItemsList();
};

window.showDealItemSuggestions = function(query) {
    const dropdown = document.getElementById('deal-autocomplete-dropdown');
    dropdown.innerHTML = '';
    
    // Get unique non-deal items
    const availableItems = [...new Set(STATE.menu.filter(i => i.category !== 'Deals').map(i => i.name))];
    
    // Filter based on query
    const matches = availableItems.filter(name => name.toLowerCase().includes(query.toLowerCase()));
    
    if (matches.length === 0) {
        dropdown.style.display = 'none';
        return;
    }
    
    matches.forEach(name => {
        const div = document.createElement('div');
        div.style.padding = '0.6rem 1rem';
        div.style.cursor = 'pointer';
        div.style.borderBottom = '1px solid var(--border)';
        div.style.color = 'var(--text-dark)';
        div.style.fontSize = '0.9rem';
        div.textContent = name;
        
        div.onmouseover = () => div.style.background = 'rgba(253,184,19,0.1)';
        div.onmouseout = () => div.style.background = 'transparent';
        div.onclick = () => window.selectDealItemSuggestion(name);
        
        dropdown.appendChild(div);
    });
    
    dropdown.style.display = 'block';
};

window.selectDealItemSuggestion = function(name) {
    const nameEl = document.getElementById('deal-item-name');
    nameEl.value = name;
    document.getElementById('deal-autocomplete-dropdown').style.display = 'none';
    nameEl.focus();
};

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('deal-autocomplete-dropdown');
    const input = document.getElementById('deal-item-name');
    if (dropdown && e.target !== dropdown && e.target !== input) {
        dropdown.style.display = 'none';
    }
});

// Allow pressing Enter in deal item input
document.addEventListener('DOMContentLoaded', () => {
    const nameInput = document.getElementById('deal-item-name');
    if (nameInput) {
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); window.addDealItem(); }
        });
    }
});

function renderDealItemsList() {
    const list = document.getElementById('deal-items-list');
    const preview = document.getElementById('deal-desc-preview');
    const previewText = document.getElementById('deal-desc-text');
    list.innerHTML = '';

    if (_dealItems.length === 0) {
        list.innerHTML = '<p style="color:#555; font-size:0.85rem; text-align:center; padding: 0.5rem 0;">No items added yet. Type an item name above and click Add.</p>';
        if (preview) preview.style.display = 'none';
        return;
    }

    _dealItems.forEach((itm, idx) => {
        const pill = document.createElement('div');
        pill.className = 'deal-item-pill';
        pill.innerHTML = `
            <span class="pill-qty">${itm.qty}x</span>
            <span class="pill-name">${itm.name}</span>
            <button class="pill-delete" onclick="_removeDealItem(${idx})" title="Remove">
                <i class="fa-solid fa-times"></i>
            </button>`;
        list.appendChild(pill);
    });

    // Update preview
    const descStr = _dealItems.map(i => `${i.qty}x ${i.name}`).join(' + ');
    if (previewText) previewText.textContent = descStr;
    if (preview) preview.style.display = 'block';
    document.getElementById('deal-desc-hidden').value = descStr;
}

window._removeDealItem = function(idx) {
    _dealItems.splice(idx, 1);
    renderDealItemsList();
};

function closeModal() { document.getElementById('item-modal').classList.remove('open'); }

// Parse prices input like "S:350, M:750" or just "299"
function parsePrices(input) {
    return input.split(',').map(p => {
        p = p.trim();
        if (p.includes(':')) {
            const [label, price] = p.split(':');
            return { label: label.trim(), price: parseFloat(price.trim()) };
        }
        return { label: '', price: parseFloat(p) };
    }).filter(v => !isNaN(v.price));
}

function handleItemSave(e) {
    e.preventDefault();
    const id       = document.getElementById('edit-item-id').value;
    const name     = document.getElementById('item-name').value.trim();
    const category = document.getElementById('item-category').value;
    const variants = parsePrices(document.getElementById('item-prices-input').value);

    if (variants.length === 0) return alert('Please enter a valid price.');

    const newItemData = { name, category, variants };

    // Pick desc source: deal builder OR manual field
    if (category === 'Deals') {
        const dealDesc = document.getElementById('deal-desc-hidden').value;
        if (dealDesc.trim()) newItemData.desc = dealDesc.trim();
    } else {
        const manualDesc = document.getElementById('item-desc').value.trim();
        if (manualDesc) newItemData.desc = manualDesc;
    }

    if (id) {
        const idx = STATE.menu.findIndex(i => i.id == id);
        if (idx > -1) STATE.menu[idx] = { id: Number(id), ...newItemData };
    } else {
        const newId = STATE.menu.length > 0 ? Math.max(...STATE.menu.map(i => i.id)) + 1 : 1;
        STATE.menu.push({ id: newId, ...newItemData });
    }
    saveMenu(); closeModal(); renderAdminTable(); renderCategories();
}

window.editItem   = function(id) { openModal(STATE.menu.find(i => i.id === id)); };
window.deleteItem = function(id) { if (confirm('Delete this item?')) { STATE.menu = STATE.menu.filter(i => i.id !== id); saveMenu(); renderAdminTable(); } };
window.addToCart  = addToCart;
window.updateQty  = updateQty;
window.removeFromCart = removeFromCart;

// ─── CATEGORY MODAL ───────────────────────────────────────────────────
window.openCategoryModal = function () {
    document.getElementById('category-modal').classList.add('open');
    renderCategoryTable();
};
window.closeCategoryModal = function () { document.getElementById('category-modal').classList.remove('open'); };

function renderCategoryTable() {
    const tbody = document.getElementById('category-list-table');
    tbody.innerHTML = '';
    STATE.categories.forEach((cat, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${cat}</td><td><button class="action-btn delete-btn" onclick="deleteCategory(${index})"><i class="fa-solid fa-trash"></i></button></td>`;
        tbody.appendChild(tr);
    });
}

function saveCategories() {
    // Save only the "custom" (empty) categories — the rest come from menu items
    const menuCats   = [...new Set(STATE.menu.map(i => i.category))];
    const customOnly = STATE.categories.filter(c => !menuCats.includes(c));
    localStorage.setItem('mf_custom_categories', JSON.stringify(customOnly));
    renderCategories();     // refresh billing page tabs
    // Push updated category list to tablet via IPC
    if (window.electronAPI && window.electronAPI.updateMenu) {
        window.electronAPI.updateMenu(STATE.menu);  // tablet derives cats from menu
    }
}

window.addCategory = function () {
    const input = document.getElementById('new-category-name');
    const name  = input.value.trim();
    if (!name) return;
    if (STATE.categories.includes(name)) {
        return alert('Category already exists!');
    }
    STATE.categories.push(name);
    input.value = '';
    saveCategories();
    renderCategoryTable();
    // Also update item-form dropdown immediately
    const sel = document.getElementById('item-category');
    if (sel) {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        sel.appendChild(opt);
    }
};

window.deleteCategory = function (index) {
    const cat = STATE.categories[index];
    if (!cat) return;
    const itemsInCat = STATE.menu.filter(i => i.category === cat);
    if (itemsInCat.length > 0) {
        if (!confirm(`Category "${cat}" has ${itemsInCat.length} items. Delete them all too?`)) return;
        STATE.menu = STATE.menu.filter(i => i.category !== cat);
    }
    STATE.categories.splice(index, 1);
    saveCategories();
    saveMenu();
    renderCategoryTable();
    renderAdminTable();
};

// ─── INVENTORY ────────────────────────────────────────────────────────
let _invActiveFilter = 'all'; // 'all' | 'today' | 'week' | 'month' | 'custom'

window.setInvFilter = function(filter) {
    _invActiveFilter = filter;

    // Update pill active state
    ['all','today','week','month','custom'].forEach(f => {
        const el = document.getElementById(`inv-filter-${f}`);
        if (el) el.classList.toggle('active', f === filter);
    });

    // Show/hide custom date inputs
    const customDates = document.getElementById('inv-custom-dates');
    if (customDates) customDates.style.display = filter === 'custom' ? 'flex' : 'none';

    // Update badge
    const badge = document.getElementById('inv-filter-badge');
    const badgeText = document.getElementById('inv-filter-badge-text');
    const labels = { all: null, today: 'Today', week: 'This Week', month: 'This Month', custom: 'Custom Range' };
    if (badge && badgeText) {
        if (filter === 'all') {
            badge.style.display = 'none';
        } else {
            badge.style.display = 'flex';
            badgeText.textContent = labels[filter];
        }
    }

    renderInventoryTable();
};

function renderInventoryTable() {
    const tbody = document.getElementById('inventory-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    let totalValue = 0;

    // ── Search filter
    const searchEl = document.getElementById('inventory-search');
    const searchQuery = searchEl ? searchEl.value.toLowerCase() : '';

    // ── Date filter based on active pill
    // Use LOCAL date string (YYYY-MM-DD) comparisons to avoid UTC/PKT timezone shift
    const now = new Date();

    // Helper: get local date string YYYY-MM-DD
    function localDate(d) {
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    const todayStr = localDate(now);

    // Week start (Sunday) in local time
    const weekStartDate = new Date(now);
    weekStartDate.setDate(now.getDate() - now.getDay());
    const weekStartStr = localDate(weekStartDate);

    // Month start
    const monthStartStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    let fromDate = null, toDate = null;
    let fromStr = null, toStr = null;

    if (_invActiveFilter === 'today') {
        fromStr = toStr = todayStr;
    } else if (_invActiveFilter === 'week') {
        fromStr = weekStartStr; toStr = todayStr;
    } else if (_invActiveFilter === 'month') {
        fromStr = monthStartStr; toStr = todayStr;
    } else if (_invActiveFilter === 'custom') {
        const fromEl = document.getElementById('inventory-from-date');
        const toEl   = document.getElementById('inventory-to-date');
        fromStr = fromEl && fromEl.value ? fromEl.value : null;
        toStr   = toEl   && toEl.value   ? toEl.value   : null;
    }
    // 'all' → fromStr/toStr = null = no date filter

    let items = STATE.inventory;

    // Apply search
    if (searchQuery) {
        items = items.filter(i =>
            i.name.toLowerCase().includes(searchQuery) ||
            i.category.toLowerCase().includes(searchQuery)
        );
    }

    // Apply date filter
    if (fromStr || toStr) {
        items = items.filter(i => {
            // Items with NO date → always include them (they are legacy stock, treat as today)
            if (!i.date) return true;

            // Convert stored ISO date to local date string for comparison (timezone-safe)
            const d = new Date(i.date);
            const itemStr = localDate(d);

            if (fromStr && itemStr < fromStr) return false;
            if (toStr   && itemStr > toStr)   return false;
            return true;
        });
    }



    // ── Render empty state
    if (items.length === 0) {
        tbody.innerHTML = `
            <tr><td colspan="7" style="text-align:center; padding: 3rem; color: var(--text-muted);">
                <i class="fa-solid fa-box-open" style="font-size: 2.5rem; margin-bottom: 1rem; opacity: 0.4;"></i>
                <br>No inventory items found
                ${searchQuery ? `<br><small>for "${searchQuery}"</small>` : ''}
            </td></tr>`;
        const totalEl = document.getElementById('inv-total-items');
        const valueEl = document.getElementById('inv-total-value');
        if (totalEl) totalEl.textContent = 0;
        if (valueEl) valueEl.textContent = 'Rs 0';
        return;
    }

    items.forEach((item, index) => {
        const value    = item.qty * item.avgCost;
        totalValue    += value;
        const unitLabel = item.unit || 'Kg';
        const dateStr   = item.date ? new Date(item.date).toLocaleDateString('en-PK', { day:'2-digit', month:'short', year:'numeric' }) : '—';
        const tr = document.createElement('tr');
        tr.style.animation = 'slideIn 0.2s ease forwards';
        tr.innerHTML = `
            <td><b>${item.name}</b></td>
            <td><span style="background: rgba(253,184,19,0.12); color: var(--primary); padding: 2px 10px; border-radius: 20px; font-size: 0.78rem; font-weight: 600;">${item.category}</span></td>
            <td><b>${item.qty.toFixed(2)}</b> <small style="color:var(--text-muted);">${unitLabel}</small></td>
            <td>Rs ${item.avgCost.toFixed(2)} <small style="color:var(--text-muted);">/ ${unitLabel}</small></td>
            <td><b>Rs ${value.toFixed(2)}</b></td>
            <td style="font-size: 0.82rem; color: var(--text-muted);">${dateStr}</td>
            <td>
                <button class="action-btn edit-btn"   title="Edit"   onclick="editInventoryItem(${index})"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn delete-btn" title="Delete" onclick="deleteInventoryItem(${index})"><i class="fa-solid fa-trash"></i></button>
            </td>`;
        tbody.appendChild(tr);
    });

    const totalEl = document.getElementById('inv-total-items');
    const valueEl = document.getElementById('inv-total-value');
    if (totalEl) totalEl.textContent = items.length;
    if (valueEl) valueEl.textContent = `Rs ${totalValue.toFixed(0)}`;
}


window.openInventoryModal = function() {
    document.getElementById('edit-inventory-id').value = '';
    document.getElementById('inventory-form').reset();
    document.getElementById('inv-modal-title').textContent = 'Add Stock';
    document.getElementById('inv-autocomplete-dropdown').style.display = 'none';
    document.getElementById('inventory-modal').classList.add('open');
};

window.closeInventoryModal = function() { document.getElementById('inventory-modal').classList.remove('open'); };

window.editInventoryItem = function(index) {
    const item = STATE.inventory[index];
    document.getElementById('edit-inventory-id').value = index;
    document.getElementById('inv-name').value     = item.name;
    document.getElementById('inv-category').value = item.category;
    document.getElementById('inv-unit').value     = item.unit || 'Kg';
    document.getElementById('inv-qty').value      = item.qty;
    document.getElementById('inv-cost').value     = (item.qty * item.avgCost).toFixed(2);
    document.getElementById('inv-modal-title').textContent = 'Edit Stock Entry';
    document.getElementById('inventory-modal').classList.add('open');
};

window.deleteInventoryItem = function(index) {
    if (confirm('Remove this inventory item?')) { STATE.inventory.splice(index, 1); saveInventory(); }
};

function handleInventorySave(e) {
    e.preventDefault();
    const idxStr   = document.getElementById('edit-inventory-id').value;
    const name     = document.getElementById('inv-name').value.trim();
    const category = document.getElementById('inv-category').value.trim();
    const unit     = document.getElementById('inv-unit').value;
    const qty      = parseFloat(document.getElementById('inv-qty').value);
    const cost     = parseFloat(document.getElementById('inv-cost').value);
    const avgCost  = qty > 0 ? cost / qty : 0;
    const now      = new Date().toISOString();

    // Build purchase entry for Supabase (every stock add = 1 purchase record)
    const purchaseEntry = {
        id:       'PUR-' + Date.now(),
        name,
        category,
        unit,
        qty,
        avgCost,
        totalCost: qty * avgCost,
        date:     now
    };

    // Save to STATE.purchases (persistent log of all purchases)
    if (!STATE.purchases) STATE.purchases = [];
    STATE.purchases.push(purchaseEntry);
    localStorage.setItem('mf_purchases', JSON.stringify(STATE.purchases));

    if (idxStr !== '') {
        const idx = parseInt(idxStr);
        // Add to existing stock
        const old     = STATE.inventory[idx];
        const newQty  = old.qty + qty;
        const newAvg  = newQty > 0 ? (old.qty * old.avgCost + qty * avgCost) / newQty : avgCost;
        STATE.inventory[idx] = { name, category, unit, qty: newQty, avgCost: newAvg, date: now };
    } else {
        // Check if item already exists by name
        const existing = STATE.inventory.find(i => i.name.toLowerCase() === name.toLowerCase());
        if (existing) {
            const newQty = existing.qty + qty;
            const newAvg = (existing.qty * existing.avgCost + qty * avgCost) / newQty;
            existing.qty = newQty; existing.avgCost = newAvg; existing.unit = unit; existing.date = now;
        } else {
            STATE.inventory.push({ name, category, unit, qty, avgCost, date: now });
        }
    }
    saveInventory();
    window.closeInventoryModal();
    syncToCloud();
    // Sync this purchase entry to Supabase immediately
    syncPurchaseToCloud(purchaseEntry);
}

window.showInvItemSuggestions = function(query) {
    const dropdown = document.getElementById('inv-autocomplete-dropdown');
    dropdown.innerHTML = '';
    
    // Get unique inventory items
    const availableItems = [...new Set(STATE.inventory.map(i => i.name))];
    
    // Filter based on query
    const matches = availableItems.filter(name => name.toLowerCase().includes(query.toLowerCase()));
    
    if (matches.length === 0) {
        dropdown.style.display = 'none';
        return;
    }
    
    matches.forEach(name => {
        const item = STATE.inventory.find(i => i.name === name);
        const div = document.createElement('div');
        div.style.padding = '0.6rem 1rem';
        div.style.cursor = 'pointer';
        div.style.borderBottom = '1px solid var(--border)';
        div.style.color = 'var(--text-dark)';
        div.style.fontSize = '0.9rem';
        div.textContent = name;
        
        div.onmouseover = () => div.style.background = 'rgba(253,184,19,0.1)';
        div.onmouseout = () => div.style.background = 'transparent';
        div.onclick = () => {
            document.getElementById('inv-name').value = name;
            if (item) {
                document.getElementById('inv-category').value = item.category;
                document.getElementById('inv-unit').value = item.unit || 'Kg';
            }
            dropdown.style.display = 'none';
            document.getElementById('inv-qty').focus();
        };
        
        dropdown.appendChild(div);
    });
    
    dropdown.style.display = 'block';
};

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('inv-autocomplete-dropdown');
    const input = document.getElementById('inv-name');
    if (dropdown && e.target !== dropdown && e.target !== input) {
        dropdown.style.display = 'none';
    }
});

// ─── REPORTS ──────────────────────────────────────────────────────────

window.toggleReportCustomDate = function() {
    const filter = document.getElementById('report-filter').value;
    const customContainer = document.getElementById('report-custom-date-container');
    if (filter === 'custom') {
        customContainer.style.display = 'flex';
    } else {
        customContainer.style.display = 'none';
    }
    renderReports();
};

function renderReports() {
    const filterEl = document.getElementById('report-filter');
    const filter   = filterEl ? filterEl.value : 'today';
    const now      = new Date();
    
    // Calculate week start (Sunday)
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0,0,0,0);

    let filtered = STATE.orders.filter(o => !o.archived);

    if (filter === 'today') {
        filtered = filtered.filter(o => new Date(o.date).toDateString() === now.toDateString());
    } else if (filter === 'week') {
        filtered = filtered.filter(o => new Date(o.date) >= weekStart);
    } else if (filter === 'month') {
        filtered = filtered.filter(o => {
            const d = new Date(o.date);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
    } else if (filter === 'custom') {
        const fromEl = document.getElementById('report-from-date');
        const toEl   = document.getElementById('report-to-date');
        const fromDate = fromEl && fromEl.value ? new Date(fromEl.value) : null;
        let toDate     = toEl && toEl.value ? new Date(toEl.value) : null;
        
        if (toDate) toDate.setHours(23, 59, 59, 999);
        
        if (fromDate || toDate) {
            filtered = filtered.filter(o => {
                const orderDate = new Date(o.date);
                if (fromDate && orderDate < fromDate) return false;
                if (toDate && orderDate > toDate) return false;
                return true;
            });
        }
    }

    const totalSales = filtered.reduce((sum, o) => sum + o.total, 0);
    const salesEl = document.getElementById('period-sales');
    const countEl = document.getElementById('period-orders-count');
    if (salesEl) salesEl.textContent = `Rs ${totalSales}`;
    if (countEl) countEl.textContent = filtered.length;

    const tableBody = document.getElementById('report-details-table');
    if (tableBody) {
        tableBody.innerHTML = '';
        const daily = {};
        filtered.forEach(o => {
            const k = new Date(o.date).toDateString();
            if (!daily[k]) daily[k] = { count: 0, total: 0 };
            daily[k].count++; daily[k].total += o.total;
        });
        Object.keys(daily).sort((a, b) => new Date(b) - new Date(a)).forEach(date => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${date}</td><td>${daily[date].count}</td><td>Rs ${daily[date].total}</td>`;
            tableBody.appendChild(tr);
        });
    }
    renderTopItemsChart(filtered);
    renderCategoryPieChart(filtered);
}

function renderCategoryPieChart(orders) {
    const categorySales = {}; let totalQty = 0;
    orders.forEach(o => o.items.forEach(item => {
        const menuItem = STATE.menu.find(m => m.name === item.name);
        const cat = menuItem ? menuItem.category : 'Other';
        if (!categorySales[cat]) categorySales[cat] = 0;
        categorySales[cat] += item.qty; totalQty += item.qty;
    }));
    const container = document.getElementById('category-pie-chart');
    if (!container) return;
    container.innerHTML = '';
    if (totalQty === 0) { container.innerHTML = '<p style="color:#888">No data</p>'; return; }
    const sortedCats = Object.entries(categorySales).sort((a, b) => b[1] - a[1]);
    const colors = ['#FDB813','#e63946','#2a9d8f','#457b9d','#f4a261','#8e44ad','#34495e','#e9c46a'];
    let gradStr = []; let cur = 0;
    const legendDiv = document.createElement('div');
    legendDiv.style.cssText = 'display:flex; flex-direction:column; gap:8px; font-size:0.85rem;';
    sortedCats.forEach(([cat, qty], idx) => {
        const pct = (qty / totalQty) * 100;
        const deg = (pct / 100) * 360;
        const color = colors[idx % colors.length];
        gradStr.push(`${color} ${cur}deg ${cur + deg}deg`);
        cur += deg;
        const itm = document.createElement('div');
        itm.innerHTML = `<span style="display:inline-block;width:10px;height:10px;background:${color};margin-right:5px;border-radius:50%;"></span>${cat} (${Math.round(pct)}%)`;
        legendDiv.appendChild(itm);
    });
    const pieDiv = document.createElement('div');
    pieDiv.style.cssText = `width:150px;height:150px;border-radius:50%;background:conic-gradient(${gradStr.join(', ')});border:4px solid #222;box-shadow:0 4px 6px rgba(0,0,0,0.3);`;
    container.appendChild(pieDiv);
    container.appendChild(legendDiv);
}

function renderTopItemsChart(orders) {
    const itemSales = {};
    orders.forEach(o => o.items.forEach(item => { if (!itemSales[item.name]) itemSales[item.name] = 0; itemSales[item.name] += item.qty; }));
    const sorted = Object.entries(itemSales).sort(([,a],[,b]) => b - a).slice(0, 10);
    const chartContainer = document.getElementById('top-items-chart');
    if (!chartContainer) return;
    chartContainer.innerHTML = '';
    if (sorted.length === 0) { chartContainer.innerHTML = '<p style="text-align:center;color:#888;padding:20px;">No sales data.</p>'; return; }
    const maxQty = sorted[0][1];
    sorted.forEach(([name, qty]) => {
        const pct = (qty / maxQty) * 100;
        const row = document.createElement('div');
        row.className = 'chart-bar-row';
        row.innerHTML = `<div class="bar-label" title="${name}">${name}</div><div class="bar-track"><div class="bar-fill" style="width:0%;"></div></div><div class="bar-value">${qty} sold</div>`;
        chartContainer.appendChild(row);
        setTimeout(() => { const fill = row.querySelector('.bar-fill'); if (fill) fill.style.width = `${pct}%`; }, 50);
    });
}

// ─── ORDER HISTORY ────────────────────────────────────────────────────
let _histActiveFilter = 'all'; // 'all' | 'today' | 'week' | 'month' | 'custom'

window.setHistFilter = function(filter) {
    _histActiveFilter = filter;
    
    // Update pill active state
    ['all','today','week','month','custom'].forEach(f => {
        const el = document.getElementById(`hist-filter-${f}`);
        if (el) el.classList.toggle('active', f === filter);
    });

    // Show/hide custom date inputs
    const customDates = document.getElementById('hist-custom-dates');
    if (customDates) customDates.style.display = filter === 'custom' ? 'flex' : 'none';

    renderOrderHistory();
};

function renderOrderHistory() {
    const tbody = document.getElementById('orders-history-table');
    tbody.innerHTML = '';
    
    // Read search filter
    const searchEl   = document.getElementById('history-search');
    const query      = searchEl && searchEl.value ? searchEl.value.toLowerCase().trim() : '';
    
    // Date filter based on active pill
    const now = new Date();
    function localDate(d) {
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    const todayStr = localDate(now);
    
    const weekStartDate = new Date(now);
    weekStartDate.setDate(now.getDate() - now.getDay());
    const weekStartStr = localDate(weekStartDate);
    
    const monthStartStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    let fromStr = null, toStr = null;

    if (_histActiveFilter === 'today') {
        fromStr = toStr = todayStr;
    } else if (_histActiveFilter === 'week') {
        fromStr = weekStartStr; toStr = todayStr;
    } else if (_histActiveFilter === 'month') {
        fromStr = monthStartStr; toStr = todayStr;
    } else if (_histActiveFilter === 'custom') {
        const fromEl = document.getElementById('history-from-date');
        const toEl   = document.getElementById('history-to-date');
        fromStr = fromEl && fromEl.value ? fromEl.value : null;
        toStr   = toEl   && toEl.value   ? toEl.value   : null;
    }

    let visible = [...STATE.orders].filter(o => !o.archived);

    // Apply text search filter (by Customer Name or Order ID)
    if (query) {
        visible = visible.filter(o => {
            const customerMatch = o.customerVal && o.customerVal.toLowerCase().includes(query);
            const idMatch       = String(o.id).includes(query);
            return customerMatch || idMatch;
        });
    }

    // Apply date filters
    if (fromStr || toStr) {
        visible = visible.filter(o => {
            if (!o.date) return true;
            const d = new Date(o.date);
            const orderStr = localDate(d);
            
            if (fromStr && orderStr < fromStr) return false;
            if (toStr   && orderStr > toStr)   return false;
            return true;
        });
    }

    visible = visible.reverse();

    if (visible.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:3rem;color:var(--text-muted);"><i class="fa-solid fa-magnifying-glass" style="font-size:2rem;margin-bottom:1rem;opacity:0.5;"></i><br>No orders found matching your criteria</td></tr>`;
        return;
    }

    visible.forEach(order => {
        const date  = new Date(order.date).toLocaleString();
        const items = order.items.map(i => `${i.qty}x ${i.name}${i.variant ? ' ('+i.variant+')' : ''}`).join(', ');
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><b>#${order.id}</b></td>
            <td style="font-size:0.85rem;">${date}</td>
            <td><small><b style="color:var(--primary);">${order.customerVal||'Guest'}</b><br>${items}</small></td>
            <td><b>Rs ${order.total}</b></td>
            <td style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <button class="btn btn-secondary" style="padding:4px 10px;font-size:0.78rem;" onclick='reprintOrder(${JSON.stringify(order)})'>
                    <i class="fa-solid fa-print"></i> Print
                </button>
                <button class="action-btn edit-btn" title="Edit Order" style="font-size:1rem;" onclick="openEditOrderModal('${order.id}')">
                    <i class="fa-solid fa-pen-to-square"></i>
                </button>
                <button class="action-btn delete-btn" title="Delete Order" style="font-size:1rem;" onclick="deleteOrder('${order.id}')">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </td>`;
        tbody.appendChild(tr);
    });
}

window.deleteOrder = function(orderId) {
    if (confirm(`Delete Order #${orderId}? This will remove it from history and reports permanently.`)) {
        STATE.orders = STATE.orders.filter(o => String(o.id) !== String(orderId));
        saveOrders();
        renderOrderHistory();
    }
};

window.openEditOrderModal = function(orderId) {
    const order = STATE.orders.find(o => String(o.id) === String(orderId));
    if (!order) return;

    document.getElementById('edit-order-id').value       = orderId;
    document.getElementById('edit-order-customer').value = order.customerVal || 'Guest';

    // Build items editor
    const itemsDiv = document.getElementById('edit-order-items');
    itemsDiv.innerHTML = '';
    order.items.forEach((item, idx) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
        row.innerHTML = `
            <span style="flex:1;font-size:0.9rem;">${item.name}${item.variant ? ' ('+item.variant+')' : ''}</span>
            <label style="font-size:0.8rem;color:var(--text-muted);">Qty</label>
            <input type="number" min="1" value="${item.qty}" data-idx="${idx}"
                style="width:60px;padding:4px 6px;background:var(--bg-light);color:var(--text-dark);border:1px solid var(--border);border-radius:6px;"
                class="edit-order-qty-input">
            <label style="font-size:0.8rem;color:var(--text-muted);">Price</label>
            <input type="number" min="0" value="${item.price}" data-idx="${idx}"
                style="width:80px;padding:4px 6px;background:var(--bg-light);color:var(--text-dark);border:1px solid var(--border);border-radius:6px;"
                class="edit-order-price-input">
            <button class="action-btn delete-btn" onclick="removeEditItem(${idx})" style="font-size:0.9rem;" title="Remove item">
                <i class="fa-solid fa-times"></i>
            </button>`;
        itemsDiv.appendChild(row);
    });

    document.getElementById('order-edit-modal').classList.add('open');
};

window.removeEditItem = function(idx) {
    const rows = document.querySelectorAll('#edit-order-items > div');
    if (rows[idx]) rows[idx].remove();
};

window.saveEditOrder = function() {
    const orderId  = document.getElementById('edit-order-id').value;
    const customer = document.getElementById('edit-order-customer').value.trim() || 'Guest';
    const order    = STATE.orders.find(o => String(o.id) === String(orderId));
    if (!order) return;

    // Collect edited items
    const itemsDiv   = document.getElementById('edit-order-items');
    const itemDivs   = itemsDiv.querySelectorAll('div');
    const qtyInputs  = itemsDiv.querySelectorAll('.edit-order-qty-input');
    const prcInputs  = itemsDiv.querySelectorAll('.edit-order-price-input');

    const newItems = [];
    qtyInputs.forEach((qtyEl, i) => {
        const idx   = parseInt(qtyEl.getAttribute('data-idx'));
        const qty   = parseInt(qtyEl.value) || 1;
        const price = parseFloat(prcInputs[i].value) || 0;
        newItems.push({ ...order.items[idx], qty, price });
    });

    const newTotal = newItems.reduce((s, i) => s + i.qty * i.price, 0);

    order.customerVal = customer;
    order.items       = newItems;
    order.total       = newTotal;

    saveOrders();
    document.getElementById('order-edit-modal').classList.remove('open');
    renderOrderHistory();
    alert(`Order #${orderId} updated successfully!`);
};

window.closeEditOrderModal = function() {
    document.getElementById('order-edit-modal').classList.remove('open');
};

window.clearHistory = function() {
    if (confirm('Clear order history view? Data stays in reports.')) {
        STATE.orders.forEach(o => o.archived = true); saveOrders(); renderOrderHistory();
    }
};
window.reprintOrder = function(order) { printReceipt(order); };


// ─── EXPORT ───────────────────────────────────────────────────────────
window.exportReport = function() {
    const filter = document.getElementById('report-filter').value;
    const now = new Date(); 
    let filtered = STATE.orders.filter(o => !o.archived);
    let filename = 'Report.csv';

    // Calculate week start (Sunday)
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0,0,0,0);

    if (filter === 'today') { 
        filtered = filtered.filter(o => new Date(o.date).toDateString() === now.toDateString()); 
        filename = `Sales_Today_${now.toISOString().slice(0,10)}.csv`; 
    }
    else if (filter === 'week') {
        filtered = filtered.filter(o => new Date(o.date) >= weekStart);
        filename = `Sales_ThisWeek_${now.toISOString().slice(0,10)}.csv`;
    }
    else if (filter === 'month') { 
        filtered = filtered.filter(o => { const d = new Date(o.date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }); 
        filename = `Sales_Month_${now.getMonth()+1}_${now.getFullYear()}.csv`; 
    }
    else if (filter === 'custom') {
        const fromEl = document.getElementById('report-from-date');
        const toEl   = document.getElementById('report-to-date');
        const fromDate = fromEl && fromEl.value ? new Date(fromEl.value) : null;
        let toDate     = toEl && toEl.value ? new Date(toEl.value) : null;
        
        if (toDate) toDate.setHours(23, 59, 59, 999);
        
        if (fromDate || toDate) {
            filtered = filtered.filter(o => {
                const orderDate = new Date(o.date);
                if (fromDate && orderDate < fromDate) return false;
                if (toDate && orderDate > toDate) return false;
                return true;
            });
        }
        filename = `Sales_CustomRange_${new Date().toISOString().slice(0,10)}.csv`;
    }
    else {
        filename = 'Sales_All_Time.csv';
    }

    if (filtered.length === 0) return alert('No data to export for this period.');
    
    const rows = [['Date','Order ID','Customer','Items','Amount']];
    filtered.forEach(o => rows.push([new Date(o.date).toLocaleString(), o.id, o.customerVal||'Guest', `"${o.items.map(i => i.qty+'x '+i.name).join(' | ')}"`, o.total]));
    rows.push(['','','','TOTAL', filtered.reduce((s,o)=>s+o.total,0)]);
    
    exportToCSV(rows, filename);
};
window.exportHistory = function() {
    if (STATE.orders.length === 0) return alert('No history to export.');
    const rows = [['Order ID','Date','Items','Total']];
    STATE.orders.forEach(o => rows.push([o.id, new Date(o.date).toLocaleString(), `"${o.items.map(i=>i.qty+'x '+i.name).join(' | ')}"`, o.total]));
    exportToCSV(rows, 'Order_History.csv');
};

function exportToCSV(data, filename) {
    const csv = 'data:text/csv;charset=utf-8,' + data.map(e => e.join(',')).join('\n');
    const link = document.createElement('a');
    link.setAttribute('href', encodeURI(csv));
    link.setAttribute('download', filename);
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
}

// ─── UNIFIED RESTORE LOGIC ────────────────────────────────────────────
window.restoreAllState = function(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid backup file data.');
    }

    if (data.shopSettings) {
        STATE.shopSettings = { ...STATE.shopSettings, ...data.shopSettings };
        localStorage.setItem('mf_shop_settings', JSON.stringify(STATE.shopSettings));
        applyBranding();
        if (window.electronAPI && window.electronAPI.updateSettings) {
            window.electronAPI.updateSettings(STATE.shopSettings);
        }
    }
    if (data.menu && Array.isArray(data.menu)) {
        STATE.menu = data.menu;
        saveMenu();
        if (window.electronAPI && window.electronAPI.updateMenu) {
            window.electronAPI.updateMenu(STATE.menu);
        }
    }
    if (data.orders && Array.isArray(data.orders)) {
        STATE.orders = data.orders;
        saveOrders();
    }
    if (data.inventory && Array.isArray(data.inventory)) {
        STATE.inventory = data.inventory;
        saveInventory();
    }
    if (data.purchases && Array.isArray(data.purchases)) {
        STATE.purchases = data.purchases;
        localStorage.setItem('mf_purchases', JSON.stringify(STATE.purchases));
    }
    if (data.customCategories) {
        localStorage.setItem('mf_custom_categories', JSON.stringify(data.customCategories));
    }
    if (data.categories && Array.isArray(data.categories)) {
        STATE.categories = data.categories;
        saveCategories();
    }

    // Re-render all views and counters
    renderBilling();
    renderAdminTable();
    renderInventoryTable();
    renderReports();
    renderOrderHistory();
    updateOrderId();

    if (typeof syncAllToCloud === 'function') {
        syncAllToCloud();
    }
    return true;
};

// ─── DIRECT JSON BACKUP & RESTORE ─────────────────────────────────────
window.backupData = function() {
    const licenseKey = localStorage.getItem('mf_license_key') || 'unlicensed';
    const payload = {
        version: '1.4.1',
        exportedAt: new Date().toISOString(),
        licenseKey,
        shopSettings: STATE.shopSettings,
        menu: STATE.menu,
        orders: STATE.orders,
        inventory: STATE.inventory,
        purchases: STATE.purchases || [],
        categories: STATE.categories,
        customCategories: JSON.parse(localStorage.getItem('mf_custom_categories') || '[]')
    };
    const brandSafe = (STATE.shopSettings?.brandName || 'POS').replace(/[^a-zA-Z0-9]/g, '_');
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${brandSafe}_Backup_${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    URL.revokeObjectURL(url);
};

// Called from file input onchange (e.g. Admin view)
window.restoreData = function(input) {
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            window.restoreAllState(data);
            alert('✅ Complete data restored successfully!');
        } catch (err) {
            alert('❌ Invalid backup file format! ' + err.message);
        }
    };
    reader.readAsText(file);
};

// Dedicated button in Settings view for local JSON restore
window.restoreFromLocalFile = function() {
    const fileInput = document.getElementById('local-backup-file-input');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        alert('⚠️ Barah-e-karam pehle JSON backup file select karein.');
        return;
    }
    const file = fileInput.files[0];
    if (!confirm(`⚠️ WARNING: Kya aap waqai "${file.name}" se backup restore karna chahte hain?\n\nIs se aapka mojooda data (Menu, Inventory, Sales, Purchases) is file se replace ho jaye ga!`)) {
        return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            window.restoreAllState(data);
            alert('✅ Complete data restored successfully from: ' + file.name);
            fileInput.value = '';
        } catch (err) {
            alert('❌ Invalid backup file format! ' + err.message);
        }
    };
    reader.readAsText(file);
};

// ─── CLOUD BACKUP & RESTORE ACTIONS ───────────────────────────────────
window.cloudBackupNow = async function() {
    const btn = document.getElementById('btn-cloud-backup-now');
    const statusEl = document.getElementById('cloud-backup-status-text');

    if (!navigator.onLine) {
        alert('❌ Internet connection nahi hai.');
        return;
    }
    if (!SUPABASE_CLIENT) {
        alert('❌ Supabase se connection nahi ban saka.');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Uploading...';
    }
    if (statusEl) {
        statusEl.innerHTML = '<span style="color:var(--text-muted);"><i class="fa-solid fa-cloud-arrow-up"></i> Cloud par backup bheja ja raha hai...</span>';
    }

    try {
        await uploadBackupToStorage();
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        if (statusEl) {
            statusEl.innerHTML = `<span style="color:#22c55e; font-weight:600;"><i class="fa-solid fa-circle-check"></i> Last backup: Aaj ${timeStr} par upload ho gaya!</span>`;
        }
        alert('✅ Cloud Backup kamyabi se Supabase par save ho gaya!');
        // Refresh cloud dropdown list
        await window.listCloudBackups();
    } catch(err) {
        console.error('Cloud backup failed:', err);
        if (statusEl) {
            statusEl.innerHTML = `<span style="color:#ef4444;"><i class="fa-solid fa-circle-xmark"></i> Backup fail: ${err.message}</span>`;
        }
        alert('❌ Cloud backup fail ho gaya: ' + err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> Backup to Cloud Now';
        }
    }
};

window.listCloudBackups = async function() {
    const selectEl = document.getElementById('cloud-backup-select');
    const refreshBtn = document.getElementById('btn-refresh-cloud-backups');
    const statusEl = document.getElementById('cloud-list-status');
    if (!selectEl) return;

    if (!navigator.onLine) {
        if (statusEl) statusEl.innerHTML = '<span style="color:#f59e0b;"><i class="fa-solid fa-wifi"></i> Offline — internet connection darkaar hai.</span>';
        return;
    }
    if (!SUPABASE_CLIENT) {
        if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> Supabase se connect nahi hai.</span>';
        return;
    }

    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate fa-spin"></i> Loading...';
    }
    if (statusEl) statusEl.textContent = 'Fetching cloud backups list...';

    const licenseKey = localStorage.getItem('mf_license_key') || 'unlicensed';

    try {
        const { data, error } = await SUPABASE_CLIENT.storage
            .from('backups')
            .list(licenseKey, { limit: 100, sortBy: { column: 'name', order: 'desc' } });

        if (error) throw error;

        selectEl.innerHTML = '';
        const jsonFiles = (data || []).filter(f => f.name && f.name.endsWith('.json'));

        if (jsonFiles.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '-- Koi Cloud Backup Mojood Nahi Hai --';
            selectEl.appendChild(opt);
            if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-muted);">Koi cloud backup file nahi mili. Pehle "Backup to Cloud Now" karein.</span>';
        } else {
            jsonFiles.sort((a, b) => b.name.localeCompare(a.name));
            jsonFiles.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f.name;
                const sizeKb = f.metadata?.size ? ` (~${Math.max(1, Math.round(f.metadata.size / 1024))} KB)` : '';
                opt.textContent = `📁 ${f.name}${sizeKb}`;
                selectEl.appendChild(opt);
            });
            if (statusEl) statusEl.innerHTML = `<span style="color:#22c55e;"><i class="fa-solid fa-check"></i> ${jsonFiles.length} cloud backup(s) dastiyab hain</span>`;
        }
    } catch(err) {
        console.error('List cloud backups error:', err);
        selectEl.innerHTML = '<option value="">-- List load nahi ho saki --</option>';
        if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;"><i class="fa-solid fa-triangle-exclamation"></i> ${err.message}</span>`;
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Refresh List';
        }
    }
};

window.restoreFromCloud = async function() {
    const selectEl = document.getElementById('cloud-backup-select');
    const restoreBtn = document.getElementById('btn-restore-cloud');
    const selectedFile = selectEl ? selectEl.value : null;

    if (!selectedFile) {
        alert('⚠️ Barah-e-karam list mein se pehle koi backup file select karein.');
        return;
    }

    if (!confirm(`⚠️ WARNING: Kya aap waqai Cloud Backup "${selectedFile}" restore karna chahte hain?\n\nIs se aapka current local data (Menu, Inventory, Sales, Purchases) is cloud backup se mukammal replace ho jayega!`)) {
        return;
    }

    if (!navigator.onLine || !SUPABASE_CLIENT) {
        alert('❌ Internet connection ya Supabase connection mojood nahi hai.');
        return;
    }

    const licenseKey = localStorage.getItem('mf_license_key') || 'unlicensed';
    const filePath = `${licenseKey}/${selectedFile}`;

    if (restoreBtn) {
        restoreBtn.disabled = true;
        restoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Restoring...';
    }

    try {
        const { data, error } = await SUPABASE_CLIENT.storage
            .from('backups')
            .download(filePath);

        if (error) throw error;

        const text = await data.text();
        const json = JSON.parse(text);

        window.restoreAllState(json);
        alert(`✅ Cloud Backup "${selectedFile}" kamyabi se restore ho gaya!`);
    } catch(err) {
        console.error('Restore from cloud error:', err);
        alert('❌ Cloud restore fail ho gaya: ' + err.message);
    } finally {
        if (restoreBtn) {
            restoreBtn.disabled = false;
            restoreBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Restore Selected';
        }
    }
};

// ─── SUPABASE CLOUD SYNC ──────────────────────────────────────────────
let SUPABASE_CLIENT = null;

const DEFAULT_SB_URL = 'https://eplxalfjkgvjqflugtou.supabase.co';
const DEFAULT_SB_KEY = 'sb_publishable_bNPmYZY-S6Fnj1D-diCDJw_zDwMxDF5';

function loadSupabaseSettings() {
    const url = DEFAULT_SB_URL;
    const key = DEFAULT_SB_KEY;
    if (url && key) initSupabase(url, key, false);
}

function loadSettingsView() {
    // Fill branding inputs
    if (STATE.shopSettings) {
        const brandInput = document.getElementById('setting-brand-name');
        const subInput   = document.getElementById('setting-brand-subtitle');
        const addrInput  = document.getElementById('setting-brand-address');
        const phoneInput = document.getElementById('setting-brand-contact');
        if (brandInput) brandInput.value = STATE.shopSettings.brandName || '';
        if (subInput)   subInput.value   = STATE.shopSettings.subtitle || '';
        if (addrInput)  addrInput.value  = STATE.shopSettings.address || '';
        if (phoneInput) phoneInput.value = STATE.shopSettings.contact || '';
    }

    // Supabase status
    const statusEl = document.getElementById('sync-status');
    if (statusEl) {
        statusEl.innerHTML = SUPABASE_CLIENT 
            ? '<i class="fa-solid fa-check-circle"></i> Connected' 
            : '<i class="fa-solid fa-triangle-exclamation"></i> Disconnected';
        statusEl.style.color = SUPABASE_CLIENT ? '#22c55e' : '#ef4444';
    }

    // Local drive backup folder handle status
    if (typeof loadBackupDirHandle === 'function') {
        loadBackupDirHandle().then(handle => {
            const el = document.getElementById('local-backup-folder-name');
            if (el) {
                if (handle) {
                    _localBackupDirHandle = handle;
                    el.textContent = '✅ Folder: ' + handle.name + ' (auto-saving on changes)';
                } else {
                    el.textContent = 'No folder selected — click below to set up';
                }
            }
        });
    }

    // Auto load cloud backups list
    if (typeof window.listCloudBackups === 'function') {
        window.listCloudBackups();
    }
}

function initSupabase(url, key, showAlert = true) {
    try {
        SUPABASE_CLIENT = supabase.createClient(url, key);
        if (showAlert) {
            const statusEl = document.getElementById('sync-status');
            if (statusEl) {
                statusEl.innerHTML = '<i class="fa-solid fa-check-circle"></i> Connected';
                statusEl.style.color = '#22c55e';
            }
        }
    } catch(err) {
        console.error('Supabase init error:', err);
        const statusEl = document.getElementById('sync-status');
        if (statusEl) {
            statusEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Connection failed';
            statusEl.style.color = '#ef4444';
        }
    }
}

window.saveSupabaseSettings = function() {
    const url = document.getElementById('supabase-url').value.trim();
    const key = document.getElementById('supabase-key').value.trim();
    if (!url || !key) return alert('Please enter both URL and Key.');
    localStorage.setItem('mf_sb_url', url);
    localStorage.setItem('mf_sb_key', key);
    initSupabase(url, key, true);
    alert('Settings saved! Syncing data...');
    forceSyncUp();
};

// ─── LEGACY SYNC FUNCTIONS (Now Automatic) ──────────────────────
window.forceSyncUp = function() {
    alert('Data is now synced automatically in real-time to Supabase!');
};
window.forceSyncDown = function() {
    alert('Data is fetched automatically when the app starts!');
};

// ─── LOCAL DRIVE BACKUP (File System Access API) ──────────────────────
// Works in Chrome/Edge — writes directly to D: drive or any folder user picks
// Permission is saved in IndexedDB so it persists across sessions

let _localBackupDirHandle = null;

// Save directory handle to IndexedDB
async function saveBackupDirHandle(handle) {
    return new Promise((resolve) => {
        const req = indexedDB.open('MFBackupDB', 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
        req.onsuccess = e => {
            const tx = e.target.result.transaction('handles', 'readwrite');
            tx.objectStore('handles').put(handle, 'backupDir');
            tx.oncomplete = resolve;
        };
    });
}

// Load directory handle from IndexedDB
async function loadBackupDirHandle() {
    return new Promise((resolve) => {
        const req = indexedDB.open('MFBackupDB', 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
        req.onsuccess = e => {
            const tx = e.target.result.transaction('handles', 'readonly');
            const get = tx.objectStore('handles').get('backupDir');
            get.onsuccess = () => resolve(get.result || null);
            get.onerror   = () => resolve(null);
        };
        req.onerror = () => resolve(null);
    });
}

// User picks backup folder (one time)
window.setupLocalBackupFolder = async function() {
    if (!('showDirectoryPicker' in window)) {
        alert('❌ Local backup is only supported in Chrome or Edge browser.');
        return;
    }
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        _localBackupDirHandle = handle;
        await saveBackupDirHandle(handle);
        // Update UI
        const el = document.getElementById('local-backup-folder-name');
        if (el) el.textContent = '✅ Folder: ' + handle.name + ' (auto-saving)';
        alert('✅ Local backup folder set: ' + handle.name + '\nBackup will now save automatically!');
        // Trigger first backup immediately
        await triggerLocalBackup();
    } catch(e) {
        if (e.name !== 'AbortError') alert('❌ Folder selection failed: ' + e.message);
    }
};

// Remove saved folder
window.clearLocalBackupFolder = async function() {
    _localBackupDirHandle = null;
    const req = indexedDB.open('MFBackupDB', 1);
    req.onsuccess = e => {
        const tx = e.target.result.transaction('handles', 'readwrite');
        tx.objectStore('handles').delete('backupDir');
    };
    alert('Local backup folder cleared.');
};

// Called on every sale / inventory change
async function triggerLocalBackup() {
    // Load handle from IndexedDB if not in memory
    if (!_localBackupDirHandle) {
        _localBackupDirHandle = await loadBackupDirHandle();
    }
    if (!_localBackupDirHandle) return; // No folder chosen yet — skip silently

    try {
        // Verify permission is still granted
        const perm = await _localBackupDirHandle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
            const req = await _localBackupDirHandle.requestPermission({ mode: 'readwrite' });
            if (req !== 'granted') return;
        }

        const licenseKey = localStorage.getItem('mf_license_key') || 'unlicensed';
        const today      = new Date().toISOString().slice(0, 10);

        // Create subfolder: MianFoodsBackup/{license_key}/
        const subFolder = await _localBackupDirHandle.getDirectoryHandle(licenseKey, { create: true });

        // Build full backup payload
        const payload = {
            version:         '1.4.1',
            exportedAt:      new Date().toISOString(),
            licenseKey,
            shopSettings:    STATE.shopSettings,
            menu:            STATE.menu,
            orders:          STATE.orders,
            inventory:       STATE.inventory,
            purchases:       STATE.purchases || [],
            categories:      STATE.categories,
        };

        // Write: YYYY-MM-DD_backup.json (overwrites same day file)
        const fileHandle = await subFolder.getFileHandle(`${today}_backup.json`, { create: true });
        const writable   = await fileHandle.createWritable();
        await writable.write(JSON.stringify(payload, null, 2));
        await writable.close();

        console.log(`[LocalBackup] ✅ Saved to local drive: ${licenseKey}/${today}_backup.json`);
    } catch(e) {
        console.warn('[LocalBackup] Failed:', e.message);
    }
}

// ─── BACKGROUND SYNCING (Offline-First) ───────────────────────────────
let _syncTimer = null;
function syncAllToCloud() {
    if (!SUPABASE_CLIENT || !navigator.onLine) return;
    clearTimeout(_syncTimer);
    _syncTimer = setTimeout(async () => {
        const licenseKey = localStorage.getItem('mf_license_key') || 'unlicensed';
        try {
            // Upsert all orders (Sales) — tagged with license_key
            for (const order of STATE.orders) {
                await SUPABASE_CLIENT.from('daily_sales').upsert({
                    order_id:    String(order.id),
                    license_key: licenseKey,
                    sale_date:   order.date ? order.date.slice(0, 10) : null,
                    customer:    order.customerVal || 'Guest',
                    total:       order.total,
                    items_json:  JSON.stringify(order.items),
                    created_at:  order.date
                }, { onConflict: 'order_id' });
            }
            // Upsert inventory snapshot — tagged with license_key
            const syncedAt = new Date().toISOString();
            for (const item of STATE.inventory) {
                await SUPABASE_CLIENT.from('inventory_snapshot').upsert({
                    item_name:   item.name,
                    license_key: licenseKey,
                    category:    item.category,
                    unit:        item.unit || 'Kg',
                    qty:         item.qty,
                    avg_cost:    item.avgCost,
                    synced_at:   syncedAt
                }, { onConflict: 'item_name' });
            }
            // Upsert purchases — tagged with license_key
            if (STATE.purchases && STATE.purchases.length > 0) {
                for (const p of STATE.purchases) {
                    await SUPABASE_CLIENT.from('purchase_records').upsert({
                        purchase_id:   String(p.id),
                        license_key:   licenseKey,
                        item_name:     p.name,
                        category:      p.category || '',
                        unit:          p.unit || 'Kg',
                        qty:           p.qty,
                        cost_per_unit: p.avgCost || 0,
                        total_cost:    (p.qty * (p.avgCost || 0)),
                        purchase_date: p.date ? p.date.slice(0, 10) : new Date().toISOString().slice(0, 10),
                        synced_at:     syncedAt
                    }, { onConflict: 'purchase_id' });
                }
            }
        } catch(e) { console.warn("Sync failed, will retry next time.", e); }
    }, 2000);
}

// ─── SUPABASE STORAGE BACKUP (Per License Key Folder) ─────────────────
// Saves: backups/{license_key}/YYYY-MM-DD_backup.json
async function uploadBackupToStorage() {
    if (!SUPABASE_CLIENT || !navigator.onLine) return false;
    const licenseKey = localStorage.getItem('mf_license_key') || 'unlicensed';
    const today      = new Date().toISOString().slice(0, 10);
    const fileName   = `${licenseKey}/${today}_backup.json`;
    const payload = {
        version:         '1.4.1',
        exportedAt:      new Date().toISOString(),
        licenseKey,
        shopSettings:    STATE.shopSettings,
        menu:            STATE.menu,
        orders:          STATE.orders,
        inventory:       STATE.inventory,
        purchases:       STATE.purchases || [],
        categories:      STATE.categories,
        customCategories: JSON.parse(localStorage.getItem('mf_custom_categories') || '[]')
    };
    try {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const { error } = await SUPABASE_CLIENT.storage
            .from('backups')
            .upload(fileName, blob, { upsert: true, contentType: 'application/json' });
        if (error) throw error;
        console.log(`[Backup] ✅ Cloud backup saved: backups/${fileName}`);
        return true;
    } catch(e) {
        console.warn('[Backup] Storage upload failed:', e.message);
        throw e;
    }
}

// Auto backup once per day
let _lastBackupDate = null;
function scheduleStorageBackup() {
    const today = new Date().toISOString().slice(0, 10);
    if (_lastBackupDate !== today) {
        _lastBackupDate = today;
        setTimeout(() => uploadBackupToStorage(), 8000); // 8s after app loads
    }
    setInterval(() => {
        const d = new Date().toISOString().slice(0, 10);
        if (_lastBackupDate !== d) { _lastBackupDate = d; uploadBackupToStorage(); }
    }, 60 * 60 * 1000); // Check every hour
}

// ─── PURCHASE CLOUD SYNC (Called on each new stock entry) ─────────────────
async function syncPurchaseToCloud(purchaseEntry) {
    if (!SUPABASE_CLIENT || !navigator.onLine) return;
    try {
        await SUPABASE_CLIENT.from('purchase_records').upsert({
            purchase_id:   String(purchaseEntry.id),
            item_name:     purchaseEntry.name,
            category:      purchaseEntry.category || '',
            unit:          purchaseEntry.unit || 'Kg',
            qty:           purchaseEntry.qty,
            cost_per_unit: purchaseEntry.avgCost || 0,
            total_cost:    (purchaseEntry.qty * (purchaseEntry.avgCost || 0)),
            purchase_date: purchaseEntry.date ? purchaseEntry.date.slice(0, 10) : new Date().toISOString().slice(0, 10),
            synced_at:     new Date().toISOString()
        }, { onConflict: 'purchase_id' });
        console.log('[Sync] ✅ Purchase synced to Supabase:', purchaseEntry.name);
    } catch(e) {
        console.warn('[Sync] Purchase sync failed:', e);
    }
}

async function syncAuditToCloud(entry) {
    if (!SUPABASE_CLIENT || !navigator.onLine) return;
    try {
        await SUPABASE_CLIENT.from('audit_log').insert({
            id: entry.id,
            action: entry.action,
            data_json: JSON.stringify(entry.data),
            logged_at: entry.timestamp
        });
    } catch(e) {}
}

// When internet comes back online, trigger sync automatically
window.addEventListener('online', syncAllToCloud);

// ─── CLOUD TABLET ORDERS WATCHER (Supabase Real-Time / Poller) ────────
let _cloudOrderWatcherRunning = false;

function playOrderChime() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
        osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.15); // A5
        gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.4);
    } catch (e) {}
}

function startCloudOrderWatcher() {
    if (_cloudOrderWatcherRunning) return;
    _cloudOrderWatcherRunning = true;

    async function checkCloudOrders() {
        const savedKey = localStorage.getItem('mf_license_key');
        if (!savedKey || !SUPABASE_CLIENT || !navigator.onLine) return;

        try {
            const actionTarget = 'online_tablet_order:' + savedKey;
            const { data: rows, error } = await SUPABASE_CLIENT
                .from('audit_log')
                .select('*')
                .eq('action', actionTarget)
                .order('logged_at', { ascending: true });

            if (error || !rows || rows.length === 0) return;

            for (const row of rows) {
                let orderData = null;
                try {
                    orderData = JSON.parse(row.data_json);
                } catch (e) {
                    orderData = null;
                }

                if (orderData && orderData.items && orderData.items.length > 0) {
                    const queuedOrder = {
                        queuedId: 'CLOUD-' + Date.now().toString().slice(-6),
                        receivedAt: row.logged_at || new Date().toISOString(),
                        ...orderData
                    };
                    STATE.pendingTabletOrders.push(queuedOrder);
                    saveTabletOrders();
                    updateTabletOrdersBadge();
                    if (document.getElementById('tablet-orders-modal')?.style.display === 'flex') {
                        renderTabletOrdersQueue();
                    }
                    playOrderChime();
                }

                // Delete processed row from cloud queue
                await SUPABASE_CLIENT.from('audit_log').delete().eq('id', row.id);
            }
        } catch (err) {
            console.warn('[Cloud Sync] Error checking online tablet orders:', err);
        }
    }

    setInterval(checkCloudOrders, 3000);
    checkCloudOrders();
}

// ─── TABLET ORDERS QUEUE ─────────────────────────────────────────────
function saveTabletOrders() {
    localStorage.setItem('mf_pending_tablet_orders', JSON.stringify(STATE.pendingTabletOrders));
}

function updateTabletOrdersBadge() {
    const badge = document.getElementById('tablet-orders-badge');
    if (!badge) return;
    if (STATE.pendingTabletOrders.length > 0) {
        badge.textContent = STATE.pendingTabletOrders.length;
        badge.style.display = 'block';
    } else {
        badge.style.display = 'none';
    }
}

function openTabletOrdersModal() {
    renderTabletOrdersQueue();
    document.getElementById('tablet-orders-modal').style.display = 'flex';
}

function closeTabletOrdersModal() {
    document.getElementById('tablet-orders-modal').style.display = 'none';
}

function renderTabletOrdersQueue() {
    const tbody = document.getElementById('tablet-orders-table');
    const emptyMsg = document.getElementById('empty-queue-msg');
    tbody.innerHTML = '';
    
    if (STATE.pendingTabletOrders.length === 0) {
        tbody.parentElement.style.display = 'none';
        emptyMsg.style.display = 'block';
        return;
    }
    
    tbody.parentElement.style.display = 'table';
    emptyMsg.style.display = 'none';
    
    STATE.pendingTabletOrders.forEach((order, index) => {
        const tr = document.createElement('tr');
        const timeStr = new Date(order.receivedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        tr.innerHTML = `
            <td><span class="status-badge" style="background: rgba(253,184,19,0.2); color: var(--primary);">${timeStr}</span></td>
            <td><strong>${order.customer || 'Tablet Guest'}</strong></td>
            <td style="text-align: center;">${order.items.reduce((sum, item) => sum + item.qty, 0)}</td>
            <td style="text-align: right; font-weight: bold;">Rs ${order.total}</td>
            <td style="text-align: center;">
                <button class="btn btn-primary" onclick="processTabletOrder(${index})" style="padding: 0.4rem 0.8rem; font-size: 0.85rem;">Process</button>
                <button class="btn btn-secondary" onclick="deleteTabletOrder(${index})" style="padding: 0.4rem 0.6rem; font-size: 0.85rem; margin-left: 0.3rem;"><i class="fa-solid fa-trash"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function processTabletOrder(index) {
    const order = STATE.pendingTabletOrders[index];
    if (!order) return;
    
    // Switch to billing view if not already there
    document.querySelector('[data-view="billing"]').click();
    closeTabletOrdersModal();
    
    // Clear current cart and load tablet order
    STATE.cart = [];
    order.items.forEach(item => {
        STATE.cart.push({
            id: item.id || Date.now() + Math.random(),
            name: item.name,
            variant: item.variant || '',
            price: item.price,
            qty: item.qty
        });
    });
    
    // Apply discount/tax if present in order
    const discInput = document.getElementById('discount-input');
    if (discInput) {
        discInput.value = (order.discountPct > 0) ? order.discountPct : '';
    }

    const taxInput = document.getElementById('tax-input');
    if (taxInput) {
        taxInput.value = (order.taxPct > 0) ? order.taxPct : '';
    }

    // Set customer name
    const customerInput = document.getElementById('customer-name');
    if (customerInput) {
        customerInput.value = order.customer || '';
    }

    // Remove from queue
    STATE.pendingTabletOrders.splice(index, 1);
    saveTabletOrders();
    updateTabletOrdersBadge();

    // Re-render cart and totals
    renderCart();
    updateTotals();
}

function deleteTabletOrder(index) {
    if (confirm("Are you sure you want to delete this incoming order?")) {
        STATE.pendingTabletOrders.splice(index, 1);
        saveTabletOrders();
        updateTabletOrdersBadge();
        renderTabletOrdersQueue();
    }
}

// Ensure badge is updated on load
document.addEventListener('DOMContentLoaded', () => {
    // Wait slightly to ensure STATE is loaded
    setTimeout(updateTabletOrdersBadge, 500);
});

// ─── BOOT ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
