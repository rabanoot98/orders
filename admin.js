// ============================================================
// ממשק ניהול: הזמנות, ארכיון, מלאי, משתמשים
// ============================================================
import {
  sb, ADMIN_EMAIL, WH_LABEL, WAREHOUSES, WH_KEYS, emptyByWarehouse, state,
  $, on, esc, showScreen, toast, showError, fmtDate, friendlyError,
  caps, fetchInventory, isMissingColumn,
} from './lib.js';

const INV_COLS = 'id, warehouse, name, qty, category, exposed';

let inventory = emptyByWarehouse();
let invEditMode = false;
let invWarehouse = 'main';   // המחסן המוצג כרגע בלשונית המלאי

// ── פתיחה + לשוניות ─────────────────────────────────────────
export function openAdmin() {
  showScreen('adminScreen', { title: 'ניהול', sub: 'לוח בקרה', back: true });
  setTab('orders');
}

function setTab(pane) {
  document.querySelectorAll('.admin-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.pane === pane));
  ['orders', 'archive', 'inventory', 'users', 'notify'].forEach(p =>
    $(p + 'Pane').classList.toggle('active', p === pane));

  if (pane === 'orders') loadOrders();
  if (pane === 'archive') loadArchive();
  if (pane === 'inventory') { showInvPicker(); loadInventory(); }
  if (pane === 'users') loadUsers();
  if (pane === 'notify') loadNotify();
}

// ── הזמנות ──────────────────────────────────────────────────
const ORDER_SELECT = 'id, initials, phone, email, warehouse, status, cert_mode, cert_path, created_at, approved_at, order_items(id, name, qty)';

async function fetchOrders(statuses) {
  const { data, error } = await sb.from('orders')
    .select(ORDER_SELECT)
    .in('status', statuses)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function loadOrders() {
  const el = $('ordersList');
  el.innerHTML = '<div class="loading"><div class="spinner"></div><div>טוען הזמנות...</div></div>';
  try {
    const orders = await fetchOrders(['pending']);
    el.innerHTML = orders.length
      ? orders.map(o => orderCard(o, false)).join('')
      : '<div class="admin-empty">אין הזמנות ממתינות 📭</div>';
  } catch (err) {
    el.innerHTML = `<div class="admin-empty">שגיאה: ${esc(friendlyError(err))}</div>`;
  }
}

async function loadArchive() {
  const el = $('archiveList');
  el.innerHTML = '<div class="loading"><div class="spinner"></div><div>טוען ארכיון...</div></div>';
  try {
    const orders = await fetchOrders(['ready', 'collected']);
    el.innerHTML = orders.length
      ? orders.map(o => orderCard(o, true)).join('')
      : '<div class="admin-empty">הארכיון ריק</div>';
  } catch (err) {
    el.innerHTML = `<div class="admin-empty">שגיאה: ${esc(friendlyError(err))}</div>`;
  }
}

function orderCard(o, archived) {
  const isReady = o.status === 'ready';
  const isCollected = o.status === 'collected';
  const stCls = isCollected ? 'collected' : (isReady ? 'approved' : 'pending');
  const stLabel = isCollected ? 'נאספה' : (isReady ? 'מוכנה לאיסוף' : 'ממתינה לאישור');

  const items = (o.order_items || []).map(it => `
    <div class="order-item-row" data-item="${it.id}">
      <span class="order-item-name">${esc(it.name)}</span>
      ${archived ? `<span class="oi-qty">×${it.qty}</span>` : `
        <button class="oi-qty-btn" data-act="dec">−</button>
        <input type="number" class="oi-qty-input" value="${it.qty}" min="0"
               data-act="qty" data-prev="${it.qty}" inputmode="numeric" aria-label="כמות">
        <button class="oi-qty-btn" data-act="inc">+</button>
        <button class="oi-qty-btn" data-act="rm" title="הסר">×</button>`}
    </div>`).join('');

  const cert = o.cert_path
    ? `<div class="cert-row">📎 תעודת ספק צורפה
         <button class="cert-dl" data-act="cert" style="margin-right:auto">⬇ הורד</button></div>`
    : `<div class="cert-row none">📋 תעודת ספק תוגש באיסוף</div>`;

  const actions = archived
    ? `<div class="order-actions">
         ${isReady ? `<button class="btn-approve" data-act="collected" style="background:#546e7a">סמן כנאספה</button>` : ''}
         <button class="btn-delete" data-act="del">🗑️</button>
       </div>`
    : `<div class="order-actions">
         <button class="btn-approve" data-act="approve">אשר הזמנה + הורד מלאי</button>
         <button class="btn-delete" data-act="del">🗑️</button>
       </div>`;

  return `<div class="order-card ${isReady || isCollected ? 'approved' : ''}" data-order="${o.id}">
    <div class="order-head">
      <div class="order-meta">
        <div class="order-customer">${esc(o.initials || '—')}</div>
        <div class="order-sub">${esc(o.phone || '')}${o.email ? ' · ' + esc(o.email) : ''}</div>
        <div class="order-sub">${esc(fmtDate(o.created_at))}</div>
        <div class="order-wh">📦 ${esc(WH_LABEL[o.warehouse] || o.warehouse)}</div>
      </div>
      <span class="order-status ${stCls}">${stLabel}</span>
    </div>
    <div class="order-items">${items}</div>
    ${cert}
    ${actions}
  </div>`;
}

// ── פעולות על הזמנה ─────────────────────────────────────────
async function approveOrder(orderId, cardEl) {
  if (!confirm('לאשר את ההזמנה, להוריד מהמלאי ולשלוח מייל למזמין?')) return;
  const btn = cardEl.querySelector('[data-act="approve"]');
  if (btn) { btn.disabled = true; btn.textContent = 'מאשר...'; }
  try {
    const { data, error } = await sb.rpc('approve_order', { p_order_id: orderId });
    if (error) throw error;

    const missing = (data?.results || []).filter(r => r.notFound).map(r => r.name);
    toast(missing.length
      ? `אושר. פריטים שלא נמצאו במלאי: ${missing.join(', ')}`
      : 'ההזמנה אושרה והמלאי עודכן ✓');

    // שליחת מייל "מוכנה לאיסוף" (לא חוסם — כישלון לא מבטל את האישור)
    sendReadyEmail(orderId);
    loadOrders();
  } catch (err) {
    toast(friendlyError(err), true);
    if (btn) { btn.disabled = false; btn.textContent = 'אשר הזמנה + הורד מלאי'; }
  }
}

// מחלץ את הודעת השגיאה האמיתית מתוך תשובת Edge Function
export async function invokeFn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let detail = error.message || String(error);
    let payload = null;
    if (/not found/i.test(detail) || error.context?.status === 404) {
      detail = `הפונקציה "${name}" לא פורסמה ב-Supabase`;
    } else {
      try {
        payload = await error.context?.json?.();
        if (payload?.error) detail = payload.error;
      } catch { /* גוף לא-JSON — נשארים עם ההודעה המקורית */ }
    }
    const e = new Error(detail);
    e.payload = payload;          // כולל diag/hint לצורך אבחון
    throw e;
  }
  return data;
}

async function sendReadyEmail(orderId) {
  try {
    const data = await invokeFn('send-order-ready', { order_id: orderId });
    if (data?.skipped) toast('ההזמנה אושרה — ללא מייל: ' + data.skipped, true);
    else if (data?.ok) toast('נשלח מייל למזמין ✉️');
  } catch (err) {
    console.error('send-order-ready:', err);
    toast('המייל נכשל: ' + (err.message || err), true);
  }
}

async function deleteOrder(orderId) {
  if (!confirm('למחוק את ההזמנה לצמיתות?')) return;
  try {
    const { error } = await sb.from('orders').delete().eq('id', orderId);
    if (error) throw error;
    toast('ההזמנה נמחקה');
    loadOrders(); loadArchive();
  } catch (err) { toast(friendlyError(err), true); }
}

async function markCollected(orderId) {
  try {
    const { error } = await sb.from('orders').update({ status: 'collected' }).eq('id', orderId);
    if (error) throw error;
    toast('סומן כנאספה ✓');
    loadArchive();
  } catch (err) { toast(friendlyError(err), true); }
}

// שמירת כמות פריט בהזמנה. qty=0 מסיר את הפריט (order_items מחייב qty > 0).
async function setItemQty(itemId, qty, rowEl) {
  const input = rowEl.querySelector('.oi-qty-input');
  const prev = Number(input?.dataset.prev ?? input?.value ?? 0);
  qty = Math.max(0, parseInt(qty, 10) || 0);

  if (qty === prev) { if (input) input.value = prev; return; }

  if (input) input.disabled = true;
  try {
    if (qty === 0) {
      const { error } = await sb.from('order_items').delete().eq('id', itemId);
      if (error) throw error;
      rowEl.remove();
      toast('הפריט הוסר מההזמנה');
      return;
    }
    const { error } = await sb.from('order_items').update({ qty }).eq('id', itemId);
    if (error) throw error;
    if (input) { input.value = qty; input.dataset.prev = qty; }
  } catch (err) {
    if (input) input.value = prev;          // לא משאירים על המסך ערך שלא נשמר
    toast(friendlyError(err), true);
  } finally {
    if (input) input.disabled = false;
  }
}

function currentItemQty(rowEl) {
  const input = rowEl.querySelector('.oi-qty-input');
  return parseInt(input?.dataset.prev ?? input?.value, 10) || 0;
}

async function changeItemQty(itemId, delta, rowEl) {
  await setItemQty(itemId, currentItemQty(rowEl) + delta, rowEl);
}

// הזנה ידנית — 0 או ריק מתפרשים כהסרה, ולכן מאשרים קודם
async function typeItemQty(itemId, rowEl, input) {
  const prev = parseInt(input.dataset.prev, 10) || 0;
  const raw = input.value.trim();
  const qty = parseInt(raw, 10);

  if (raw === '' || isNaN(qty) || qty < 0) { input.value = prev; return; }
  if (qty === 0) {
    if (!confirm('כמות 0 תסיר את הפריט מההזמנה. להמשיך?')) { input.value = prev; return; }
  }
  await setItemQty(itemId, qty, rowEl);
}

async function removeItem(itemId, rowEl) {
  if (!confirm('להסיר את הפריט מההזמנה?')) return;
  try {
    const { error } = await sb.from('order_items').delete().eq('id', itemId);
    if (error) throw error;
    rowEl.remove();
    toast('הפריט הוסר');
  } catch (err) { toast(friendlyError(err), true); }
}

async function downloadCert(orderId) {
  try {
    const { data: o, error } = await sb.from('orders').select('cert_path').eq('id', orderId).single();
    if (error) throw error;
    if (!o?.cert_path) { toast('אין תעודה להזמנה זו', true); return; }
    const { data, error: sErr } = await sb.storage.from('supplier-certs')
      .createSignedUrl(o.cert_path, 120, { download: true });
    if (sErr) throw sErr;
    window.open(data.signedUrl, '_blank');
  } catch (err) { toast(friendlyError(err), true); }
}

// ── מלאי ────────────────────────────────────────────────────
async function loadInventory() {
  const el = $('inventoryList');
  el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const data = await fetchInventory(() => sb.from('inventory').select(INV_COLS));
    inventory = emptyByWarehouse();
    data.forEach(p => inventory[p.warehouse]?.push(p));
    renderPicker();
    if ($('invDetail').style.display !== 'none') renderInventory();
  } catch (err) {
    el.innerHTML = `<div class="admin-empty">שגיאה: ${esc(friendlyError(err))}</div>`;
    toast(friendlyError(err), true);
  }
}

// כרטיסי בחירת מחסן + סיכום לכל אחד — נבנים מ-WAREHOUSES
function renderPicker() {
  $('invPickerGrid').innerHTML = WH_KEYS.map((wh) => {
    const c = WAREHOUSES[wh];
    const arr = inventory[wh] || [];
    const low = arr.filter(p => (p.qty || 0) <= 3).length;
    const hidden = arr.filter(p => !p.exposed).length;
    const bits = [];
    if (low) bits.push(`<span class="low">${low} במלאי נמוך</span>`);
    if (hidden) bits.push(`${hidden} מוסתרים`);
    return `<div class="inv-pick-card ${wh}" data-wh="${wh}">
      <div class="inv-pick-icon">${c.icon}</div>
      <div class="inv-pick-title">${esc(c.label)}</div>
      <div class="inv-pick-count">${arr.length} פריטים</div>
      <div class="inv-pick-meta">${bits.join(' · ')}</div>
      <div class="inv-pick-arrow">‹</div>
    </div>`;
  }).join('');
}

// מעבר בין מסך הבחירה למסך המחסן
function showInvPicker() {
  $('invPicker').style.display = 'block';
  $('invDetail').style.display = 'none';
  $('receivePanel').style.display = 'none';
  renderPicker();
}

function openInvWarehouse(wh) {
  invWarehouse = wh;
  $('invPicker').style.display = 'none';
  $('invDetail').style.display = 'block';
  $('invDetailTitle').textContent = WH_LABEL[wh];
  $('rcWhLabel').textContent = WH_LABEL[wh];
  $('invSearch').value = '';
  $('receivePanel').style.display = 'none';
  renderInventory();
  window.scrollTo(0, 0);
}

function renderInventory() {
  const search = ($('invSearch')?.value || '').trim().toLowerCase();
  const all = inventory[invWarehouse] || [];
  const arr = search
    ? all.filter(p => p.name.toLowerCase().includes(search) ||
                      (p.category || '').toLowerCase().includes(search))
    : all;

  if (!all.length) {
    $('inventoryList').innerHTML = '<div class="admin-empty">אין פריטים במחסן זה</div>';
    return;
  }
  if (!arr.length) {
    $('inventoryList').innerHTML = '<div class="admin-empty">לא נמצאו פריטים תואמים 🔍</div>';
    return;
  }

  const rows = arr.map((p, idx) => {
    const low = (p.qty || 0) <= 3;
    if (invEditMode) {
      // סידור מוסתר בזמן חיפוש (הסדר מתייחס לרשימה המלאה)
      // וגם אם migration_03 עוד לא רצה
      const sortable = !search && caps.sortOrder;
      const moves = !sortable ? '' : `
        <button class="inv-drag" title="גרור לשינוי מיקום" aria-label="גרור לשינוי מיקום">⣿</button>
        <button class="inv-top" data-act="top" title="העבר לראש הרשימה"
                aria-label="העבר לראש הרשימה" ${idx === 0 ? 'disabled' : ''}>⤒</button>`;
      return `<div class="inv-row edit" data-inv="${p.id}">
        <div class="inv-edit-main">
          ${moves}
          <input type="text" class="inv-name-input" value="${esc(p.name)}"
                 data-act="name" maxlength="120" aria-label="שם המוצר">
        </div>
        <div class="inv-edit-side">
          <input type="number" class="inv-qty-input" min="0" value="${p.qty}" data-act="qty">
          <label class="inv-exp"><input type="checkbox" ${p.exposed ? 'checked' : ''} data-act="exp"> חשוף</label>
        </div>
      </div>`;
    }
    return `<div class="inv-row">
      <span class="inv-name">${esc(p.name)}${p.exposed ? '' : '<span class="inv-hidden-tag">מוסתר</span>'}</span>
      <span class="inv-stock ${low ? 'low' : ''}">${p.qty}</span>
    </div>`;
  }).join('');

  const shown = search ? `${arr.length} מתוך ${all.length}` : `${all.length}`;
  const hidden = all.filter(p => !p.exposed).length;
  const summary = `${shown} פריטים${hidden ? ` · ${hidden} מוסתרים` : ''}`;

  $('inventoryList').innerHTML =
    `<div class="section-title" style="margin-top:4px">${esc(WH_LABEL[invWarehouse])} — ${summary}</div>${rows}`;
}

// ── סידור מחדש ──────────────────────────────────────────────
// שומר את הסדר החדש של כל המחסן. אם השמירה נכשלת — חוזרים
// לסדר הקודם, כדי שהמסך לא יראה סדר שלא נשמר.
async function persistOrder(ids, prevOrder) {
  try {
    const { error } = await sb.rpc('reorder_inventory', {
      p_warehouse: invWarehouse, p_ids: ids,
    });
    if (error) {
      if (/could not find|does not exist|schema cache/i.test(String(error.message))) {
        throw new Error('כדי לסדר מחדש יש להריץ את migration_06 ב-Supabase');
      }
      throw error;
    }
    return true;
  } catch (err) {
    if (prevOrder) { inventory[invWarehouse] = prevOrder; renderInventory(); }
    toast(friendlyError(err), true);
    return false;
  }
}

// מסדר את המערך המקומי לפי רשימת מזהים
function applyLocalOrder(ids) {
  const byId = new Map((inventory[invWarehouse] || []).map(p => [p.id, p]));
  inventory[invWarehouse] = ids.map(id => byId.get(id)).filter(Boolean);
}

// העברה לראש הרשימה — פותר את המקרה המתיש של מעבר ארוך
async function moveToTop(id) {
  const prev = [...(inventory[invWarehouse] || [])];
  const ids = [id, ...prev.filter(p => p.id !== id).map(p => p.id)];
  applyLocalOrder(ids);
  renderInventory();
  $('inventoryList').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (await persistOrder(ids, prev)) toast('הועבר לראש הרשימה ✓');
}

// ── גרירה (עכבר + מגע) ──────────────────────────────────────
let drag = null;
let autoScrollTimer = null;

function stopAutoScroll() {
  if (autoScrollTimer) { cancelAnimationFrame(autoScrollTimer); autoScrollTimer = null; }
}

// גלילה אוטומטית כשגוררים לקצה המסך
function runAutoScroll() {
  if (!drag) return stopAutoScroll();
  const margin = 90, max = 14;
  const y = drag.lastY;
  let dy = 0;
  if (y < margin) dy = -max * (1 - y / margin);
  else if (y > innerHeight - margin) dy = max * (1 - (innerHeight - y) / margin);
  if (dy) window.scrollBy(0, dy);
  autoScrollTimer = requestAnimationFrame(runAutoScroll);
}

function onDragStart(e) {
  const handle = e.target.closest('.inv-drag');
  if (!handle || e.button > 0) return;
  const row = handle.closest('.inv-row');
  if (!row) return;

  e.preventDefault();
  drag = {
    row,
    list: $('inventoryList'),
    grabY: e.clientY,
    lastY: e.clientY,
    moved: false,
    prev: [...(inventory[invWarehouse] || [])],
  };
  row.classList.add('dragging');
  document.body.classList.add('dragging-active');
  handle.setPointerCapture(e.pointerId);
  autoScrollTimer = requestAnimationFrame(runAutoScroll);
}

function onDragMove(e) {
  if (!drag) return;
  drag.lastY = e.clientY;
  drag.row.style.transform = `translateY(${e.clientY - drag.grabY}px)`;

  // היעד = השורה הראשונה שהסמן נמצא מעל אמצעה; null => סוף הרשימה
  const others = [...drag.list.querySelectorAll('.inv-row[data-inv]')]
    .filter(r => r !== drag.row);

  let ref = null;
  for (const r of others) {
    const b = r.getBoundingClientRect();
    if (e.clientY < b.top + b.height / 2) { ref = r; break; }
  }

  // מזיזים רק אם המיקום באמת משתנה
  if (ref === drag.row.nextElementSibling) return;
  drag.list.insertBefore(drag.row, ref);
  drag.grabY = e.clientY;
  drag.row.style.transform = '';
  drag.moved = true;
}

async function onDragEnd() {
  if (!drag) return;
  const { row, list, moved, prev } = drag;
  row.style.transform = '';
  row.classList.remove('dragging');
  document.body.classList.remove('dragging-active');
  stopAutoScroll();
  drag = null;

  if (!moved) return;
  const ids = [...list.querySelectorAll('.inv-row[data-inv]')].map(r => +r.dataset.inv);
  applyLocalOrder(ids);
  if (await persistOrder(ids, prev)) toast('הסדר נשמר ✓');
}

// שינוי שם מוצר — מעדכן גם הזמנות ממתינות כדי שהאישור ימשיך להוריד מלאי
async function renameInvItem(id, newName, inputEl) {
  const item = WH_KEYS.flatMap(k => inventory[k] || []).find(p => p.id === id);
  const oldName = item?.name ?? '';
  const trimmed = (newName || '').trim();

  if (!trimmed) { inputEl.value = oldName; toast('שם המוצר לא יכול להיות ריק', true); return; }
  if (trimmed === oldName) { inputEl.value = oldName; return; }

  inputEl.disabled = true;
  try {
    const { data, error } = await sb.rpc('rename_inventory_item', { p_id: id, p_name: trimmed });
    if (error) {
      if (/could not find|does not exist|schema cache/i.test(String(error.message))) {
        throw new Error('כדי לשנות שמות יש להריץ את migration_05 ב-Supabase');
      }
      throw error;
    }
    if (item) item.name = data.name;
    inputEl.value = data.name;

    const n = data.pending_items_updated || 0;
    toast(n ? `השם עודכן — וגם ב-${n} פריטים בהזמנות ממתינות ✓` : 'השם עודכן ✓');
  } catch (err) {
    inputEl.value = oldName;                       // החזרה למצב הקודם
    toast(friendlyError(err), true);
  } finally {
    inputEl.disabled = false;
  }
}

async function updateInvField(id, patch) {
  try {
    const { error } = await sb.from('inventory').update(patch).eq('id', id);
    if (error) throw error;
    const all = WH_KEYS.flatMap(k => inventory[k] || []);
    Object.assign(all.find(p => p.id === id) || {}, patch);
    toast('עודכן ✓');
  } catch (err) { toast(friendlyError(err), true); }
}

async function receiveGoods() {
  const btn = $('rcSubmit');
  const p_warehouse = invWarehouse;          // המחסן שנכנסנו אליו
  const p_name = $('rcName').value.trim();
  const p_qty = parseInt($('rcQty').value, 10) || 0;
  const p_category = $('rcCategory').value.trim();
  const p_exposed = $('rcExposed').checked;

  if (!p_name) { toast('אנא הזן שם מוצר', true); return; }
  if (p_qty <= 0) { toast('אנא הזן כמות חיובית', true); return; }

  btn.disabled = true; btn.textContent = 'קולט...';
  try {
    const { data, error } = await sb.rpc('receive_goods', { p_warehouse, p_name, p_qty, p_category, p_exposed });
    if (error) throw error;
    toast(data.created ? `נוצר מוצר חדש: ${data.name}` : `נוסף למלאי — סה"כ ${data.newStock}`);
    $('rcName').value = ''; $('rcQty').value = '1'; $('rcCategory').value = '';
    loadInventory();
  } catch (err) {
    toast(friendlyError(err), true);
  } finally {
    btn.disabled = false; btn.textContent = 'קלוט סחורה';
  }
}

// ── ייצוא לאקסל ─────────────────────────────────────────────
let xlsxLib = null;
async function loadXLSX() {
  if (xlsxLib) return xlsxLib;
  xlsxLib = await import('https://esm.sh/xlsx@0.18.5');
  return xlsxLib;
}

async function exportInventory() {
  const btn = $('exportBtn');
  btn.disabled = true; btn.textContent = 'מייצא...';
  try {
    const XLSX = await loadXLSX();
    const { data, error } = await sb.from('inventory')
      .select('warehouse, name, qty, category, exposed')
      .order('warehouse').order('name');
    if (error) throw error;

    const wb = XLSX.utils.book_new();
    WH_KEYS.forEach((wh) => {
      const sheetName = WAREHOUSES[wh].sheet;
      const rows = (data || []).filter(p => p.warehouse === wh).map(p => ({
        'פריט': p.name,
        'כמות': p.qty,
        'קטגוריה': p.category || '',
        'פעיל': p.exposed ? 'כן' : 'לא',
      }));
      const ws = XLSX.utils.json_to_sheet(rows, { header: ['פריט', 'כמות', 'קטגוריה', 'פעיל'] });
      ws['!cols'] = [{ wch: 42 }, { wch: 9 }, { wch: 26 }, { wch: 8 }];
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `מלאי ${stamp}.xlsx`);
    toast('הקובץ הורד ✓');
  } catch (err) {
    toast('שגיאה בייצוא: ' + friendlyError(err), true);
  } finally {
    btn.disabled = false; btn.textContent = '⬇ אקסל';
  }
}

// ── משתמשים ─────────────────────────────────────────────────
async function loadUsers() {
  const el = $('usersList');
  el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const { data, error } = await sb.from('profiles')
      .select('id, email, full_name, initials, phone, role, is_guest, created_at')
      .eq('is_guest', false)
      .order('created_at', { ascending: false });
    if (error) throw error;

    if (!data?.length) { el.innerHTML = '<div class="admin-empty">אין משתמשים רשומים</div>'; return; }

    el.innerHTML = data.map(u => {
      const isMain = (u.email || '').toLowerCase() === ADMIN_EMAIL;
      const details = [u.initials, u.phone].filter(Boolean).join(' · ');
      return `<div class="user-row" data-user="${u.id}">
        <div class="user-info">
          <div class="user-email">${esc(u.email || u.full_name || '—')}</div>
          <div class="user-sub">${esc(details || 'לא מילא פרטים')}</div>
        </div>
        ${isMain
          ? '<span class="order-status approved">מנהל ראשי</span>'
          : `<select class="role-select" data-act="role">
               <option value="user" ${u.role !== 'admin' ? 'selected' : ''}>משתמש</option>
               <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>מנהל</option>
             </select>`}
      </div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<div class="admin-empty">שגיאה: ${esc(friendlyError(err))}</div>`;
  }
}

async function setRole(userId, role, selectEl) {
  try {
    const { error } = await sb.from('profiles').update({ role }).eq('id', userId);
    if (error) throw error;
    toast(role === 'admin' ? 'המשתמש הוגדר כמנהל ✓' : 'ההרשאה שונתה למשתמש רגיל ✓');
  } catch (err) {
    toast(friendlyError(err), true);
    if (selectEl) selectEl.value = role === 'admin' ? 'user' : 'admin';  // החזרה למצב הקודם
  }
}

// ── כתובות להתראה על הזמנה חדשה ─────────────────────────────
async function loadNotify() {
  const el = $('notifyList');
  el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  try {
    const { data, error } = await sb.from('notify_emails')
      .select('id, email, label, active')
      .order('created_at');
    if (error) throw error;

    if (!data?.length) {
      el.innerHTML = '<div class="admin-empty">לא הוגדרו כתובות — לא יישלחו התראות 🔕</div>';
      return;
    }

    el.innerHTML = `<div class="section-title" style="margin-top:6px">כתובות מוגדרות (${data.length})</div>` +
      data.map(n => `
        <div class="user-row" data-notify="${n.id}">
          <div class="user-info">
            <div class="user-email">${esc(n.email)}</div>
            <div class="user-sub">${esc(n.label || '')}${n.active ? '' : ' · מושבת'}</div>
          </div>
          <label class="inv-exp"><input type="checkbox" ${n.active ? 'checked' : ''} data-act="toggle"> פעיל</label>
          <button class="cart-trash-btn" data-act="rm" title="מחק">🗑️</button>
        </div>`).join('');
  } catch (err) {
    el.innerHTML = `<div class="admin-empty">שגיאה: ${esc(friendlyError(err))}</div>`;
  }
}

async function addNotify() {
  const btn = $('nfAdd');
  const email = $('nfEmail').value.trim();
  const label = $('nfLabel').value.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast('כתובת מייל לא תקינה', true); return;
  }

  btn.disabled = true; btn.textContent = 'מוסיף...';
  try {
    const { error } = await sb.from('notify_emails')
      .insert({ email: email.toLowerCase(), label: label || null });
    if (error) throw error;
    $('nfEmail').value = ''; $('nfLabel').value = '';
    toast('הכתובת נוספה ✓');
    loadNotify();
  } catch (err) {
    const m = String(err?.message || '');
    toast(/duplicate|unique/i.test(m) ? 'הכתובת כבר קיימת ברשימה' : friendlyError(err), true);
  } finally {
    btn.disabled = false; btn.textContent = 'הוסף כתובת';
  }
}

async function toggleNotify(id, active) {
  try {
    const { error } = await sb.from('notify_emails').update({ active }).eq('id', id);
    if (error) throw error;
    toast(active ? 'הופעל ✓' : 'הושבת');
    loadNotify();
  } catch (err) { toast(friendlyError(err), true); }
}

// בדיקת הגדרות המייל — מציג אבחון מפורט
async function testEmail() {
  const btn = $('nfTest');
  const box = $('nfTestResult');
  btn.disabled = true; btn.textContent = 'בודק...';
  box.innerHTML = '<div class="loading"><div class="spinner"></div><div>שולח מייל בדיקה...</div></div>';

  const line = (label, val, good) =>
    `<div class="inv-row"><span class="inv-name">${label}</span>` +
    `<span style="font-weight:700;color:${good === null ? 'var(--text)' : good ? 'var(--success)' : 'var(--accent)'}">` +
    `${esc(val)}</span></div>`;

  try {
    const data = await invokeFn('send-test-email', {});
    const d = data.diag || {};
    box.innerHTML = `<div class="order-card approved">
      <div class="order-customer" style="color:var(--success)">✅ המייל נשלח בהצלחה</div>
      <div class="order-sub" style="margin-bottom:8px">נשלח אל ${esc(data.sent_to)} — בדוק בתיבה (וגם בספאם)</div>
      ${line('שולח', d.gmail_user, true)}
    </div>`;
    toast('מייל בדיקה נשלח ✉️');
  } catch (err) {
    // invokeFn זורק Error עם ההודעה; הפרטים המלאים בגוף התשובה
    let d = {}, hint = '', stage = '';
    try {
      const raw = err.payload || {};
      d = raw.diag || {}; hint = raw.hint || ''; stage = raw.stage || '';
    } catch { /* אין גוף מפורט */ }

    box.innerHTML = `<div class="order-card" style="border-color:var(--accent)">
      <div class="order-customer" style="color:var(--accent)">❌ שליחת המייל נכשלה</div>
      <div class="order-sub" style="margin:6px 0 10px">${esc(err.message || '')}</div>
      ${hint ? `<div class="cert-row" style="background:#fff3cd;color:#7a5b00">💡 ${esc(hint)}</div>` : ''}
      ${stage ? line('נכשל בשלב', stage, false) : ''}
      ${d.gmail_user !== undefined ? line('GMAIL_USER', d.gmail_user, d.gmail_user_valid) : ''}
      ${d.password_set !== undefined ? line('סיסמה הוגדרה', d.password_set ? 'כן' : 'לא', !!d.password_set) : ''}
      ${d.password_length_after_cleanup !== undefined
        ? line('אורך סיסמה', d.password_length_after_cleanup + ' תווים (נדרש 16)', d.password_length_ok) : ''}
      ${d.password_had_spaces ? line('רווחים בסיסמה', 'נמצאו — הוסרו אוטומטית', null) : ''}
      ${d.gmail_user_had_whitespace ? line('רווחים ב-GMAIL_USER', 'נמצאו — הוסרו אוטומטית', null) : ''}
    </div>`;
    toast('בדיקת המייל נכשלה', true);
  } finally {
    btn.disabled = false; btn.textContent = '✉️ בדוק מייל';
  }
}

async function removeNotify(id, email) {
  if (!confirm(`למחוק את ${email} מרשימת ההתראות?`)) return;
  try {
    const { error } = await sb.from('notify_emails').delete().eq('id', id);
    if (error) throw error;
    toast('הכתובת נמחקה');
    loadNotify();
  } catch (err) { toast(friendlyError(err), true); }
}

// ── חיווט ───────────────────────────────────────────────────
export function initAdmin() {
  document.querySelectorAll('.admin-tab').forEach(t =>
    t.addEventListener('click', () => setTab(t.dataset.pane)));

  on('refreshOrders', 'click', loadOrders);
  on('refreshArchive', 'click', loadArchive);
  on('refreshInv', 'click', loadInventory);
  on('refreshUsers', 'click', loadUsers);
  on('exportBtn', 'click', exportInventory);
  on('rcSubmit', 'click', receiveGoods);

  on('receiveToggle', 'click', () => {
    const p = $('receivePanel');
    const open = p.style.display === 'none';
    p.style.display = open ? 'block' : 'none';
    if (open) $('rcName').focus();
  });

  // כניסה למחסן / חזרה לבחירה — האזנה על המכל, הכרטיסים דינמיים
  on('invPickerGrid', 'click', (e) => {
    const card = e.target.closest('.inv-pick-card');
    if (card) openInvWarehouse(card.dataset.wh);
  });
  on('invBackBtn', 'click', showInvPicker);

  // חיפוש במלאי
  on('invSearch', 'input', renderInventory);

  on('editInvBtn', 'click', () => {
    invEditMode = !invEditMode;
    const b = $('editInvBtn');
    b.classList.toggle('on', invEditMode);
    b.textContent = invEditMode ? '✓ סיום' : '✎ עריכה';
    renderInventory();
  });

  // מלאי — העברה לראש הרשימה
  on('inventoryList', 'click', (e) => {
    const btn = e.target.closest('[data-act="top"]');
    if (!btn || btn.disabled) return;
    moveToTop(+btn.closest('[data-inv]').dataset.inv);
  });

  // מלאי — גרירה לשינוי מיקום (pointer events => עכבר ומגע כאחד)
  on('inventoryList', 'pointerdown', onDragStart);
  on('inventoryList', 'pointermove', onDragMove);
  on('inventoryList', 'pointerup', onDragEnd);
  on('inventoryList', 'pointercancel', onDragEnd);

  // מלאי — עריכה
  on('inventoryList', 'change', (e) => {
    const row = e.target.closest('[data-inv]'); if (!row) return;
    const id = +row.dataset.inv;
    if (e.target.dataset.act === 'qty') {
      const qty = Math.max(0, parseInt(e.target.value, 10) || 0);
      e.target.value = qty;
      updateInvField(id, { qty });
    } else if (e.target.dataset.act === 'exp') {
      updateInvField(id, { exposed: e.target.checked });
    } else if (e.target.dataset.act === 'name') {
      renameInvItem(id, e.target.value, e.target);
    }
  });

  // Enter מסיים עריכת שם, Esc מבטל
  on('inventoryList', 'keydown', (e) => {
    if (e.target.dataset.act !== 'name') return;
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape') {
      const id = +e.target.closest('[data-inv]').dataset.inv;
      const item = WH_KEYS.flatMap(k => inventory[k] || []).find(p => p.id === id);
      if (item) e.target.value = item.name;
      e.target.blur();
    }
  });

  // משתמשים — שינוי תפקיד
  on('usersList', 'change', (e) => {
    if (e.target.dataset.act !== 'role') return;
    setRole(e.target.closest('[data-user]').dataset.user, e.target.value, e.target);
  });

  // התראות
  on('refreshNotify', 'click', loadNotify);
  on('nfTest', 'click', testEmail);
  on('nfAdd', 'click', addNotify);
  on('nfEmail', 'keydown', (e) => { if (e.key === 'Enter') addNotify(); });
  on('nfLabel', 'keydown', (e) => { if (e.key === 'Enter') addNotify(); });
  on('notifyList', 'change', (e) => {
    if (e.target.dataset.act !== 'toggle') return;
    toggleNotify(+e.target.closest('[data-notify]').dataset.notify, e.target.checked);
  });
  on('notifyList', 'click', (e) => {
    const btn = e.target.closest('[data-act="rm"]'); if (!btn) return;
    const row = btn.closest('[data-notify]');
    removeNotify(+row.dataset.notify, row.querySelector('.user-email').textContent);
  });

  // פעולות על הזמנות (הזמנות + ארכיון)
  ['ordersList', 'archiveList'].forEach(listId => {
    on(listId, 'click', (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const card = btn.closest('[data-order]'); if (!card) return;
      const orderId = card.dataset.order;
      const act = btn.dataset.act;

      if (act === 'approve') return approveOrder(orderId, card);
      if (act === 'del') return deleteOrder(orderId);
      if (act === 'collected') return markCollected(orderId);
      if (act === 'cert') return downloadCert(orderId);

      const row = btn.closest('[data-item]');
      if (!row) return;
      const itemId = +row.dataset.item;
      if (act === 'inc') return changeItemQty(itemId, 1, row);
      if (act === 'dec') return changeItemQty(itemId, -1, row);
      if (act === 'rm') return removeItem(itemId, row);
    });

    // הזנת כמות ידנית
    on(listId, 'change', (e) => {
      if (e.target.dataset.act !== 'qty') return;
      const row = e.target.closest('[data-item]'); if (!row) return;
      typeItemQty(+row.dataset.item, row, e.target);
    });

    // Enter מאשר, Esc מבטל
    on(listId, 'keydown', (e) => {
      if (e.target.dataset.act !== 'qty') return;
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      if (e.key === 'Escape') {
        e.target.value = e.target.dataset.prev || '';
        e.target.blur();
      }
    });

    // בחירת כל הטקסט בלחיצה — מחליפים ערך במקום לערוך תו־תו
    on(listId, 'focusin', (e) => {
      if (e.target.dataset.act === 'qty') e.target.select();
    });
  });
}
