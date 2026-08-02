// ============================================================
// Edge Function: send-new-order
// שולח התראה על הזמנה חדשה לכתובות שהוגדרו בטבלת notify_emails
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  readMailEnv, sendMail, layout, metaTable, itemsTable, notice, esc, warehouseTheme,
} from "../_shared/mailer.ts";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { order_id } = await req.json();
    if (!order_id) return json({ error: "חסר מזהה הזמנה" }, 400);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const env = readMailEnv();

    if (!env.userValid) {
      return json({ error: `GMAIL_USER אינו כתובת תקינה: "${env.user}" — בדוק את ה-Secrets` }, 500);
    }
    if (!env.passSet) return json({ error: "GMAIL_APP_PASSWORD חסר — בדוק את ה-Secrets" }, 500);

    // ── חייב להיות מחובר ──
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "לא מחובר" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: order, error: oErr } = await admin
      .from("orders")
      .select("id, user_id, initials, phone, email, warehouse, cert_mode, cert_path, created_at, order_items(name, qty)")
      .eq("id", order_id)
      .single();
    if (oErr || !order) return json({ error: "ההזמנה לא נמצאה" }, 404);

    // רק בעל ההזמנה או מנהל (מניעת ניצול לרעה)
    if (order.user_id !== user.id) {
      const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
      if (prof?.role !== "admin") return json({ error: "אין הרשאה" }, 403);
    }

    const { data: recips } = await admin
      .from("notify_emails").select("email").eq("active", true);
    const to = (recips ?? []).map((r) => r.email).filter(Boolean);
    if (!to.length) return json({ ok: false, skipped: "לא הוגדרו כתובות להתראה" });

    const wh = warehouseTheme(order.warehouse);
    const whLabel = wh.label;
    const headColor = wh.head;
    const accent = wh.accent;
    const items = (order.order_items ?? []) as Array<{ name: string; qty: number }>;
    const units = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
    const when = new Date(order.created_at).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });

    const certNotice = order.cert_path
      ? notice("<strong>תעודת ספק צורפה</strong> — ניתן להורדה בממשק הניהול.", "info")
      : notice("<strong>תעודת ספק תוגש באיסוף.</strong>", "warn");

    const metaRows: Array<[string, string]> = [
      ["שם", order.initials],
      ["טלפון", order.phone],
    ];
    if (order.email) metaRows.push(["אימייל", order.email]);
    metaRows.push(["תאריך", when]);

    const html = layout({
      headColor,
      title: "הזמנה חדשה התקבלה",
      badge: whLabel,
      badgeColor: accent,
      body: metaTable(metaRows)
        + `<tr><td style="padding:0 24px;">${certNotice}</td></tr>`
        + itemsTable(items, headColor),
    });

    const text = [
      `הזמנה חדשה — ${whLabel}`,
      ``,
      `שם: ${order.initials}`,
      `טלפון: ${order.phone}`,
      order.email ? `אימייל: ${order.email}` : null,
      `תאריך: ${when}`,
      order.cert_path ? `תעודת ספק צורפה` : `תעודת ספק תוגש באיסוף`,
      ``,
      `פריטים:`,
      ...items.map((i) => `- ${i.name} (כמות: ${i.qty})`),
      ``,
      `סה"כ פריטים: ${items.length} | סה"כ יחידות: ${units}`,
    ].filter((l) => l !== null).join("\n");

    const info = await sendMail({
      to,
      subject: `הזמנה חדשה — ${whLabel} (${order.initials})`,
      text,
      html,
    });

    return json({ ok: true, sent_to: to, message_id: info?.messageId ?? null });
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
