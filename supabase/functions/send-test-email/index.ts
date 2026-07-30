// ============================================================
// Edge Function: send-test-email
// כלי אבחון — בודק את הגדרות ה-Gmail ושולח מייל בדיקה
// מחזיר שגיאה מפורטת כדי לאתר תקלות הגדרה
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const diag: Record<string, unknown> = {};

  try {
    const body = await req.json().catch(() => ({}));
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const rawUser = Deno.env.get("GMAIL_USER");
    const rawPass = Deno.env.get("GMAIL_APP_PASSWORD");
    const GMAIL_USER = (rawUser ?? "").trim();
    const GMAIL_APP_PASSWORD = (rawPass ?? "").replace(/\s+/g, "");

    // ── דוח הגדרות (בלי לחשוף את הסיסמה) ──
    diag.gmail_user = GMAIL_USER || "(ריק)";
    diag.gmail_user_valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(GMAIL_USER);
    diag.gmail_user_had_whitespace = rawUser !== undefined && rawUser !== GMAIL_USER;
    diag.password_set = !!rawPass;
    diag.password_length_after_cleanup = GMAIL_APP_PASSWORD.length;
    diag.password_had_spaces = (rawPass ?? "").length !== GMAIL_APP_PASSWORD.length;
    diag.password_length_ok = GMAIL_APP_PASSWORD.length === 16;
    diag.rav_contact = (Deno.env.get("RAV_CONTACT") ?? "").trim() || "(לא הוגדר)";

    // ── אימות מנהל ──
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ ok: false, stage: "auth", error: "לא מחובר", diag }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: prof } = await admin.from("profiles").select("role, email").eq("id", user.id).single();
    if (prof?.role !== "admin") {
      return json({ ok: false, stage: "auth", error: "אין הרשאה — מנהל בלבד", diag }, 403);
    }

    const to = String(body.to ?? "").trim() || prof.email || user.email;
    diag.recipient = to;
    if (!to) return json({ ok: false, stage: "recipient", error: "אין נמען", diag }, 400);

    // ── בדיקות הגדרה לפני ניסיון שליחה ──
    if (!diag.gmail_user_valid) {
      return json({ ok: false, stage: "config",
        error: `GMAIL_USER אינו כתובת תקינה: "${GMAIL_USER}"`, diag }, 500);
    }
    if (!GMAIL_APP_PASSWORD) {
      return json({ ok: false, stage: "config", error: "GMAIL_APP_PASSWORD חסר", diag }, 500);
    }
    if (GMAIL_APP_PASSWORD.length !== 16) {
      return json({ ok: false, stage: "config",
        error: `סיסמת אפליקציה אמורה להיות 16 תווים, התקבלו ${GMAIL_APP_PASSWORD.length}. `
             + `ודא שהעתקת סיסמת אפליקציה (App Password) ולא את סיסמת החשבון.`, diag }, 500);
    }

    // ── חיבור ושליחה ──
    diag.stage_reached = "connecting";
    const client = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: GMAIL_USER, password: GMAIL_APP_PASSWORD },
      },
    });

    diag.stage_reached = "sending";
    await client.send({
      from: GMAIL_USER,
      to,
      subject: "בדיקת מייל — מערכת הזמנות ציוד דת",
      content: "אם הגיע המייל הזה, הגדרות ה-Gmail תקינות והמערכת מוכנה לשלוח התראות.",
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;background:#f0ede8;padding:24px;">
        <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;">
          <div style="background:#2d6a4f;color:#fff;padding:20px 24px;font-size:19px;font-weight:800;">
            ✅ בדיקת מייל עברה בהצלחה
          </div>
          <div style="padding:22px 24px;font-size:15px;color:#1c1c2e;line-height:1.7;">
            הגדרות ה-Gmail תקינות והמערכת מוכנה לשלוח:
            <ul style="margin:12px 0;padding-right:20px;">
              <li>התראה על הזמנה חדשה</li>
              <li>עדכון "ההזמנה מוכנה לאיסוף"</li>
            </ul>
            <div style="color:#7c7c8e;font-size:13px;margin-top:14px;">
              נשלח מ־${GMAIL_USER}
            </div>
          </div>
        </div>
      </div>`,
    });
    await client.close();

    diag.stage_reached = "done";
    return json({ ok: true, sent_to: to, diag });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    let hint = "";
    if (/Invalid login|Username and Password not accepted|535/i.test(msg)) {
      hint = "האימות נדחה ע\"י Gmail — סיסמת האפליקציה שגויה, או שהיא נוצרה לחשבון אחר. "
           + "צור סיסמת אפליקציה חדשה ב-myaccount.google.com/apppasswords.";
    } else if (/valid email address/i.test(msg)) {
      hint = "כתובת השולח נדחתה — ודא ש-GMAIL_USER מכיל רק את הכתובת, בלי שם תצוגה.";
    } else if (/timed out|connection|refused|dns/i.test(msg)) {
      hint = "החיבור ל-smtp.gmail.com נכשל. נסה שוב; אם חוזר — ייתכן חסימת פורט.";
    } else if (/2-Step|less secure/i.test(msg)) {
      hint = "נדרש אימות דו-שלבי פעיל בחשבון Google כדי ליצור סיסמת אפליקציה.";
    }
    return json({ ok: false, stage: "smtp", error: msg, hint, diag }, 500);
  }
});
