# Workout Log

Personal workout-logging PWA for one user (the repo owner). No build step, no package manager, no tests.

## Files
- `index.html`: the whole app (HTML, CSS, JS in one file). Exercise library is the `LIB_RAW` text block near the top of the script.
- `config.js`: Supabase URL and publishable key. Public by design; data is protected by row-level security.
- `sw.js`: service worker. Network-first for HTML/JS, cache-first for icons and fonts. Never caches Supabase or AI calls.
- `manifest.webmanifest`, `icons/`: PWA install metadata and icons.
- `vendor/`: bundled supabase-js. Don't edit.
- `schema.sql`: database tables, RLS policies, `bump_ai_usage()`. Reference copy only; the owner runs it by hand in the Supabase SQL editor.
- `index.ts`: Supabase Edge Function `generate-plan` (calls the Anthropic API with a server-side key). Deployed by hand in the Supabase dashboard; not part of the website.

## Rules for every change
- **Bump `VERSION` in `sw.js`** (`wl-vN` → `wl-vN+1`) whenever any site file changes, or installed phones keep the old version.
- Every path in the `SHELL` list in `sw.js` must exist: `cache.addAll` fails on a single 404 and the service worker then never installs. If you add, rename or remove a shell file, update `SHELL`.
- Keep paths relative (`icons/...`, `./sw.js`): the site is served from the `/workout-log/` subpath.
- Changes to `schema.sql` or `index.ts` don't deploy automatically. Tell the owner exactly what to run or paste in Supabase.
- Never put secrets in the repo. The Anthropic key lives only in Supabase Edge Function secrets.

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
