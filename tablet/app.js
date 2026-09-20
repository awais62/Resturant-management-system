let menu = [];
let cart = [];
let activeCategory = 'all';
let searchQuery = '';
let lastMenuHash = '';

// Supabase Cloud Configuration
const SUPABASE_URL = 'https://eplxalfjkgvjqflugtou.supabase.co';
const SUPABASE_KEY = 'sb_publishable_bNPmYZY-S6Fnj1D-diCDJw_zDwMxDF5';
let SUPABASE_CLIENT = null;

function initTabletSupabase() {
    try {
        if (typeof supabase !== 'undefined' && supabase.createClient) {
            SUPABASE_CLIENT = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        }
    } catch (e) {
        console.warn('Supabase init failed:', e);
    }
}

// Category Icon Mapping
const CATEGORY_ICONS = {
    'all': 'fa-border-all',
    'pizza flavours': 'fa-pizza-slice',
    'burger junction': 'fa-burger',
    'shawarma junction': 'fa-bread-slice',
    'pasta junction': 'fa-bowl-food',
    'fries junction': 'fa-fire-flame-curved',
    'appetizer': 'fa-drumstick-bite',
    'sandwich': 'fa-bread-slice',
    'paratha roll': 'fa-utensils',
    'deals': 'fa-fire',
    'drinks': 'fa-bottle-water',
    'extra': 'fa-plus-circle'
};

function getCategoryIcon(cat) {
    if (!cat) return 'fa-utensils';
    const key = cat.toLowerCase().trim();
    return CATEGORY_ICONS[key] || 'fa-utensils';
}

// DOM Elements
const menuGrid = document.getElementById('menu-grid');
const categoryTabs = document.getElementById('category-tabs');
const cartBadge = document.getElementById('cart-badge');
const cartNavTotal = document.getElementById('cart-nav-total');
const cartItemsContainer = document.getElementById('cart-items');
const subtotalEl = document.getElementById('subtotal');
const totalEl = document.getElementById('total');
const cartPanel = document.getElementById('cart-panel');
const cartOverlay = document.getElementById('cart-overlay');
const customerInput = document.getElementById('customer-name');
const searchInput = document.getElementById('tablet-search');
const searchClearBtn = document.getElementById('search-clear-btn');
const bottomCartBar = document.getElementById('bottom-cart-bar');
const bottomCartCount = document.getElementById('bottom-cart-count');
const bottomCartPrice = document.getElementById('bottom-cart-price');

// ─── INITIALIZATION ───────────────────────────────────────────────────
async function init() {
    initTabletSupabase();
    setupEventListeners();
    updateTabletLicenseUI();
    await fetchSettings();
    await fetchMenu();
    startLiveSync(); // Live sync: polling every 3s + SSE
}

// ─── LICENSE MANAGEMENT ───────────────────────────────────────────────
function updateTabletLicenseUI() {
    const key = localStorage.getItem('tablet_license_key');
    const label = document.getElementById('tablet-license-label');
    const btn = document.getElementById('tablet-license-btn');
    if (key) {
        if (label) label.textContent = 'Linked: ' + (key.length > 10 ? key.slice(0, 10) + '...' : key);
        if (btn) btn.classList.add('connected');
    } else {
        if (label) label.textContent = 'Link POS';
        if (btn) btn.classList.remove('connected');
    }
}

window.openTabletLicenseModal = function() {
    const input = document.getElementById('tablet-license-input');
    const msg = document.getElementById('tablet-license-msg');
    const savedKey = localStorage.getItem('tablet_license_key') || 'Food-12345-MianGFoods';
    if (input) input.value = savedKey;
    if (msg) msg.textContent = '';
    const modal = document.getElementById('tablet-license-modal');
    if (modal) modal.classList.add('show');
};

window.closeTabletLicenseModal = function() {
    const modal = document.getElementById('tablet-license-modal');
    if (modal) modal.classList.remove('show');
};

window.saveTabletLicense = async function() {
    const input = document.getElementById('tablet-license-input');
    const msg = document.getElementById('tablet-license-msg');
    const btn = document.getElementById('tablet-license-save-btn');
    const key = (input ? input.value : '').trim();

    if (!key) {
        if (msg) {
            msg.style.color = '#ef4444';
            msg.textContent = '❌ Valid license key enter karein.';
        }
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let isValid = true;
    let clientName = '';

    if (SUPABASE_CLIENT) {
        try {
            const { data, error } = await SUPABASE_CLIENT
                .from('licenses')
                .select('status, expires_at, client_name')
                .ilike('license_key', key)
                .limit(1)
                .single();

            if (error || !data) {
                isValid = false;
                if (msg) {
                    msg.style.color = '#ef4444';
                    msg.textContent = '❌ License key galat hai ya exist nahi karti.';
                }
            } else if (data.status === 'disabled' || data.status === 'expired') {
                isValid = false;
                if (msg) {
                    msg.style.color = '#ef4444';
                    msg.textContent = '❌ Yeh license ' + data.status + ' ho chuki hai.';
                }
            } else {
                clientName = data.client_name;
            }
        } catch (e) {
            console.warn('License check error:', e);
        }
    }

    if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-link"></i> Connect';
    }

    if (isValid) {
        localStorage.setItem('tablet_license_key', key);
        updateTabletLicenseUI();
        if (msg) {
            msg.style.color = '#10b981';
            msg.textContent = '✅ Connected to ' + (clientName || 'POS') + '!';
        }
        setTimeout(() => {
            closeTabletLicenseModal();
        }, 700);
    }
};

// ─── LIVE SYNC (Polling + SSE) ────────────────────────────────────────
function startLiveSync() {
    // Primary: Poll every 3 seconds (always reliable)
    setInterval(() => fetchMenu(true), 3000);
    setInterval(() => fetchSettings(true), 10000);

    // SSE for instant push
    try {
        const sse = new EventSource('/api/events');

        sse.addEventListener('menu-update', (e) => {
            const newMenu = JSON.parse(e.data);
            const newHash = JSON.stringify(newMenu);
            if (newHash === lastMenuHash) return;
            lastMenuHash = newHash;
            menu = newMenu;
            renderCategories();
            renderMenu(activeCategory);
        });

        sse.addEventListener('settings-update', (e) => {
            applyTabletBranding(JSON.parse(e.data));
        });

        sse.onopen = () => console.log('[Tablet] ✅ SSE live feed connected');
        sse.onerror = () => console.warn('[Tablet] SSE fallback to polling');
    } catch(e) {
        console.log('[Tablet] SSE not available, using polling only');
    }

    // localStorage event (same browser tab sync)
    window.addEventListener('storage', (e) => {
        if (e.key === 'mf_menu' && e.newValue) {
            const newMenu = JSON.parse(e.newValue);
            const newHash = JSON.stringify(newMenu);
            if (newHash !== lastMenuHash) {
                lastMenuHash = newHash;
                menu = newMenu;
                renderCategories();
                renderMenu(activeCategory);
            }
        }
        if (e.key === 'mf_shop_settings' && e.newValue) {
            applyTabletBranding(JSON.parse(e.newValue));
        }
    });
}

async function fetchSettings(silent = false) {
    try {
        const res = await fetch('/api/settings?t=' + Date.now());
        if (!res.ok) throw new Error();
        const settings = await res.json();
        applyTabletBranding(settings);
    } catch (e) {
        if (!silent) {
            const local = localStorage.getItem('mf_shop_settings');
            if (local) applyTabletBranding(JSON.parse(local));
        }
    }
}

function applyTabletBranding(settings) {
    if (!settings) return;
    const nameEl = document.getElementById('tablet-brand-name');
    const subEl  = document.getElementById('tablet-brand-subtitle');
    const logoEl = document.getElementById('tablet-brand-logo');
    const fallbackEl = document.getElementById('tablet-fallback-icon');

    if (nameEl) nameEl.textContent = settings.brandName || 'Mian Foods';
    if (subEl)  subEl.textContent  = settings.subtitle  || 'Digital Waiter Ordering';
    if (logoEl && settings.logoUrl && settings.logoUrl !== 'logo.png') {
        logoEl.src = settings.logoUrl;
        logoEl.style.display = 'block';
        if (fallbackEl) fallbackEl.style.display = 'none';
    }
}

async function fetchMenu(silent = false) {
    let newMenu = null;
    try {
        // Try local server API first (when running on same Wi-Fi as POS)
        const res = await fetch('/api/menu?t=' + Date.now());
        if (!res.ok) throw new Error('Network error');
        newMenu = await res.json();
    } catch (e) {
        // Fallback 1: localStorage (synced from POS on same browser)
        const localMenu = localStorage.getItem('mf_menu');
        if (localMenu) {
            newMenu = JSON.parse(localMenu);
        } else {
            // Fallback 2: Static menu.json bundled with tablet app (Vercel hosting)
            try {
                const fb = await fetch('menu.json?t=' + Date.now());
                if (fb.ok) {
                    newMenu = await fb.json();
                } else {
                    throw new Error('menu.json not found');
                }
            } catch (err2) {
                // Fallback 3: Try parent menu.js (local electron server)
                try {
                    const fb2 = await fetch('../menu.js?t=' + Date.now());
                    const text = await fb2.text();
                    const match = text.match(/const INITIAL_MENU = (\[[\s\S]*?\]);/);
                    if (match) {
                        newMenu = new Function("return " + match[1])();
                    }
                } catch (err3) {
                    if (!silent) console.warn('All menu sources failed.');
                    return;
                }
            }
        }
    }

    if (!newMenu) return;

    const newHash = JSON.stringify(newMenu);
    if (newHash === lastMenuHash) return; // No change, skip re-render
    lastMenuHash = newHash;
    menu = newMenu;

    renderCategories();
    renderMenu(activeCategory);
}

// ─── RENDERING CATEGORIES ─────────────────────────────────────────────
function renderCategories() {
    const rawCategories = [...new Set(menu.map(i => i.category))];
    const categories = ['all', ...rawCategories];
    categoryTabs.innerHTML = '';
    
    categories.forEach(cat => {
        const btn = document.createElement('button');
        btn.className = `cat-btn ${cat === activeCategory ? 'active' : ''}`;
        
        const iconName = getCategoryIcon(cat);
        const displayName = cat === 'all' ? 'All Items' : cat;
        
        btn.innerHTML = `<i class="fa-solid ${iconName}"></i> <span>${displayName}</span>`;
        btn.onclick = () => {
            document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeCategory = cat;
            renderMenu(cat);
        };
        categoryTabs.appendChild(btn);
    });
}

// ─── RENDERING MENU CARDS ─────────────────────────────────────────────
function renderMenu(category) {
    menuGrid.innerHTML = '';
    let items = category === 'all' ? menu : menu.filter(i => i.category === category);
    
    // Apply search filter
    if (searchQuery) {
        items = items.filter(i => 
            i.name.toLowerCase().includes(searchQuery) ||
            (i.desc && i.desc.toLowerCase().includes(searchQuery)) ||
            (i.category && i.category.toLowerCase().includes(searchQuery))
        );
    }
    
    if (items.length === 0) {
        menuGrid.innerHTML = `
            <div class="no-items-found">
                <i class="fa-solid fa-utensils"></i>
                <h3>No Items Found</h3>
                <p>${searchQuery ? `No menu item matching "${searchQuery}"` : 'No items found in this category'}</p>
            </div>
        `;
        return;
    }

    items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'menu-card glass-effect';
        
        const catIcon = getCategoryIcon(item.category);
        const variants = item.variants || [];
        const variantsCount = variants.length;
        
        let variantsHtml = '';
        if (variantsCount === 1) {
            const v = variants[0];
            variantsHtml = `
                <div class="single-variant-wrap">
                    <button class="single-add-btn" onclick="addToCart(${item.id}, '${v.label || ''}', ${v.price})">
                        <span><i class="fa-solid fa-plus"></i> Add to Order</span>
                        <span class="price-highlight">Rs ${v.price}</span>
                    </button>
                </div>
            `;
        } else {
            const gridClass = variantsCount <= 2 ? 'variants-grid-2' : 'variants-grid-4';
            variantsHtml = `<div class="variants-container ${gridClass}">`;
            variants.forEach(v => {
                const label = v.label || 'Regular';
                variantsHtml += `
                    <button class="variant-btn" onclick="addToCart(${item.id}, '${v.label}', ${v.price})">
                        <span class="variant-label">${label}</span>
                        <span class="variant-price">Rs ${v.price}</span>
                    </button>
                `;
            });
            variantsHtml += '</div>';
        }

        card.innerHTML = `
            <div class="card-header">
                <span class="card-cat-badge"><i class="fa-solid ${catIcon}"></i> ${item.category}</span>
            </div>
            <div class="card-body">
                <div class="item-name">${item.name}</div>
                ${item.desc ? `<div class="item-desc">${item.desc}</div>` : ''}
            </div>
            <div class="card-footer">
                ${variantsHtml}
            </div>
        `;
        menuGrid.appendChild(card);
    });
}

// ─── CART LOGIC ───────────────────────────────────────────────────────
window.addToCart = function(itemId, variantLabel, price) {
    const item = menu.find(i => i.id === itemId);
    if (!item) return;

    const key = `${itemId}_${variantLabel}`;
    const existing = cart.find(i => i._key === key);
    
    if (existing) {
        existing.qty++;
    } else {
        cart.push({
            _key: key,
            id: itemId,
            name: item.name,
            variant: variantLabel,
            price: price,
            qty: 1
        });
    }
    updateCartUI();
    if (navigator.vibrate) navigator.vibrate(40);
};

function updateCartUI() {
    const totalCount = cart.reduce((sum, i) => sum + i.qty, 0);
    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);

    // Update Header Badges & Info
    if (cartBadge) cartBadge.textContent = totalCount;
    if (cartNavTotal) cartNavTotal.textContent = `Rs ${subtotal}`;

    // Update Floating Bottom Bar
    if (bottomCartBar) {
        if (totalCount > 0) {
            bottomCartBar.classList.add('visible');
            if (bottomCartCount) bottomCartCount.textContent = `${totalCount} Item${totalCount > 1 ? 's' : ''}`;
            if (bottomCartPrice) bottomCartPrice.textContent = `Rs ${subtotal}`;
        } else {
            bottomCartBar.classList.remove('visible');
        }
    }
    
    // Update Cart Panel Items
    if (!cartItemsContainer) return;

    if (cart.length === 0) {
        cartItemsContainer.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-basket-shopping"></i>
                <h3>Cart is Empty</h3>
                <p>Select delicious dishes from the menu to start order</p>
            </div>`;
    } else {
        cartItemsContainer.innerHTML = '';
        cart.forEach((item, index) => {
            const el = document.createElement('div');
            el.className = 'cart-item';
            el.innerHTML = `
                <div class="c-item-top">
                    <div>
                        <span class="c-item-title">${item.name}</span>
                        ${item.variant ? `<span class="c-item-variant">${item.variant}</span>` : ''}
                    </div>
                    <div class="c-item-price">Rs ${item.price * item.qty}</div>
                </div>
                <div class="c-item-bottom">
                    <div class="qty-controls">
                        <button class="qty-btn" onclick="updateQty(${index}, -1)"><i class="fa-solid fa-minus"></i></button>
                        <span>${item.qty}</span>
                        <button class="qty-btn" onclick="updateQty(${index}, 1)"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    <button class="delete-cart-btn" onclick="removeFromCart(${index})" title="Remove">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `;
            cartItemsContainer.appendChild(el);
        });
    }

    if (subtotalEl) subtotalEl.textContent = `Rs ${subtotal}`;
    if (totalEl) totalEl.textContent = `Rs ${subtotal}`;
}

window.updateQty = function(index, change) {
    if (!cart[index]) return;
    if (cart[index].qty + change > 0) {
        cart[index].qty += change;
    } else {
        cart.splice(index, 1);
    }
    updateCartUI();
};

window.removeFromCart = function(index) {
    cart.splice(index, 1);
    updateCartUI();
};

// ─── CHECKOUT & PUSH ──────────────────────────────────────────────────
async function pushOrder() {
    if (cart.length === 0) {
        alert("Cart is empty! Please add items first.");
        return;
    }

    const licenseKey = localStorage.getItem('tablet_license_key');
    if (!licenseKey) {
        openTabletLicenseModal();
        const msg = document.getElementById('tablet-license-msg');
        if (msg) {
            msg.style.color = '#fdb813';
            msg.textContent = '⚠️ Order push karne ke liye pehle POS License link karein.';
        }
        return;
    }

    const btn = document.getElementById('push-order-btn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Transmitting...';
    btn.disabled = true;

    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const orderData = {
        licenseKey: licenseKey,
        customer: customerInput && customerInput.value.trim() ? customerInput.value.trim() : 'Tablet Guest',
        items: cart,
        subtotal: subtotal,
        total: subtotal,
        pushedAt: new Date().toISOString()
    };

    let orderSent = false;

    // 1. Cloud Push via Supabase (Works from ANYWHERE: Vercel, Online, Mobile Data)
    if (SUPABASE_CLIENT && navigator.onLine) {
        try {
            const { error } = await SUPABASE_CLIENT.from('audit_log').insert({
                id: 'ORDER-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
                action: 'online_tablet_order:' + licenseKey,
                data_json: JSON.stringify(orderData),
                logged_at: new Date().toISOString()
            });

            if (!error) {
                orderSent = true;
                console.log('[Cloud Order] Transmitted successfully via Supabase!');
            } else {
                console.warn('[Cloud Order] Supabase push error:', error);
            }
        } catch (err) {
            console.warn('[Cloud Order] Exception on cloud push:', err);
        }
    }

    // 2. Local Fallback (if running on local Wi-Fi or offline)
    if (!orderSent) {
        try {
            const res = await fetch('/api/order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(orderData)
            });
            if (res.ok) orderSent = true;
        } catch (e) {
            try {
                const pending = JSON.parse(localStorage.getItem('mf_pending_orders') || '[]');
                orderData._timestamp = Date.now();
                pending.push(orderData);
                localStorage.setItem('mf_pending_orders', JSON.stringify(pending));
                orderSent = true;
            } catch (err) {}
        }
    }

    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Push Order to POS';
    btn.disabled = false;

    if (orderSent) {
        completePushSuccess();
    } else {
        alert("Could not transmit order. Please check your internet connection.");
    }
}

function completePushSuccess() {
    cart = [];
    if (customerInput) customerInput.value = '';
    updateCartUI();
    closeCart();
    showSuccessModal();
}

// ─── UI INTERACTIONS ──────────────────────────────────────────────────
function setupEventListeners() {
    const cartToggle = document.getElementById('cart-toggle-btn');
    if (cartToggle) cartToggle.onclick = openCart;

    const bottomViewBtn = document.getElementById('bottom-view-order-btn');
    if (bottomViewBtn) bottomViewBtn.onclick = openCart;

    const closeCartBtn = document.getElementById('close-cart-btn');
    if (closeCartBtn) closeCartBtn.onclick = closeCart;

    if (cartOverlay) cartOverlay.onclick = closeCart;

    const pushBtn = document.getElementById('push-order-btn');
    if (pushBtn) pushBtn.onclick = pushOrder;
    
    const newOrderBtn = document.getElementById('new-order-btn');
    if (newOrderBtn) {
        newOrderBtn.onclick = () => {
            document.getElementById('success-modal').classList.remove('show');
        };
    }

    // Search input listener
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.toLowerCase().trim();
            if (searchClearBtn) searchClearBtn.style.display = searchQuery ? 'block' : 'none';
            renderMenu(activeCategory);
        });
    }

    if (searchClearBtn) {
        searchClearBtn.addEventListener('click', () => {
            searchInput.value = '';
            searchQuery = '';
            searchClearBtn.style.display = 'none';
            searchInput.focus();
            renderMenu(activeCategory);
        });
    }
}

function openCart() {
    if (cartPanel) cartPanel.classList.add('open');
    if (cartOverlay) cartOverlay.classList.add('open');
}

function closeCart() {
    if (cartPanel) cartPanel.classList.remove('open');
    if (cartOverlay) cartOverlay.classList.remove('open');
}

function showSuccessModal() {
    const modal = document.getElementById('success-modal');
    if (modal) modal.classList.add('show');
}

// Boot
init();
