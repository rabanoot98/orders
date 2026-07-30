// ============================================================
// ליבה משותפת: חיבור ל-Supabase, מצב, וכלי עזר
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CFG = window.APP_CONFIG || {};
export const ADMIN_EMAIL = (CFG.ADMIN_EMAIL || 'rabanoot98@gmail.com').toLowerCase();
export const IS_CONFIGURED = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

export const sb = IS_CONFIGURED
  ? createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

export const WH_LABEL = { main: 'מחסן דת', zuk: 'ציוד זו"ק' };

export const state = {
  user: null,
  profile: null,
  isAdmin: false,
  isGuest: false,
  warehouse: null,
  products: [],
  categories: [],
  activeCategory: 'הכל',
  cart: {},           // { name: {qty, max} }
  submitting: false,
};

// ── DOM helpers ──
export const $ = (id) => document.getElementById(id);
export const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Screens ──
const SCREENS = [
  'configScreen', 'loginScreen', 'onboardScreen', 'homeScreen',
  'orderScreen', 'successScreen', 'myOrdersScreen', 'adminScreen',
];

export function showScreen(id, opts = {}) {
  SCREENS.forEach((s) => $(s)?.classList.toggle('active', s === id));
  $('headerTitle').textContent = opts.title || 'מערכת הזמנות';
  $('headerSub').textContent = opts.sub || 'רבנות אוגדה 98';
  $('backBtn').classList.toggle('visible', !!opts.back);
  $('mainHeader').classList.toggle('zuk-mode', !!opts.zuk);
  document.body.classList.toggle('zuk-mode', !!opts.zuk);
  if (!opts.keepCart) $('cartBadge').style.display = 'none';
  closeAccountMenu();
  window.scrollTo(0, 0);
}

export function closeAccountMenu() { $('accountMenu')?.classList.remove('open'); }

// ── Toast ──
let toastTimer = null;
export function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

export function showError(id, msg) {
  const e = $(id);
  if (!e) return;
  if (msg) { e.textContent = msg; e.classList.add('show'); }
  else { e.textContent = ''; e.classList.remove('show'); }
}

// ── יכולות סכימה ──
// מתגלה בזמן ריצה: אם migration_03 עוד לא רצה, אין עמודת sort_order
// והמערכת נופלת חזרה למיון לפי שם במקום להישבר.
export const caps = { sortOrder: true };

export function isMissingColumn(err, col) {
  const m = String(err?.message || err || '');
  return m.includes(col) && /does not exist|could not find|schema cache/i.test(m);
}

// שולף מלאי עם מיון לפי סדר התצוגה, עם נפילה חיננית למיון לפי שם
export async function fetchInventory(buildQuery) {
  if (caps.sortOrder) {
    const r = await buildQuery().order('sort_order').order('name');
    if (!r.error) return r.data || [];
    if (!isMissingColumn(r.error, 'sort_order')) throw r.error;
    caps.sortOrder = false;
    console.warn('sort_order חסר — הרץ את migration_03_sort.sql. ממיין לפי שם בינתיים.');
  }
  const r2 = await buildQuery().order('name');
  if (r2.error) throw r2.error;
  return r2.data || [];
}

// ── Formatting ──
export function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('he-IL', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return String(iso); }
}

// ממפה שגיאות Supabase לעברית ידידותית
export function friendlyError(err) {
  const m = String(err?.message || err || '');
  if (/Invalid login credentials/i.test(m)) return 'אימייל או סיסמה שגויים';
  if (/User already registered/i.test(m))   return 'המשתמש כבר קיים — נסה להתחבר';
  if (/Password should be at least/i.test(m)) return 'הסיסמה חייבת להכיל לפחות 6 תווים';
  if (/Unable to validate email/i.test(m) || /invalid.*email/i.test(m)) return 'כתובת אימייל לא תקינה';
  if (/Anonymous sign-ins are disabled/i.test(m)) return 'כניסת אורח מושבתת — יש להפעיל Anonymous sign-ins ב-Supabase';
  if (/rate limit/i.test(m)) return 'יותר מדי ניסיונות — נסה שוב בעוד רגע';
  if (/Failed to fetch/i.test(m)) return 'אין חיבור לשרת — בדוק את החיבור לרשת';
  return m || 'אירעה שגיאה';
}
