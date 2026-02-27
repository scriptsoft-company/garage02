# Project: Garage & Spare Parts POS System

## 1. Project Overview
A specialized POS system for a garage that manages spare parts inventory, repair services (labor charges), and vehicle-wise service history. It functions entirely in the browser using an offline-first approach.

## 2. Business Requirements
### A. Inventory & Parts Management
* Store parts with Name, Part Number, Price, and Stock Quantity.
* Automatic stock deduction when a part is added to a bill.
* "Low Stock" indicators for essential items (e.g., Oil, Brake pads).

### B. Repair & Service Management (Job Cards)
* Ability to record Vehicle Number (e.g., WP CP-1234).
* Option to add "Labor/Service Charges" which don't have stock but have a price.
* Track the mechanic's name if necessary.

### C. Billing & Invoicing
* Unified billing: Mix both Spare Parts and Labor charges in one invoice.
* Discount handling (Percentage or Fixed amount).
* Payment modes: Cash or Credit (to track regular customers).
* Auto-generated invoice with "Garage Name," "Vehicle Number," and "Itemized List."

### D. Customer & History
* Search history by Vehicle Number to see previous repairs and parts replaced.
* Daily and Monthly profit/loss overview.

---

## 3. Technical Requirements & Stack
* **UI/UX:** Tailwind CSS for a rugged, dark-themed or professional garage UI.
* **Database:** Dexie.js (IndexedDB) for permanent local storage.
* **Icons:** Lucide-icons or FontAwesome for visual navigation.
* **Framework:** No complex frameworks—just pure HTML5 and Vanilla JavaScript.

---

## 4. Database Schema (Dexie.js)
The database `GarageMasterDB` will have the following tables:
* `inventory`: `++id, partName, partNumber, price, stock, category`
* `sales`: `++id, vehicleNo, items, subtotal, discount, total, paymentMethod, date`
* `services`: `++id, serviceName, cost`

---

## 5. Detailed Implementation Steps

### Phase 1: Environment Setup
1. Create `index.html`.
2. Include Tailwind via CDN: `<script src="https://cdn.tailwindcss.com"></script>`.
3. Include Dexie.js: `<script src="https://unpkg.com/dexie/dist/dexie.js"></script>`.

### Phase 2: Interface Design
* **Header:** Search bar for Vehicle History + Garage Brand Name.
* **Left Panel (Store):** Categories (Engine, Body, Electrical, Service).
* **Middle Panel (POS):** A list of parts/services with "Add" buttons.
* **Right Panel (Invoice):** Vehicle Info input fields + Cart + Total + Pay Button.

### Phase 3: Core Logic (JavaScript)
1. **Database Initialization:** Setup Dexie stores.
2. **Inventory Logic:** * `updateStock(id, qty)`: Function to decrease stock after sale.
    * `restock(id, qty)`: Function to add new stock.
3. **Billing Logic:** * `calculateTotal()`: Calculate sum of (part price * qty) + labor charges.
    * `applyDiscount()`: Deduct from the final total.
4. **Search Logic:**
    * `getVehicleHistory(vNo)`: Filter `sales` table by vehicle number.

### Phase 4: Invoice Generation
1. Create a print-friendly CSS media query.
2. Use `window.print()` or `html2pdf.js` to generate a professional invoice containing the Vehicle Number and Date.

---

## 6. File Structure
```text
/garage-pos
│
├── index.html          # UI and HTML structure
├── script.js           # Dexie DB logic and UI interactions
└── styles.css          # Custom Tailwind configurations and print styles