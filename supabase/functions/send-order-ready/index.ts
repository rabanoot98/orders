// ============================================================
// Edge Function: send-order-ready
// שולח מייל "ההזמנה מוכנה לאיסוף" דרך Gmail SMTP
// נקרא ע"י המנהל אחרי אישור הזמנה
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { order_id } = await req.json();
    if (!order_id) return json({ error: "חסר מזהה הזמנה" }, 400);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // trim — מנקה רווחים/שורות חדשות שנדבקים בהעתקה ל-Secrets.
    // בסיסמת אפליקציה של Google מסירים גם רווחים פנימיים (מוצגת כ-"abcd efgh ijkl mnop").
    const GMAIL_USER = (Deno.env.get("GMAIL_USER") ?? "").trim();
    const GMAIL_APP_PASSWORD = (Deno.env.get("GMAIL_APP_PASSWORD") ?? "").replace(/\s+/g, "");
    const RAV_CONTACT = (Deno.env.get("RAV_CONTACT") ?? "").trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(GMAIL_USER)) {
      return json({ error: `GMAIL_USER אינו כתובת תקינה: "${GMAIL_USER}" — בדוק את ה-Secrets` }, 500);
    }
    if (!GMAIL_APP_PASSWORD) {
      return json({ error: "GMAIL_APP_PASSWORD חסר — בדוק את ה-Secrets" }, 500);
    }

    // ── אימות שהקורא הוא מנהל ──
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "לא מחובר" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: prof } = await admin.from("profiles")
      .select("role").eq("id", user.id).single();
    if (prof?.role !== "admin") return json({ error: "אין הרשאה" }, 403);

    // ── שליפת ההזמנה ──
    const { data: order, error: oErr } = await admin
      .from("orders")
      .select("id, initials, phone, email, warehouse, status, created_at, order_items(name, qty)")
      .eq("id", order_id)
      .single();

    if (oErr || !order) return json({ error: "ההזמנה לא נמצאה" }, 404);
    if (!order.email) return json({ ok: false, skipped: "אין כתובת מייל להזמנה זו" });

    const isZuk = order.warehouse === "zuk";
    const whLabel = isZuk ? 'ציוד זו״ק' : "מחסן דת";
    const headColor = isZuk ? "#1a3a2e" : "#1c1c2e";
    const accent = isZuk ? "#3a9e6f" : "#457b9d";
    const items = (order.order_items ?? []) as Array<{ name: string; qty: number }>;
    const totalUnits = items.reduce((s, i) => s + (i.qty || 0), 0);

    const itemRows = items.map((i, idx) => {
      const bg = idx % 2 === 0 ? "#ffffff" : "#f6f5f2";
      return `<tr>
        <td style="padding:11px 16px;border-bottom:1px solid #ececec;font-size:15px;color:#1c1c2e;background:${bg};">${esc(i.name)}</td>
        <td style="padding:11px 16px;border-bottom:1px solid #ececec;font-size:15px;font-weight:700;color:#1c1c2e;text-align:center;background:${bg};">${i.qty}</td>
      </tr>`;
    }).join("");

    const contactBlock = RAV_CONTACT
      ? `<div style="margin-top:6px;font-size:14px;color:#1c1c2e;">${esc(RAV_CONTACT)}</div>`
      : "";

    const html = `<div dir="rtl" style="margin:0;padding:0;background:#f0ede8;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
      <tr><td style="background:${headColor};padding:22px 24px;">
        <div style="color:#ffffff;font-size:20px;font-weight:800;">✅ ההזמנה שלך מוכנה לאיסוף</div>
        <div style="margin-top:10px;"><span style="display:inline-block;background:${accent};color:#ffffff;font-size:13px;font-weight:700;padding:6px 16px;border-radius:20px;">${whLabel}</span></div>
      </td></tr>
      <tr><td style="padding:22px 24px 8px;">
        <div style="font-size:16px;color:#1c1c2e;line-height:1.6;">
          שלום <strong>${esc(order.initials)}</strong>,<br>
          ההזמנה שלך אושרה ומוכנה לאיסוף מהמחסן.
        </div>
        <div style="margin-top:16px;padding:14px 16px;background:#fff8e1;border-right:4px solid #f0a500;border-radius:8px;font-size:14px;color:#6b5900;line-height:1.6;">
          <strong>לתיאום איסוף — יש ליצור קשר עם קצין הדת.</strong>${contactBlock}
        </div>
        <div style="margin-top:14px;padding:12px 16px;background:#fdecea;border-right:4px solid #e63946;border-radius:8px;font-size:14px;color:#7f1d1d;line-height:1.6;">
          <strong>חשוב:</strong> לכל משיכת ציוד יש להציג תעודת ספק. ללא תעודת ספק הציוד לא ימסר.
        </div>
      </td></tr>
      <tr><td style="padding:16px 24px 8px;">
        <div style="font-size:12px;font-weight:700;color:#7c7c8e;letter-spacing:.5px;">פריטים בהזמנה</div>
      </td></tr>
      <tr><td style="padding:0 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ececec;border-radius:8px;overflow:hidden;">
          <tr>
            <th style="text-align:right;padding:10px 16px;background:${headColor};color:#ffffff;font-size:13px;">מוצר</th>
            <th style="text-align:center;padding:10px 16px;background:${headColor};color:#ffffff;font-size:13px;width:80px;">כמות</th>
          </tr>${itemRows}
        </table>
      </td></tr>
      <tr><td style="padding:16px 24px 24px;">
        <div style="font-size:14px;color:#1c1c2e;">סה״כ פריטים: <strong>${items.length}</strong> &nbsp;·&nbsp; סה״כ יחידות: <strong>${totalUnits}</strong></div>
      </td></tr>
    </table>
    <div style="text-align:center;color:#a7a2a2;font-size:12px;padding:16px 0;">מערכת הזמנות ציוד דת · רבנות אוגדה 98</div>
  </div>
</div>`;

    const plain = `ההזמנה שלך מוכנה לאיסוף — ${whLabel}

שלום ${order.initials},
ההזמנה שלך אושרה ומוכנה לאיסוף מהמחסן.

לתיאום איסוף יש ליצור קשר עם קצין הדת.${RAV_CONTACT ? "\n" + RAV_CONTACT : ""}

חשוב: לכל משיכת ציוד יש להציג תעודת ספק. ללא תעודת ספק הציוד לא ימסר.

פריטים:
${items.map((i) => `- ${i.name} (כמות: ${i.qty})`).join("\n")}

סה״כ פריטים: ${items.length} | סה״כ יחידות: ${totalUnits}`;

    // ── שליחה דרך Gmail SMTP ──
    const client = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD },
      },
    });

    // חשוב: כתובת בלבד ללא שם תצוגה — denomailer דוחה שם עם תווים לא-אנגליים.
    // (את שם השולח אפשר להגדיר בהגדרות חשבון ה-Gmail עצמו)
    await client.send({
      from: GMAIL_USER,
      to: order.email,
      subject: `ההזמנה שלך מוכנה לאיסוף — ${whLabel}`,
      content: plain,
      html,
    });
    await client.close();

    await admin.from("orders")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", order_id);

    return json({ ok: true, sent_to: order.email });
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
