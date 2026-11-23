// Supabase Edge Function "generate-plan".
// Keeps the Anthropic API key on the server and asks Claude for a workout plan.
// Secrets to set (Supabase → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY  required
//   ALLOWED_EMAILS     optional, comma-separated. If set, only these accounts can generate plans.
//   DAILY_LIMIT        optional, plans per person per day (default 10)
//   ANTHROPIC_MODEL    optional (default claude-sonnet-5-5)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM =
  "You are a careful strength coach inside a personal workout-log app. " +
  "Follow the user's instructions about format exactly and reply with only the JSON object requested.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // 1. Who is asking?
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user }, error: authError } = await sb.auth.getUser();
    if (authError || !user) return json({ error: "not_signed_in" }, 401);

    // 2. Are they allowed, and under today's limit?
    const allowed = (Deno.env.get("ALLOWED_EMAILS") ?? "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes((user.email ?? "").toLowerCase())) {
      return json({ error: "not_allowed" }, 403);
    }
    const limit = Number(Deno.env.get("DAILY_LIMIT") ?? "10");
    const { data: count, error: usageError } = await sb.rpc("bump_ai_usage");
    if (usageError) { console.error(usageError); return json({ error: "usage_check_failed" }, 500); }
    if (Number(count) > limit) return json({ error: "daily_limit", limit }, 429);

    // 3. Check the request.
    const body = await req.json().catch(() => null);
    const messages = body?.messages;
    const ok = Array.isArray(messages) && messages.length >= 1 && messages.length <= 5 &&
      messages.every((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string") &&
      messages[messages.length - 1].role === "user" &&
      JSON.stringify(messages).length < 60000;
    if (!ok) return json({ error: "bad_request" }, 400);

    // 4. Ask Claude.
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "server_not_configured" }, 500);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5",
        max_tokens: 2500,
        system: SYSTEM,
        messages,
      }),
    });
    if (!r.ok) {
      console.error("Anthropic error", r.status, await r.text());
      return json({ error: "ai_failed", status: r.status }, 502);
    }
    const data = await r.json();
    const text = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    return json({ text });
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
