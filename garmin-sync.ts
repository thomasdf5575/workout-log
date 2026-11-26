// Supabase Edge Function "garmin-sync".
// Pulls the owner's recent Garmin Connect data with a Personal API key and stores a
// compact daily summary (garmin_days) and activity list (garmin_activities).
// Secrets to set (Supabase → Edge Functions → Secrets):
//   GARMIN_API_KEY   required. Created at connect.garmin.com → Settings → Personal API.
//   ALLOWED_EMAILS   optional, shared with generate-plan. If set, only these accounts can sync.
// Request body: { today: "YYYY-MM-DD" (the phone's local date), days: 1-28, debug?: true }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const BASE = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Obj = Record<string, any>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);

// First finite number found at any of the dotted paths.
function num(o: unknown, ...paths: string[]): number | null {
  for (const p of paths) {
    let v: any = o;
    for (const k of p.split(".")) v = isObj(v) ? v[k] : undefined;
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}
function str(o: unknown, ...paths: string[]): string | null {
  for (const p of paths) {
    let v: any = o;
    for (const k of p.split(".")) v = isObj(v) ? v[k] : undefined;
    if (typeof v === "string" && v) return v;
  }
  return null;
}
// Garmin wraps lists differently per endpoint: return the first array found.
function list(x: unknown, ...keys: string[]): any[] {
  if (Array.isArray(x)) return x;
  if (!isObj(x)) return [];
  for (const k of [...keys, "data", "items", "summaries"]) if (Array.isArray(x[k])) return x[k];
  return [];
}
const dateOf = (o: Obj, ...paths: string[]) => (str(o, ...paths) ?? "").slice(0, 10);
const okDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const kg = (w: number | null) => (w == null ? null : Math.round((w > 1000 ? w / 1000 : w) * 10) / 10); // Garmin sends grams

// startTimeGMT comes as "YYYY-MM-DD HH:MM:SS" (UTC, no zone).
const gmtIso = (s: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");

function jwtExp(token: string): number | null {
  try {
    const p = token.split(".")[1];
    const payload = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (p.length % 4)) % 4)));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch { return null; }
}

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
    const allowed = (Deno.env.get("ALLOWED_EMAILS") ?? "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes((user.email ?? "").toLowerCase())) return json({ error: "not_allowed" }, 403);

    // 2. Which days?
    const body = await req.json().catch(() => ({}));
    const end = okDate(body?.today) ? body.today : new Date().toISOString().slice(0, 10);
    const days = Math.min(28, Math.max(1, Math.round(Number(body?.days) || 7)));
    const start = addDays(end, -(days - 1));
    const debug = body?.debug === true;

    // 3. Exchange the personal key for a 24-hour access token.
    const key = Deno.env.get("GARMIN_API_KEY");
    if (!key) return json({ error: "garmin_not_configured" }, 500);
    const tr = await fetch(BASE + TOKEN_PATH, { method: "POST", headers: { Accept: "*/*", Authorization: `ApiKey ${key}` } });
    if (!tr.ok) {
      console.error("Garmin token error", tr.status, (await tr.text()).slice(0, 300));
      return json({ error: tr.status === 401 || tr.status === 403 ? "garmin_key_rejected" : "garmin_token_failed", status: tr.status }, 502);
    }
    const token = (await tr.text()).trim();
    const tokenExp = jwtExp(token);

    // 4. Pull everything in parallel. One failing endpoint doesn't stop the rest.
    const get = async (path: string, params?: Record<string, string | number>) => {
      const q = params ? "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) : "";
      const r = await fetch(BASE + path + q, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      return t ? JSON.parse(t) : null;
    };
    const calls: Record<string, Promise<any>> = {
      dailies: get("/usersummary-service/v2/dailysummaries", { startDate: start, endDate: end }),
      sleep: get("/sleep-service/sleep/dailySleepSummariesByDate", { startDate: start, endDate: end }),
      hrv: get(`/hrv-service/hrv/daily/${start}/${end}`),
      bodyBattery: get("/wellness-service/wellness/bodyBattery/reports/daily", { startDate: start, endDate: end }),
      weight: get(`/weight-service/weight/range/${start}/${end}`, { includeAll: "true" }),
      activities: get("/activitylist-service/activities/search/activities", { start: 0, limit: 100, startDate: start, endDate: end }),
      profile: get("/userprofile-service/userprofile/settings"),
    };
    const names = Object.keys(calls);
    const settled = await Promise.allSettled(Object.values(calls));
    const raw: Obj = {}, errors: Obj = {};
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") raw[names[i]] = s.value;
      else { errors[names[i]] = String(s.reason?.message ?? s.reason); console.error("Garmin", names[i], errors[names[i]]); }
    });

    // 5. Boil it down to one row per day.
    const day: Record<string, Obj> = {};
    const at = (d: string) => (okDate(d) ? (day[d] ??= {}) : {});

    for (const x of list(raw.dailies, "dailySummaries")) {
      const r = at(dateOf(x, "calendarDate", "summaryDate", "date"));
      r.rhr = num(x, "restingHeartRate", "restingHeartRateInBeatsPerMinute", "values.restingHR");
      r.bbWake = num(x, "bodyBatteryAtWakeTime", "values.bodyBatteryAtWakeTime");
      r.bbHigh = num(x, "bodyBatteryHighestValue", "values.bodyBatteryHighestValue");
      r.stress = num(x, "averageStressLevel", "values.averageStressLevel");
      r.steps = num(x, "totalSteps", "values.totalSteps");
    }
    for (const x0 of list(raw.sleep, "dailySleepSummaries", "sleepSummaries")) {
      const x = isObj(x0?.dailySleepDTO) ? x0.dailySleepDTO : x0;
      const r = at(dateOf(x, "calendarDate", "sleepDate", "date"));
      r.sleepSec = num(x, "sleepTimeSeconds", "totalSleepTimeSeconds", "sleepTimeInSeconds", "durationInSeconds");
      r.sleepScore = num(x, "sleepScores.overall.value", "overallSleepScore.value", "sleepScore", "overallSleepScore");
    }
    for (const x of list(raw.hrv, "hrvSummaries")) {
      const r = at(dateOf(x, "calendarDate", "date"));
      r.hrv = num(x, "lastNightAvg", "lastNight5MinHigh");
      r.hrvWeek = num(x, "weeklyAvg");
      r.hrvStatus = str(x, "status");
      r.hrvLow = num(x, "baseline.balancedLow");
      r.hrvHigh = num(x, "baseline.balancedUpper");
    }
    for (const x of list(raw.bodyBattery)) {
      const r = at(dateOf(x, "date", "calendarDate"));
      const vals = (Array.isArray(x?.bodyBatteryValuesArray) ? x.bodyBatteryValuesArray : [])
        .map((v: any) => (Array.isArray(v) ? Number(v[1]) : NaN)).filter(Number.isFinite);
      if (vals.length && r.bbHigh == null) r.bbHigh = Math.max(...vals);
      if (r.bbWake == null && r.bbHigh != null) r.bbWake = r.bbHigh; // morning peak, until the wake value is confirmed
    }
    for (const x of list(raw.weight, "dailyWeightSummaries", "dateWeightList")) {
      const r = at(dateOf(x, "summaryDate", "calendarDate", "date"));
      const w = kg(num(x, "latestWeight.weight", "weight", "allWeightMetrics.0.weight"));
      if (w) r.weightKg = w;
    }

    // 6. Activities.
    const acts = list(raw.activities, "activityList").map((a: Obj) => {
      const zones = [1, 2, 3, 4, 5].map((z) => num(a, `hrTimeInZone_${z}`));
      return {
        id: num(a, "activityId"),
        start: str(a, "startTimeGMT"),
        data: {
          name: str(a, "activityName"),
          type: str(a, "activityType.typeKey") ?? "other",
          parent: num(a, "activityType.parentTypeId"),
          startLocal: str(a, "startTimeLocal"),
          sec: num(a, "duration", "elapsedDuration", "movingDuration"),
          m: num(a, "distance"),
          avgHr: num(a, "averageHR"),
          maxHr: num(a, "maxHR"),
          kcal: num(a, "calories"),
          te: num(a, "aerobicTrainingEffect"),
          teAn: num(a, "anaerobicTrainingEffect"),
          load: num(a, "activityTrainingLoad"),
          zones: zones.some((z) => z != null) ? zones.map((z) => z ?? 0) : null,
        },
      };
    }).filter((a) => a.id != null && a.start);

    // 7. Profile basics for the Personal info page.
    const u = isObj(raw.profile?.userData) ? raw.profile.userData : raw.profile;
    const profile = isObj(u) ? {
      weightKg: kg(num(u, "weight")),
      heightCm: num(u, "height"),
      birthYear: Number((str(u, "birthDate") ?? "").slice(0, 4)) || null,
      sex: (str(u, "gender") ?? "").toLowerCase() || null,
    } : null;

    // 8. Save (row-level security limits writes to the caller's rows).
    const now = new Date().toISOString();
    const dayRows = Object.entries(day).map(([d, data]) => ({ user_id: user.id, day: d, data, updated_at: now }));
    if (dayRows.length) {
      const { error } = await sb.from("garmin_days").upsert(dayRows, { onConflict: "user_id,day" });
      if (error) { console.error(error); return json({ error: "save_failed", detail: error.message }, 500); }
    }
    if (acts.length) {
      const rows = acts.map((a) => ({ user_id: user.id, id: a.id, start: gmtIso(a.start!), data: a.data, updated_at: now }));
      const { error } = await sb.from("garmin_activities").upsert(rows, { onConflict: "user_id,id" });
      if (error) { console.error(error); return json({ error: "save_failed", detail: error.message }, 500); }
    }

    const out: Obj = { ok: true, start, end, days: dayRows.length, activities: acts.length, profile, tokenExp, errors };
    // Debug: a trimmed sample of each raw response, to check field names against real data.
    if (debug) out.sample = Object.fromEntries(Object.entries(raw).map(([k, v]) => {
      const first = Array.isArray(v) ? v[0] : isObj(v) ? (list(v)[0] ?? v) : v;
      return [k, JSON.stringify(first ?? null).slice(0, 2500)];
    }));
    return json(out);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
