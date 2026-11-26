# Workout Log

Personal workout-logging PWA for one user (the repo owner). No build step, no package manager, no tests.

## Files
- `index.html`: the whole app (HTML, CSS, JS in one file). Exercise library is the `LIB_RAW` text block near the top of the script (`name|main muscles (1-3, comma-separated)|assisting muscles|equipment|type`).
- Exercises store `muscles` (1-3 main) plus `muscle` (= first main, kept for older code and backups). Weekly volume counts 1 per set for each main muscle, 0.5 per assisting muscle. Always read muscles through `musclesOf()`, which also handles entries saved before multi-muscle support.
- Plan generation rules (priority, weekly set targets, RIR, deloads) live in `PRIORITIES`, `PRIORITY_RULE` and `buildPrompt()`.
- Starting numbers (`settings.baselines`) are only entered on the first-run screen (`viewWelcome`, shown while `settings.onboarded` is false and there are no sessions); after that, logged sessions drive all suggestions. Saved sessions can be edited: `draftFromSession()` loads one into the log as a draft with `editing: true`.
- The exercise list is `LIB`: `DEFAULT_LIB` (from `LIB_RAW`) minus `settings.exLib.hidden`, with `settings.exLib.custom` entries added or replacing defaults of the same name. `rebuildLib()` runs on every render; edit the defaults in `LIB_RAW`, the person's own changes in Setup → Exercises.
- Plan mix (`S.gen.mix`, % strength in steps of 25; 100 = strength only, 0 = conditioning only, else hybrid). `generate()` enforces it: no workout at 100, no strength part at 0. Conditioning plans and sessions carry `wod` ({format: fortime|amrap|emom|intervals|chipper, minutes, rounds, workSec, restSec, movements[]}); sessions add `score`, `rx`, `effort`. Each round of a weighted WOD movement counts ½ set (¼ for assisting muscles) in `weekVolume()`. The workout clock (`clockState`/`tickClock`) runs from the start timestamp with a 10 s countdown; beeps use Web Audio.
- Locations (`settings.profiles[]`) have `eq` (keys of `EQUIP`) and optional available weights in `w` (see `WEIGHTED`, `availList`, `snapW`); suggestions and prompts only use weights available at the location.
- Garmin (optional, `settings.garmin.enabled`): `garminSync()` calls the `garmin-sync` Edge Function on app open, on return to the foreground and before generating (at most every 15 min), then `loadGarmin()` reads `garmin_days` (per-day `data`: sleepSec, sleepScore, sleepEnd, hrv, hrvWeek, hrvStatus, hrvLow, hrvHigh, rhr, bbWake, bbHigh, bbLow, stress, steps, weightKg, bodyFat) and `garmin_activities` (id, start, `data`: type, name, startLocal, sec, m, avgHr, maxHr, kcal, te, teAn, load, zones) into `S.garmin`. The app must keep working when Garmin is off or failing. Key expiry (`settings.garmin.keyExpires`) warns in Setup at 14 days and on the Plan page at 7.
- Readiness (`readinessFor(day)`, rules R1-R4 in its comment): points from sleep, HRV vs baseline, resting HR vs the previous 7 days and Body Battery at wake; total ≥+2 fresh, ≤-2 tired, needs 2+ signals. The Plan page pre-selects the suggestion once a day unless the trainee picked (`S.gen.energyPick`/`energyAuto`), `readinessWarning()` offers a light session, `readinessPrompt()` adds a recovery line, and 3+ tired days in 7 (`tiredDays7()`) makes a deload more likely.
- Personal info (Setup → Personal info): sex, experience, goals, limitations, `settings.personal` {birthYear, height, weights[{date,kg}]}. `currentWeight()` takes the most recent of manual and Garmin weigh-ins; `bodyText()` adds age, weight and height to the prompt.
- `config.js`: Supabase URL and publishable key. Public by design; data is protected by row-level security.
- `sw.js`: service worker. Network-first for HTML/JS, cache-first for icons and fonts. Never caches Supabase or AI calls.
- `manifest.webmanifest`, `icons/`: PWA install metadata and icons.
- `vendor/`: bundled supabase-js. Don't edit.
- `schema.sql`: database tables, RLS policies, `bump_ai_usage()`. Reference copy only; the owner runs it by hand in the Supabase SQL editor.
- `garmin-sync.ts`: Supabase Edge Function `garmin-sync`. Exchanges the `GARMIN_API_KEY` secret (Garmin Connect Personal API key) for a 24 h token at personal.connectapi.garmin.com, pulls up to 28 days and upserts `garmin_days` / `garmin_activities` with the caller's JWT (RLS). Field names are read defensively; send `{debug:true}` to get raw response samples. Deployed by hand like `index.ts`.
- `index.ts`: Supabase Edge Function `generate-plan` (calls the Anthropic API with a server-side key). Deployed by hand in the Supabase dashboard; not part of the website.
  It sends `output_config: {effort, format: json_schema}` (`PLAN_SCHEMA` must stay in sync with `normalizePlan()`/`normalizeWod()`), and logs token use to the `ai_calls` table, shown in Setup → AI usage. Keep prompts lean: `buildPrompt()` only includes the sections the chosen mix needs.

## Rules for every change
- **Bump `VERSION` in `sw.js`** (`wl-vN` → `wl-vN+1`) whenever any site file changes, or installed phones keep the old version.
- Every path in the `SHELL` list in `sw.js` must exist: `cache.addAll` fails on a single 404 and the service worker then never installs. If you add, rename or remove a shell file, update `SHELL`.
- Keep paths relative (`icons/...`, `./sw.js`): the site is served from the `/workout-log/` subpath.
- Changes to `schema.sql`, `index.ts` or `garmin-sync.ts` don't deploy automatically. Tell the owner exactly what to run or paste in Supabase.
- Never put secrets in the repo. The Anthropic key lives only in Supabase Edge Function secrets.
- Keep the repo root clean: save screenshots, test scripts and other scratch output outside the repo (e.g. the session scratchpad), never in it. `.gitignore` blocks common junk; run `git status` before every commit and stage files by name rather than `git add -A`.

## Deploy
- `.github/workflows/deploy.yml` publishes to GitHub Pages on every push to `main`: https://thomasdf5575.github.io/workout-log/
- It ships only `index.html`, `config.js`, `manifest.webmanifest`, `sw.js`, `icons/`, `vendor/`. A new top-level site file must be added to the "Collect site files" step.
- Workflow: work on a branch, open a PR, the owner merges (or says "merge it"), and Pages updates within about a minute.

## Check locally
```bash
python3 -m http.server 8000
```
Then confirm every `SHELL` path returns 200, and open the app in a browser (Playwright is available in cloud sessions).

## Supabase settings (managed by the owner, not in the repo)
- Sign-ups disabled; Edge Function secret `ALLOWED_EMAILS` restricts plan generation to the owner.
- Auth redirect URL includes the Pages URL above.
