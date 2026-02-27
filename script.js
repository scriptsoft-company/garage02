const db = new Dexie("GarageMasterDB");
db.version(16).stores({
    inventory: '++id, partName, partNumber, category',
    sales: '++id, vehicleNo, paymentMethod, date, timestamp, isPaid, sessionId, userId, customerPhone, mileage',
    services: '++id, serviceName',
    sessions: '++id, startTime, endTime, floatCash, cashInHand, status, invoiceCounter, userId',
    dailyReports: '++id, date, data',
    customers: '++id, name, &phone, vehicleNo, points',
    users: '++id, &username, password, role',
    journal: '++id, timestamp, content',
    grns: '++id, date, timestamp, supplier, reference, total, items, userId, paidAmount, supplierId',
    expenses: '++id, date, timestamp, category, description, amount, userId',
    settings: 'key, value',
    vehicles: '++id, &vehicleNo, customerPhone, model, year',
    suppliers: '++id, &name, phone'
});

// App State
let currentView = 'pos';
let currentCategory = 'All';
let cart = [];
let inventory = [];
let services = [];
let currentSession = null;
let redeemedPoints = 0;
let salesCharts = { sales: null, inventory: null };
let currentUser = null;
let grnCart = [];
let journalFolderHandle = null;

// Initialize App
async function init() {
    // Check if DB is empty and add seed data
    const invCount = await db.inventory.count();
    if (invCount === 0) {
        await seedData();
    }

    lucide.createIcons();
    updateClock();
    setInterval(updateClock, 1000);

    await refreshData();
    renderCategories();
    renderItems();
    renderQuickServices();
    updateReports();

    // Event Listeners
    document.getElementById('item-form').onsubmit = handleItemSubmit;
    document.getElementById('service-form').onsubmit = handleServiceSubmit;
    document.getElementById('global-search').oninput = handleGlobalSearch;
    document.getElementById('inventory-search').oninput = () => renderInventoryTable();
    document.getElementById('cart-discount').oninput = updateCartUI;
    document.getElementById('cart-vehicle-no').oninput = handleVehicleInput;

    await checkSession();
    await updateNextInvoiceID();
    await loadEmailSettings();

    // Restore Journal Handle
    try {
        const saved = await db.settings.get('journalHandle');
        if (saved) {
            journalFolderHandle = saved.value;
            // Check if we still have permission
            if (await journalFolderHandle.queryPermission({ mode: 'readwrite' }) === 'granted') {
                updateJournalUI(true);
            } else {
                updateJournalUI(false);
            }
        }
    } catch (e) { console.error("Restore handle error", e); }
}

function updateJournalUI(connected) {
    const btn = document.getElementById('journal-folder-btn');
    if (!btn) return;
    if (connected) {
        btn.innerHTML = '<i data-lucide="check-circle" class="w-4 h-4"></i> DATA FOLDER CONNECTED';
        btn.className = "bg-green-500/10 text-green-400 border border-green-500/20 px-6 py-3 rounded-xl text-sm font-bold transition-all flex items-center gap-2";
    } else {
        btn.innerHTML = '<i data-lucide="folder-key" class="w-4 h-4"></i> CONNECT BACKUP FOLDER';
        btn.className = "bg-primary/10 text-primary border border-primary/20 hover:bg-primary hover:text-dark px-6 py-3 rounded-xl text-sm font-bold transition-all flex items-center gap-2";
    }
    lucide.createIcons();
}

async function seedUsers() {
    const count = await db.users.count();
    if (count === 0) {
        await db.users.add({
            username: 'admin',
            password: localStorage.getItem('sys_pass') || '1234',
            role: 'admin'
        });
    }
}

// Session Management
async function checkSession() {
    if (!currentUser) return;

    // Find open session FOR THE LOGGED IN USER
    const active = await db.sessions
        .where('userId').equals(currentUser.id)
        .and(s => s.status === 'open')
        .first();

    const isAdmin = currentUser?.role === 'admin';

    if (active) {
        currentSession = active;
        if (!currentSession.startTime) currentSession.startTime = Date.now();
        if (isNaN(currentSession.floatCash)) currentSession.floatCash = 0;
        if (!currentSession.invoiceCounter) currentSession.invoiceCounter = 0;
        document.getElementById('day-status-indicator').innerHTML = `<span class="flex items-center gap-2 text-green-400 text-[10px] font-bold uppercase"><span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span> Day Active (Session #${currentSession.id})</span>`;
    } else {
        currentSession = null;
        showModal('day-start-modal');
        document.getElementById('admin-force-day-end').classList.toggle('hidden', !isAdmin);
        document.getElementById('day-status-indicator').innerHTML = `<span class="flex items-center gap-2 text-red-500 text-[10px] font-bold uppercase"><span class="w-1.5 h-1.5 rounded-full bg-red-500"></span> Day Closed</span>`;
    }
}

// Seed Data for First Run
async function seedData() {
    await db.inventory.bulkAdd([
        { partName: "Pioneer Stereo System", partNumber: "AUD-001", price: 45000, buyingPrice: 38000, stock: 5, category: "Car Audio Video" },
        { partName: "12V LED Bulb Set", partNumber: "ELC-052", price: 3500, buyingPrice: 2500, stock: 12, category: "Auto Electrical" },
        { partName: "Metallic Red Paint (1L)", partNumber: "PNT-110", price: 8500, buyingPrice: 6500, stock: 10, category: "Auto Painting" },
        { partName: "AC Gas R134a (Can)", partNumber: "ACC-009", price: 2850, buyingPrice: 1800, stock: 20, category: "Auto AC" },
        { partName: "Android Player 9-inch", partNumber: "AUD-044", price: 28000, buyingPrice: 22000, stock: 8, category: "Car Audio Video" },
        { partName: "Reverse Camera Pro", partNumber: "AUD-022", price: 4500, buyingPrice: 3000, stock: 15, category: "Car Audio Video" }
    ]);

    await db.services.bulkAdd([
        { serviceName: "Full Engine Service", cost: 5000 },
        { serviceName: "Brake Cleaning & Adjust", cost: 2500 },
        { serviceName: "A/C Gas Refilling", cost: 4500 },
        { serviceName: "Body Wash & Interior", cost: 1500 },
        { serviceName: "Wheel Alignment", cost: 3000 }
    ]);
}

// Navigation
function switchView(view) {
    // Role-based Access Check
    if ((view === 'inventory' || view === 'admin' || view === 'grn') && currentUser?.role !== 'admin') {
        showToast("Access Denied: Admin only", "error");
        return;
    }

    // Update UI buttons
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.remove('active', 'bg-primary', 'text-dark');
        btn.classList.add('text-slate-400');
    });
    document.getElementById(`nav-${view}`).classList.add('active', 'bg-primary', 'text-dark');
    document.getElementById(`nav-${view}`).classList.remove('text-slate-400');

    // Show/Hide Containers
    document.querySelectorAll('#view-container > section').forEach(sec => sec.classList.add('hidden'));
    document.getElementById(`view-${view}`).classList.remove('hidden');

    currentView = view;
    if (view === 'inventory') renderInventoryTable();
    if (view === 'reports') updateReports();
    if (view === 'history') renderHistory();
    if (view === 'customers') renderCustomerView();
    if (view === 'expenses') renderExpenses();
    if (view === 'reminders') renderReminders();
    if (view === 'vehicles') renderVehicleList();
    if (view === 'suppliers') renderSuppliers();
    if (view === 'analytics') renderAnalytics();
    if (view === 'grn') {
        renderGrnTable();
        document.getElementById('grn-item-search').value = '';
        document.getElementById('grn-item-selected-id').value = '';
        document.getElementById('grn-search-results').classList.add('hidden');
    }
}

function renderHistory() {
    const container = document.getElementById('history-results');
    container.innerHTML = `
        <div class="py-20 text-center text-slate-500">
            <i data-lucide="search" class="w-16 h-16 mx-auto mb-4 opacity-10"></i>
            <p>Search for a vehicle number to see its complete service record</p>
        </div>`;
    lucide.createIcons();
}

// Data Handling
async function refreshData() {
    inventory = await db.inventory.toArray();
    services = await db.services.toArray();
}

function renderCategories() {
    const categories = ['All', 'Car Audio Video', 'Auto Electrical', 'Auto Painting', 'Auto AC'];
    const container = document.getElementById('category-list');
    container.innerHTML = categories.map(cat => `
        <button onclick="filterCategory('${cat}')" 
            class="w-full text-left px-3 py-1.5 rounded-lg text-xs transition-all ${currentCategory === cat ? 'bg-primary/20 text-primary font-bold' : 'text-slate-400 hover:bg-slate-800'}">
            ${cat}
        </button>
    `).join('');
}

function filterCategory(cat) {
    currentCategory = cat;
    document.getElementById('current-category-name').innerText = cat === 'All' ? 'All Items' : cat;
    renderCategories();
    renderItems();
}

function renderItems() {
    const container = document.getElementById('items-grid');
    const filtered = currentCategory === 'All'
        ? inventory
        : inventory.filter(i => i.category === currentCategory);

    if (filtered.length === 0) {
        container.innerHTML = `<div class="col-span-full py-20 text-center text-slate-500">No items found in this category</div>`;
        return;
    }

    container.innerHTML = filtered.map(item => `
        <div class="glass p-2 rounded-lg border border-slate-700/50 card-hover flex flex-col justify-between h-auto gap-0.5 min-h-[80px]">
            <div>
                <div class="flex justify-between items-start mb-0.5">
                    <span class="text-[7px] font-bold uppercase tracking-wider text-slate-500 truncate">${item.category}</span>
                    <span class="text-[7px] font-mono text-slate-400">#${item.partNumber}</span>
                </div>
                <h4 class="font-bold text-slate-100 leading-tight mb-0.5 line-clamp-2 text-[10px] h-6 overflow-hidden">${item.partName}</h4>
                <p class="text-sm font-black text-primary mb-1">Rs ${item.price.toLocaleString()}</p>
            </div>
            <div class="flex items-center justify-between mt-1">
                <span class="text-[8px] ${item.stock <= 5 ? 'text-red-400 font-bold' : 'text-slate-400'}">
                    ${item.stock} in stock
                </span>
                <button onclick="addToCart('item', ${item.id})" 
                    class="bg-slate-700 hover:bg-primary hover:text-dark p-1 rounded-md transition-all h-6 w-6 flex items-center justify-center"
                    ${item.stock <= 0 ? 'disabled' : ''}>
                    <i data-lucide="plus" class="w-3 h-3"></i>
                </button>
            </div>
        </div>
    `).join('');
    lucide.createIcons();
}

function renderQuickServices() {
    const container = document.getElementById('service-list-quick');
    container.innerHTML = services.map(s => `
        <button onclick="addToCart('service', ${s.id})" 
            class="w-full text-left px-3 py-1.5 rounded-lg text-[10px] text-blue-400 hover:bg-blue-500/10 border border-transparent hover:border-blue-500/30 transition-all flex justify-between items-center group">
            <span>${s.serviceName}</span>
            <i data-lucide="plus" class="w-3 h-3 opacity-0 group-hover:opacity-100"></i>
        </button>
    `).join('');
    lucide.createIcons();
}

// Cart Logic
function addToCart(type, id) {
    if (type === 'item') {
        const product = inventory.find(i => i.id === id);
        if (!product || product.stock <= 0) return;

        const existing = cart.find(c => c.type === 'item' && c.id === id);
        if (existing) {
            if (existing.qty < product.stock) existing.qty++;
            else showToast("Maximum stock reached", "error");
        } else {
            cart.push({ ...product, type: 'item', qty: 1 });
        }
    } else {
        const service = services.find(s => s.id === id);
        cart.push({ id: Date.now(), serviceId: id, partName: service.serviceName, price: service.cost, type: 'service', qty: 1 });
    }
    updateCartUI();
}

function showCustomServiceModal() {
    document.getElementById('custom-service-name').value = '';
    document.getElementById('custom-service-amount').value = '';
    showModal('custom-service-modal');
    setTimeout(() => {
        document.getElementById('custom-service-name').focus();
    }, 100);
}

function addCustomServiceToCart() {
    const name = document.getElementById('custom-service-name').value.trim() || 'Service Charge';
    const amount = parseFloat(document.getElementById('custom-service-amount').value) || 0;

    if (amount <= 0) {
        return showToast("Please enter a valid amount", "error");
    }

    const item = {
        id: Date.now(),
        partName: name,
        price: amount,
        type: 'service',
        qty: 1
    };

    cart.push(item);
    updateCartUI();
    hideModal('custom-service-modal');
    showToast("Service added to bill", "success");
}

function removeFromCart(index) {
    cart.splice(index, 1);
    updateCartUI();
}

async function updateNextInvoiceID() {
    let nextId = 1;
    if (currentSession) {
        nextId = (currentSession.invoiceCounter || 0) + 1;
    }
    const el = document.getElementById('next-invoice-id');
    if (el) el.innerText = `#${nextId.toString().padStart(6, '0')}`;
}

function updateCartUI() {
    const container = document.getElementById('cart-items');
    if (cart.length === 0) {
        container.innerHTML = `
            <div class="h-full flex flex-col items-center justify-center text-slate-600">
                <i data-lucide="shopping-basket" class="w-12 h-12 mb-2 opacity-20"></i>
                <p class="text-sm">Cart is empty</p>
            </div>`;
        document.getElementById('cart-subtotal').innerText = 'Rs 0.00';
        document.getElementById('cart-total').innerText = 'Rs 0.00';
        lucide.createIcons();
        return;
    }

    container.innerHTML = cart.map((item, idx) => `
        <div class="bg-slate-800/50 p-1.5 rounded-lg flex items-center gap-2 animate-fade-in border border-slate-700/30">
            <div class="w-6 h-6 rounded bg-slate-700 flex items-center justify-center text-[9px] font-bold text-slate-400">
                ${item.type === 'item' ? 'PT' : (item.type === 'credit_payment' ? 'CR' : 'SV')}
            </div>
            <div class="flex-1 min-w-0">
                <p class="text-[10px] font-bold leading-tight truncate">${item.partName}</p>
                <p class="text-[9px] text-slate-500">Rs ${item.price.toLocaleString()} x ${item.qty}</p>
            </div>
            <div class="text-right">
                <p class="text-[10px] font-bold">Rs ${(item.price * item.qty).toLocaleString()}</p>
                <button onclick="removeFromCart(${idx})" class="text-red-400 hover:text-red-300">
                    <i data-lucide="trash-2" class="w-3 h-3"></i>
                </button>
            </div>
        </div>
    `).join('');

    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const discount = parseFloat(document.getElementById('cart-discount').value) || 0;
    const total = Math.max(0, subtotal - discount);

    document.getElementById('cart-subtotal').innerText = `Rs ${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('cart-total').innerText = `Rs ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    calculateBalance();
    lucide.createIcons();
}

function calculateBalance() {
    const totalStr = document.getElementById('cart-total').innerText.replace('Rs ', '').replace(/,/g, '');
    const total = parseFloat(totalStr) || 0;
    const received = parseFloat(document.getElementById('cart-cash-received').value) || 0;
    const balance = received - total;

    const balanceEl = document.getElementById('cart-balance');
    if (balance >= 0) {
        balanceEl.innerText = `Rs ${balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        balanceEl.className = "text-sm font-black text-green-400";
    } else {
        balanceEl.innerText = `Rs ${Math.abs(balance).toLocaleString(undefined, { minimumFractionDigits: 2 })} (Short)`;
        balanceEl.className = "text-sm font-black text-red-400";
    }
}

function clearCart() {
    cart = [];
    document.getElementById('cart-vehicle-no').value = '';
    document.getElementById('cart-customer-name').value = '';
    document.getElementById('cart-customer-phone').value = '';
    document.getElementById('cart-mileage').value = '';
    document.getElementById('cart-discount').value = 0;
    document.getElementById('cart-cash-received').value = '';
    document.getElementById('cart-balance').innerText = '0.00';
    updateCartUI();
}

async function connectJournalFolder() {
    try {
        if (journalFolderHandle) {
            const status = await journalFolderHandle.requestPermission({ mode: 'readwrite' });
            if (status === 'granted') {
                updateJournalUI(true);
                return showToast("Folder permission granted!", "success");
            }
        }

        journalFolderHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await db.settings.put({ key: 'journalHandle', value: journalFolderHandle });
        updateJournalUI(true);
        showToast("System folder connected. Auto-backups active!", "success");
    } catch (err) {
        console.warn("Folder connection cancelled or failed", err);
    }
}

async function appendToDailyJournal(text) {
    // 1. Internal DB Log
    await db.journal.add({ timestamp: Date.now(), content: text });

    // 2. Persistent Silent Save
    if (journalFolderHandle) {
        try {
            // Re-verify permission if needed (browsers require user gesture for re-grant)
            if (await journalFolderHandle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
                // We can't auto-request, but we can notify
                console.warn("Journal folder permission required. Click button to re-authorize.");
                return false;
            }

            const today = new Date().toLocaleDateString().replace(/\//g, '-');
            const fileName = `Journal_${today}.txt`;
            const fileHandle = await journalFolderHandle.getFileHandle(fileName, { create: true });

            // To append, we need to read existing or just write at end
            const writable = await fileHandle.createWritable({ keepExistingData: true });
            const file = await fileHandle.getFile();
            await writable.seek(file.size); // Go to end
            await writable.write(text + "\n\n");
            await writable.close();
            return true;
        } catch (err) {
            console.error("Journal auto-save failed", err);
        }
    }
    return false;
}

async function saveJournalToDisk(sale) {
    const journalText = `[${new Date().toLocaleTimeString()}] INVOICE #${sale.invoiceNo.toString().padStart(6, '0')} - VEHICLE: ${sale.vehicleNo} - TOTAL: Rs ${sale.total.toLocaleString()} (${sale.paymentMethod.toUpperCase()})`;

    // Add full details for the daily log
    const fullEntry = `
-----------------------------------------
TIME       : ${new Date().toLocaleTimeString()}
CASHIER    : ${currentUser?.username || 'System'}
INVOICE ID : #${sale.invoiceNo.toString().padStart(6, '0')}
VEHICLE NO : ${sale.vehicleNo}
CUSTOMER   : ${sale.customerName || 'Walking'}
ITEMS:
${sale.items.map(i => `- ${i.partName.padEnd(25)} x${i.qty}  Rs.${(i.price * i.qty).toLocaleString()}`).join('\n')}
SUBTOTAL   : Rs ${sale.subtotal.toLocaleString()}
DISCOUNT   : Rs ${sale.discount.toLocaleString()}
GRAND TOTAL: Rs ${sale.total.toLocaleString()}
METHOD     : ${sale.paymentMethod.toUpperCase()}
-----------------------------------------`;

    const success = await appendToDailyJournal(fullEntry);

    // Update UI Log
    const logEl = document.getElementById('journal-live-log');
    if (logEl) {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const entry = document.createElement('p');
        entry.className = success ? "text-green-400 border-b border-white/5 pb-1 mb-1 animate-fade-in" : "text-yellow-400 border-b border-white/5 pb-1 mb-1 animate-fade-in";
        entry.innerHTML = `<span class="opacity-50 text-[8px]">${timeStr}</span> <span class="font-bold">INV #${sale.invoiceNo.toString().padStart(6, '0')}</span> ${success ? 'SAVED TO JOURNAL' : 'LOGGED TO DB'}`;
        logEl.prepend(entry);
    }
}

// Checkout Logic
async function checkout(method) {
    if (cart.length === 0) return showToast("Cart is empty!", "error");
    const vNo = document.getElementById('cart-vehicle-no').value.trim();
    const cName = document.getElementById('cart-customer-name').value.trim() || 'Walking Customer';
    const cPhone = document.getElementById('cart-customer-phone').value.trim() || '-';
    const mileage = parseFloat(document.getElementById('cart-mileage').value) || 0;

    if (!vNo) return showToast("Please enter Vehicle Number", "error");

    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const totalBuyingPrice = cart.reduce((sum, item) => {
        if (item.type === 'item') return sum + ((Number(item.buyingPrice) || Number(item.price) || 0) * item.qty);
        return sum;
    }, 0);

    const discount = parseFloat(document.getElementById('cart-discount').value) || 0;
    const total = subtotal - discount;
    const cashReceived = parseFloat(document.getElementById('cart-cash-received').value) || 0;
    const balance = method === 'cash' ? (cashReceived - total) : total;
    const profit = total - totalBuyingPrice;
    const date = new Date();

    // Shift-based invoice numbering
    const shiftInvNo = (currentSession?.invoiceCounter || 0) + 1;
    if (currentSession) {
        await db.sessions.update(currentSession.id, { invoiceCounter: shiftInvNo });
        currentSession.invoiceCounter = shiftInvNo;
    }

    const sale = {
        invoiceNo: shiftInvNo,
        vehicleNo: vNo.toUpperCase(),
        customerName: cName,
        customerPhone: cPhone,
        mileage: mileage, // Added mileage
        items: JSON.parse(JSON.stringify(cart)),
        subtotal,
        discount,
        total,
        cashReceived,
        balance,
        profit: isNaN(profit) ? 0 : profit,
        paymentMethod: method,
        date: date.toLocaleDateString(),
        timestamp: date.getTime(),
        isPaid: method === 'cash',
        sessionId: currentSession ? currentSession.id : null,
        userId: currentUser ? currentUser.id : null
    };

    try {
        // Save to DB
        const saleId = await db.sales.add(sale);

        // Update Stock and handle old credit payments
        for (const item of cart) {
            if (item.type === 'item') {
                const p = await db.inventory.get(item.id);
                await db.inventory.update(item.id, { stock: p.stock - item.qty });
            }
            if (item.type === 'credit_payment' && item.originalSales) {
                for (const saleId of item.originalSales) {
                    await db.sales.update(saleId, { isPaid: true });
                }
            }
        }

        // Save or update customer
        const earnedPoints = Math.floor(sale.total / 100);
        const existingCustomer = await db.customers.where('phone').equals(cPhone).first();

        if (existingCustomer) {
            const newPoints = (existingCustomer.points || 0) - redeemedPoints + earnedPoints;
            await db.customers.update(existingCustomer.id, {
                name: cName,
                vehicleNo: vNo.toUpperCase(),
                points: Math.max(0, newPoints)
            });
        } else {
            await db.customers.add({
                name: cName,
                phone: cPhone,
                vehicleNo: vNo.toUpperCase(),
                points: earnedPoints
            });
        }

        preparePrint(sale);
        showCheckoutSuccess(sale.invoiceNo, sale);
        saveJournalToDisk(sale);

        // Reset UI
        redeemedPoints = 0;
        const loyaltyPanel = document.getElementById('loyalty-panel');
        if (loyaltyPanel) loyaltyPanel.classList.add('hidden');
        document.getElementById('redeem-value').innerText = '';

        clearCart();
        await refreshData();
        renderItems();
        updateReports();
        await updateNextInvoiceID();

        // Trigger Print after a small delay
        setTimeout(() => {
            window.print();
        }, 500);

    } catch (err) {
        console.error(err);
        showToast("Error processing sale", "error");
    }
}

// Inventory Management
function renderInventoryTable() {
    const search = document.getElementById('inventory-search').value.toLowerCase();
    const container = document.getElementById('inventory-table-body');

    const filtered = inventory.filter(i =>
        i.partName.toLowerCase().includes(search) ||
        i.partNumber.toLowerCase().includes(search)
    );

    container.innerHTML = filtered.map(item => `
        <tr class="hover:bg-slate-700/30 transition-colors">
            <td class="px-4 py-2.5 font-bold text-xs text-slate-200">${item.partName}</td>
            <td class="px-4 py-2.5 font-mono text-[10px] text-slate-500">${item.partNumber}</td>
            <td class="px-4 py-2.5 text-right">
                <span class="${item.stock <= 5 ? 'text-red-400 font-bold' : 'text-slate-300'} text-xs">
                    ${item.stock}
                </span>
            </td>
            <td class="px-4 py-2.5 text-right font-black text-primary text-xs">${item.price.toLocaleString()}</td>
            <td class="px-4 py-2.5 text-center">
                <div class="flex justify-center gap-1.5">
                    <button onclick="editItem(${item.id})" class="p-1 hover:bg-blue-500/20 text-blue-400 rounded transition-colors"><i data-lucide="edit-3" class="w-3.5 h-3.5"></i></button>
                    <button onclick="deleteItem(${item.id})" class="p-1 hover:bg-red-500/20 text-red-400 rounded transition-colors"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                </div>
            </td>
        </tr>
    `).join('');

    // Services Table
    const sContainer = document.getElementById('services-table-body');
    sContainer.innerHTML = services.map(s => `
        <tr class="hover:bg-slate-700/30">
            <td class="px-6 py-3 font-semibold">${s.serviceName}</td>
            <td class="px-6 py-3 text-right font-bold text-blue-400">${s.cost.toLocaleString()}</td>
            <td class="px-6 py-3 text-center">
                <button onclick="deleteService(${s.id})" class="text-red-400 hover:text-red-300"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
            </td>
        </tr>
    `).join('');
    lucide.createIcons();
}

async function handleItemSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('item-id').value;
    const data = {
        partName: document.getElementById('input-part-name').value,
        partNumber: document.getElementById('input-part-no').value,
        category: document.getElementById('input-category').value,
        stock: parseInt(document.getElementById('input-stock').value),
        buyingPrice: parseFloat(document.getElementById('input-buying-price').value),
        price: parseFloat(document.getElementById('input-price').value)
    };

    if (id) await db.inventory.update(parseInt(id), data);
    else await db.inventory.add(data);

    hideModal('item-modal');
    e.target.reset();
    document.getElementById('item-id').value = '';
    await refreshData();
    renderInventoryTable();
    renderItems();
    showToast("Inventory updated!", "success");
}

async function handleServiceSubmit(e) {
    e.preventDefault();
    const data = {
        serviceName: document.getElementById('input-service-name').value,
        cost: parseFloat(document.getElementById('input-service-cost').value)
    };

    await db.services.add(data);
    hideModal('service-modal');
    e.target.reset();
    await refreshData();
    renderInventoryTable();
    renderQuickServices();
    showToast("Service added!", "success");
}

async function deleteItem(id) {
    if (confirm("Delete this part from inventory?")) {
        await db.inventory.delete(id);
        await refreshData();
        renderInventoryTable();
        renderItems();
    }
}

async function deleteService(id) {
    if (confirm("Delete this service charge?")) {
        await db.services.delete(id);
        await refreshData();
        renderInventoryTable();
        renderQuickServices();
    }
}

async function editItem(id) {
    const item = await db.inventory.get(id);
    document.getElementById('item-id').value = item.id;
    document.getElementById('input-part-name').value = item.partName;
    document.getElementById('input-part-no').value = item.partNumber;
    document.getElementById('input-category').value = item.category;
    document.getElementById('input-stock').value = item.stock;
    document.getElementById('input-buying-price').value = item.buyingPrice;
    document.getElementById('input-price').value = item.price;
    showModal('item-modal');
}

// Expense Management
async function renderExpenses() {
    const search = document.getElementById('expense-search').value.toLowerCase();
    const allExpenses = await db.expenses.toArray();

    // Sort by timestamp desc
    const sorted = allExpenses.sort((a, b) => b.timestamp - a.timestamp);

    const filtered = sorted.filter(e =>
        e.description.toLowerCase().includes(search) ||
        e.category.toLowerCase().includes(search)
    );

    const today = new Date().toLocaleDateString();
    const thisMonth = new Date().getMonth();
    const thisYear = new Date().getFullYear();

    const todayTotal = allExpenses
        .filter(e => e.date === today)
        .reduce((sum, e) => sum + e.amount, 0);

    const monthTotal = allExpenses
        .filter(e => {
            const d = new Date(e.timestamp);
            return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
        })
        .reduce((sum, e) => sum + e.amount, 0);

    document.getElementById('expense-total-today').innerText = `Rs ${todayTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('expense-total-month').innerText = `Rs ${monthTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    const container = document.getElementById('expense-list-body');
    if (!container) return;

    if (filtered.length === 0) {
        container.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-slate-500 italic">No expenses recorded</td></tr>`;
        return;
    }

    container.innerHTML = filtered.map(e => `
        <tr class="hover:bg-amber-500/5 transition-colors group">
            <td class="px-6 py-4 text-xs text-slate-400">${e.date}</td>
            <td class="px-6 py-4">
                <span class="px-2 py-0.5 rounded-full bg-slate-700 text-[10px] font-bold text-amber-400 border border-amber-500/20 uppercase tracking-wider">${e.category}</span>
            </td>
            <td class="px-6 py-4 font-medium text-slate-200">${e.description}</td>
            <td class="px-6 py-4 text-right font-black text-amber-500">Rs ${e.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            <td class="px-6 py-4 text-center">
                <button onclick="deleteExpense(${e.id})" class="text-slate-500 hover:text-red-500 transition-colors">
                    <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
            </td>
        </tr>
    `).join('');

    lucide.createIcons();
    updateReports(); // Refresh profit calculations
}

async function handleExpenseSubmit(e) {
    e.preventDefault();

    const category = document.getElementById('expense-category').value;
    const description = document.getElementById('expense-description').value;
    const amount = parseFloat(document.getElementById('expense-amount').value);
    const dateInput = document.getElementById('expense-date').value;

    // Convert input date string to local date string format used in DB
    const dateObj = new Date(dateInput);
    const dateStr = dateObj.toLocaleDateString();

    const expense = {
        date: dateStr,
        timestamp: dateObj.getTime(),
        category,
        description,
        amount,
        userId: currentUser?.id || null
    };

    try {
        await db.expenses.add(expense);
        hideModal('expense-modal');
        document.getElementById('expense-form').reset();
        showToast("Expense recorded successfully!", "success");
        renderExpenses();
    } catch (err) {
        console.error(err);
        showToast("Error saving expense", "error");
    }
}

async function deleteExpense(id) {
    if (confirm("Are you sure you want to delete this expense record?")) {
        await db.expenses.delete(id);
        showToast("Expense deleted", "info");
        renderExpenses();
    }
}

// Reports & History
async function updateReports() {
    const allSales = await db.sales.toArray();
    const today = new Date().toLocaleDateString();

    // Filter summary by current user if they are staff (so they only see their own sales)
    const isAdmin = currentUser?.role === 'admin';
    const reportSales = isAdmin ? allSales : allSales.filter(s => s.userId === currentUser.id);

    const todaySales = reportSales.filter(s => s.date === today);
    const todayTotal = todaySales.reduce((sum, s) => sum + (s.total || 0), 0);
    const todayGrossProfit = todaySales.reduce((sum, s) => sum + (s.profit || 0), 0);

    // Calculate Today's Expenses
    const allExpenses = await db.expenses.toArray();
    const todayExpenses = allExpenses.filter(e => e.date === today).reduce((sum, e) => sum + e.amount, 0);
    const todayNetProfit = todayGrossProfit - todayExpenses;

    // Credit sales - filter by user for staff
    const creditSales = reportSales.filter(s => s.paymentMethod === 'credit' && (s.isPaid === false || s.isPaid === undefined));
    const creditTotal = creditSales.reduce((sum, s) => sum + (s.total || 0), 0);

    document.getElementById('report-today-sales').innerText = `Rs ${todayTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('report-today-profit').innerText = `Rs ${todayNetProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('report-today-profit').title = `Gross: Rs ${todayGrossProfit.toLocaleString()} | Expenses: Rs ${todayExpenses.toLocaleString()}`;

    // Monthly Sales
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthSales = allSales.filter(s => s.timestamp >= monthStart.getTime());
    const monthTotal = monthSales.reduce((sum, s) => sum + (s.total || 0), 0);
    document.getElementById('report-month-sales').innerText = `Rs ${monthTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    document.getElementById('report-credit').innerText = `Rs ${creditTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    // Render Recent Sales Table
    const container = document.getElementById('reports-table-body');
    if (!container) return; // Guard against missing element

    const recent = reportSales.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 10);

    container.innerHTML = recent.map(sale => {
        const total = (sale.total || 0).toLocaleString();
        const vNo = (sale.vehicleNo || 'N/A').toUpperCase();
        const cName = sale.customerName || 'N/A';
        const isPaid = sale.isPaid === true || sale.paymentMethod === 'cash';

        return `
        <tr class="hover:bg-slate-700/30">
            <td class="px-6 py-3 text-xs opacity-60">${sale.date || '-'}</td>
            <td class="px-6 py-3">
                <div class="font-bold text-primary uppercase">${vNo}</div>
                <div class="text-[10px] text-slate-400">${cName}</div>
            </td>
            <td class="px-6 py-3 uppercase text-[10px]">
                <span class="px-2 py-0.5 rounded ${sale.paymentMethod === 'cash' ? 'bg-green-500/20 text-green-400' : 'bg-indigo-500/20 text-indigo-400'}">
                    ${sale.paymentMethod || 'N/A'}
                </span>
                ${isPaid ? '<span class="ml-1 text-[8px] text-green-500 font-bold">PAID</span>' : '<span class="ml-1 text-[8px] text-red-500 font-bold">UNPAID</span>'}
            </td>
            <td class="px-6 py-3 text-right font-black">Rs ${total}</td>
            <td class="px-6 py-3 text-center">
                <div class="flex justify-center gap-2">
                    <button onclick="reprint(${sale.id})" class="text-slate-400 hover:text-white"><i data-lucide="printer" class="w-4 h-4"></i></button>
                    ${!isPaid ? `<button onclick="markAsPaid(${sale.id})" class="text-green-400 hover:text-green-300"><i data-lucide="check-square" class="w-4 h-4"></i></button>` : ''}
                </div>
            </td>
        </tr>
    `;
    }).join('');

    // Render Debtors table
    const creditContainer = document.getElementById('credit-table-body');
    if (creditContainer) {
        creditContainer.innerHTML = creditSales.map(s => `
            <tr class="hover:bg-red-500/5">
                <td class="px-6 py-3 font-semibold">${s.customerName || 'N/A'}</td>
                <td class="px-6 py-3 font-mono text-primary">${(s.vehicleNo || 'N/A').toUpperCase()}</td>
                <td class="px-6 py-3 font-mono text-xs">${s.customerPhone || 'N/A'}</td>
                <td class="px-6 py-3 text-right font-bold text-red-400">Rs ${(s.total || 0).toLocaleString()}</td>
                <td class="px-6 py-3 text-center">
                    <button onclick="markAsPaid(${s.id})" class="bg-green-500 hover:bg-green-600 text-dark font-bold px-3 py-1 rounded text-xs">Mark Paid</button>
                </td>
            </tr>
        `).join('');
    }

    renderCharts(allSales);
    lucide.createIcons();
}

let activeCustomerTab = 'credit';

function tabCustomer(tab) {
    activeCustomerTab = tab;
    const creditBtn = document.getElementById('tab-cust-credit');
    const loyaltyBtn = document.getElementById('tab-cust-loyalty');

    if (tab === 'credit') {
        creditBtn.className = "px-4 py-2 rounded-lg text-xs font-bold transition-all bg-red-600 text-white shadow-lg";
        loyaltyBtn.className = "px-4 py-2 rounded-lg text-xs font-bold transition-all text-slate-400";
    } else {
        loyaltyBtn.className = "px-4 py-2 rounded-lg text-xs font-bold transition-all bg-amber-500 text-white shadow-lg";
        creditBtn.className = "px-4 py-2 rounded-lg text-xs font-bold transition-all text-slate-400";
    }

    renderCustomerView();
}

async function renderCustomerView() {
    const search = document.getElementById('customer-search').value.toLowerCase();
    const container = document.getElementById('customer-list-body');
    const header = document.getElementById('customer-table-header');
    if (!container || !header) return;

    // Load initial stats
    const allSales = await db.sales.toArray();
    const allCustomers = await db.customers.toArray();

    const unpaidSales = allSales.filter(s => s.paymentMethod === 'credit' && (s.isPaid === false || s.isPaid === undefined));
    const totalOutstanding = unpaidSales.reduce((sum, s) => sum + (s.total || 0), 0);
    const totalPoints = allCustomers.reduce((sum, c) => sum + (c.points || 0), 0);

    document.getElementById('customer-total-credit').innerText = `Rs ${totalOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('stat-total-loyalty-pts').innerText = Math.floor(totalPoints).toLocaleString();
    document.getElementById('customer-count').innerText = allCustomers.length;

    if (activeCustomerTab === 'credit') {
        header.innerHTML = `
            <th class="px-6 py-4">Customer Details</th>
            <th class="px-6 py-4">Vehicle #</th>
            <th class="px-6 py-4 text-right">Balance (Rs)</th>
            <th class="px-6 py-4 text-center">Actions</th>
        `;

        const filtered = unpaidSales.filter(s => {
            const match = (s.customerName || '').toLowerCase().includes(search) ||
                (s.vehicleNo || '').toLowerCase().includes(search) ||
                (s.customerPhone || '').toLowerCase().includes(search);
            return match;
        });

        if (filtered.length === 0) {
            container.innerHTML = `<tr><td colspan="4" class="px-6 py-10 text-center text-slate-500 italic">No pending credit found</td></tr>`;
        } else {
            container.innerHTML = filtered.map(s => `
                <tr class="hover:bg-red-500/5 transition-colors group">
                    <td class="px-6 py-4">
                        <div class="font-bold text-slate-100">${s.customerName || 'N/A'}</div>
                        <div class="text-xs text-slate-500 flex items-center gap-1">
                            <i data-lucide="phone" class="w-3 h-3"></i> ${s.customerPhone || 'N/A'}
                        </div>
                    </td>
                    <td class="px-6 py-4">
                        <span class="px-3 py-1 bg-slate-800 text-slate-300 border border-slate-700 rounded-lg font-mono font-bold">
                            ${(s.vehicleNo || 'N/A').toUpperCase()}
                        </span>
                        <div class="text-[10px] text-slate-500 mt-1 uppercase">${s.date || '-'}</div>
                    </td>
                    <td class="px-6 py-4 text-right font-black text-red-500">Rs ${(s.total || 0).toLocaleString()}</td>
                    <td class="px-6 py-4 text-center">
                        <div class="flex justify-center gap-2">
                            <button onclick="reprint(${s.id})" class="p-2 bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-all"><i data-lucide="printer" class="w-4 h-4"></i></button>
                            <button onclick="markAsPaid(${s.id})" class="px-4 py-2 bg-green-500 hover:bg-green-600 text-dark font-bold rounded-lg text-xs transition-all">Mark Paid</button>
                        </div>
                    </td>
                </tr>
            `).join('');
        }
    } else {
        header.innerHTML = `
            <th class="px-6 py-4">Customer Name</th>
            <th class="px-6 py-4">Phone Number</th>
            <th class="px-6 py-4">Prime Vehicle</th>
            <th class="px-6 py-4 text-right">Points Balance</th>
        `;

        const filtered = allCustomers.filter(c => {
            const match = (c.name || '').toLowerCase().includes(search) ||
                (c.phone || '').toLowerCase().includes(search) ||
                (c.vehicleNo || '').toLowerCase().includes(search);
            return match;
        }).sort((a, b) => (b.points || 0) - (a.points || 0));

        if (filtered.length === 0) {
            container.innerHTML = `<tr><td colspan="4" class="px-6 py-10 text-center text-slate-500 italic">No customers found</td></tr>`;
        } else {
            container.innerHTML = filtered.map(c => `
                <tr class="hover:bg-amber-500/5 transition-colors group">
                    <td class="px-6 py-4 font-bold text-slate-100">${c.name || 'N/A'}</td>
                    <td class="px-6 py-4 text-slate-400">${c.phone || 'N/A'}</td>
                    <td class="px-6 py-4 italic text-xs text-slate-500">${(c.vehicleNo || 'N/A').toUpperCase()}</td>
                    <td class="px-6 py-4 text-right">
                        <div class="flex items-center justify-end gap-2 text-amber-500 font-black text-lg">
                            <i data-lucide="star" class="w-4 h-4 fill-amber-500"></i>
                            ${Math.floor(c.points || 0).toLocaleString()}
                        </div>
                    </td>
                </tr>
            `).join('');
        }
    }
    lucide.createIcons();
}

async function handleCustomerSubmit(e) {
    e.preventDefault();
    const name = document.getElementById('cust-name').value;
    const phone = document.getElementById('cust-phone').value.trim();
    const vNo = document.getElementById('cust-vno').value.trim().toUpperCase();
    const points = parseInt(document.getElementById('cust-initial-points').value) || 0;

    const customer = {
        name,
        phone,
        vehicleNo: vNo,
        points: points
    };

    try {
        const existing = await db.customers.where('phone').equals(phone).first();
        if (existing) {
            await db.customers.update(existing.id, customer);
            showToast("Customer updated!", "success");
        } else {
            await db.customers.add(customer);
            showToast("Customer registered!", "success");
        }

        hideModal('customer-modal');
        e.target.reset();
        renderCustomerView();
    } catch (err) {
        console.error(err);
        showToast("Error saving customer", "error");
    }
}

async function markAsPaid(id) {
    await db.sales.update(id, { isPaid: true });
    updateReports();
    if (currentView === 'customers') renderCustomerView();
    showToast("Payment marked as PAID", "success");
}

function renderCharts(allSales) {
    if (typeof Chart === 'undefined') return console.warn("Chart.js not loaded yet");
    if (salesCharts.sales) salesCharts.sales.destroy();
    if (salesCharts.inventory) salesCharts.inventory.destroy();

    // Sales Trend (Last 7 Days)
    const last7Days = [...Array(7)].map((_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - i);
        return d.toLocaleDateString();
    }).reverse();

    const salesData = last7Days.map(date => {
        return allSales.filter(s => s.date === date).reduce((sum, s) => sum + s.total, 0);
    });

    const ctx1 = document.getElementById('salesChart').getContext('2d');
    const chartConfig = {
        type: 'line',
        data: {
            labels: last7Days,
            datasets: [{
                label: 'Daily Revenue',
                data: salesData,
                borderColor: '#f59e0b',
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
                x: { grid: { display: false }, ticks: { color: '#94a3b8' } }
            }
        }
    };
    salesCharts.sales = new Chart(ctx1, chartConfig);

    // Inventory Distribution
    const categories = ['Engine', 'Body', 'Electrical', 'Service', 'Tires'];
    const invData = categories.map(cat => {
        return inventory.filter(i => i.category === cat).length;
    });

    const ctx2 = document.getElementById('inventoryChart').getContext('2d');
    salesCharts.inventory = new Chart(ctx2, {
        type: 'doughnut',
        data: {
            labels: categories,
            datasets: [{
                data: invData,
                backgroundColor: ['#f59e0b', '#3b82f6', '#ef4444', '#10b981', '#6366f1'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'right', labels: { color: '#f8fafc' } } }
        }
    });
}

async function searchVehicleHistory() {
    const query = document.getElementById('history-vehicle-search').value.trim().toUpperCase();
    if (!query) return;

    const history = await db.sales.where('vehicleNo').equals(query).toArray();
    const container = document.getElementById('history-results');

    if (history.length === 0) {
        container.innerHTML = `<div class="py-10 text-center text-slate-500">No records found for ${query}</div>`;
        return;
    }

    container.innerHTML = history.reverse().map(sale => {
        const subtotal = sale.subtotal || sale.items.reduce((sum, i) => sum + (i.price * i.qty), 0);
        const discount = sale.discount || 0;

        return `
        <div class="glass border border-slate-700 rounded-2xl overflow-hidden shadow-lg animate-fade-in mb-6">
            <div class="p-4 bg-slate-800/50 border-b border-slate-700 flex justify-between items-center">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                        <i data-lucide="file-text" class="w-5 h-5"></i>
                    </div>
                    <div>
                        <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest">${sale.date}</p>
                        <h3 class="font-bold text-slate-100 italic">Bill #${sale.id.toString().padStart(6, '0')}</h3>
                    </div>
                </div>
                <div class="flex gap-2">
                    <button onclick="viewBill(${sale.id})" 
                        class="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-lg text-xs font-bold transition-all border border-blue-400">
                        <i data-lucide="eye" class="w-4 h-4"></i>
                        VIEW
                    </button>
                    <button onclick="reprint(${sale.id})" 
                        class="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-3 py-2 rounded-lg text-xs font-bold transition-all border border-slate-600">
                        <i data-lucide="printer" class="w-4 h-4 text-primary"></i>
                        PRINT
                    </button>
                </div>
            </div>
            
            <div class="p-6">
                <div class="flex justify-between mb-4 border-b border-slate-700/50 pb-2">
                    <span class="text-xs text-slate-500 uppercase font-bold">Services & Parts</span>
                    <span class="text-xs text-slate-500 uppercase font-bold text-right">Amount</span>
                </div>
                <div class="space-y-4 mb-6">
                    ${sale.items.map(item => `
                        <div class="flex justify-between items-center group">
                            <div class="flex flex-col">
                                <span class="text-sm font-semibold text-slate-200">${item.partName}</span>
                                <span class="text-[10px] text-slate-500">${item.qty} ${item.type === 'service' ? 'Service' : 'Unit'} x Rs ${item.price.toLocaleString()}</span>
                            </div>
                            <span class="text-sm font-bold text-slate-300">Rs ${(item.price * item.qty).toLocaleString()}</span>
                        </div>
                    `).join('')}
                </div>

                <div class="border-t border-slate-700/50 pt-4 space-y-1 ml-auto max-w-[280px]">
                    <div class="flex justify-between text-xs text-slate-400">
                        <span>Subtotal</span>
                        <span>Rs ${subtotal.toLocaleString()}</span>
                    </div>
                    ${discount > 0 ? `
                    <div class="flex justify-between text-xs text-red-400">
                        <span>Discount</span>
                        <span>- Rs ${discount.toLocaleString()}</span>
                    </div>` : ''}
                    <div class="flex justify-between items-center pt-2 text-primary border-t border-slate-700/30 mt-2">
                        <span class="text-base font-black uppercase tracking-tight">Net Amount</span>
                        <span class="text-2xl font-black">Rs ${sale.total.toLocaleString()}</span>
                    </div>
                </div>
            </div>
            <div class="px-6 py-2 bg-slate-900/30 border-t border-slate-700/20 text-[9px] text-slate-500 uppercase tracking-[0.2em] font-bold text-center">
                Payment Type: ${sale.paymentMethod} | Vehicle: ${sale.vehicleNo}
            </div>
        </div>
        `;
    }).join('');

    lucide.createIcons();
}

async function viewBill(id) {
    const sale = await db.sales.get(id);
    if (!sale) return showToast("Bill not found", "error");

    preparePrint(sale, id);
    const content = document.getElementById('print-area').innerHTML;
    document.getElementById('receipt-modal-content').innerHTML = content;

    // Bind Download Button
    const dlBtn = document.getElementById('preview-download-btn');
    if (dlBtn) dlBtn.onclick = () => downloadBillPDF(id);

    showModal('receipt-modal');
}


// Print & Modal Helpers
function preparePrint(sale) {
    const id = sale.invoiceNo || 0;
    const dateObj = new Date(sale.timestamp || Date.now());

    const printDate = document.getElementById('print-date');
    const printTime = document.getElementById('print-time');
    const printInvoiceId = document.getElementById('print-invoice-id');
    const printPaymentMethod = document.getElementById('print-payment-method');
    const printVehicleNo = document.getElementById('print-vehicle-no');
    const printCustomerName = document.getElementById('print-customer-name');
    const printSubtotal = document.getElementById('print-subtotal');
    const printDiscount = document.getElementById('print-discount');
    const printTotal = document.getElementById('print-total');
    const cashSection = document.getElementById('print-cash-section');
    const printCashReceived = document.getElementById('print-cash-received');
    const printBalance = document.getElementById('print-balance');
    const itemsContainer = document.getElementById('print-items');

    if (printDate) printDate.innerText = dateObj.toLocaleDateString();
    if (printTime) printTime.innerText = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (printInvoiceId) printInvoiceId.innerText = `${id.toString().padStart(6, '0')}`;
    if (printPaymentMethod) printPaymentMethod.innerText = sale.paymentMethod;
    if (printVehicleNo) printVehicleNo.innerText = sale.vehicleNo;
    if (printCustomerName) printCustomerName.innerText = sale.customerName || 'Walking Customer';

    if (printSubtotal) printSubtotal.innerText = sale.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 });
    if (printDiscount) printDiscount.innerText = sale.discount.toLocaleString(undefined, { minimumFractionDigits: 2 });
    if (printTotal) printTotal.innerText = sale.total.toLocaleString(undefined, { minimumFractionDigits: 2 });

    if (cashSection) {
        if (sale.paymentMethod === 'cash') {
            cashSection.style.display = 'block';
            if (printCashReceived) printCashReceived.innerText = (sale.cashReceived || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
            if (printBalance) printBalance.innerText = (sale.balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
        } else {
            cashSection.style.display = 'none';
        }
    }

    if (itemsContainer) {
        itemsContainer.innerHTML = sale.items.map(i => `
        <tr>
            <td style="padding: 1mm 0;">${i.partName}</td>
            <td style="text-align: center; padding: 1mm 0;">${i.qty}</td>
            <td style="text-align: right; padding: 1mm 0;">${(i.price * i.qty).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        </tr>
    `).join('');
    }
}

async function reprint(id) {
    const sale = await db.sales.get(id);
    preparePrint(sale, id);
    window.print();
}

function showModal(id) {
    document.getElementById(id).classList.remove('hidden');
}

function hideModal(id) {
    document.getElementById(id).classList.add('hidden');
}

function showToast(msg, type = 'success') {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-msg');
    toastMsg.innerText = msg;
    toast.style.backgroundColor = type === 'success' ? '#f59e0b' : '#ef4444';
    toast.classList.remove('translate-y-20', 'opacity-0');
    setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
    }, 3000);
}

function updateClock() {
    const now = new Date();
    document.getElementById('clock').innerText = now.toLocaleString();
}

function handleGlobalSearch() {
    const query = document.getElementById('global-search').value.toLowerCase();
    if (currentView === 'pos') {
        const filtered = inventory.filter(i => i.partName.toLowerCase().includes(query) || i.partNumber.toLowerCase().includes(query));
        const container = document.getElementById('items-grid');
        container.innerHTML = filtered.map(item => `
        <div class="glass p-2 rounded-lg border border-slate-700/50 card-hover flex flex-col justify-between h-auto gap-0.5 min-h-[80px]">
            <div>
                <div class="flex justify-between items-start mb-0.5">
                    <span class="text-[7px] font-bold uppercase tracking-wider text-slate-500 truncate">${item.category}</span>
                    <span class="text-[7px] font-mono text-slate-400">#${item.partNumber}</span>
                </div>
                <h4 class="font-bold text-slate-100 leading-tight mb-0.5 line-clamp-2 text-[10px] h-6 overflow-hidden">${item.partName}</h4>
                <p class="text-sm font-black text-primary mb-1">Rs ${item.price.toLocaleString()}</p>
            </div>
            <div class="flex items-center justify-between mt-1">
                <span class="text-[8px] ${item.stock <= 5 ? 'text-red-400 font-bold' : 'text-slate-400'}">
                    ${item.stock} in stock
                </span>
                <button onclick="addToCart('item', ${item.id})" 
                    class="bg-slate-700 hover:bg-primary hover:text-dark p-1 rounded-md transition-all h-6 w-6 flex items-center justify-center"
                    ${item.stock <= 0 ? 'disabled' : ''}>
                    <i data-lucide="plus" class="w-3 h-3"></i>
                </button>
            </div>
        </div>
        `).join('');
        lucide.createIcons();
    } else if (currentView === 'history') {
        document.getElementById('history-vehicle-search').value = query;
        searchVehicleHistory();
    } else if (currentView === 'customers') {
        document.getElementById('customer-search').value = query;
        renderCustomerView();
    }
}

function clearCart() {
    cart = [];
    document.getElementById('cart-vehicle-no').value = '';
    document.getElementById('cart-customer-name').value = '';
    document.getElementById('cart-customer-phone').value = '';
    document.getElementById('cart-mileage').value = ''; // Added mileage reset
    document.getElementById('cart-discount').value = 0;
    document.getElementById('cart-cash-received').value = '';
    document.getElementById('cart-balance').innerText = 'Rs 0.00'; // Corrected format
    document.getElementById('pos-credit-alert').classList.add('hidden');
    updateCartUI();
}

// Database Management (Export/Import)
async function exportDatabase(isAuto = false) {
    try {
        const inventory = await db.inventory.toArray();
        const sales = await db.sales.toArray();
        const services = await db.services.toArray();
        const grns = await db.grns.toArray();

        const data = {
            inventory, sales, services, grns,
            exportDate: new Date().toISOString(),
            version: "1.1"
        };

        const jsonString = JSON.stringify(data, null, 2);
        const today = new Date().toLocaleDateString().replace(/\//g, '-');
        const fileName = `GarageMaster_Backup_${today}.json`;

        // Direct Save to 'data' folder
        if (journalFolderHandle) {
            try {
                // Request/Verify Permission
                let permission = await journalFolderHandle.queryPermission({ mode: 'readwrite' });
                if (permission !== 'granted' && !isAuto) {
                    permission = await journalFolderHandle.requestPermission({ mode: 'readwrite' });
                }

                if (permission === 'granted') {
                    // 1. Get or Create 'data' folder
                    const dataFolder = await journalFolderHandle.getDirectoryHandle('data', { create: true });
                    // 2. Save File
                    const fileHandle = await dataFolder.getFileHandle(fileName, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(jsonString);
                    await writable.close();

                    if (!isAuto) showToast(`Backup saved to data/${fileName}`, "success");
                    return true;
                }
            } catch (err) {
                console.warn("Folder backup failed", err);
            }
        }

        // Fallback for Manual Export
        if (!isAuto) {
            if (confirm("No backup folder connected. Download file instead?")) {
                const blob = new Blob([jsonString], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                showToast("Backup downloaded successfully!", "success");
            }
        }
    } catch (err) {
        console.error(err);
        if (!isAuto) showToast("Error exporting database", "error");
    }
    return false;
}

async function importDatabase(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = JSON.parse(e.target.result);

            if (confirm("This will overwrite existing data. Are you sure?")) {
                await db.inventory.clear();
                await db.sales.clear();
                await db.services.clear();

                if (data.inventory) await db.inventory.bulkAdd(data.inventory);
                if (data.sales) await db.sales.bulkAdd(data.sales);
                if (data.services) await db.services.bulkAdd(data.services);

                await refreshData();
                renderItems();
                renderInventoryTable();
                updateReports();
                showToast("Database restored successfully!", "success");
            }
        } catch (err) {
            console.error(err);
            showToast("Invalid backup file", "error");
        }
    };
    reader.readAsText(file);
}

async function factoryReset() {
    if (!confirm("⚠️ DANGER ZONE ⚠️\n\nThis will wipe ALL data from the system.\nA backup will be downloaded automatically before deletion.\n\nType 'DELETE' to confirm:")) return;

    const confirmation = prompt("Please type 'DELETE' to confirm factory reset:");
    if (confirmation !== 'DELETE') return showToast("Reset cancelled", "info");

    showToast(" Creating backup...", "info");
    await exportDatabase(); // Auto-backup first

    try {
        await db.transaction('rw', db.inventory, db.sales, db.services, db.customers, db.sessions, db.dailyReports, async () => {
            await db.inventory.clear();
            await db.sales.clear();
            await db.services.clear();
            await db.customers.clear();
            await db.sessions.clear();
            await db.dailyReports.clear();
        });

        localStorage.clear(); // Clear any local storage configs if any
        showToast("System Reset Complete! Reloading...", "success");
        setTimeout(() => location.reload(), 2000);
    } catch (err) {
        console.error(err);
        showToast("Reset failed!", "error");
    }
}

// POS Vehicle Credit Check
async function handleVehicleInput() {
    const vNo = document.getElementById('cart-vehicle-no').value.trim().toUpperCase();
    const alertBox = document.getElementById('pos-credit-alert');
    if (vNo.length < 2) {
        alertBox.classList.add('hidden');
        return;
    }

    const allSales = await db.sales.where('vehicleNo').equals(vNo).toArray();
    const unpaid = allSales.filter(s => s.paymentMethod === 'credit' && (s.isPaid === false || s.isPaid === undefined));
    const totalCredit = unpaid.reduce((sum, s) => sum + (s.total || 0), 0);

    if (totalCredit > 0) {
        if (document.getElementById('pos-credit-amount')) {
            document.getElementById('pos-credit-amount').innerText = `Rs ${totalCredit.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        }
        alertBox.classList.remove('hidden');
        alertBox.classList.add('flex');

        // Auto-fill customer info if available and fields are empty
        const lastSale = allSales[allSales.length - 1];
        if (lastSale) {
            const nameField = document.getElementById('cart-customer-name');
            const phoneField = document.getElementById('cart-customer-phone');
            if (!nameField.value) nameField.value = lastSale.customerName || '';
            if (!phoneField.value) phoneField.value = lastSale.customerPhone || '';
        }
    } else {
        alertBox.classList.add('hidden');

        // Still try to auto-fill if it's a known vehicle but no credit
        if (allSales.length > 0) {
            const lastSale = allSales[allSales.length - 1];
            const nameField = document.getElementById('cart-customer-name');
            const phoneField = document.getElementById('cart-customer-phone');
            if (!nameField.value) nameField.value = lastSale.customerName || '';
            if (!phoneField.value) phoneField.value = lastSale.customerPhone || '';
        }
    }

    // Loyalty Points Logic
    const phone = document.getElementById('cart-customer-phone').value.trim();
    const loyaltyPanel = document.getElementById('loyalty-panel');
    const pointsDisplay = document.getElementById('customer-points-display');
    const redeemBtn = document.getElementById('btn-redeem');

    if (phone && phone !== '-') {
        const customer = await db.customers.where('phone').equals(phone).first();
        const points = customer ? (customer.points || 0) : 0;

        if (points > 0) {
            loyaltyPanel.classList.remove('hidden');
            pointsDisplay.innerText = Math.floor(points);
            redeemBtn.disabled = false;
        } else {
            loyaltyPanel.classList.add('hidden');
        }
    } else {
        loyaltyPanel.classList.add('hidden');
    }
}

// Loyalty Redemption
async function redeemPoints() {
    const points = parseInt(document.getElementById('customer-points-display').innerText) || 0;
    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const existingDiscount = parseFloat(document.getElementById('cart-discount').value) || 0;
    const currentTotal = subtotal - existingDiscount;

    if (points <= 0) return showToast("No points to redeem!", "error");
    if (currentTotal <= 0) return showToast("Bill total is already zero!", "error");

    // 1 Point = 1 Rs
    const maxRedeemable = Math.min(points, currentTotal);

    if (confirm(`Redeem ${maxRedeemable} points for Rs ${maxRedeemable.toLocaleString()} discount?`)) {
        redeemedPoints = maxRedeemable;

        // Add to existing discount
        document.getElementById('cart-discount').value = (existingDiscount + maxRedeemable).toFixed(2);

        document.getElementById('redeem-value').innerText = `- Rs ${maxRedeemable} points used`;
        document.getElementById('btn-redeem').disabled = true;

        updateCartUI();
        showToast(`Redeemed ${maxRedeemable} points`, "success");
    }
}
async function payOutstandingCredit() {
    const vNo = document.getElementById('cart-vehicle-no').value.trim().toUpperCase();
    if (!vNo) return;

    const allSales = await db.sales.where('vehicleNo').equals(vNo).toArray();
    const unpaid = allSales.filter(s => s.paymentMethod === 'credit' && (s.isPaid === false || s.isPaid === undefined));
    const totalCredit = unpaid.reduce((sum, s) => sum + (s.total || 0), 0);

    if (totalCredit === 0) return;

    const creditItem = {
        id: 'CREDIT-' + Date.now(),
        partName: `OLD CREDIT (${vNo})`,
        price: totalCredit,
        qty: 1,
        type: 'credit_payment',
        buyingPrice: totalCredit,
        originalSales: unpaid.map(s => s.id)
    };

    if (cart.find(c => c.type === 'credit_payment')) {
        showToast("Credit already added to cart", "error");
        return;
    }

    cart.push(creditItem);
    updateCartUI();
    showToast("Old credit added to current bill", "success");
    document.getElementById('pos-credit-alert').classList.add('hidden');
}

// Business Day Management
async function startNewDay() {
    const float = parseFloat(document.getElementById('opening-float').value) || 0;
    const session = {
        startTime: Date.now(),
        floatCash: float,
        status: 'open',
        invoiceCounter: 0,
        userId: currentUser.id
    };
    const id = await db.sessions.add(session);
    currentSession = { id, ...session };
    hideModal('day-start-modal');
    await checkSession();
    await updateNextInvoiceID();

    // Log Day Start to Journal
    appendToDailyJournal(`
=========================================
   DAY STARTED [${new Date().toLocaleDateString()}]
=========================================
TIME      : ${new Date().toLocaleTimeString()}
CASHIER   : ${currentUser?.username || 'System'}
FLOAT     : Rs ${float.toLocaleString()}
=========================================`);

    showToast("Business day started!", "success");
}

async function generateDayEndReport(isForce = false) {
    const today = new Date().toLocaleDateString();
    const isAdmin = currentUser?.role === 'admin';

    // 1. Get relevant sessions: ALWAYS process only the current user's session
    let sessionsToProcess = [];
    if (currentSession) {
        sessionsToProcess = [currentSession];
    } else {
        return showToast("No active session", "error");
    }

    if (sessionsToProcess.length === 0 && !isForce) return showToast("No session found", "info");

    // 2. Aggregate Data
    let totalCashSales = 0;
    let totalFloat = 0;
    let totalSalesList = [];

    // Calculate Today's Expenses
    const allExpArr = await db.expenses.toArray();
    const todayExpenses = allExpArr
        .filter(e => e.date === today)
        .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

    // Reset list
    const shiftsList = document.getElementById('de-shifts-list');
    shiftsList.innerHTML = '';

    for (const session of sessionsToProcess) {
        const sessionSales = await db.sales.where('sessionId').equals(session.id).toArray();
        const cashSales = sessionSales.filter(s => s.paymentMethod === 'cash').reduce((sum, s) => sum + (Number(s.total) || 0), 0);

        totalCashSales += cashSales;
        totalFloat += (Number(session.floatCash) || 0);
        totalSalesList.push(...sessionSales);

        if (isAdmin) {
            const row = document.createElement('div');
            row.className = "flex justify-between items-center p-3 bg-slate-900/50 border border-slate-700 rounded-xl";
            row.innerHTML = `
                <div>
                    <p class="text-xs font-bold text-primary">SHIFT #${session.id}</p>
                    <p class="text-[10px] text-slate-400">${new Date(session.startTime).toLocaleTimeString()}</p>
                </div>
                <div class="text-right">
                    <p class="text-sm font-black">Rs ${cashSales.toLocaleString()}</p>
                    <p class="text-[10px] ${session.status === 'open' ? 'text-green-400' : 'text-slate-500'} font-bold uppercase">${session.status}</p>
                </div>
            `;
            shiftsList.appendChild(row);
        }
    }

    const expected = totalFloat + totalCashSales - todayExpenses;

    // 3. UI Toggles - Standardized for Single User
    document.getElementById('de-shifts-container').classList.add('hidden'); // Hide shifts list as it's now single user
    document.getElementById('de-metrics-grid').style.display = 'grid'; // Always show metrics
    document.getElementById('de-expected-row').style.display = 'flex';
    document.getElementById('de-header-title').innerText = 'End Day Summary';
    document.getElementById('de-confirm-btn').innerText = 'CONFIRM END DAY';

    // Populate data
    document.getElementById('de-float').innerText = `Rs ${totalFloat.toLocaleString()}`;
    document.getElementById('de-cash').innerText = `Rs ${totalCashSales.toLocaleString()}`;
    document.getElementById('de-expected').innerText = `Rs ${expected.toLocaleString()}`;

    // Store data temporarily for processing
    window.pendingDayEnd = {
        sessions: sessionsToProcess,
        sales: totalSalesList,
        float: totalFloat,
        cashSales: totalCashSales,
        expenses: todayExpenses,
        expected: expected
    };

    // Update UI for expenses if elements exist (adding them to HTML in next step)
    const expEl = document.getElementById('de-expenses');
    if (expEl) expEl.innerText = `Rs ${todayExpenses.toLocaleString()}`;

    showModal('day-end-modal');
}

async function overrideSessionError() {
    if (!currentSession) return;

    // Auto-fix ID 1 reset issue or corruption
    const fixedFloat = prompt("Manual Override: Enter opening float amount:", currentSession.floatCash || 0);
    if (fixedFloat !== null) {
        const newFloat = parseFloat(fixedFloat) || 0;
        await db.sessions.update(currentSession.id, { floatCash: newFloat });
        currentSession.floatCash = newFloat;
        generateDayEndReport(); // Refresh view
        showToast("Session Float Updated Manually", "success");
    }
}

async function processDayEnd() {
    const data = window.pendingDayEnd;
    if (!data) return showToast("Session data lost. Please try again.", "error");

    const cashHand = parseFloat(document.getElementById('actual-cash-hand').value) || 0;
    const isAdmin = currentUser?.role === 'admin';

    // 1. Close Sessions
    // 1. Close Sessions with Transaction for Reliability
    await db.transaction('rw', db.sessions, async () => {
        for (const session of data.sessions) {
            if (session.status === 'open') {
                // Determine cash to record
                let finalCash = 0;
                if (currentSession && session.id === currentSession.id) {
                    finalCash = cashHand;
                } else {
                    finalCash = session.cashInHand || 0;
                }

                await db.sessions.update(session.id, {
                    endTime: Date.now(),
                    cashInHand: finalCash,
                    status: 'closed'
                });
            }
        }
    });

    // 2. Metrics for the Final Report (Aggregated)
    const metrics = {
        totalSales: data.sales.reduce((sum, s) => sum + (Number(s.total) || 0), 0),
        cashSales: data.cashSales,
        creditSales: data.sales.filter(s => s.paymentMethod === 'credit').reduce((sum, s) => sum + (Number(s.total) || 0), 0),
        grossProfit: data.sales.reduce((sum, s) => sum + (Number(s.profit) || 0), 0),
        expenses: data.expenses || 0,
        float: data.float,
        cashInHand: cashHand,
        variance: cashHand - data.expected
    };
    metrics.netProfit = metrics.grossProfit - metrics.expenses;

    // Save report for this specific end day (individual)
    // We treat this as a session close report
    prepareDayEndPrint(metrics, data.sales);

    // Log Day End to Journal
    appendToDailyJournal(`
=========================================
   DAY END SUMMARY [${new Date().toLocaleDateString()}]
=========================================
TIME         : ${new Date().toLocaleTimeString()}
CASHIER      : ${currentUser?.username || 'System'}
TOTAL SALES  : Rs ${metrics.totalSales.toLocaleString()}
CASH SALES   : Rs ${metrics.cashSales.toLocaleString()}
CREDIT SALES : Rs ${metrics.creditSales.toLocaleString()}
EXPENSES     : Rs ${metrics.expenses.toLocaleString()}
GROSS PROFIT : Rs ${metrics.grossProfit.toLocaleString()}
NET PROFIT   : Rs ${metrics.netProfit.toLocaleString()}
FLOAT        : Rs ${metrics.float.toLocaleString()}
CASH IN HAND : Rs ${metrics.cashInHand.toLocaleString()}
VARIANCE     : Rs ${metrics.variance.toLocaleString()}
=========================================`);

    await exportDatabase(true);

    // Auto Email Notification
    const emailRes = await db.settings.get('emailSettings');
    if (emailRes && emailRes.value.autoEmail) {
        showToast("Sending email report...", "info");
        await sendDayEndEmail(metrics);
    }

    showToast("Day Ended & Backup Created", "success");

    // Cleanup
    currentSession = null;
    window.pendingDayEnd = null;
    hideModal('day-end-modal');
    hideModal('day-start-modal');
    await checkSession();
    updateReports();
    document.getElementById('actual-cash-hand').value = '';

    // Auto-logout to Admin Login
    setTimeout(() => {
        logout();
    }, 1500);
}

function prepareDayEndPrint(m, sales) {
    const today = new Date().toLocaleDateString();
    const time = new Date().toLocaleTimeString();
    const printArea = document.getElementById('print-area');

    printArea.innerHTML = `
        <div style="text-align: center; border-bottom: 2mm double black; padding-bottom: 2mm; margin-bottom: 3mm;">
            <h1 style="margin: 0; font-size: 16pt; font-weight: 900;">GARAGE MASTER</h1>
            <p style="margin: 1mm 0; font-size: 10pt; font-weight: bold; background: #000; color: #fff; display: inline-block; padding: 0.5mm 3mm;">DAY END REPORT</p>
            <p style="margin: 1mm 0 0 0; font-size: 8pt;">${today} | ${time}</p>
        </div>

        <div style="font-size: 9pt; margin-bottom: 3mm;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 1mm;">
                <span>Opening Float:</span>
                <span style="font-weight: bold;">Rs ${(m.float || 0).toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 1mm;">
                <span>Total Cash Sales:</span>
                <span style="font-weight: bold;">Rs ${(m.cashSales || 0).toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 1mm; color: #d00;">
                <span>Today's Expenses:</span>
                <span style="font-weight: bold;">- Rs ${(m.expenses || 0).toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; border-top: 1px dashed black; padding-top: 1mm; font-weight: bold;">
                <span>EXPECTED CASH:</span>
                <span>Rs ${((m.float || 0) + (m.cashSales || 0) - (m.expenses || 0)).toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-top: 1mm;">
                <span>ACTUAL CASH:</span>
                <span style="font-weight: bold;">Rs ${(m.cashInHand || 0).toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-top: 1mm; border-top: 1px solid black; padding-top: 1mm; font-size: 10pt; font-weight: 900;">
                <span>VARIANCE:</span>
                <span>Rs ${(m.variance || 0).toLocaleString()}</span>
            </div>
        </div>

        <div style="border-top: 2mm solid black; border-bottom: 2mm solid black; padding: 2mm 0; margin-bottom: 4mm;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 1mm;">
                <span>Total Items Sold:</span>
                <span style="font-weight: bold;">${(sales || []).length}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 1mm;">
                <span>Credit Sales:</span>
                <span style="font-weight: bold;">Rs ${(m.creditSales || 0).toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 1mm;">
                <span>Total Expenses:</span>
                <span style="font-weight: bold; color: #d00;">Rs ${(m.expenses || 0).toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 1mm; font-size: 11pt; font-weight: 900;">
                <span>TOTAL REVENUE:</span>
                <span>Rs ${(m.totalSales || 0).toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; color: #444; font-size: 8pt; border-top: 1px dashed #444; padding-top: 1mm;">
                <span>GROSS PROFIT:</span>
                <span style="font-weight: bold;">Rs ${(m.grossProfit || 0).toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; color: #000; font-size: 10pt; font-weight: 950;">
                <span>NET PROFIT:</span>
                <span>Rs ${(m.netProfit || 0).toLocaleString()}</span>
            </div>
        </div>

        <div style="margin-top: 10mm; text-align: center;">
            <div style="border-top: 1px solid black; width: 80%; margin: 0 auto;"></div>
            <p style="margin: 1mm 0; font-size: 8pt; font-weight: bold; text-transform: uppercase;">Authorized Signature</p>
        </div>
        
        <div style="margin-top: 6mm; text-align: center; font-size: 7pt; border-top: 1px dashed black; padding-top: 2mm;">
            <p style="margin: 0;">Session ID: ${m.float > 0 ? Date.now().toString().slice(-6) : 'N/A'}</p>
            <p style="margin: 0;">Software by scriptsoft pvt.ltd</p>
        </div>
    `;

    window.print();
}

function generatePDF(m, sales) {
    const { jsPDF } = window.jspdf;
    const doc = jsPDF();
    const today = new Date().toLocaleDateString();

    doc.setFontSize(22);
    doc.text("GARAGE MASTER - DAY END", 105, 20, { align: "center" });
    doc.setFontSize(10);
    doc.text(`Report Date: ${today}`, 105, 28, { align: "center" });

    doc.setFontSize(14);
    doc.text("Financial Summary", 20, 45);
    doc.autoTable({
        startY: 50,
        body: [
            ["Opening Float", `Rs ${m.float.toLocaleString()}`],
            ["Total Cash Sales", `Rs ${m.cashSales.toLocaleString()}`],
            ["Today's Expenses", `Rs ${(m.expenses || 0).toLocaleString()}`],
            ["Total Credit Sales", `Rs ${m.creditSales.toLocaleString()}`],
            ["Expected Cash", `Rs ${(m.float + m.cashSales - (m.expenses || 0)).toLocaleString()}`],
            ["Actual Cash In Hand", `Rs ${m.cashInHand.toLocaleString()}`],
            ["Variance", `Rs ${m.variance.toLocaleString()}`],
            ["Total Expenses", `Rs ${(m.expenses || 0).toLocaleString()}`],
            ["Gross Profit", `Rs ${(m.grossProfit || 0).toLocaleString()}`],
            ["NET PROFIT", `Rs ${(m.netProfit || 0).toLocaleString()}`]
        ]
    });

    doc.text("Detailed Transactions", 20, doc.lastAutoTable.finalY + 15);
    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 20,
        head: [['Invoice', 'Vehicle', 'Customer', 'Method', 'Total']],
        body: sales.map(s => [
            s.id, s.vehicleNo, s.customerName, s.paymentMethod.toUpperCase(), `Rs ${s.total.toLocaleString()}`
        ])
    });

    doc.save(`GarageMaster_DayEnd_${today.replace(/\//g, '-')}.pdf`);
}

// Fallback text header if logo fails
function drawDefaultHeaderText(doc) {
    doc.setTextColor(0, 0, 0);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.text("LP AUTO ZONE", 14, 20);

    doc.setDrawColor(239, 68, 68); // Red accent
    doc.setLineWidth(1);
    doc.line(14, 23, 75, 23);

    doc.setFontSize(10);
    doc.text("PILIYANDALA", 14, 28);
}

// Help function for professional "Crystal Report" styling
// --- EMERALD STYLE GLOBAL REPORTING SYSTEM ---

function addCrystalReportHeader(doc, title) {
    const today = new Date().toLocaleDateString();
    const time = new Date().toLocaleTimeString();

    // Background accent for header area
    doc.setFillColor(248, 250, 252);
    doc.rect(0, 0, 210, 52, 'F'); // Slightly taller header area

    // 1. TOP LEFT - Logo Style Branding
    const logoImg = document.getElementById('receipt-logo');
    if (logoImg && logoImg.complete && logoImg.naturalWidth > 0) {
        try {
            const containerWidth = 75;
            const containerHeight = 35;
            const imgWidth = logoImg.naturalWidth;
            const imgHeight = logoImg.naturalHeight;
            const ratio = Math.min(containerWidth / imgWidth, containerHeight / imgHeight);

            const logoWidth = imgWidth * ratio;
            const logoHeight = imgHeight * ratio;

            // Draw logo
            doc.addImage(logoImg, 'PNG', 14, 5, logoWidth, logoHeight, undefined, 'FAST');
        } catch (e) {
            console.warn("Logo addition failed in report", e);
            drawDefaultHeaderText(doc);
        }
    } else {
        drawDefaultHeaderText(doc);
    }

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    // Move text down relative to the max height (approx 35 + 5 = 40)
    doc.text("200/2 Sapumal uyana kotagadara rode Madapatha", 14, 43);
    doc.text("Tel: 071 494 3786 / 074 024 9796", 14, 47);

    // 2. DOCUMENT TYPE (Title)
    doc.setTextColor(30, 41, 59);
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text(title.toUpperCase(), 196, 32, { align: "right" });

    // 3. RIGHT SIDE METADATA
    doc.setFontSize(7);
    doc.setFont("helvetica", "normal");
    const rightX = 196;
    doc.text(`Report Generated: ${today} ${time}`, rightX, 12, { align: "right" });
    doc.text(`Authorized User: ${currentUser?.username?.toUpperCase() || 'SYSTEM'}`, rightX, 16, { align: "right" });
    doc.text("LP AUTO ZONE - Professional Care", rightX, 20, { align: "right" });

    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.2);
    doc.line(14, 50, 196, 50);

    // 4. Content Start Y
    return 65;
}

function addCrystalReportFooter(doc) {
    const pageCount = doc.internal.getNumberOfPages();
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);

    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);

        // Horizontal Line
        doc.setDrawColor(200);
        doc.line(14, 280, 196, 280);

        // Signatures if it's the last page
        if (i === pageCount) {
            doc.setTextColor(0, 0, 0);
            const sigY = 250;
            doc.line(14, sigY, 55, sigY);
            doc.text("Authorized Signature", 14, sigY + 4);

            doc.line(155, sigY, 196, sigY);
            doc.text("Manager Signature", 196, sigY + 4, { align: 'right' });
            doc.setTextColor(100, 116, 139);
        }

        doc.text(`SYSTEM BY SCRIPTSOFT - AUTOMATED REPORTING SYSTEM`, 14, 285);
        doc.text(`Page ${i} of ${pageCount}`, 196, 285, { align: "right" });
    }
}

// Expense Report PDF
async function generateExpenseReport() {
    const { jsPDF } = window.jspdf;
    const dateFrom = document.getElementById('report-date-from').value;
    const dateTo = document.getElementById('report-date-to').value;

    let expenses = [];
    let periodText = "";

    if (dateFrom && dateTo) {
        const startTs = new Date(dateFrom).setHours(0, 0, 0, 0);
        const endTs = new Date(dateTo).setHours(23, 59, 59, 999);
        expenses = await db.expenses.where('timestamp').between(startTs, endTs, true, true).toArray();
        periodText = `${dateFrom} to ${dateTo}`;
    } else {
        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        expenses = await db.expenses.where('timestamp').above(startOfMonth).toArray();
        periodText = now.toLocaleString('default', { month: 'long', year: 'numeric' });
    }

    if (expenses.length === 0) {
        return showToast("No expenses found for this period", "error");
    }

    const doc = new jsPDF();
    const startY = addCrystalReportHeader(doc, "Expense Summary Report");

    doc.setFontSize(10);
    doc.setTextColor(71, 85, 105);
    doc.text(`Period: ${periodText}`, 14, startY - 10);

    const totalExp = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);

    doc.autoTable({
        startY: startY,
        theme: 'grid',
        head: [['Date', 'Category', 'Description', 'Amount (Rs)']],
        body: expenses.sort((a, b) => b.timestamp - a.timestamp).map(e => [
            e.date,
            e.category.toUpperCase(),
            e.description,
            e.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })
        ]),
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: 'bold' },
        columnStyles: {
            3: { halign: 'right' }
        }
    });

    const finalY = doc.lastAutoTable.finalY + 10;
    doc.setFillColor(254, 243, 199); // Light amber
    doc.roundedRect(140, finalY, 56, 12, 2, 2, 'F');
    doc.setTextColor(146, 64, 14); // Dark amber
    doc.setFont("helvetica", "bold");
    doc.text("TOTAL EXPENSES:", 145, finalY + 8);
    doc.text(`Rs ${totalExp.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 192, finalY + 8, { align: 'right' });

    addCrystalReportFooter(doc);
    doc.save(`Expense_Report_${periodText.replace(/ /g, '_')}.pdf`);
}

// GRN Date Range Summary Report
async function generateGrnRangeReport() {
    const { jsPDF } = window.jspdf;
    const dateFrom = document.getElementById('report-date-from').value;
    const dateTo = document.getElementById('report-date-to').value;

    if (!dateFrom || !dateTo) {
        return showToast("Please select both From and To dates", "error");
    }

    const startTs = new Date(dateFrom).setHours(0, 0, 0, 0);
    const endTs = new Date(dateTo).setHours(23, 59, 59, 999);

    if (startTs > endTs) {
        return showToast("'From' date cannot be after 'To' date", "error");
    }

    const grns = await db.grns.where('timestamp').between(startTs, endTs, true, true).toArray();

    if (grns.length === 0) {
        return showToast("No GRN records found for this period", "error");
    }

    const doc = new jsPDF();
    const startY = addCrystalReportHeader(doc, "GRN Period Summary Report");

    doc.setFontSize(10);
    doc.setTextColor(71, 85, 105);
    doc.text(`Period: ${dateFrom} to ${dateTo}`, 14, startY - 10);

    const totalValue = grns.reduce((sum, g) => sum + (g.total || 0), 0);

    doc.autoTable({
        startY: startY,
        theme: 'grid',
        head: [['Date', 'GRN #', 'Supplier', 'Reference', 'Total (Rs)']],
        body: grns.map(g => [
            g.date,
            `#GRN-${g.id.toString().padStart(5, '0')}`,
            g.supplier,
            g.reference || '-',
            g.total.toLocaleString(undefined, { minimumFractionDigits: 2 })
        ]),
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: 'bold' },
        columnStyles: {
            4: { halign: 'right' }
        }
    });

    const finalY = doc.lastAutoTable.finalY + 10;
    doc.setFillColor(241, 245, 249);
    doc.roundedRect(140, finalY, 56, 12, 2, 2, 'F');
    doc.setTextColor(30, 41, 59);
    doc.setFont("helvetica", "bold");
    doc.text("PERIOD TOTAL:", 145, finalY + 8);
    doc.text(`Rs ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 192, finalY + 8, { align: 'right' });

    addCrystalReportFooter(doc);
    doc.save(`GRN_Summary_${dateFrom}_to_${dateTo}.pdf`);
}


// Daily Sales PDF Report
async function generateDailySalesReport() {
    const { jsPDF } = window.jspdf;
    const doc = jsPDF();
    const today = new Date().toLocaleDateString();

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const sales = await db.sales.where('timestamp').between(startOfDay.getTime(), endOfDay.getTime(), true, true).toArray();

    // Fetch Expenses for today
    const expenses = await db.expenses.where('timestamp').between(startOfDay.getTime(), endOfDay.getTime(), true, true).toArray();

    const startY = addCrystalReportHeader(doc, "Daily Sales Report");

    const totalRevenue = sales.reduce((sum, s) => sum + (s.total || 0), 0);
    const grossProfit = sales.reduce((sum, s) => sum + (s.profit || 0), 0);
    const totalExpenses = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
    const netProfit = grossProfit - totalExpenses;

    doc.setFontSize(10);
    doc.text("Sales Transactions", 14, startY - 5);

    doc.autoTable({
        startY: startY,
        theme: 'grid',
        head: [['Invoice', 'Vehicle', 'Method', 'Total (Rs)', 'Profit (Rs)']],
        body: sales.map(s => [
            s.id.toString().padStart(6, '0'),
            s.vehicleNo.toUpperCase(),
            s.paymentMethod.toUpperCase(),
            s.total.toLocaleString(undefined, { minimumFractionDigits: 2 }),
            s.profit.toLocaleString(undefined, { minimumFractionDigits: 2 })
        ]),
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: 'bold' },
        styles: { fontSize: 8, cellPadding: 2 }
    });

    const summaryY = doc.lastAutoTable.finalY + 10;
    doc.setFontSize(12);
    doc.setFont("helvetica", "bold");
    doc.text("Financial Summary (Today)", 14, summaryY);

    doc.autoTable({
        startY: summaryY + 5,
        theme: 'plain',
        body: [
            ['Total Sales Revenue:', `Rs ${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`],
            ['Total Expenses:', `Rs ${totalExpenses.toLocaleString(undefined, { minimumFractionDigits: 2 })}`],
            ['Gross Profit (Sales):', `Rs ${grossProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}`],
            ['NET PROFIT (Final):', `Rs ${netProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}`]
        ],
        bodyStyles: { fontSize: 10, cellPadding: 2 },
        columnStyles: {
            0: { fontStyle: 'bold', cellWidth: 60 },
            1: { halign: 'right', fontStyle: 'bold' }
        }
    });

    if (expenses.length > 0) {
        doc.addPage();
        addCrystalReportHeader(doc, "Daily Expense Breakdown");
        doc.autoTable({
            startY: 65,
            theme: 'grid',
            head: [['Category', 'Description', 'Amount (Rs)']],
            body: expenses.map(e => [e.category.toUpperCase(), e.description, e.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })]),
            headStyles: { fillColor: [254, 243, 199], textColor: [146, 64, 14] }
        });
    }

    addCrystalReportFooter(doc);
    doc.save(`Daily_Report_${today.replace(/\//g, '-')}.pdf`);
}

// Monthly PDF Report
async function generateMonthlyReport() {
    const { jsPDF } = window.jspdf;
    const doc = jsPDF();
    const date = new Date();
    const month = date.toLocaleString('default', { month: 'long', year: 'numeric' });

    const start = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    const sales = await db.sales.where('timestamp').above(start).toArray();
    if (sales.length === 0) return showToast("No sales found for this month", "error");

    const startY = addCrystalReportHeader(doc, `Monthly Report - ${month}`);

    const total = sales.reduce((sum, s) => sum + (s.total || 0), 0);
    const profit = sales.reduce((sum, s) => sum + (s.profit || 0), 0);

    doc.autoTable({
        startY: startY,
        theme: 'grid',
        head: [['Financial Metric', 'Value (Rs)']],
        body: [
            ['Total Transactions', sales.length],
            ['Total Monthly Revenue', `Rs ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`],
            ['Total Monthly Profit', `Rs ${profit.toLocaleString(undefined, { minimumFractionDigits: 2 })}`]
        ],
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0] }
    });

    doc.setFontSize(14);
    doc.setTextColor(30, 41, 59);
    doc.text("Daily Revenue Summary", 20, doc.lastAutoTable.finalY + 15);

    const dailyData = {};
    sales.forEach(s => {
        dailyData[s.date] = (dailyData[s.date] || 0) + s.total;
    });

    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 20,
        theme: 'grid',
        head: [['Date', 'Revenue (Rs)']],
        body: Object.entries(dailyData).map(([d, val]) => [d, `Rs ${val.toLocaleString(undefined, { minimumFractionDigits: 2 })}`]),
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0] }
    });

    addCrystalReportFooter(doc);
    doc.save(`Monthly_Report_${month.replace(' ', '_')}.pdf`);
}

// Annual Sales Report
async function generateAnnualReport() {
    const { jsPDF } = window.jspdf;
    const doc = jsPDF();
    const year = new Date().getFullYear();

    const start = new Date(year, 0, 1).getTime();
    const sales = await db.sales.where('timestamp').above(start).toArray();
    if (sales.length === 0) return showToast("No sales found for this year", "error");

    const startY = addCrystalReportHeader(doc, `Annual Report - ${year}`);

    const total = sales.reduce((sum, s) => sum + (s.total || 0), 0);

    const monthlySummary = Array(12).fill(0).map((_, i) => ({
        month: new Date(year, i).toLocaleString('default', { month: 'long' }),
        total: 0
    }));

    sales.forEach(s => {
        const m = new Date(s.timestamp).getMonth();
        monthlySummary[m].total += s.total;
    });

    doc.autoTable({
        startY: startY,
        theme: 'grid',
        head: [['Month', 'Revenue (Rs)']],
        body: monthlySummary.filter(m => m.total > 0).map(m => [m.month, `Rs ${m.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`]),
        foot: [['TOTAL ANNUAL REVENUE', `Rs ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`]],
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: 'bold' },
        footStyles: { fillColor: [248, 250, 252], textColor: [0, 0, 0], fontStyle: 'bold' }
    });

    addCrystalReportFooter(doc);
    doc.save(`Annual_Report_${year}.pdf`);
}

// Product Performance Report
async function generateProductPerformanceReport() {
    const { jsPDF } = window.jspdf;
    const doc = jsPDF();
    const today = new Date().toLocaleDateString();

    const sales = await db.sales.toArray();
    const itemStats = {};

    sales.forEach(sale => {
        sale.items.forEach(item => {
            if (item.type === 'item') {
                if (!itemStats[item.id]) {
                    itemStats[item.id] = { name: item.partName, pNo: item.partNumber || 'N/A', qty: 0, revenue: 0 };
                }
                itemStats[item.id].qty += item.qty;
                itemStats[item.id].revenue += (item.price * item.qty);
            }
        });
    });

    const body = Object.values(itemStats).sort((a, b) => b.qty - a.qty);
    if (body.length === 0) return showToast("No item sales recorded", "error");

    const startY = addCrystalReportHeader(doc, "Item Performance Report");

    doc.autoTable({
        startY: startY,
        theme: 'grid',
        head: [['Part Number', 'Item Name', 'Quantity Sold', 'Revenue']],
        body: body.map(i => [i.pNo, i.name, i.qty, `Rs ${i.revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`]),
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0] },
        foot: [['', 'TOTAL', body.reduce((sum, i) => sum + i.qty, 0), `Rs ${body.reduce((sum, i) => sum + i.revenue, 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`]],
        footStyles: { fillColor: [241, 245, 249], textColor: [30, 41, 59], fontStyle: 'bold' }
    });

    addCrystalReportFooter(doc);
    doc.save(`Item_Performance_${today.replace(/\//g, '-')}.pdf`);
}



// Load Customer
async function loadCustomerDetails(phone) {
    if (!phone || phone.length < 9) return;

    // Find customer
    const customer = await db.customers.where('phone').equals(phone).first();
    if (customer) {
        const nameInput = document.getElementById('cart-customer-name');
        const vehicleInput = document.getElementById('cart-vehicle-no');

        if (nameInput) nameInput.value = customer.name || '';
        if (vehicleInput && customer.vehicleNo) vehicleInput.value = customer.vehicleNo;

        // precise credit check
        const sales = await db.sales.where('customerPhone').equals(phone).toArray();
        const pending = sales.filter(s => s.paymentMethod === 'credit' && (s.isPaid === false || s.isPaid === undefined));
        const totalCredit = pending.reduce((sum, s) => sum + (s.total || 0), 0);

        const alertBox = document.getElementById('pos-credit-alert');
        const amountText = document.getElementById('pos-credit-amount');

        if (totalCredit > 0 && alertBox && amountText) {
            alertBox.classList.remove('hidden');
            alertBox.classList.add('flex');
            amountText.innerText = `Rs ${totalCredit.toLocaleString()}`;
            // Store for quick pay
            window.currentCustomerPhone = phone;
        } else if (alertBox) {
            alertBox.classList.add('hidden');
            alertBox.classList.remove('flex');
        }

        showToast("Customer Found!", "success");
    }
}

async function goToCustomerCredit(phone) {
    if (!phone) return;
    switchView('customers');
    // Allow view to switch then search
    setTimeout(() => {
        const input = document.getElementById('customer-search');
        if (input) {
            input.value = phone;
            input.dispatchEvent(new Event('input'));
        }
    }, 300);
}

// Category-wise Sales Report
async function generateCategoryReport() {
    const { jsPDF } = window.jspdf;
    const doc = jsPDF();
    const today = new Date().toLocaleDateString();

    const sales = await db.sales.toArray();
    const categoryStats = {};

    sales.forEach(sale => {
        sale.items.forEach(item => {
            if (item.type === 'item') {
                const category = item.category || 'Uncategorized';
                if (!categoryStats[category]) {
                    categoryStats[category] = { qty: 0, revenue: 0, items: 0 };
                }
                categoryStats[category].qty += item.qty;
                categoryStats[category].revenue += (item.price * item.qty);
                categoryStats[category].items += 1;
            }
        });
    });

    const body = Object.entries(categoryStats).map(([cat, stats]) => [
        cat,
        stats.qty,
        `Rs ${stats.revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
    ]).sort((a, b) => b[1] - a[1]);

    if (body.length === 0) return showToast("No category sales recorded", "error");

    const startY = addCrystalReportHeader(doc, "Category Sales Report");

    doc.autoTable({
        startY: startY,
        theme: 'grid',
        head: [['Category Name', 'Units Sold', 'Total Revenue']],
        body: body,
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: 'bold' },
        foot: [['TOTAL', body.reduce((sum, row) => sum + row[1], 0), `Rs ${Object.values(categoryStats).reduce((sum, s) => sum + s.revenue, 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`]],
        footStyles: { fillColor: [248, 250, 252], textColor: [0, 0, 0], fontStyle: 'bold' }
    });

    addCrystalReportFooter(doc);
    doc.save(`Category_Sales_${today.replace(/\//g, '-')}.pdf`);
}



// Stock Report
async function generateStockReport() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const today = new Date().toLocaleDateString();

    const items = await db.inventory.toArray();
    if (items.length === 0) return showToast("No items in inventory", "error");

    const startY = addCrystalReportHeader(doc, "Current Stock Report");

    const totalStockValue = items.reduce((sum, i) => sum + ((i.buyingPrice || 0) * i.stock), 0);
    const totalPotentialRevenue = items.reduce((sum, i) => sum + (i.price * i.stock), 0);

    doc.autoTable({
        startY: startY,
        theme: 'grid',
        head: [['Part #', 'Item Name', 'Category', 'Stock', 'Cost (Rs)', 'Price (Rs)']],
        body: items.map(i => [
            i.partNumber,
            i.partName,
            i.category,
            i.stock,
            (i.buyingPrice || 0).toLocaleString(),
            i.price.toLocaleString()
        ]),
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 8 },
        bodyStyles: { fontSize: 8 },
        foot: [['', 'TOTAL STOCK VALUE', '', '', totalStockValue.toLocaleString(), totalPotentialRevenue.toLocaleString()]],
        footStyles: { fillColor: [248, 250, 252], textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 8 },
        columnStyles: {
            0: { cellWidth: 25 },
            3: { halign: 'center' },
            4: { halign: 'right' },
            5: { halign: 'right' }
        }
    });

    addCrystalReportFooter(doc);
    doc.save(`Stock_Report_${today.replace(/\//g, '-')}.pdf`);
}

// Customer Directory Report
async function generateCustomerReport() {
    const { jsPDF } = window.jspdf;
    const doc = jsPDF();
    const today = new Date().toLocaleDateString();

    const customers = await db.customers.toArray();
    if (customers.length === 0) return showToast("No customers found in database", "error");

    const startY = addCrystalReportHeader(doc, "Customer Directory");

    doc.autoTable({
        startY: startY,
        theme: 'grid',
        head: [['Customer Name', 'Phone Number', 'Last Vehicle #']],
        body: customers.map(c => [
            c.name || 'N/A',
            c.phone || '-',
            c.vehicleNo ? c.vehicleNo.toUpperCase() : '-'
        ]),
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontStyle: 'bold' },
        styles: { fontSize: 10, cellPadding: 4 }
    });

    addCrystalReportFooter(doc);
    doc.save(`Customer_Directory_${today.replace(/\//g, '-')}.pdf`);
}

async function saveCustomer(data) {
    if (!data.phone || data.phone === '-') return;
    const existing = await db.customers.where('phone').equals(data.phone).first();
    if (existing) {
        await db.customers.update(existing.id, {
            name: data.name,
            vehicleNo: data.vehicleNo
        });
    } else {
        await db.customers.add(data);
    }
}

async function sendWhatsAppBill(saleId, saleData = null) {
    const sale = saleData || await db.sales.get(saleId);
    if (!sale || !sale.customerPhone || sale.customerPhone === '-') {
        return showToast("No phone number found!", "error");
    }

    // 1. Generate Thermal PDF
    const pdfBlob = await generateInvoicePDF(sale, saleId);

    // 2. Prepare WhatsApp message
    const cleanPhone = sale.customerPhone.replace(/\D/g, '');
    const phoneWithCountry = cleanPhone.startsWith('94') ? cleanPhone : `94${cleanPhone.startsWith('0') ? cleanPhone.slice(1) : cleanPhone}`;

    const message = `*LP AUTO ZONE - INVOICE*%0A%0A` +
        `*Inv #:* ${saleId.toString().padStart(6, '0')}%0A` +
        `*Vehicle:* ${sale.vehicleNo}%0A` +
        `*Total: Rs ${sale.total.toLocaleString()}*%0A%0A` +
        `Please find your invoice PDF attached.`;

    // 3. Try Web Share API (Mobile/Modern Browsers)
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([pdfBlob], 'Invoice.pdf', { type: 'application/pdf' })] })) {
        try {
            await navigator.share({
                files: [new File([pdfBlob], `Invoice_${saleId}.pdf`, { type: 'application/pdf' })],
                title: 'Invoice',
                text: 'Your Garage Master Invoice'
            });
            return;
        } catch (err) {
            console.log("Share skipped, using direct message");
        }
    }

    // 4. Fallback: Download and Open WA
    const url = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Invoice_${saleId.toString().padStart(6, '0')}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    window.open(`https://wa.me/${phoneWithCountry}?text=${message}`, '_blank');
}




// Print & Modal Helpers
function preparePrint(sale) {
    const id = sale.invoiceNo || 0;
    const dateObj = new Date(sale.timestamp || Date.now());

    const printDate = document.getElementById('print-date');
    const printTime = document.getElementById('print-time');
    const printInvoiceId = document.getElementById('print-invoice-id');
    const printPaymentMethod = document.getElementById('print-payment-method');
    const printVehicleNo = document.getElementById('print-vehicle-no');
    const printCustomerName = document.getElementById('print-customer-name');
    const printSubtotal = document.getElementById('print-subtotal');
    const printDiscount = document.getElementById('print-discount');
    const printTotal = document.getElementById('print-total');
    const cashSection = document.getElementById('print-cash-section');
    const printCashReceived = document.getElementById('print-cash-received');
    const printBalance = document.getElementById('print-balance');
    const itemsContainer = document.getElementById('print-items');

    if (printDate) printDate.innerText = dateObj.toLocaleDateString();
    if (printTime) printTime.innerText = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (printInvoiceId) printInvoiceId.innerText = `${id.toString().padStart(6, '0')}`;
    if (printPaymentMethod) printPaymentMethod.innerText = sale.paymentMethod;
    if (printVehicleNo) printVehicleNo.innerText = sale.vehicleNo;
    if (printCustomerName) printCustomerName.innerText = sale.customerName || 'Walking Customer';

    if (printSubtotal) printSubtotal.innerText = sale.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 });
    if (printDiscount) printDiscount.innerText = sale.discount.toLocaleString(undefined, { minimumFractionDigits: 2 });
    if (printTotal) printTotal.innerText = sale.total.toLocaleString(undefined, { minimumFractionDigits: 2 });

    if (cashSection) {
        if (sale.paymentMethod === 'cash') {
            cashSection.style.display = 'block';
            if (printCashReceived) printCashReceived.innerText = (sale.cashReceived || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
            if (printBalance) printBalance.innerText = (sale.balance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
        } else {
            cashSection.style.display = 'none';
        }
    }

    if (itemsContainer) {
        itemsContainer.innerHTML = sale.items.map(i => `
        <tr>
            <td style="padding: 1mm 0;">${i.partName}</td>
            <td style="text-align: center; padding: 1mm 0;">${i.qty}</td>
            <td style="text-align: right; padding: 1mm 0;">${(i.price * i.qty).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        </tr>
    `).join('');
    }
}

async function downloadBillPDF(saleId) {
    try {
        const sale = await db.sales.get(saleId);
        if (!sale) throw new Error("Sale not found");

        const pdfBlob = await generateInvoicePDF(sale, saleId);
        const url = URL.createObjectURL(pdfBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `GarageMaster_Invoice_${saleId}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast("PDF Downloaded Successfully", "success");
    } catch (err) {
        console.error(err);
        showToast("Error downloading PDF", "error");
    }
}

async function generateInvoicePDF(sale, id) {
    const { jsPDF } = window.jspdf;
    // Increased height multiplier to avoid truncation
    const doc = new jsPDF({
        unit: 'mm',
        format: [80, 100 + (sale.items.length * 15)]
    });

    const centerX = 40;

    // Header - LP AUTO ZONE Branding
    const logoImg = document.getElementById('receipt-logo');
    if (logoImg && logoImg.complete && logoImg.naturalWidth > 0) {
        try {
            const aspectRatio = logoImg.naturalHeight / logoImg.naturalWidth;
            const logoWidth = 50;
            const logoHeight = logoWidth * aspectRatio;
            // Use 'PNG' format for SVG sources
            doc.addImage(logoImg, 'PNG', (80 - logoWidth) / 2, 5, logoWidth, logoHeight, undefined, 'FAST');
        } catch (e) {
            console.warn("Logo addition failed in receipt", e);
            doc.setFont("helvetica", "bold");
            doc.setFontSize(22);
            doc.text("LP AUTO ZONE", centerX, 12, { align: "center" });
            doc.setFontSize(10);
            doc.text("PILIYANDALA", centerX, 19, { align: "center" });
        }
    } else {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(22);
        doc.text("LP AUTO ZONE", centerX, 12, { align: "center" });

        doc.setDrawColor(239, 68, 68); // Red accent line
        doc.setLineWidth(1);
        doc.line(centerX - 35, 14, centerX + 35, 14);

        doc.setFontSize(10);
        doc.text("PILIYANDALA", centerX, 19, { align: "center" });
    }

    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.text("PROFESSIONAL AUTO CARE SERVICES", centerX, 32, { align: "center" });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.text("200/2 Sapumal uyana kotagadara rode Madapatha", centerX, 36, { align: "center" });
    doc.text("Tel: 071 494 3786 / 074 024 9796", centerX, 39, { align: "center" });

    doc.setLineDash([1, 1], 0);
    doc.setDrawColor(0);
    doc.line(5, 42, 75, 42);

    // Bill Info
    doc.setFontSize(8);
    doc.text(`INV: ${id.toString().padStart(6, '0')}`, 5, 47);
    doc.text(`DATE: ${sale.date}`, 75, 47, { align: "right" });

    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.rect(5, 50, 70, 10);
    doc.text(sale.vehicleNo, centerX, 57, { align: "center" });

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Customer: ${sale.customerName || 'Walking Customer'}`, 5, 65);

    doc.setLineDash([], 0);
    doc.line(5, 68, 75, 68);

    // Table Header
    let y = 73;
    doc.setFont("helvetica", "bold");
    doc.text("ITEM DESCRIPTION", 5, y);
    doc.text("QTY", 55, y, { align: "center" });
    doc.text("PRICE", 75, y, { align: "right" });

    y += 2;
    doc.line(5, y, 75, y);
    y += 5;

    // Items
    doc.setFont("helvetica", "normal");
    sale.items.forEach(item => {
        const lines = doc.splitTextToSize(item.partName, 45);
        doc.text(lines, 5, y);
        doc.text(item.qty.toString(), 55, y, { align: "center" });
        doc.text((item.price * item.qty).toLocaleString(undefined, { minimumFractionDigits: 2 }), 75, y, { align: "right" });
        y += (lines.length * 4) + 1;
    });

    doc.setLineDash([1, 1], 0);
    doc.line(5, y, 75, y);
    y += 6;

    // Totals
    doc.setFontSize(9);
    doc.text("Subtotal:", 45, y);
    doc.text(`Rs ${sale.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 75, y, { align: "right" });
    y += 4;

    if (sale.discount > 0) {
        doc.text("Discount:", 45, y);
        doc.text(`- Rs ${sale.discount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 75, y, { align: "right" });
        y += 4;
    }

    doc.setLineDash([], 0);
    doc.setFontSize(13);
    doc.setFont("helvetica", "bold");
    doc.text("TOTAL:", 45, y + 2);
    doc.text(`Rs ${sale.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, 75, y + 2, { align: "right" });
    y += 10;

    // Cash Section
    if (sale.paymentMethod === 'cash' && sale.cashReceived > 0) {
        doc.setFontSize(8);
        doc.setFont("helvetica", "normal");
        doc.text("Cash Received:", 45, y);
        doc.text(sale.cashReceived.toLocaleString(undefined, { minimumFractionDigits: 2 }), 75, y, { align: "right" });
        y += 4;
        doc.setFont("helvetica", "bold");
        doc.text("Balance:", 45, y);
        doc.text(sale.balance.toLocaleString(undefined, { minimumFractionDigits: 2 }), 75, y, { align: "right" });
        y += 6;
    }

    doc.setLineDash([1, 1], 0);
    doc.line(5, y, 75, y);
    y += 6;

    // Footer
    doc.setFont("helvetica", "bold");
    doc.text("*** THANK YOU - COME AGAIN ***", centerX, y, { align: "center" });
    y += 4;
    doc.setFont("helvetica", "italic");
    doc.setFontSize(7);
    doc.text("Quality Service & Genuine Spares", centerX, y, { align: "center" });
    y += 4;
    doc.text("Software by scriptsoft pvt.ltd", centerX, y, { align: "center" });

    return doc.output('blob');
}

function showCheckoutSuccess(id, sale) {
    const modal = document.getElementById('checkout-success-modal');
    document.getElementById('success-invoice-id').innerText = id.toString().padStart(6, '0');

    // Set WhatsApp listener
    const waBtn = document.getElementById('wa-share-btn');
    waBtn.onclick = () => sendWhatsAppBill(id, sale);

    // Set Download listener
    const dlBtn = document.getElementById('download-pdf-btn');
    if (dlBtn) dlBtn.onclick = () => downloadBillPDF(id);

    showModal('checkout-success-modal');
}

// Helper to re-authorize folder using a user gesture
async function attemptFolderReauth() {
    try {
        const saved = await db.settings.get('journalHandle');
        if (saved && saved.value) {
            journalFolderHandle = saved.value;
            const status = await journalFolderHandle.requestPermission({ mode: 'readwrite' });
            updateJournalUI(status === 'granted');
            if (status === 'granted') console.log("Backup folder auto-reconnected");
        }
    } catch (e) {
        console.warn("Auto-reauth failed (gesture required)", e);
    }
}

// AUTHENTICATION SYSTEM
async function checkAuth() {
    const sessionUser = sessionStorage.getItem('currentUser');
    if (sessionUser) {
        currentUser = JSON.parse(sessionUser);

        // Check if we have a saved handle but need permission
        const saved = await db.settings.get('journalHandle');
        if (saved) {
            journalFolderHandle = saved.value;
            const status = await journalFolderHandle.queryPermission({ mode: 'readwrite' });
            updateJournalUI(status === 'granted');
        }

        document.getElementById('login-screen').classList.add('hidden');
        updateUIPermissions();
        initApp();
    } else {
        document.getElementById('login-screen').classList.remove('hidden');
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const u = document.getElementById('login-user').value;
    const p = document.getElementById('login-pass').value;

    const user = await db.users.where('username').equals(u).first();

    if (user && user.password === p) {
        currentUser = user;
        sessionStorage.setItem('currentUser', JSON.stringify(user));

        // Attempt to re-authorize backup folder using this click gesture
        await attemptFolderReauth();

        document.getElementById('login-screen').classList.add('hidden');
        showToast(`Welcome ${user.username}!`, "success");
        updateUIPermissions();
        initApp();
    } else {
        showToast("Invalid Credentials", "error");
        document.getElementById('login-pass').value = '';
    }
}

function updateUIPermissions() {
    if (!currentUser) return;
    const isAdmin = currentUser.role === 'admin';

    // Hide sidebar items if not admin
    document.getElementById('nav-inventory').style.display = isAdmin ? 'flex' : 'none';
    document.getElementById('nav-grn').style.display = isAdmin ? 'flex' : 'none';
    document.getElementById('nav-admin').style.display = isAdmin ? 'flex' : 'none';

    // Update user info in sidebar
    document.getElementById('current-username').innerText = currentUser.username;
    document.getElementById('current-user-role').innerText = currentUser.role.toUpperCase();

    // Role-based Day End Text
    const dayEndBtnText = document.getElementById('nav-day-end-text');
    if (dayEndBtnText) {
        dayEndBtnText.innerText = isAdmin ? 'END BUSINESS DAY' : 'CASHIER CLOSE';
    }

    if (isAdmin) renderUserManagement();
}

function logout() {
    sessionStorage.removeItem('currentUser');
    currentUser = null;
    location.reload();
}

// User Management (Admin Only)
async function renderUserManagement() {
    const userList = await db.users.toArray();
    const container = document.getElementById('user-management-list');
    if (!container) return;

    container.innerHTML = userList.map(u => `
        <tr class="hover:bg-slate-700/30">
            <td class="px-6 py-3 font-bold text-primary">${u.username}</td>
            <td class="px-6 py-3 text-xs opacity-60 uppercase">${u.role}</td>
            <td class="px-6 py-3 text-mono">••••••••</td>
            <td class="px-6 py-3 text-right">
                ${u.username !== 'admin' ? `
                    <button onclick="deleteUser(${u.id})" class="text-red-500 hover:text-red-400">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                ` : '<span class="text-[8px] opacity-40">SYSTEM</span>'}
            </td>
        </tr>
    `).join('');
    lucide.createIcons();
}

async function handleAddUser(e) {
    e.preventDefault();
    const username = document.getElementById('new-username').value;
    const password = document.getElementById('new-password').value;
    const role = document.getElementById('new-role').value;

    try {
        await db.users.add({ username, password, role });
        showToast("User added successfully", "success");
        e.target.reset();
        renderUserManagement();
    } catch (err) {
        showToast("Username already exists", "error");
    }
}

async function deleteUser(id) {
    if (confirm("Delete this user?")) {
        await db.users.delete(id);
        showToast("User removed", "info");
        renderUserManagement();
    }
}

function updatePassword() {
    const newPass = document.getElementById('new-admin-pass').value;
    if (newPass.length < 4) return showToast("Password too weak", "error");

    if (currentUser) {
        db.users.update(currentUser.id, { password: newPass }).then(() => {
            showToast("Password updated successfully", "success");
            document.getElementById('new-admin-pass').value = '';
        });
    }
}

// Stock Movement Report (New Implementation)
async function generateStockMovementReport() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const today = new Date().toLocaleDateString();

    const items = await db.inventory.toArray();
    const sales = await db.sales.toArray();

    if (items.length === 0) return showToast("No items in inventory", "error");

    // Calculate Sales per Item
    const soldCounts = {};
    const soldRevenue = {};

    sales.forEach(sale => {
        if (sale.items) {
            sale.items.forEach(saleItem => {
                if (saleItem.type === 'item') {
                    // Match by ID if possible, otherwise by Part Number
                    const key = saleItem.id || saleItem.partNumber;
                    if (!soldCounts[key]) soldCounts[key] = 0;
                    if (!soldRevenue[key]) soldRevenue[key] = 0;

                    soldCounts[key] += saleItem.qty;
                    soldRevenue[key] += (saleItem.price * saleItem.qty);
                }
            });
        }
    });

    const startY = addCrystalReportHeader(doc, "Stock Movement Report");

    const reportData = items.map(i => {
        const key = i.id || i.partNumber; // prefer ID match
        // If ID match fails (legacy data), try Part Number match manually
        let sold = soldCounts[key] || 0;
        let rev = soldRevenue[key] || 0;

        if (sold === 0 && i.partNumber) {
            // Fallback to part number if ID didn't match (e.g. from older sales)
            sold = soldCounts[i.partNumber] || 0;
            rev = soldRevenue[i.partNumber] || 0;
        }

        const totalAdded = i.stock + sold; // Approx total handled
        return {
            ...i,
            sold,
            totalAdded,
            revenue: rev
        };
    });

    // Summary Box
    const totalSoldItems = reportData.reduce((sum, i) => sum + i.sold, 0);
    const totalRevenueNative = reportData.reduce((sum, i) => sum + i.revenue, 0);
    const currentStockVal = reportData.reduce((sum, i) => sum + ((i.buyingPrice || 0) * i.stock), 0);

    doc.autoTable({
        startY: startY + 15, // Reduced space - removed summary box
        theme: 'grid',
        head: [['Part #', 'Item Name', 'Total Stock', 'Sold', 'Available', 'Rev (Rs)']],
        body: reportData.map(i => [
            i.partNumber,
            i.partName,
            i.totalAdded,
            i.sold,
            i.stock,
            i.revenue.toLocaleString()
        ]),
        headStyles: { fillColor: [240, 240, 240], textColor: [0, 0, 0], fontSize: 8 },
        bodyStyles: { fontSize: 8 },
        columnStyles: {
            0: { cellWidth: 25 },
            2: { halign: 'center' },
            3: { halign: 'center' },
            4: { halign: 'center', fontStyle: 'bold' },
            5: { halign: 'right' }
        }
    });

    addCrystalReportFooter(doc);
    doc.save(`Stock_Movement_Report_${today.replace(/\//g, '-')}.pdf`);
}

// --- GRN (GOOD RECEIVED NOTE) SYSTEM ---

async function renderGrnTable() {
    const list = await db.grns.reverse().toArray();
    const container = document.getElementById('grn-table-body');
    if (!container) return;

    container.innerHTML = list.map(g => `
        <tr class="hover:bg-slate-700/30 transition-colors">
            <td class="px-6 py-4 text-xs opacity-60">${g.date}</td>
            <td class="px-6 py-4 font-bold text-green-400">#GRN-${g.id.toString().padStart(5, '0')}</td>
            <td class="px-6 py-4">
                <div class="font-bold text-slate-100">${g.supplier || 'N/A'}</div>
                <div class="text-[10px] text-slate-500 uppercase">REF: ${g.reference || '-'}</div>
            </td>
            <td class="px-6 py-4 text-right font-black">Rs ${g.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
            <td class="px-6 py-4 text-center">
                <div class="flex justify-center gap-2">
                    <button onclick="viewGRN(${g.id})" class="p-2 bg-slate-800 text-green-400 hover:text-green-300 rounded-lg transition-all" title="View Details">
                        <i data-lucide="eye" class="w-4 h-4"></i>
                    </button>
                    <button onclick="generateGrnPdf(${g.id})" class="p-2 bg-slate-800 text-blue-400 hover:text-blue-300 rounded-lg transition-all" title="Download Report">
                        <i data-lucide="file-text" class="w-4 h-4"></i>
                    </button>
                    <button onclick="deleteGRN(${g.id})" class="p-2 bg-slate-800 text-red-500 hover:text-red-400 rounded-lg transition-all" title="Delete GRN">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
    lucide.createIcons();
}

// Searchable Item Dropdown for GRN
function filterGrnItems(query) {
    const resultsContainer = document.getElementById('grn-search-results');
    if (!query.trim()) {
        resultsContainer.innerHTML = '';
        resultsContainer.classList.add('hidden');
        return;
    }

    const filtered = inventory.filter(i =>
        i.partName.toLowerCase().includes(query.toLowerCase()) ||
        i.partNumber.toLowerCase().includes(query.toLowerCase())
    );

    if (filtered.length === 0) {
        resultsContainer.innerHTML = '<div class="p-3 text-xs text-slate-500 italic">No items found</div>';
    } else {
        resultsContainer.innerHTML = filtered.map(item => `
            <div onclick="selectGrnItem(${item.id}, '${item.partName.replace(/'/g, "\\'")}')" 
                class="p-3 hover:bg-slate-700 cursor-pointer border-b border-slate-700/50 last:border-0 transition-colors">
                <p class="text-sm font-bold text-slate-100">${item.partName}</p>
                <p class="text-[10px] text-slate-400 font-mono">${item.partNumber} | Current Stock: ${item.stock}</p>
            </div>
        `).join('');
    }
    resultsContainer.classList.remove('hidden');
}

function selectGrnItem(id, name) {
    document.getElementById('grn-item-selected-id').value = id;
    document.getElementById('grn-item-search').value = name;
    document.getElementById('grn-search-results').classList.add('hidden');
    autoLoadGrnPrice(id);
}

async function autoLoadGrnPrice(itemId) {
    if (!itemId) return;
    const part = await db.inventory.get(parseInt(itemId));
    if (part) {
        document.getElementById('grn-item-cost').value = part.buyingPrice || 0;
    }
}

function addGrnItem() {
    const idInput = document.getElementById('grn-item-selected-id');
    const nameInput = document.getElementById('grn-item-search');
    const qtyInput = document.getElementById('grn-item-qty');
    const costInput = document.getElementById('grn-item-cost');

    const itemId = idInput.value;
    const qty = parseInt(qtyInput.value) || 0;
    const cost = parseFloat(costInput.value) || 0;

    if (!itemId) return showToast("Please select an item from the list", "error");
    if (qty <= 0) return showToast("Quantity must be greater than 0", "error");

    const part = inventory.find(i => i.id == itemId);
    const existing = grnCart.find(c => c.id == itemId);

    if (existing) {
        existing.qty += qty;
        existing.cost = cost; // Update with latest cost
    } else {
        grnCart.push({
            id: part.id,
            partName: part.partName,
            partNumber: part.partNumber,
            qty: qty,
            cost: cost
        });
    }

    renderGrnCart();

    // Reset Inputs
    idInput.value = '';
    nameInput.value = '';
    qtyInput.value = 1;
    costInput.value = '';
}

function renderGrnCart() {
    const container = document.getElementById('grn-items-list');
    let total = 0;

    container.innerHTML = grnCart.map((item, index) => {
        const lineTotal = item.qty * item.cost;
        total += lineTotal;
        return `
            <tr class="hover:bg-slate-800/50">
                <td class="px-4 py-2">
                    <div class="font-bold">${item.partName}</div>
                    <div class="text-[9px] text-slate-500">${item.partNumber}</div>
                </td>
                <td class="px-4 py-2 text-center">${item.qty}</td>
                <td class="px-4 py-2 text-right">${item.cost.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                <td class="px-4 py-2 text-right font-bold text-green-400">${lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                <td class="px-4 py-2 text-center">
                    <button onclick="grnCart.splice(${index}, 1); renderGrnCart();" class="text-red-400 hover:text-red-300">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    if (grnCart.length === 0) {
        container.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-600 italic">No items added yet</td></tr>';
    }

    document.getElementById('grn-modal-total').innerText = `Rs ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    lucide.createIcons();
}

async function submitGRN() {
    if (grnCart.length === 0) return showToast("GRN items list is empty!", "error");

    const supplierSelect = document.getElementById('grn-supplier-id');
    const supplierId = supplierSelect.value;
    const supplier = supplierSelect.options[supplierSelect.selectedIndex].text;
    const reference = document.getElementById('grn-ref').value.trim();
    const paidAmount = parseFloat(document.getElementById('grn-paid-amount').value) || 0;

    if (!supplierId) return showToast("Please select a registered supplier", "error");

    const total = grnCart.reduce((sum, item) => sum + (item.qty * item.cost), 0);
    const now = new Date();

    const grnData = {
        date: now.toLocaleDateString(),
        timestamp: now.getTime(),
        supplierId: Number(supplierId),
        supplier,
        reference,
        total,
        paidAmount,
        items: JSON.parse(JSON.stringify(grnCart)),
        userId: currentUser?.id
    };

    try {
        const id = await db.grns.add(grnData);

        // Update Inventory Stock and Buying Price
        for (const item of grnCart) {
            const p = await db.inventory.get(item.id);
            if (p) {
                await db.inventory.update(item.id, {
                    stock: (p.stock || 0) + item.qty,
                    buyingPrice: item.cost // Update with latest buying cost
                });
            }
        }

        showToast("GRN Finalized Successfully!", "success");
        hideModal('grn-modal');

        // Clear inputs
        document.getElementById('grn-supplier-id').value = '';
        document.getElementById('grn-ref').value = '';
        document.getElementById('grn-paid-amount').value = 0;
        grnCart = [];

        await refreshData();
        renderGrnTable();
        renderInventoryTable();
        renderItems();

        // Generate PDF
        generateGrnPdf(id);

    } catch (err) {
        console.error("GRN Submit Error:", err);
        showToast("Error finalizing GRN", "error");
    }
}

async function generateGrnPdf(id) {
    const { jsPDF } = window.jspdf;
    const grn = await db.grns.get(id);
    if (!grn) return;

    const doc = new jsPDF();
    const startY = addCrystalReportHeader(doc, "Goods Received Note (GRN)");

    // 4. HEADER INFO FIELDS
    doc.setFontSize(9);
    doc.text("Document #", 14, 75);
    doc.text("Date", 14, 83);
    doc.text("Remark", 14, 91);

    doc.setFont("helvetica", "bold");
    doc.text(`GRN${grn.id.toString().padStart(8, '0')}`, 45, 75);
    doc.text(grn.date, 45, 83);
    doc.text(grn.supplier, 45, 91);

    // Right Info Fields
    doc.setFont("helvetica", "normal");
    doc.text("Reference No", 130, 75);
    doc.text("From Location", 130, 83);
    doc.text("To Location", 130, 91);

    doc.setFont("helvetica", "bold");
    doc.text(grn.reference || "-", 165, 75);
    doc.text(grn.supplier, 165, 83);
    doc.text("GARAGE MASTER STORE", 165, 91);

    // 5. TABLE 
    doc.autoTable({
        startY: 100,
        theme: 'plain',
        head: [['Pro.Code', 'Pro.Name', 'Unit', 'Qty', 'Unit Cost', 'Nett Amt.']],
        body: grn.items.map(i => [
            i.partNumber,
            i.partName,
            'NOS',
            i.qty.toFixed(2),
            i.cost.toLocaleString(undefined, { minimumFractionDigits: 2 }),
            (i.qty * i.cost).toLocaleString(undefined, { minimumFractionDigits: 2 })
        ]),
        headStyles: { textColor: [0, 0, 0], fontStyle: 'bold', fontSize: 8 },
        bodyStyles: { fontSize: 8, textColor: [0, 0, 0] },
        columnStyles: {
            3: { halign: 'center' },
            4: { halign: 'right' },
            5: { halign: 'right' }
        },
        margin: { left: 14, right: 14 },
        didDrawPage: (data) => {
            doc.line(14, data.cursor.y, 196, data.cursor.y); // Bottom line after table body
        }
    });

    // 6. SUMMARY BLOCK (Right Aligned)
    const finalY = doc.lastAutoTable.finalY + 10;
    doc.setFontSize(9);
    doc.setFont("helvetica", "normal");
    doc.text("Gross Amount:", 160, finalY, { align: 'right' });
    doc.text("Net Amount:", 160, finalY + 8, { align: 'right' });

    doc.setFont("helvetica", "bold");
    doc.text(grn.total.toLocaleString(undefined, { minimumFractionDigits: 2 }), 196, finalY, { align: 'right' });
    doc.text(grn.total.toLocaleString(undefined, { minimumFractionDigits: 2 }), 196, finalY + 8, { align: 'right' });

    // 7. SIGNATURES (3 sections like image)
    const sigY = 240;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);

    // Left
    doc.line(14, sigY, 55, sigY);
    doc.text("Issuer's Name", 14, sigY + 5);
    doc.line(14, sigY + 15, 55, sigY + 15);
    doc.text("Issuer's Signature", 14, sigY + 20);

    // Middle/Right
    doc.line(110, sigY, 155, sigY);
    doc.text("Recipient's Name", 110, sigY + 5);
    doc.line(110, sigY + 15, 155, sigY + 15);
    doc.text("Recipient's Signature", 110, sigY + 20);

    // Far Right
    doc.line(160, sigY + 30, 201, sigY + 30);
    doc.text("Manager / Asst Signature", 160, sigY + 35);

    // FOOTER
    doc.setDrawColor(200);
    doc.line(14, 280, 196, 280);
    doc.text(`SYSTEM BY SCRIPTSOFT - 0756087280`, 14, 285);
    doc.text(`Page 1 of 1`, 196, 285, { align: "right" });

    doc.save(`GRN_Report_${grn.id.toString().padStart(5, '0')}.pdf`);
}

async function viewGRN(id) {
    const grn = await db.grns.get(id);
    if (!grn) return;

    const content = document.getElementById('grn-preview-content');
    content.innerHTML = `
        <div class="text-center mb-8">
            <h2 class="text-2xl font-black text-slate-800 uppercase">GOOD RECEIVED NOTE</h2>
            <p class="text-xs text-slate-500">ID: #GRN-${grn.id.toString().padStart(6, '0')}</p>
        </div>
        
        <div class="grid grid-cols-2 gap-8 mb-8 text-sm">
            <div>
                <p class="text-slate-400 uppercase font-bold text-[10px]">Supplier Details</p>
                <p class="font-black text-slate-800">${grn.supplier}</p>
                <p class="text-slate-500 underline">Ref: ${grn.reference || 'N/A'}</p>
            </div>
            <div class="text-right">
                <p class="text-slate-400 uppercase font-bold text-[10px]">Date & Time</p>
                <p class="font-bold text-slate-800">${grn.date}</p>
                <p class="text-slate-500">${new Date(grn.timestamp).toLocaleTimeString()}</p>
            </div>
        </div>

        <table class="w-full text-left text-sm mb-8">
            <thead>
                <tr class="border-b-2 border-slate-200">
                    <th class="py-2">Item Description</th>
                    <th class="py-2 text-center">Qty</th>
                    <th class="py-2 text-right">Cost (Rs)</th>
                    <th class="py-2 text-right">Subtotal</th>
                </tr>
            </thead>
            <tbody>
                ${grn.items.map(i => `
                    <tr class="border-b border-slate-100">
                        <td class="py-3">
                            <p class="font-bold text-slate-800">${i.partName}</p>
                            <p class="text-[10px] text-slate-500">${i.partNumber}</p>
                        </td>
                        <td class="py-3 text-center">${i.qty}</td>
                        <td class="py-3 text-right">${i.cost.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td class="py-3 text-right font-bold">${(i.qty * i.cost).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>

        <div class="flex justify-end p-4 bg-slate-50 rounded-2xl">
            <div class="text-right">
                <p class="text-xs text-slate-500 uppercase font-bold">Total GRN Amount</p>
                <p class="text-3xl font-black text-green-600">Rs ${grn.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
            </div>
        </div>
    `;

    document.getElementById('grn-preview-download-btn').onclick = () => generateGrnPdf(id);
    showModal('grn-preview-modal');
    lucide.createIcons();
}

async function deleteGRN(id) {
    if (confirm("Are you sure you want to delete this GRN record? Note: This will NOT automatically reverse the stock additions. You must manually adjust inventory if needed.")) {
        try {
            await db.grns.delete(id);
            showToast("GRN record deleted", "success");
            renderGrnTable();
        } catch (err) {
            console.error(err);
            showToast("Error deleting GRN", "error");
        }
    }
}

// Keyboard Shortcuts for POS
window.addEventListener('keydown', function (e) {
    // Only in POS view
    if (currentView !== 'pos') return;

    // F1: Focus Search
    if (e.key === 'F1') {
        e.preventDefault();
        const search = document.getElementById('global-search');
        if (search) search.focus();
    }
    // F2: Focus Cash Received
    if (e.key === 'F2') {
        e.preventDefault();
        const cash = document.getElementById('cart-cash-received');
        if (cash) {
            cash.focus();
            cash.select();
        }
    }
    // F3: Add Custom Service
    if (e.key === 'F3') {
        e.preventDefault();
        showCustomServiceModal();
    }
    // F4: Focus Discount
    if (e.key === 'F4') {
        e.preventDefault();
        const disc = document.getElementById('cart-discount');
        if (disc) {
            disc.focus();
            disc.select();
        }
    }
    // F8: Checkout Cash
    if (e.key === 'F8') {
        e.preventDefault();
        if (cart.length > 0) checkout('cash');
    }
    // F9: Checkout Credit
    if (e.key === 'F9') {
        e.preventDefault();
        if (cart.length > 0) checkout('credit');
    }
    // ESC: Clear Cart or Close Modal
    if (e.key === 'Escape') {
        // Find open modals
        const modals = ['day-start-modal', 'day-end-modal', 'item-modal', 'service-modal'];
        let modalClosed = false;
        modals.forEach(m => {
            const el = document.getElementById(m);
            if (el && !el.classList.contains('hidden')) {
                hideModal(m);
                modalClosed = true;
            }
        });

        if (!modalClosed && cart.length > 0) {
            if (confirm("Clear current cart?")) clearCart();
        }
    }
});

// Start App Wrapper
function initApp() {
    init();
}

// Global Start
(async () => {
    await seedUsers();
    await checkAuth();
})();

// EMail Notification Logic
async function saveEmailSettings() {
    const email = document.getElementById('settings-email-recipient').value;
    const auto = document.getElementById('settings-email-auto').checked;
    const serviceId = document.getElementById('settings-email-service-id').value;
    const templateId = document.getElementById('settings-email-template-id').value;
    const publicKey = document.getElementById('settings-email-public-key').value;

    if (auto && (!email || !serviceId || !templateId || !publicKey)) {
        return showToast("Please fill all EmailJS fields to enable auto-email", "error");
    }

    const emailSettings = {
        recipient: email,
        autoEmail: auto,
        serviceId,
        templateId,
        publicKey
    };

    await db.settings.put({ key: 'emailSettings', value: emailSettings });
    updateEmailStatusUI(emailSettings);
    showToast("Email settings saved successfully!", "success");
}

function updateEmailStatusUI(settings) {
    const badge = document.getElementById('email-status-badge');
    if (!badge) return;
    if (settings && settings.autoEmail && settings.publicKey) {
        badge.innerText = "ACTIVE";
        badge.className = "px-2 py-0.5 rounded text-[10px] bg-green-500/10 text-green-400 font-bold";
    } else {
        badge.innerText = "DISABLED";
        badge.className = "px-2 py-0.5 rounded text-[10px] bg-red-500/10 text-red-500 font-bold";
    }
}

async function loadEmailSettings() {
    try {
        const result = await db.settings.get('emailSettings');
        if (result) {
            const settings = result.value;
            if (document.getElementById('settings-email-recipient')) {
                document.getElementById('settings-email-recipient').value = settings.recipient || '';
                document.getElementById('settings-email-auto').checked = settings.autoEmail || false;
                document.getElementById('settings-email-service-id').value = settings.serviceId || '';
                document.getElementById('settings-email-template-id').value = settings.templateId || '';
                document.getElementById('settings-email-public-key').value = settings.publicKey || '';
                updateEmailStatusUI(settings);
            }
        }
    } catch (e) { console.error("Load email settings error", e); }
}


async function testEmailConnection() {
    try {
        const email = document.getElementById('settings-email-recipient').value;
        const serviceId = document.getElementById('settings-email-service-id').value;
        const templateId = document.getElementById('settings-email-template-id').value;
        const publicKey = document.getElementById('settings-email-public-key').value;

        if (!email || !serviceId || !templateId || !publicKey) {
            return showToast("Please fill all fields to test", "error");
        }

        showToast("Sending test email...", "info");

        emailjs.init(publicKey);
        const res = await emailjs.send(serviceId, templateId, {
            to_email: email,
            report_date: new Date().toLocaleDateString(),
            float_cash: "TEST-FLOAT",
            cash_sales: "TEST-SALES",
            credit_sales: "TEST-CREDIT",
            expected_cash: "TEST-EXPECTED",
            actual_cash: "TEST-ACTUAL",
            variance: "TEST-VARIANCE",
            total_revenue: "TEST-REVENUE",
            estimated_profit: "TEST-PROFIT",
            generated_by: "TEST-USER"
        });

        console.log("EmailJS Success:", res);
        showToast("Test email SENT! Check your inbox.", "success");
    } catch (error) {
        console.error('Email Test Failed:', error);
        showToast("Test Failed: " + (error.text || error.message || "Unknown error"), "error");
    }
}

async function sendDayEndEmail(metrics) {
    try {
        const result = await db.settings.get('emailSettings');
        if (!result || !result.value.autoEmail || !result.value.publicKey) {
            console.log("Auto-email disabled or settings missing.");
            return;
        }

        const settings = result.value;
        const today = new Date().toLocaleDateString();

        const templateParams = {
            to_email: settings.recipient,
            report_date: today,
            float_cash: `Rs ${(metrics.float || 0).toLocaleString()}`,
            cash_sales: `Rs ${(metrics.cashSales || 0).toLocaleString()}`,
            credit_sales: `Rs ${(metrics.creditSales || 0).toLocaleString()}`,
            expected_cash: `Rs ${(metrics.float + metrics.cashSales - metrics.expenses).toLocaleString()}`,
            actual_cash: `Rs ${(metrics.cashInHand || 0).toLocaleString()}`,
            variance: `Rs ${(metrics.variance || 0).toLocaleString()}`,
            total_revenue: `Rs ${(metrics.totalSales || 0).toLocaleString()}`,
            estimated_profit: `Rs ${(metrics.netProfit || 0).toLocaleString()}`,
            generated_by: currentUser?.username || 'System'
        };

        console.log("Sending Day End Email with params:", templateParams);

        emailjs.init(settings.publicKey);
        const res = await emailjs.send(settings.serviceId, settings.templateId, templateParams);
        console.log("Day End Email Sent:", res);
        showToast("Summary email sent successfully!", "success");
    } catch (error) {
        console.error('Email failed during Day End:', error);
        showToast("Email failed! Check settings (" + (error.text || "Connection Error") + ")", "error");
    }
}

// Service Reminders Logic
async function renderReminders() {
    const search = document.getElementById('reminder-search').value.toLowerCase();
    const filter = document.getElementById('reminder-filter').value;
    const allSales = await db.sales.toArray();

    // Group sales by vehicle to find the LAST service for each
    const vehicleLastService = {};
    allSales.forEach(sale => {
        if (!vehicleLastService[sale.vehicleNo] || sale.timestamp > vehicleLastService[sale.vehicleNo].timestamp) {
            vehicleLastService[sale.vehicleNo] = sale;
        }
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const reminders = [];

    for (const vNo in vehicleLastService) {
        const lastSale = vehicleLastService[vNo];
        const lastDate = new Date(lastSale.timestamp);

        // Rule: 90 days after last service
        const dueDate = new Date(lastDate);
        dueDate.setDate(dueDate.getDate() + 90);

        const diffDays = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
        const mileageAtService = lastSale.mileage || 0;
        const nextMileageDue = mileageAtService > 0 ? (mileageAtService + 5000) : 0;

        const reminder = {
            vehicleNo: vNo,
            customerName: lastSale.customerName,
            customerPhone: lastSale.customerPhone,
            lastDate: lastSale.date,
            lastMileage: mileageAtService,
            dueDate: dueDate.toLocaleDateString(),
            dueTimestamp: dueDate.getTime(),
            nextMileageDue: nextMileageDue,
            daysLeft: diffDays,
            isOverdue: diffDays < 0
        };

        // Filter search
        const matchesSearch = vNo.toLowerCase().includes(search) || (reminder.customerName && reminder.customerName.toLowerCase().includes(search));

        // Filter logic
        let matchesFilter = true;
        if (filter === 'overdue') matchesFilter = reminder.isOverdue;
        if (filter === 'upcoming') matchesFilter = (diffDays >= 0 && diffDays <= 7);

        if (matchesSearch && matchesFilter) {
            reminders.push(reminder);
        }
    }

    // Sort by due date (overdue first)
    reminders.sort((a, b) => a.dueTimestamp - b.dueTimestamp);

    const container = document.getElementById('reminder-list-body');
    if (!container) return;

    document.getElementById('reminder-count-total').innerText = reminders.length;
    document.getElementById('reminder-count-today').innerText = reminders.filter(r => r.daysLeft <= 0).length;

    if (reminders.length === 0) {
        container.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-slate-500 italic">No reminders found</td></tr>`;
        return;
    }

    container.innerHTML = reminders.map(r => `
        <tr class="hover:bg-amber-500/5 transition-colors group">
            <td class="px-6 py-4">
                <p class="font-bold text-slate-100">${r.vehicleNo}</p>
                <p class="text-[10px] text-slate-500">${r.customerName}</p>
            </td>
            <td class="px-6 py-4">
                <p class="text-xs text-slate-400">${r.lastDate}</p>
            </td>
            <td class="px-6 py-4 text-xs">
                <span class="text-slate-200">${r.lastMileage.toLocaleString()} KM</span>
                <p class="text-[9px] text-slate-500">Next due: ${r.nextMileageDue.toLocaleString()} KM</p>
            </td>
            <td class="px-6 py-4">
                <p class="text-xs ${r.isOverdue ? 'text-red-400 font-bold' : 'text-slate-300'}">${r.dueDate}</p>
                <p class="text-[10px] ${r.isOverdue ? 'text-red-500' : 'text-slate-500'} font-bold">
                    ${r.isOverdue ? `Overdue by ${Math.abs(r.daysLeft)} days` : `In ${r.daysLeft} days`}
                </p>
            </td>
            <td class="px-6 py-4 text-center">
                <button onclick="sendReminderWhatsApp('${r.customerPhone}', '${r.vehicleNo}', ${r.nextMileageDue})" 
                    class="bg-green-600/10 hover:bg-green-600 text-green-500 hover:text-white border border-green-500/20 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all flex items-center gap-2 mx-auto">
                    <i data-lucide="phone" class="w-3 h-3"></i>
                    SEND REMINDER
                </button>
            </td>
        </tr>
    `).join('');

    lucide.createIcons();
}

function sendReminderWhatsApp(phone, vehicle, mileage) {
    if (!phone || phone === '-') return showToast("No phone number available", "error");

    const cleanPhone = phone.replace(/\D/g, '');
    const phoneWithCountry = cleanPhone.startsWith('94') ? cleanPhone : `94${cleanPhone.startsWith('0') ? cleanPhone.slice(1) : cleanPhone}`;

    const message = `*LP AUTO ZONE - SERVICE REMINDER*%0A%0A` +
        `Hi, Your vehicle *${vehicle}* is due for service/oil change.%0A` +
        `Next recommended service mileage: *${mileage.toLocaleString()} KM*.%0A%0A` +
        `Please visit *LP Auto Zone, Madapatha* for professional care.%0A` +
        `Call: 0714943786 / 0740249796%0A%0A` +
        `Thank you!`;

    window.open(`https://wa.me/${phoneWithCountry}?text=${message}`, '_blank');
}

// Vehicle Profile & Images Logic
async function renderVehicleList() {
    const search = document.getElementById('vehicle-view-search').value.toLowerCase();
    const vehicles = await db.vehicles.toArray();
    const container = document.getElementById('vehicle-cards-container');

    const filtered = vehicles.filter(v => v.vehicleNo.toLowerCase().includes(search));

    if (filtered.length === 0) {
        container.innerHTML = `<div class="col-span-full py-20 text-center text-slate-500 italic">No vehicle profiles found. Start by clicking 'INFO' in POS.</div>`;
        return;
    }

    container.innerHTML = filtered.map(v => `
        <div class="glass p-6 rounded-3xl border border-slate-700 hover:border-sky-500/50 transition-all group overflow-hidden relative">
            <div class="flex justify-between items-start mb-4">
                <div>
                    <h4 class="text-xl font-black text-sky-400">${v.vehicleNo}</h4>
                    <p class="text-xs text-slate-400">${v.model || 'Unknown Model'}</p>
                </div>
                <button onclick="openVehicleProfile('${v.vehicleNo}')" class="p-2 bg-sky-500/10 text-sky-400 rounded-lg hover:bg-sky-500 hover:text-white transition-all">
                    <i data-lucide="edit-3" class="w-4 h-4"></i>
                </button>
            </div>
            
            <div class="space-y-2 mb-4 text-[11px]">
                <div class="flex justify-between">
                    <span class="text-slate-500 uppercase">Engine</span>
                    <span class="text-slate-300 font-mono">${v.engine || '-'}</span>
                </div>
                <div class="flex justify-between">
                    <span class="text-slate-500 uppercase">Year</span>
                    <span class="text-slate-300">${v.year || '-'}</span>
                </div>
            </div>

            <div class="flex -space-x-2 overflow-hidden mb-4 h-8">
                ${(v.images || []).slice(0, 5).map(img => `
                    <img src="${img}" class="inline-block h-8 w-8 rounded-full ring-2 ring-slate-800 object-cover">
                `).join('')}
                ${(v.images || []).length > 5 ? `<span class="flex items-center justify-center h-8 w-8 rounded-full bg-slate-700 ring-2 ring-slate-800 text-[8px] font-bold text-white">+${v.images.length - 5}</span>` : ''}
            </div>

            <button onclick="switchView('history'); setTimeout(() => { document.getElementById('history-search').value = '${v.vehicleNo}'; renderHistory(); }, 100);" 
                class="w-full py-2 bg-slate-800 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-slate-700 transition-colors">
                View service history
            </button>
        </div>
    `).join('');

    lucide.createIcons();
}

async function openVehicleProfileFromPos() {
    const vNo = document.getElementById('cart-vehicle-no').value.trim().toUpperCase();
    if (!vNo) return showToast("Enter Vehicle Number first", "error");
    openVehicleProfile(vNo);
}

async function openVehicleProfile(vNo) {
    const vehicle = await db.vehicles.where('vehicleNo').equals(vNo).first();

    // Reset Form
    document.getElementById('vehicle-form').reset();
    document.getElementById('v-profile-id').value = vehicle ? vehicle.id : '';
    document.getElementById('v-profile-no').value = vNo;
    document.getElementById('v-modal-title-no').innerText = vNo;
    document.getElementById('v-image-gallery').innerHTML = '';

    if (vehicle) {
        document.getElementById('v-model').value = vehicle.model || '';
        document.getElementById('v-year').value = vehicle.year || '';
        document.getElementById('v-engine').value = vehicle.engine || '';
        document.getElementById('v-chassis').value = vehicle.chassis || '';
        document.getElementById('v-notes').value = vehicle.notes || '';
        renderVehicleImageGallery(vehicle.images || []);
    }

    showModal('vehicle-modal');
}

async function handleVehicleSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('v-profile-id').value;
    const vNo = document.getElementById('v-profile-no').value;
    const cPhone = document.getElementById('cart-customer-phone').value.trim();

    const data = {
        vehicleNo: vNo,
        customerPhone: cPhone,
        model: document.getElementById('v-model').value,
        year: document.getElementById('v-year').value,
        engine: document.getElementById('v-engine').value,
        chassis: document.getElementById('v-chassis').value,
        notes: document.getElementById('v-notes').value,
        updatedAt: Date.now()
    };

    if (id) {
        await db.vehicles.update(Number(id), data);
    } else {
        data.images = [];
        await db.vehicles.add(data);
    }

    showToast("Vehicle profile updated", "success");
    hideModal('vehicle-modal');
    if (currentView === 'vehicles') renderVehicleList();
}

async function handleVehicleImages(e) {
    const files = e.target.files;
    const vNo = document.getElementById('v-profile-no').value;
    if (!vNo) return;

    let vehicle = await db.vehicles.where('vehicleNo').equals(vNo).first();

    // Auto-create profile if missing
    if (!vehicle) {
        const id = await db.vehicles.add({
            vehicleNo: vNo,
            customerPhone: document.getElementById('cart-customer-phone').value.trim(),
            images: [],
            updatedAt: Date.now()
        });
        vehicle = await db.vehicles.get(id);
    }

    const currentImages = vehicle.images || [];

    for (let file of files) {
        const base64 = await convertToBase64(file);
        currentImages.push(base64);
    }

    await db.vehicles.update(vehicle.id, { images: currentImages });
    renderVehicleImageGallery(currentImages);
    showToast(`${files.length} Photo(s) added`, "success");
}

function renderVehicleImageGallery(images) {
    const container = document.getElementById('v-image-gallery');
    container.innerHTML = images.map((img, idx) => `
        <div class="relative group aspect-square rounded-xl overflow-hidden border border-slate-700 bg-black">
            <img src="${img}" class="w-full h-full object-cover">
            <button onclick="deleteVehicleImage(${idx})" 
                class="absolute top-1 right-1 bg-red-600 text-white p-1 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity">
                <i data-lucide="trash-2" class="w-3 h-3"></i>
            </button>
        </div>
    `).join('');
    lucide.createIcons();
}

async function deleteVehicleImage(idx) {
    const vNo = document.getElementById('v-profile-no').value;
    const vehicle = await db.vehicles.where('vehicleNo').equals(vNo).first();
    const images = vehicle.images || [];
    images.splice(idx, 1);
    await db.vehicles.update(vehicle.id, { images });
    renderVehicleImageGallery(images);
}

// Barcode Scanner Integration
function focusBarcode() {
    const catchInput = document.getElementById('barcode-catch');
    if (catchInput) {
        catchInput.focus();
        showToast("Scanner Ready", "success");
    }
}

// Global Listener to catch scanner input when not in any other input
document.addEventListener('keydown', (e) => {
    // If user is typing in any other input, don't hijack
    const active = document.activeElement.tagName;
    if (active === 'INPUT' || active === 'TEXTAREA' || active === 'SELECT') {
        // Exception for our hidden barcode catch
        if (document.activeElement.id !== 'barcode-catch') return;
    }

    // Typical scanners end with 'Enter'
    if (e.key === 'Enter') {
        const catchInput = document.getElementById('barcode-catch');
        const code = catchInput.value.trim();
        if (code) {
            handleBarcodeScan(code);
            catchInput.value = '';
        }
    } else {
        // Auto-focus our catch input if user starts typing a potential barcode
        // but only if we are in POS view
        if (currentView === 'pos') {
            document.getElementById('barcode-catch').focus();
        }
    }
});

async function handleBarcodeScan(code) {
    // 1. Search by Part Number (Barcode)
    const item = await db.inventory.where('partNumber').equals(code).first();

    if (item) {
        if (item.stock <= 0) {
            showToast(`Out of stock: ${item.partName}`, "error");
            return;
        }

        // Add to cart logic (mimic addToCart)
        const cartItem = cart.find(i => i.id === item.id && i.type === 'item');
        if (cartItem) {
            if (cartItem.qty + 1 <= item.stock) {
                cartItem.qty++;
            } else {
                showToast("Insufficient stock!", "error");
                return;
            }
        } else {
            cart.push({
                ...item,
                qty: 1,
                type: 'item',
                price: Number(item.sellingPrice) || Number(item.price) || 0
            });
        }

        updateCartUI();
        showToast(`Added: ${item.partName}`, "success");

        // Visual feedback on grid if possible
        const card = document.querySelector(`[data-item-id="${item.id}"]`);
        if (card) {
            card.classList.add('ring-4', 'ring-primary');
            setTimeout(() => card.classList.remove('ring-4', 'ring-primary'), 500);
        }
    } else {
        showToast(`Barcode not found: ${code}`, "error");
    }
}

// Supplier Management Logic
async function renderSuppliers() {
    const suppliers = await db.suppliers.toArray();
    const grns = await db.grns.toArray();
    const container = document.getElementById('supplier-list-body');
    if (!container) return;

    let totalPayableGlobal = 0;

    const supplierData = suppliers.map((s, idx) => {
        const sGrns = grns.filter(g => g.supplierId === s.id);
        const totalPurchased = sGrns.reduce((sum, g) => sum + (g.total || 0), 0);
        const totalPaid = sGrns.reduce((sum, g) => sum + (g.paidAmount || 0), 0);
        const outstanding = totalPurchased - totalPaid;

        totalPayableGlobal += outstanding;

        return {
            ...s,
            idx: idx + 1,
            totalPurchased,
            totalPaid,
            outstanding
        };
    });

    const countEl = document.getElementById('supplier-count');
    const payableEl = document.getElementById('supplier-total-payable');
    if (countEl) countEl.innerText = suppliers.length;
    if (payableEl) payableEl.innerText = `Rs ${totalPayableGlobal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    if (supplierData.length === 0) {
        container.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-slate-500 italic">No suppliers found. Click 'ADD NEW SUPPLIER' to start.</td></tr>`;
        return;
    }

    container.innerHTML = supplierData.map(s => `
        <tr class="hover:bg-emerald-500/5 transition-colors group">
            <td class="px-6 py-4 text-center font-mono text-xs text-slate-500">${s.idx}</td>
            <td class="px-6 py-4">
                <p class="font-bold text-slate-100">${s.name}</p>
                <p class="text-[10px] text-slate-500">${s.address || 'No address'}</p>
            </td>
            <td class="px-6 py-4">
                <p class="text-xs text-slate-300 font-medium">${s.phone || '-'}</p>
            </td>
            <td class="px-6 py-4 text-right">
                <p class="text-sm font-black ${s.outstanding > 0 ? 'text-red-400' : 'text-emerald-400'}">
                    Rs ${s.outstanding.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
                <p class="text-[9px] text-slate-500 uppercase tracking-wider">Total Buys: Rs ${s.totalPurchased.toLocaleString()}</p>
            </td>
            <td class="px-6 py-4">
                <div class="flex items-center justify-center gap-2">
                    <button onclick="openSupplierLedger(${s.id})" title="View Ledger"
                        class="p-2 bg-blue-500/10 text-blue-400 rounded-lg hover:bg-blue-500 hover:text-white transition-all">
                        <i data-lucide="book-open" class="w-4 h-4"></i>
                    </button>
                    ${s.outstanding > 0 ? `
                    <button onclick="openPaySupplierModal(${s.id}, \`${s.name.replace(/'/g, "\\'")}\`, ${s.outstanding})" title="Pay Supplier"
                        class="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg hover:bg-emerald-500 hover:text-white transition-all">
                        <i data-lucide="wallet" class="w-4 h-4"></i>
                    </button>` : ''}
                    <button onclick="editSupplier(${s.id})" title="Edit Info"
                        class="p-2 bg-slate-700/50 text-white rounded-lg hover:bg-slate-600 transition-all">
                        <i data-lucide="edit-3" class="w-4 h-4"></i>
                    </button>
                    <button onclick="deleteSupplier(${s.id})" title="Delete Supplier"
                        class="p-2 bg-red-500/10 text-red-500 rounded-lg hover:bg-red-500 hover:text-white transition-all">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                </div>
            </td>
        </tr>
    `).join('');

    lucide.createIcons();
    populateGrnSuppliers();
}

async function handleSupplierSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('supplier-id').value;
    const name = document.getElementById('supplier-name').value.trim();
    const phone = document.getElementById('supplier-phone').value.trim();
    const address = document.getElementById('supplier-address').value.trim();

    try {
        if (id) {
            await db.suppliers.update(Number(id), { name, phone, address });
            showToast("Supplier updated", "success");
        } else {
            await db.suppliers.add({ name, phone, address });
            showToast("Supplier added", "success");
        }
        hideModal('supplier-modal');
        document.getElementById('supplier-id').value = '';
        e.target.reset();
        renderSuppliers();
    } catch (err) {
        showToast("Error: Supplier name already exists", "error");
    }
}

async function editSupplier(id) {
    const s = await db.suppliers.get(id);
    if (!s) return;
    document.getElementById('supplier-id').value = s.id;
    document.getElementById('supplier-name').value = s.name;
    document.getElementById('supplier-phone').value = s.phone || '';
    document.getElementById('supplier-address').value = s.address || '';
    showModal('supplier-modal');
}

async function deleteSupplier(id) {
    if (!confirm("Are you sure? This will NOT delete GRNs, but they will become unlinked.")) return;
    await db.suppliers.delete(id);
    showToast("Supplier deleted", "success");
    renderSuppliers();
}

function openPaySupplierModal(id, name, outstanding) {
    document.getElementById('pay-supplier-name').innerText = name;
    document.getElementById('pay-supplier-total').innerText = `Rs ${outstanding.toLocaleString()}`;
    document.getElementById('supplier-pay-amount').value = outstanding;
    document.getElementById('supplier-pay-amount').dataset.supplierId = id;
    showModal('supplier-payment-modal');
}

async function processSupplierPayment() {
    const id = Number(document.getElementById('supplier-pay-amount').dataset.supplierId);
    let amountToPay = parseFloat(document.getElementById('supplier-pay-amount').value) || 0;

    if (amountToPay <= 0) return showToast("Invalid amount", "error");

    const sGrns = await db.grns.where('supplierId').equals(id).toArray();
    // Sort by timestamp to pay oldest GRNs first
    sGrns.sort((a, b) => a.timestamp - b.timestamp);

    for (const g of sGrns) {
        const outstanding = (g.total || 0) - (g.paidAmount || 0);
        if (outstanding > 0 && amountToPay > 0) {
            const payment = Math.min(outstanding, amountToPay);
            await db.grns.update(g.id, { paidAmount: (g.paidAmount || 0) + payment });
            amountToPay -= payment;
        }
    }

    showToast("Payment processed successfully", "success");
    hideModal('supplier-payment-modal');
    renderSuppliers();
}

async function openSupplierLedger(id) {
    const s = await db.suppliers.get(id);
    const sGrns = await db.grns.where('supplierId').equals(id).toArray();
    sGrns.sort((a, b) => b.timestamp - a.timestamp);

    const totalPurchased = sGrns.reduce((sum, g) => sum + (g.total || 0), 0);
    const totalPaid = sGrns.reduce((sum, g) => sum + (g.paidAmount || 0), 0);
    const net = totalPurchased - totalPaid;

    document.getElementById('ledger-supplier-name').innerText = s.name;
    document.getElementById('ledger-total-grn').innerText = `Rs ${totalPurchased.toLocaleString()}`;
    document.getElementById('ledger-total-paid').innerText = `Rs ${totalPaid.toLocaleString()}`;
    document.getElementById('ledger-net-balance').innerText = `Rs ${net.toLocaleString()}`;

    const content = document.getElementById('supplier-ledger-content');
    if (sGrns.length === 0) {
        content.innerHTML = `<div class="p-10 text-center text-slate-500 italic">No GRN records for this supplier</div>`;
    } else {
        content.innerHTML = sGrns.map(g => `
            <div class="glass p-5 rounded-2xl border border-slate-700/50 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-xs bg-slate-700 px-2 py-0.5 rounded text-slate-300 font-mono">${g.date}</span>
                        <span class="text-sm font-bold text-slate-200">Ref: ${g.reference || '-'}</span>
                    </div>
                    <div class="flex flex-wrap gap-2">
                        ${g.items.map(item => `<span class="text-[9px] bg-sky-500/10 text-sky-400 px-1.5 py-0.5 rounded border border-sky-500/20">${item.partName} x${item.qty}</span>`).join('')}
                    </div>
                </div>
                <div class="text-right">
                    <p class="text-xs text-slate-500 uppercase font-bold">Total: Rs ${g.total.toLocaleString()}</p>
                    <p class="text-sm font-black ${g.total - g.paidAmount > 0 ? 'text-red-400' : 'text-emerald-400'}">
                        Outstanding: Rs ${(g.total - g.paidAmount).toLocaleString()}
                    </p>
                </div>
            </div>
        `).join('');
    }

    showModal('supplier-ledger-modal');
    lucide.createIcons();
}

async function populateGrnSuppliers() {
    const suppliers = await db.suppliers.toArray();
    const select = document.getElementById('grn-supplier-id');
    if (!select) return;

    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Select Supplier --</option>' +
        suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    select.value = currentVal;
}

function convertToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

// Industrial Analytics Logic
let charts = {}; // To store chart instances for proper destruction/update

async function renderAnalytics() {
    const days = parseInt(document.getElementById('analytics-period').value) || 30;
    const now = new Date();
    const startTime = now.getTime() - (days * 24 * 60 * 60 * 1000);

    // Fetch data from IndexedDB
    const sales = await db.sales.where('timestamp').above(startTime).toArray();
    const inventory = await db.inventory.toArray();

    // Summary Stats
    const totalRev = sales.reduce((sum, s) => sum + (s.total || 0), 0);
    const totalInvoices = sales.length;
    const outOfStock = inventory.filter(i => (i.stock || 0) <= 0).length;

    // Calculate Estimated Profit
    // We assume sale items contain 'buyingPrice' at time of sale, 
    // if not we use current inventory buying price (proxy)
    let totalProfit = 0;
    sales.forEach(s => {
        if (s.items) {
            s.items.forEach(item => {
                const boughtAt = item.buyingPrice || 0;
                const soldAt = item.price || 0;
                const qty = item.qty || 0;
                if (item.type === 'item') {
                    totalProfit += (soldAt - boughtAt) * qty;
                } else {
                    // Service profit is 100% minus labor (if we track labor)
                    // Currently assuming services are 100% gain for garage
                    totalProfit += soldAt * qty;
                }
            });
        }
        // Discount subtracts from profit
        totalProfit -= (s.discount || 0);
    });

    // Update UI Stats
    document.getElementById('stat-total-revenue').innerText = `Rs ${totalRev.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('stat-total-profit').innerText = `Rs ${totalProfit.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    document.getElementById('stat-total-invoices').innerText = totalInvoices;
    document.getElementById('stat-out-of-stock').innerText = outOfStock;

    // Data Preparation for Charts
    prepareTrendChart(sales, days);
    prepareTopPartsChart(sales);
    prepareCategoryChart(sales);
    prepareWeeklyActivityChart(sales);
}

function prepareTrendChart(sales, days) {
    const dailyData = {};
    const now = new Date();

    // Initialize days
    for (let i = days; i >= 0; i--) {
        const d = new Date(now.getTime() - (i * 24 * 60 * 60 * 1000));
        const dateStr = d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
        dailyData[dateStr] = { rev: 0, profit: 0 };
    }

    sales.forEach(s => {
        const d = new Date(s.timestamp);
        const dateStr = d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
        if (dailyData[dateStr]) {
            dailyData[dateStr].rev += (s.total || 0);

            // Profit calc
            let p = 0;
            if (s.items) {
                s.items.forEach(it => {
                    const price = it.price || 0;
                    const cost = it.buyingPrice || 0;
                    p += it.type === 'item' ? (price - cost) * it.qty : price * it.qty;
                });
            }
            dailyData[dateStr].profit += (p - (s.discount || 0));
        }
    });

    const labels = Object.keys(dailyData);
    const revs = labels.map(l => dailyData[l].rev);
    const profits = labels.map(l => dailyData[l].profit);

    createChart('chart-sales-trend', 'line', {
        labels,
        datasets: [
            {
                label: 'Revenue',
                data: revs,
                borderColor: '#f59e0b',
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                fill: true,
                tension: 0.4
            },
            {
                label: 'Profit',
                data: profits,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                fill: true,
                tension: 0.4
            }
        ]
    });
}

function prepareTopPartsChart(sales) {
    const partsCount = {};
    sales.forEach(s => {
        if (s.items) {
            s.items.forEach(it => {
                if (it.type === 'item') {
                    partsCount[it.partName] = (partsCount[it.partName] || 0) + it.qty;
                }
            });
        }
    });

    const top6 = Object.entries(partsCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);

    createChart('chart-top-parts', 'bar', {
        labels: top6.map(p => p[0]),
        datasets: [{
            label: 'Qty Sold',
            data: top6.map(p => p[1]),
            backgroundColor: '#3b82f6'
        }]
    }, { indexAxis: 'y' });
}

function prepareCategoryChart(sales) {
    const cats = {};
    sales.forEach(s => {
        if (s.items) {
            s.items.forEach(it => {
                const c = it.category || 'Other';
                cats[c] = (cats[c] || 0) + ((it.price || 0) * (it.qty || 1));
            });
        }
    });

    createChart('chart-category-dist', 'doughnut', {
        labels: Object.keys(cats),
        datasets: [{
            data: Object.values(cats),
            backgroundColor: ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b']
        }]
    }, { plugins: { legend: { position: 'bottom' } } });
}

function prepareWeeklyActivityChart(sales) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const data = [0, 0, 0, 0, 0, 0, 0];

    sales.forEach(s => {
        const d = new Date(s.timestamp).getDay();
        data[d] += (s.total || 0);
    });

    createChart('chart-weekly-activity', 'bar', {
        labels: days,
        datasets: [{
            label: 'Sales Volume',
            data: data,
            backgroundColor: 'rgba(59, 130, 246, 0.5)',
            borderColor: '#3b82f6',
            borderWidth: 2
        }]
    });
}

function createChart(id, type, data, options = {}) {
    if (charts[id]) charts[id].destroy();
    const ctx = document.getElementById(id).getContext('2d');

    // Industrial theme defaults
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.borderColor = 'rgba(148, 163, 184, 0.1)';

    charts[id] = new Chart(ctx, {
        type,
        data,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: type === 'doughnut' },
                ...options.plugins
            },
            ...options
        }
    });
}
