// ============================================================
// שליחת מייל משותפת — nodemailer מעל Gmail SMTP
//
// למה nodemailer ולא denomailer:
// denomailer מייצר כותרת Subject שבורה לטקסט לא-אנגלי
// (=utf-8?Q?... במקום =?utf-8?Q?...?=, ומקפל שורות בצורה לא חוקית).
// Gmail נכשל בפענוח ומציג את כל ההודעה כקוד גולמי.
// nodemailer מיישם RFC 2047 כראוי, כולל עברית בכותרת ובשם השולח.
// ============================================================
import nodemailer from "npm:nodemailer@6.9.16";

export const FROM_NAME = "מערכת הזמנות ציוד דת";

export function readMailEnv() {
  const rawUser = Deno.env.get("GMAIL_USER");
  const rawPass = Deno.env.get("GMAIL_APP_PASSWORD");
  // trim/הסרת רווחים — Google מציג סיסמת אפליקציה כ-"abcd efgh ijkl mnop"
  const user = (rawUser ?? "").trim();
  const pass = (rawPass ?? "").replace(/\s+/g, "");
  return {
    user,
    pass,
    userValid: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user),
    userHadWhitespace: rawUser !== undefined && rawUser !== user,
    passSet: !!rawPass,
    passLen: pass.length,
    passHadSpaces: (rawPass ?? "").length !== pass.length,
  };
}

export async function sendMail(
  opts: { to: string | string[]; subject: string; text: string; html: string },
) {
  const { user, pass } = readMailEnv();

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from: { name: FROM_NAME, address: user },
    to: Array.isArray(opts.to) ? opts.to.join(", ") : opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });

  try { transporter.close(); } catch { /* לא קריטי */ }
  return info;
}

// ── עוטף HTML אחיד לכל המיילים ──
export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function layout(opts: {
  headColor: string;
  title: string;
  badge?: string;
  badgeColor?: string;
  body: string;
}) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0ede8;">
<div dir="rtl" style="background:#f0ede8;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;">
    <tr><td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.08);">
        <tr><td style="background:${opts.headColor};padding:22px 24px;">
          <div style="color:#ffffff;font-size:20px;font-weight:bold;">${opts.title}</div>
          ${opts.badge ? `<div style="margin-top:10px;"><span style="display:inline-block;background:${opts.badgeColor};color:#ffffff;font-size:13px;font-weight:bold;padding:6px 16px;border-radius:20px;">${esc(opts.badge)}</span></div>` : ""}
        </td></tr>
        ${opts.body}
      </table>
      <div style="text-align:center;color:#a7a2a2;font-size:12px;padding:16px 0;">
        מערכת הזמנות ציוד דת &middot; רבנות אוגדה 98
      </div>
    </td></tr>
  </table>
</div>
</body></html>`;
}

export function metaTable(rows: Array<[string, string]>) {
  return `<tr><td style="padding:20px 24px 6px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${rows.map(([k, v]) => `<tr>
        <td style="padding:5px 0;font-size:14px;color:#7c7c8e;width:70px;">${esc(k)}</td>
        <td style="padding:5px 0;font-size:15px;font-weight:bold;color:#1c1c2e;">${esc(v)}</td>
      </tr>`).join("")}
    </table>
  </td></tr>`;
}

export function itemsTable(
  items: Array<{ name: string; qty: number }>,
  headColor: string,
) {
  const rows = items.map((i, idx) => {
    const bg = idx % 2 === 0 ? "#ffffff" : "#f6f5f2";
    return `<tr>
      <td style="padding:11px 16px;border-bottom:1px solid #ececec;font-size:15px;color:#1c1c2e;background:${bg};">${esc(i.name)}</td>
      <td style="padding:11px 16px;border-bottom:1px solid #ececec;font-size:15px;font-weight:bold;color:#1c1c2e;text-align:center;background:${bg};">${i.qty}</td>
    </tr>`;
  }).join("");

  const units = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);

  return `<tr><td style="padding:14px 24px 8px;">
      <div style="font-size:12px;font-weight:bold;color:#7c7c8e;letter-spacing:.5px;">פריטים שהוזמנו</div>
    </td></tr>
    <tr><td style="padding:0 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="border:1px solid #ececec;border-radius:8px;overflow:hidden;">
        <tr>
          <th style="text-align:right;padding:10px 16px;background:${headColor};color:#ffffff;font-size:13px;">מוצר</th>
          <th style="text-align:center;padding:10px 16px;background:${headColor};color:#ffffff;font-size:13px;width:80px;">כמות</th>
        </tr>${rows}
      </table>
    </td></tr>
    <tr><td style="padding:16px 24px 24px;">
      <div style="font-size:14px;color:#1c1c2e;">
        סה&quot;כ פריטים: <strong>${items.length}</strong> &nbsp;&middot;&nbsp; סה&quot;כ יחידות: <strong>${units}</strong>
      </div>
    </td></tr>`;
}

export function notice(text: string, kind: "warn" | "danger" | "info" = "info") {
  const c = {
    warn:   { bg: "#fff8e1", border: "#f0a500", color: "#6b5900" },
    danger: { bg: "#fdecea", border: "#e63946", color: "#7f1d1d" },
    info:   { bg: "#f6f5f2", border: "#457b9d", color: "#1c1c2e" },
  }[kind];
  return `<div style="margin-top:14px;padding:12px 16px;background:${c.bg};border-right:4px solid ${c.border};border-radius:8px;font-size:14px;color:${c.color};line-height:1.6;">${text}</div>`;
}
