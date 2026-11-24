// Supabase Edge Function "generate-plan".
// Keeps the Anthropic API key on the server and asks Claude for a workout plan.
// Secrets to set (Supabase → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY  required
//   ALLOWED_EMAILS     optional, comma-separated. If set, only these accounts can generate plans.
//   DAILY_LIMIT        optional, plans per person per day (default 10)
//   ANTHROPIC_MODEL    optional (default claude-sonnet-5-5)
//   ANTHROPIC_EFFORT   optional: low | medium | high (default medium). Lower = fewer thinking tokens.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM =
  "You are a careful strength and conditioning coach inside a personal workout-log app. " +
  "Follow the user's instructions exactly and reply with only the JSON object requested.";

// The reply must match this shape (structured outputs), so it always parses.
// Keep in sync with normalizePlan() / normalizeWod() in index.html.
const MUSCLES = ["chest", "back", "shoulders", "biceps", "triceps", "forearms", "quads", "hamstrings", "glutes", "calves", "core"];
const str = { type: "string" };
const int = { type: "integer" };
const nullable = (t: unknown) => ({ anyOf: [t, { type: "null" }] });
const muscles = { type: "array", items: { type: "string", enum: MUSCLES } };
const obj = (props: Record<string, unknown>) =>
  ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
const PLAN_SCHEMA = obj({
  kind: { type: "string", enum: ["strength", "conditioning", "hybrid"] },
  title: str, summary: str, deload: { type: "boolean" }, estMinutes: int, warmup: str, cooldown: str,
  exercises: { type: "array", items: obj({
    name: str, muscles, secondary: muscles, sets: int, reps: str,
    weight: nullable({ type: "number" }), rir: nullable(int), restSec: int, note: str,
  }) },
  wod: nullable(obj({
    format: { type: "string", enum: ["fortime", "amrap", "emom", "intervals", "chipper"] },
    minutes: int, rounds: nullable(int), workSec: nullable(int), restSec: nullable(int), purpose: str,
    movements: { type: "array", items: obj({
      name: str, reps: str, unit: { type: "string", enum: ["reps", "cal", "m", "s"] },
      weight: nullable({ type: "number" }), muscles, secondary: muscles,
      scaled: nullable(obj({ name: str, reps: str, weight: nullable({ type: "number" }) })),
    }) },
  })),
});

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

    // 4. Ask Claude. Effort "medium" keeps thinking (billed as output) in check; the schema
    // guarantees parseable JSON; max_tokens leaves room for thinking + the plan so it isn't cut off.
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "server_not_configured" }, 500);
    const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
    const effort = ["low", "medium", "high"].includes(Deno.env.get("ANTHROPIC_EFFORT") ?? "")
      ? Deno.env.get("ANTHROPIC_EFFORT") : "medium";
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        system: SYSTEM,
        output_config: { effort, format: { type: "json_schema", schema: PLAN_SCHEMA } },
        messages,
      }),
    });
    if (!r.ok) {
      console.error("Anthropic error", r.status, await r.text());
      return json({ error: "ai_failed", status: r.status }, 502);
    }
    const data = await r.json();

    // 5. Record token use (best effort: a missing ai_calls table never blocks a plan).
    const u = data.usage ?? {};
    const usage = {
      model: data.model ?? model, effort, stop_reason: data.stop_reason ?? null,
      input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0, cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      prompt_chars: JSON.stringify(messages).length,
    };
    console.log("usage", JSON.stringify(usage));
    const { error: logError } = await sb.from("ai_calls").insert({ user_id: user.id, ...usage });
    if (logError) console.error("ai_calls insert failed", logError.message);

    if (data.stop_reason === "refusal") return json({ error: "ai_refused", usage }, 502);
    if (data.stop_reason === "max_tokens") return json({ error: "ai_truncated", usage }, 502);
    const text = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    return json({ text, usage });
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
