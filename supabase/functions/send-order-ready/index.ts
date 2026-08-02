// ============================================================
// Edge Function: send-order-ready
// שולח מייל "ההזמנה מוכנה לאיסוף" למזמין
// נקרא ע"י המנהל אחרי אישור הזמנה
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
    const RAV_CONTACT = (Deno.env.get("RAV_CONTACT") ?? "").trim();
    const env = readMailEnv();

    if (!env.userValid) {
      return json({ error: `GMAIL_USER אינו כתובת תקינה: "${env.user}" — בדוק את ה-Secrets` }, 500);
    }
    if (!env.passSet) return json({ error: "GMAIL_APP_PASSWORD חסר — בדוק את ה-Secrets" }, 500);

    // ── אימות מנהל ──
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "לא מחובר" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
    if (prof?.role !== "admin") return json({ error: "אין הרשאה" }, 403);

    const { data: order, error: oErr } = await admin
      .from("orders")
      .select("id, initials, phone, email, warehouse, status, created_at, order_items(name, qty)")
      .eq("id", order_id)
      .single();
    if (oErr || !order) return json({ error: "ההזמנה לא נמצאה" }, 404);
    if (!order.email) return json({ ok: false, skipped: "אין כתובת מייל להזמנה זו" });

    const wh = warehouseTheme(order.warehouse);
    const whLabel = wh.label;
    const headColor = wh.head;
    const accent = wh.accent;
    const items = (order.order_items ?? []) as Array<{ name: string; qty: number }>;
    const units = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);

    const contactLine = RAV_CONTACT
      ? `<div style="margin-top:6px;font-weight:bold;">${esc(RAV_CONTACT)}</div>`
      : "";

    const html = layout({
      headColor,
      title: "ההזמנה שלך מוכנה לאיסוף",
      badge: whLabel,
      badgeColor: accent,
      body: `<tr><td style="padding:22px 24px 6px;">
          <div style="font-size:16px;color:#1c1c2e;line-height:1.6;">
            שלום <strong>${esc(order.initials)}</strong>,<br>
            ההזמנה שלך אושרה ומוכנה לאיסוף מהמחסן.
          </div>
          ${notice(`<strong>לתיאום איסוף — יש ליצור קשר עם קצין הדת.</strong>${contactLine}`, "warn")}
          ${notice("<strong>חשוב:</strong> לכל משיכת ציוד יש להציג תעודת ספק. ללא תעודת ספק הציוד לא ימסר.", "danger")}
        </td></tr>`
        + itemsTable(items, headColor),
    });

    const text = [
      `ההזמנה שלך מוכנה לאיסוף — ${whLabel}`,
      ``,
      `שלום ${order.initials},`,
      `ההזמנה שלך אושרה ומוכנה לאיסוף מהמחסן.`,
      ``,
      `לתיאום איסוף יש ליצור קשר עם קצין הדת.${RAV_CONTACT ? "\n" + RAV_CONTACT : ""}`,
      ``,
      `חשוב: לכל משיכת ציוד יש להציג תעודת ספק. ללא תעודת ספק הציוד לא ימסר.`,
      ``,
      `פריטים:`,
      ...items.map((i) => `- ${i.name} (כמות: ${i.qty})`),
      ``,
      `סה"כ פריטים: ${items.length} | סה"כ יחידות: ${units}`,
    ].join("\n");

    const info = await sendMail({
      to: order.email,
      subject: `ההזמנה שלך מוכנה לאיסוף — ${whLabel}`,
      text,
      html,
    });

    await admin.from("orders")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", order_id);

    return json({ ok: true, sent_to: order.email, message_id: info?.messageId ?? null });
  } catch (err) {
    return json({ error: String((err as Error)?.message ?? err) }, 500);
  }
});
