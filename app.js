// ============================================================
// אפליקציה ראשית: כניסה, פרופיל, הזמנות
// ============================================================
import {
  sb, IS_CONFIGURED, ADMIN_EMAIL, WH_LABEL, state,
  $, on, esc, showScreen, closeAccountMenu, toast, showError, fmtDate, friendlyError,
} from './lib.js';
import { openAdmin, initAdmin } from './admin.js';

// ── ניווט בסיסי ─────────────────────────────────────────────
export function goHome() {
  state.warehouse = null;
  showScreen('homeScreen');
}

function afterAuthScreen() {
  // אם חסרים פרטים למשתמש רשום — מסך השלמת פרטים
  if (!state.isGuest && (!state.profile?.initials || !state.profile?.phone)) {
    $('obInitials').value = state.profile?.initials || '';
    $('obPhone').value = state.profile?.phone || '';
    $('onboardTitle').textContent = 'כמה פרטים אחרונים';
    $('onboardSub').textContent = 'נשמור אותם כדי שלא תצטרך למלא בכל הזמנה';
    showScreen('onboardScreen');
    return;
  }
  goHome();
}

// ── מצב התחברות ─────────────────────────────────────────────
async function loadProfile() {
  const { data, error } = await sb.from('profiles').select('*').eq('id', state.user.id).maybeSingle();
  if (error) console.warn('profile load', error);
  state.profile = data || null;
  state.isGuest = !!(data?.is_guest ?? state.user.is_anonymous);
  state.isAdmin = data?.role === 'admin';
  return data;
}

function paintAccountUI() {
  const signedIn = !!state.user;
  $('accountWrap').style.display = signedIn ? 'block' : 'none';
  if (!signedIn) return;
  const label = state.isGuest ? 'אורח' : (state.profile?.initials || state.profile?.full_name || state.user.email || '');
  $('accountName').textContent = label;
  $('adminBtn').style.display = state.isAdmin ? 'block' : 'none';
  $('myOrdersBtn').style.display = state.isGuest ? 'none' : 'block';
  $('profileBtn').style.display = state.isGuest ? 'none' : 'block';
}

async function onSignedIn() {
  await loadProfile();
  paintAccountUI();
  afterAuthScreen();
}

function toLogin() {
  state.user = null; state.profile = null;
  state.isAdmin = false; state.isGuest = false;
  state.cart = {};
  paintAccountUI();
  showScreen('loginScreen');
}

// ── פעולות התחברות ──────────────────────────────────────────
let authMode = 'signin';   // 'signin' | 'signup'

function setAuthMode(mode) {
  authMode = mode;
  $('authSubmitBtn').textContent = mode === 'signin' ? 'התחבר' : 'הרשמה';
  $('authToggleBtn').textContent = mode === 'signin' ? 'אין לי משתמש — הרשמה' : 'יש לי כבר משתמש — התחברות';
  $('authPassword').setAttribute('autocomplete', mode === 'signin' ? 'current-password' : 'new-password');
  showError('authError', '');
}

async function handleEmailAuth() {
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  showError('authError', '');

  if (!email || !password) { showError('authError', 'יש למלא אימייל וסיסמה'); return; }
  if (authMode === 'signup' && password.length < 6) {
    showError('authError', 'הסיסמה חייבת להכיל לפחות 6 תווים'); return;
  }

  const btn = $('authSubmitBtn');
  btn.disabled = true;
  btn.textContent = authMode === 'signin' ? 'מתחבר...' : 'נרשם...';

  try {
    const fn = authMode === 'signin' ? 'signInWithPassword' : 'signUp';
    const { data, error } = await sb.auth[fn]({ email, password });
    if (error) throw error;

    // הרשמה ללא אימות מייל — אמור להחזיר session מיד
    if (!data.session) {
      const { error: e2 } = await sb.auth.signInWithPassword({ email, password });
      if (e2) throw e2;
    }
    $('authPassword').value = '';
    toast(authMode === 'signup' ? 'נרשמת בהצלחה 🎉' : 'התחברת בהצלחה');
  } catch (err) {
    showError('authError', friendlyError(err));
  } finally {
    btn.disabled = false;
    setAuthMode(authMode);
  }
}

async function handleGoogle() {
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) throw error;
  } catch (err) {
    showError('authError', friendlyError(err));
  }
}

async function handleGuest() {
  const btn = $('guestBtn');
  btn.disabled = true; btn.textContent = 'נכנס...';
  try {
    const { error } = await sb.auth.signInAnonymously();
    if (error) throw error;
  } catch (err) {
    showError('authError', friendlyError(err));
  } finally {
    btn.disabled = false; btn.textContent = 'המשך כאורח';
  }
}

async function handleLogout() {
  closeAccountMenu();
  await sb.auth.signOut();
  toLogin();
}

// ── שמירת פרטי פרופיל ───────────────────────────────────────
async function saveOnboarding() {
  const initials = $('obInitials').value.trim();
  const phone = $('obPhone').value.trim();
  showError('obError', '');
  if (!initials || !phone) { showError('obError', 'יש למלא שם בראשי תיבות ומספר טלפון'); return; }

  const btn = $('obSaveBtn');
  btn.disabled = true; btn.textContent = 'שומר...';
  try {
    const { error } = await sb.from('profiles')
      .update({ initials, phone }).eq('id', state.user.id);
    if (error) throw error;
    await loadProfile();
    paintAccountUI();
    toast('הפרטים נשמרו ✓');
    goHome();
  } catch (err) {
    showError('obError', friendlyError(err));
  } finally {
    btn.disabled = false; btn.textContent = 'שמור והמשך';
  }
}

function openProfileEdit() {
  closeAccountMenu();
  $('obInitials').value = state.profile?.initials || '';
  $('obPhone').value = state.profile?.phone || '';
  $('onboardTitle').textContent = 'הפרטים שלי';
  $('onboardSub').textContent = 'הפרטים שישמשו בהזמנות הבאות שלך';
  showError('obError', '');
  showScreen('onboardScreen', { back: true });
}

// ── מוצרים ──────────────────────────────────────────────────
async function openWarehouse(wh) {
  state.warehouse = wh;
  state.cart = {};
  state.activeCategory = 'הכל';
  const zuk = wh === 'zuk';

  showScreen('orderScreen', { title: WH_LABEL[wh], back: true, zuk, keepCart: true });
  $('prodSectionTitle').textContent = zuk ? 'בחר ציוד' : 'בחר מוצרים';
  $('prodSearch').value = '';
  $('prodSearch').placeholder = zuk ? 'חיפוש ציוד...' : 'חיפוש מוצר...';

  // פרטי לקוח: שמורים למשתמש רשום, ידניים לאורח
  const known = !state.isGuest && state.profile?.initials && state.profile?.phone;
  $('customerKnown').style.display = known ? 'block' : 'none';
  $('customerFields').style.display = known ? 'none' : 'block';
  if (known) {
    $('customerLine').innerHTML = `${esc(state.profile.initials)} <span>·</span> ${esc(state.profile.phone)}`;
  } else {
    $('ordInitials').value = ''; $('ordPhone').value = '';
  }

  $('prodLoading').style.display = 'block';
  $('prodSection').style.display = 'none';
  updateCartBadge();

  try {
    const { data, error } = await sb.from('inventory')
      .select('name, qty, category')
      .eq('warehouse', wh).eq('exposed', true).gt('qty', 0)
      .order('name');
    if (error) throw error;

    state.products = data || [];
    state.categories = ['הכל', ...new Set(state.products.map(p => p.category).filter(Boolean))];
    renderCategories();
    renderProducts();
    $('prodLoading').style.display = 'none';
    $('prodSection').style.display = 'block';
  } catch (err) {
    $('prodLoading').innerHTML = `<div class="empty-state">שגיאה בטעינת המוצרים:<br>${esc(friendlyError(err))}</div>`;
  }
}

function renderCategories() {
  $('prodCategories').innerHTML = state.categories.map((c, i) =>
    `<button class="cat-btn ${c === state.activeCategory ? 'active' : ''}" data-cat="${i}">${esc(c)}</button>`
  ).join('');
}

function renderProducts() {
  const search = $('prodSearch').value.trim().toLowerCase();
  const list = state.products.filter(p => {
    const okCat = state.activeCategory === 'הכל' || p.category === state.activeCategory;
    const okSearch = !search || p.name.toLowerCase().includes(search);
    return okCat && okSearch;
  });

  const el = $('prodList');
  if (!list.length) { el.innerHTML = '<div class="empty-state">לא נמצאו פריטים</div>'; return; }

  el.innerHTML = list.map(p => {
    const qty = state.cart[p.name]?.qty || 0;
    return `<div class="product-card ${qty > 0 ? 'in-cart' : ''}" data-name="${esc(p.name)}">
      <div>
        <div class="product-name">${esc(p.name)}</div>
        ${p.category ? `<div class="product-cat">${esc(p.category)}</div>` : ''}
        <div class="product-stock">במלאי: ${p.qty}</div>
      </div>
      <div class="qty-control">
        <button class="qty-btn minus" data-act="dec" ${qty === 0 ? 'disabled' : ''}>−</button>
        <input type="number" class="qty-display" value="${qty}" min="0" max="${p.qty}" data-act="set">
        <button class="qty-btn plus" data-act="inc" ${qty >= p.qty ? 'disabled' : ''}>+</button>
      </div>
    </div>`;
  }).join('');
}

function setQty(name, qty) {
  const prod = state.products.find(p => p.name === name);
  if (!prod) return;
  qty = Math.max(0, Math.min(prod.qty, parseInt(qty, 10) || 0));
  if (qty === 0) delete state.cart[name];
  else state.cart[name] = { qty, max: prod.qty };
  updateCartBadge();
  renderProducts();
}

function updateCartBadge() {
  const count = Object.keys(state.cart).length;
  const badge = $('cartBadge');
  $('cartCount').textContent = count + ' פריטים';
  badge.style.display = count > 0 ? 'block' : 'none';
  badge.className = 'cart-badge' + (state.warehouse === 'zuk' ? ' zuk' : '');
}

// ── סל ──────────────────────────────────────────────────────
function openCart() {
  renderCart();
  $('cartOverlay').classList.add('open');
  $('submitBtn').className = 'submit-btn' + (state.warehouse === 'zuk' ? ' zuk' : '');
  $('submitBtn').disabled = state.submitting;
}
function closeCart() { $('cartOverlay').classList.remove('open'); }

function renderCart() {
  const items = Object.entries(state.cart);
  const box = $('cartItems');
  if (!items.length) { box.innerHTML = '<div class="cart-empty">הסל ריק</div>'; return; }
  const zuk = state.warehouse === 'zuk';
  box.innerHTML = items.map(([name, v]) => `
    <div class="cart-item" data-name="${esc(name)}">
      <div class="cart-item-info"><div class="cart-item-name">${esc(name)}</div></div>
      <div class="cart-item-controls">
        <button class="cart-qty-btn" data-act="dec" ${v.qty <= 1 ? 'disabled' : ''}>−</button>
        <span class="cart-qty-num">${v.qty}</span>
        <button class="cart-qty-btn plus ${zuk ? 'zuk-btn' : ''}" data-act="inc" ${v.qty >= v.max ? 'disabled' : ''}>+</button>
        <button class="cart-trash-btn" data-act="del" title="הסר">🗑️</button>
      </div>
    </div>`).join('');
}

// ── שליחת הזמנה ─────────────────────────────────────────────
function getOrderIdentity() {
  if (!state.isGuest && state.profile?.initials && state.profile?.phone) {
    return { initials: state.profile.initials, phone: state.profile.phone };
  }
  return { initials: $('ordInitials').value.trim(), phone: $('ordPhone').value.trim() };
}

function validateOrder() {
  const { initials, phone } = getOrderIdentity();
  if (!initials || !phone) return 'אנא מלא שם בראשי תיבות ומספר טלפון';
  if (!Object.keys(state.cart).length) return 'אנא בחר לפחות פריט אחד';
  return null;
}

function requestSubmit() {
  const err = validateOrder();
  if (err) { showError('cartError', err); return; }
  showError('cartError', '');
  openCertModal();
}

// ── חלונית תעודת ספק ────────────────────────────────────────
let certFile = null;

function openCertModal() {
  certFile = null;
  $('certFile').value = '';
  $('certDrop').classList.remove('has-file');
  $('certDropLabel').textContent = 'העלה תעודת ספק';
  $('certDropHint').textContent = 'קובץ PDF · עד 10MB';
  $('certSendWithFile').disabled = true;
  showError('certError', '');
  $('certModal').classList.add('open');
}
function closeCertModal() { $('certModal').classList.remove('open'); }

function onCertFilePicked(file) {
  showError('certError', '');
  if (!file) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) { showError('certError', 'ניתן להעלות קובץ PDF בלבד'); return; }
  if (file.size > 10 * 1024 * 1024) { showError('certError', 'הקובץ גדול מ-10MB'); return; }
  certFile = file;
  $('certDrop').classList.add('has-file');
  $('certDropLabel').textContent = '✓ ' + file.name;
  $('certDropHint').textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB — לחץ להחלפה';
  $('certSendWithFile').disabled = false;
}

async function submitOrder(certMode) {
  if (state.submitting) return;
  const err = validateOrder();
  if (err) { showError('certError', err); return; }

  const { initials, phone } = getOrderIdentity();
  const btnA = $('certSendWithFile'), btnB = $('certSendLater');
  state.submitting = true;
  btnA.disabled = true; btnB.disabled = true;
  btnB.textContent = 'שולח...';

  try {
    // 1) יצירת ההזמנה
    const { data: order, error: oErr } = await sb.from('orders').insert({
      user_id: state.user.id,
      initials, phone,
      email: state.isGuest ? null : (state.user.email || null),
      warehouse: state.warehouse,
      cert_mode: certMode,
      is_guest: state.isGuest,
    }).select('id').single();
    if (oErr) throw oErr;

    // 2) פריטי ההזמנה
    const items = Object.entries(state.cart).map(([name, v]) => ({
      order_id: order.id, name, qty: v.qty,
    }));
    const { error: iErr } = await sb.from('order_items').insert(items);
    if (iErr) throw iErr;

    // 3) העלאת תעודת הספק (אם נבחרה)
    if (certMode === 'uploaded' && certFile) {
      const safe = certFile.name.replace(/[^\w.\-]+/g, '_');
      const path = `${order.id}/${Date.now()}_${safe}`;
      const { error: upErr } = await sb.storage.from('supplier-certs')
        .upload(path, certFile, { contentType: 'application/pdf', upsert: false });
      if (upErr) {
        toast('ההזמנה נשלחה, אך העלאת התעודה נכשלה', true);
      } else {
        await sb.from('orders').update({ cert_path: path }).eq('id', order.id);
      }
    }

    // 4) התראה במייל למנהלים — לא חוסם; כישלון לא מבטל את ההזמנה
    sb.functions.invoke('send-new-order', { body: { order_id: order.id } })
      .catch(err => console.warn('notify', err));

    state.cart = {};
    updateCartBadge();
    closeCertModal();
    closeCart();
    $('successText').innerHTML = certMode === 'uploaded'
      ? 'תודה, ההזמנה ותעודת הספק התקבלו.<br>נעדכן אותך במייל כשההזמנה תהיה מוכנה לאיסוף.'
      : 'תודה, ההזמנה שלך התקבלה.<br>יש להגיש תעודת ספק בעת האיסוף.';
    showScreen('successScreen');
  } catch (e) {
    showError('certError', friendlyError(e));
  } finally {
    state.submitting = false;
    btnA.disabled = !certFile; btnB.disabled = false;
    btnB.textContent = 'אגיש תעודת ספק באיסוף';
  }
}

// ── ההזמנות שלי ─────────────────────────────────────────────
const MY_STATUS = {
  pending:   { cls: 'pending',   label: '⏳ ממתינה' },
  ready:     { cls: 'approved',  label: '✅ מוכנה לאיסוף' },
  collected: { cls: 'collected', label: '📦 נאספה' },
};

async function openMyOrders() {
  closeAccountMenu();
  showScreen('myOrdersScreen', { title: 'ההזמנות שלי', back: true });
  await loadMyOrders();
}

async function loadMyOrders() {
  const el = $('myOrdersList');
  el.innerHTML = '<div class="loading"><div class="spinner"></div><div>טוען...</div></div>';
  try {
    const { data, error } = await sb.from('orders')
      .select('id, warehouse, status, cert_mode, created_at, order_items(name, qty)')
      .eq('user_id', state.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    if (!data?.length) { el.innerHTML = '<div class="admin-empty">אין לך הזמנות עדיין 📭</div>'; return; }

    el.innerHTML = data.map(o => {
      const st = MY_STATUS[o.status] || MY_STATUS.pending;
      const items = (o.order_items || []).map(i =>
        `<div class="order-item-row"><span class="order-item-name">${esc(i.name)}</span><span class="oi-qty">×${i.qty}</span></div>`
      ).join('');
      const note = o.status === 'ready'
        ? '<div class="cert-row">📞 ליצירת קשר ותיאום איסוף — פנה לקצין הדת</div>' : '';
      const cert = o.cert_mode === 'uploaded'
        ? '<div class="cert-row">📎 תעודת ספק צורפה</div>'
        : '<div class="cert-row none">📋 תעודת ספק תוגש באיסוף</div>';
      return `<div class="order-card ${o.status === 'ready' ? 'approved' : ''}">
        <div class="order-head">
          <div class="order-meta">
            <div class="order-customer">📦 ${esc(WH_LABEL[o.warehouse] || o.warehouse)}</div>
            <div class="order-sub">${esc(fmtDate(o.created_at))}</div>
          </div>
          <span class="order-status ${st.cls}">${st.label}</span>
        </div>
        <div class="order-items">${items}</div>
        ${cert}${note}
      </div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<div class="admin-empty">שגיאה: ${esc(friendlyError(err))}</div>`;
  }
}

// ── חיווט אירועים ───────────────────────────────────────────
function wire() {
  // כניסה
  on('googleBtn', 'click', handleGoogle);
  on('guestBtn', 'click', handleGuest);
  on('authSubmitBtn', 'click', handleEmailAuth);
  on('authToggleBtn', 'click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
  on('authPassword', 'keydown', (e) => { if (e.key === 'Enter') handleEmailAuth(); });
  on('authEmail', 'keydown', (e) => { if (e.key === 'Enter') $('authPassword').focus(); });

  // פרופיל
  on('obSaveBtn', 'click', saveOnboarding);
  on('profileBtn', 'click', openProfileEdit);

  // תפריט חשבון
  on('accountMenuBtn', 'click', (e) => { e.stopPropagation(); $('accountMenu').classList.toggle('open'); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#accountWrap')) closeAccountMenu();
  });
  on('logoutBtn', 'click', handleLogout);
  on('myOrdersBtn', 'click', openMyOrders);
  on('refreshMyOrders', 'click', loadMyOrders);
  on('adminBtn', 'click', () => { closeAccountMenu(); openAdmin(); });

  // ניווט
  on('backBtn', 'click', goHome);
  on('newOrderBtn', 'click', goHome);
  document.querySelectorAll('.warehouse-card').forEach(card =>
    card.addEventListener('click', () => openWarehouse(card.dataset.wh)));

  // מוצרים
  on('prodSearch', 'input', renderProducts);
  on('prodCategories', 'click', (e) => {
    const btn = e.target.closest('.cat-btn'); if (!btn) return;
    state.activeCategory = state.categories[+btn.dataset.cat];
    renderCategories(); renderProducts();
  });
  on('prodList', 'click', (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn || btn.tagName === 'INPUT') return;
    const name = btn.closest('.product-card').dataset.name;
    const cur = state.cart[name]?.qty || 0;
    setQty(name, btn.dataset.act === 'inc' ? cur + 1 : cur - 1);
  });
  on('prodList', 'change', (e) => {
    if (e.target.dataset.act !== 'set') return;
    setQty(e.target.closest('.product-card').dataset.name, e.target.value);
  });

  // סל
  on('cartBadge', 'click', openCart);
  on('cartCloseBtn', 'click', closeCart);
  on('cartOverlay', 'click', (e) => { if (e.target === $('cartOverlay')) closeCart(); });
  on('cartItems', 'click', (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const name = btn.closest('.cart-item').dataset.name;
    const cur = state.cart[name]?.qty || 0;
    if (btn.dataset.act === 'del') setQty(name, 0);
    else setQty(name, btn.dataset.act === 'inc' ? cur + 1 : cur - 1);
    renderCart();
  });
  on('submitBtn', 'click', requestSubmit);

  // תעודת ספק
  on('certDrop', 'click', () => $('certFile').click());
  on('certFile', 'change', (e) => onCertFilePicked(e.target.files[0]));
  on('certSendWithFile', 'click', () => submitOrder('uploaded'));
  on('certSendLater', 'click', () => submitOrder('at_pickup'));
  on('certCancel', 'click', closeCertModal);
  on('certModal', 'click', (e) => { if (e.target === $('certModal')) closeCertModal(); });
}

// ── אתחול ───────────────────────────────────────────────────
(async function init() {
  if (!IS_CONFIGURED) { showScreen('configScreen'); return; }

  wire();
  initAdmin();
  setAuthMode('signin');

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') { toLogin(); return; }
    if (session?.user) {
      const changed = state.user?.id !== session.user.id;
      state.user = session.user;
      if (changed) onSignedIn();
    }
  });

  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) { state.user = session.user; await onSignedIn(); }
  else toLogin();
})();

export { loadProfile, paintAccountUI, openWarehouse };
