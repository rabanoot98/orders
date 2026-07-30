// ============================================================
// Edge Function: send-test-email
// כלי אבחון — בודק את הגדרות ה-Gmail ושולח מייל בדיקה
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { readMailEnv, sendMail, layout, notice } from "../_shared/mailer.ts";

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

  const env = readMailEnv();
  const diag: Record<string, unknown> = {
    gmail_user: env.user || "(ריק)",
    gmail_user_valid: env.userValid,
    gmail_user_had_whitespace: env.userHadWhitespace,
    password_set: env.passSet,
    password_length_after_cleanup: env.passLen,
    password_had_spaces: env.passHadSpaces,
    password_length_ok: env.passLen === 16,
    rav_contact: (Deno.env.get("RAV_CONTACT") ?? "").trim() || "(לא הוגדר)",
  };

  try {
    const body = await req.json().catch(() => ({}));
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // ── אימות מנהל ──
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ ok: false, stage: "auth", error: "לא מחובר", diag }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: prof } = await admin.from("profiles")
      .select("role, email").eq("id", user.id).single();
    if (prof?.role !== "admin") {
      return json({ ok: false, stage: "auth", error: "אין הרשאה — מנהל בלבד", diag }, 403);
    }

    const to = String(body.to ?? "").trim() || prof.email || user.email;
    diag.recipient = to;
    if (!to) return json({ ok: false, stage: "recipient", error: "אין נמען", diag }, 400);

    // ── בדיקות הגדרה ──
    if (!env.userValid) {
      return json({ ok: false, stage: "config",
        error: `GMAIL_USER אינו כתובת תקינה: "${env.user}"`, diag }, 500);
    }
    if (!env.passSet) {
      return json({ ok: false, stage: "config", error: "GMAIL_APP_PASSWORD חסר", diag }, 500);
    }
    if (env.passLen !== 16) {
      return json({ ok: false, stage: "config",
        error: `סיסמת אפליקציה אמורה להיות 16 תווים, התקבלו ${env.passLen}. `
             + `ודא שהעתקת סיסמת אפליקציה (App Password) ולא את סיסמת החשבון.`, diag }, 500);
    }

    // ── שליחה ──
    diag.stage_reached = "sending";
    const html = layout({
      headColor: "#2d6a4f",
      title: "בדיקת מייל עברה בהצלחה",
      badge: "בדיקת מערכת",
      badgeColor: "#40916c",
      body: `<tr><td style="padding:22px 24px 24px;">
        <div style="font-size:15px;color:#1c1c2e;line-height:1.7;">
          הגדרות ה-Gmail תקינות, והמערכת מוכנה לשלוח:
        </div>
        <ul style="margin:12px 0;padding-right:20px;font-size:15px;color:#1c1c2e;line-height:1.8;">
          <li>התראה על הזמנה חדשה</li>
          <li>עדכון &quot;ההזמנה מוכנה לאיסוף&quot;</li>
        </ul>
        ${notice(`נשלח מהכתובת <strong>${env.user}</strong>`, "info")}
      </td></tr>`,
    });

    const info = await sendMail({
      to,
      subject: "בדיקת מייל — מערכת הזמנות ציוד דת",
      text: "אם הגיע המייל הזה, הגדרות ה-Gmail תקינות והמערכת מוכנה לשלוח התראות.",
      html,
    });

    diag.stage_reached = "done";
    diag.message_id = info?.messageId ?? null;
    return json({ ok: true, sent_to: to, diag });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    let hint = "";
    if (/Invalid login|Username and Password not accepted|535|BadCredentials/i.test(msg)) {
      hint = 'האימות נדחה ע"י Gmail — סיסמת האפליקציה שגויה או שייכת לחשבון אחר. '
           + "צור סיסמה חדשה ב-myaccount.google.com/apppasswords.";
    } else if (/timed out|ETIMEDOUT|ECONNREFUSED|socket close|ENOTFOUND/i.test(msg)) {
      hint = "החיבור ל-smtp.gmail.com נכשל. נסה שוב; אם חוזר — ייתכן חסימת פורט.";
    } else if (/2-Step|less secure/i.test(msg)) {
      hint = "נדרש אימות דו-שלבי פעיל בחשבון Google כדי ליצור סיסמת אפליקציה.";
    }
    return json({ ok: false, stage: "smtp", error: msg, hint, diag }, 500);
  }
});
