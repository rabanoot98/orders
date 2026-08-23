import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") || "";
    const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "לא מחובר" }, 401);

    const admin = createClient(url, serviceKey);
    const { data: callerProfile } = await admin.from("profiles").select("role").eq("id", user.id).single();
    if (callerProfile?.role !== "admin") return json({ error: "אין הרשאת מנהל" }, 403);

    const { user_id, action } = await req.json();
    if (!user_id || !["block", "unblock", "delete"].includes(action)) return json({ error: "בקשה לא תקינה" }, 400);
    if (user_id === user.id) return json({ error: "לא ניתן למחוק או לחסום את המשתמש הנוכחי" }, 400);

    const { data: target } = await admin.from("profiles").select("email").eq("id", user_id).single();
    if ((target?.email || "").toLowerCase() === "rabanoot98@gmail.com") return json({ error: "לא ניתן לשנות את המנהל הראשי" }, 400);

    if (action === "delete") {
      const { error } = await admin.auth.admin.deleteUser(user_id);
      if (error) throw error;
    } else {
      const blocked = action === "block";
      const { error: authError } = await admin.auth.admin.updateUserById(user_id, { ban_duration: blocked ? "876000h" : "none" });
      if (authError) throw authError;
      const { error: profileError } = await admin.from("profiles").update({ blocked_at: blocked ? new Date().toISOString() : null }).eq("id", user_id);
      if (profileError) throw profileError;
    }
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
