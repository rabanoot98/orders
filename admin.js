// ============================================================
// ממשק ניהול: הזמנות, ארכיון, מלאי, משתמשים
// ============================================================
import {
  sb, ADMIN_EMAIL, WH_LABEL, state,
  $, on, esc, showScreen, toast, showError, fmtDate, friendlyError,
} from './lib.js';

let inventory = { main: [], zuk: [] };
let invEditMode = false;

// ── פתיחה + לשוניות ─────────────────────────────────────────
export function openAdmin() {
  showScreen('adminScreen', { title: 'ניהול', sub: 'לוח בקרה', back: true });
  setTab('orders');
}

function setTab(pane) {
  document.querySelectorAll('.admin-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.pane === pane));
  ['orders', 'archive', 'inventory', 'users'].forEach(p =>
    $(p + 'Pane').classList.toggle('active', p === pane));

  if (pane === 'orders') loadOrders();
  if (pane === 'archive') loadArchive();
  if (pane === 'inventory') loadInventory();
  if (pane === 'users') loadUsers();
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
        <span class="oi-qty">${it.qty}</span>
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

async function sendReadyEmail(orderId) {
  try {
    const { data, error } = await sb.functions.invoke('send-order-ready', { body: { order_id: orderId } });
    if (error) throw error;
    if (data?.skipped) toast('ההזמנה אושרה (ללא מייל: ' + data.skipped + ')');
    else if (data?.ok) toast('נשלח מייל למזמין ✉️');
  } catch (err) {
    console.warn('email', err);
    toast('ההזמנה אושרה, אך שליחת המייל נכשלה', true);
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

async function changeItemQty(itemId, delta, rowEl) {
  const span = rowEl.querySelector('.oi-qty');
  const next = Math.max(0, (parseInt(span.textContent, 10) || 0) + delta);
  try {
    if (next === 0) {
      const { error } = await sb.from('order_items').delete().eq('id', itemId);
      if (error) throw error;
      rowEl.remove();
    } else {
      const { error } = await sb.from('order_items').update({ qty: next }).eq('id', itemId);
      if (error) throw error;
      span.textContent = next;
    }
  } catch (err) { toast(friendlyError(err), true); }
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
    const { data, error } = await sb.from('inventory')
      .select('id, warehouse, name, qty, category, exposed')
      .order('warehouse').order('name');
    if (error) throw error;
    inventory = { main: [], zuk: [] };
    (data || []).forEach(p => inventory[p.warehouse]?.push(p));
    renderInventory();
  } catch (err) {
    el.innerHTML = `<div class="admin-empty">שגיאה: ${esc(friendlyError(err))}</div>`;
  }
}

function renderInventory() {
  const html = [['main', 'מחסן דת'], ['zuk', 'ציוד זו"ק']].map(([wh, title]) => {
    const arr = inventory[wh] || [];
    if (!arr.length) return '';
    const rows = arr.map(p => {
      const low = (p.qty || 0) <= 3;
      if (invEditMode) {
        return `<div class="inv-row" data-inv="${p.id}">
          <span class="inv-name">${esc(p.name)}</span>
          <input type="number" class="inv-qty-input" min="0" value="${p.qty}" data-act="qty">
          <label class="inv-exp"><input type="checkbox" ${p.exposed ? 'checked' : ''} data-act="exp"> חשוף</label>
        </div>`;
      }
      return `<div class="inv-row">
        <span class="inv-name">${esc(p.name)}${p.exposed ? '' : '<span class="inv-hidden-tag">מוסתר</span>'}</span>
        <span class="inv-stock ${low ? 'low' : ''}">${p.qty}</span>
      </div>`;
    }).join('');
    return `<div class="section-title" style="margin-top:16px">${title} — ${arr.length} פריטים</div>${rows}`;
  }).join('');
  $('inventoryList').innerHTML = html || '<div class="admin-empty">אין פריטים במלאי</div>';
}

async function updateInvField(id, patch) {
  try {
    const { error } = await sb.from('inventory').update(patch).eq('id', id);
    if (error) throw error;
    const all = [...inventory.main, ...inventory.zuk];
    Object.assign(all.find(p => p.id === id) || {}, patch);
    toast('עודכן ✓');
  } catch (err) { toast(friendlyError(err), true); }
}

async function receiveGoods() {
  const btn = $('rcSubmit');
  const p_warehouse = $('rcWarehouse').value;
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
    [['main', 'מלאי'], ['zuk', 'מחסן זוק']].forEach(([wh, sheetName]) => {
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

async function setRole(userId, role) {
  try {
    const { error } = await sb.from('profiles').update({ role }).eq('id', userId);
    if (error) throw error;
    toast('ההרשאה עודכנה ✓');
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

  on('editInvBtn', 'click', () => {
    invEditMode = !invEditMode;
    const b = $('editInvBtn');
    b.classList.toggle('on', invEditMode);
    b.textContent = invEditMode ? '✓ סיום' : '✎ עריכה';
    renderInventory();
  });

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
    }
  });

  // משתמשים — שינוי תפקיד
  on('usersList', 'change', (e) => {
    if (e.target.dataset.act !== 'role') return;
    setRole(e.target.closest('[data-user]').dataset.user, e.target.value);
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
  });
}
