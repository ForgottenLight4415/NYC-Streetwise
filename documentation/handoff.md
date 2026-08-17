# Handoff

Running log of what changed, what it broke, and what the next person needs to
know. Newest first.

---

## Both tier explanations shown; building-tier "template" explained

**Status:** done. Verified against live data.

### Why Building Health always said "template"

Not a bug, and not the AI failing. Two things compounding:

1. **Zero building complaints is the normal case.** The building radius is
   25m, and sampling 10 spread NYC coordinates found **9 with zero** building
   complaints. `explain.js` deliberately short-circuits a zero-complaint tier
   to template text rather than asking the model (llama3.1 described *zero*
   complaints as "areas of concern" — worse than no AI at all).
2. **The UI was dropping it.** The first version of the banner merged both
   tiers into one paragraph and filtered out anything that wasn't AI-backed.
   With Building Health nearly always template, only the Block Quality
   sentence ever survived — so the building explanation appeared missing
   rather than merely template.

Fixed by keeping the tiers separate: the banner now renders one labeled line
per tier, each falling back to its **own** template text. `explainVerdict` is
now only used when neither tier has any text at all.

### Open item 3 resolved (null-geocoding rate)

`backend/CLAUDE.md` flagged a risk that plumbing/unsanitary complaints might
be poorly geocoded, which would make the building sub-score unreliable.
Measured against live `erm2-nwe9` over 24 months — **all three building
buckets are >99.99% geocoded** (e.g. 651,263 of 651,313 heat complaints). The
risk is not real; table recorded in `backend/CLAUDE.md`.

The useful consequence: zero building counts are **real data**, not a
geocoding artifact. Which means the thing worth revisiting is the 25m radius
itself (open item 5), not the pipeline.

---

## AI explanations wired to the UI; fake-report fallback removed

**Status:** done, verified end-to-end against the live backend.

### What was wrong

Three separate problems stacked on top of each other, all presenting as "the
backend always returns template explanations".

1. **The Docker container was running stale code.** Port 3001 was held by
   `should-i-live-here-backend-1`, built from an older commit. `compose.yaml`
   uses `build: .` with no bind mount — **editing `backend/src/` does not reach
   the running container.** Fix: `docker compose up -d --build backend`.

2. **Ollama was not running.** `AI_PROVIDER=ollama`, so every generation threw
   `ollama unreachable`, which `services/explain.js` catches and degrades to
   template — exactly as designed. The binary was installed and `llama3.1:8b`
   already pulled; the server just wasn't up.

3. **The frontend never consumed the AI explanation at all.** `ScoreSection`
   in `lib/types.ts` didn't even declare `explanation` / `explanationSource`,
   and nothing ever called `GET /api/explanation`. The UI was showing
   client-side `explainVerdict()` text the whole time, so no amount of backend
   fixing would have changed what was on screen.

### What changed

| File | Change |
|---|---|
| `lib/types.ts` | Added `explanation` + `explanationSource` to `ScoreSection`, and an `ExplanationSource` type |
| `lib/api.ts` | Added `fetchExplanation(lat, lng, tier)`; removed the mock fallback and the now-unused `address?` param from `fetchReport` |
| `components/VerdictBanner.tsx` | New optional `aiExplanation` prop driving three states: `"Reasoning..."` → AI text → `explainVerdict` fallback |
| `components/ReportView.tsx` | Fires `fetchExplanation` per template tier after render, joins results, passes to the banner |
| `lib/mock-data.ts` | `buildScoreSection` supplies the two new required fields |
| `app/api/report/route.ts` | **Deleted** — dead code, nothing called it |

Behavior: `/api/score` stays fast and always returns template text. Tiers
already cached as `"ai"` render immediately with no `"Reasoning..."` flash.
Anything else fetches in parallel (~7s/tier on local Ollama) and swaps in. If
every tier fails, the banner falls back to `explainVerdict` — the line is
never empty and never shows an error.

### Gotchas for the next person

- **Mongo is now split dev/prod.** Dev is the compose `mongo` service
  (database `nyc-streetwise-dev`); prod is Atlas (database `nyc-streetwise`),
  configured on the deploy host — see
  [`backend/.env.production.example`](../backend/.env.production.example). No
  code branches on this; only `MONGODB_URI` / `MONGODB_DB` differ.
  - *Previously a gotcha, now fixed:* two Mongos used to be running, and
    `docker compose up` vs `npm run dev` silently hit different databases. The
    compose Mongo now publishes `127.0.0.1:27017`, so both run modes use the
    same dev database. If you still have an old standalone `local-mongo`
    (mongo:7) container squatting on 27017, delete it — it will collide.
  - Atlas's connection string arrives with a literal `<db_password>` in it.
    Left unreplaced, the app warns once and runs **uncached** rather than
    crashing, so the symptom is "the cache does nothing", not an error. Check
    the boot logs.
- **`explanationSource` is per tier**, not per report. Seeing `"template"` on
  `blockQuality` while `buildingHealth` says `"ai"` is correct — it just means
  only the building tier has been generated.
- **Zero-complaint addresses always return `"template"`,** deliberately
  (`explain.js`). llama3.1 described *zero* complaints as "areas of concern",
  so the template is used instead. `"template"` alone is not evidence the AI
  is broken.
- **Ollama runs as a desktop app process** and won't survive a reboot unless
  set to launch at login. `AI_PROVIDER=gemini` removes the local-process
  dependency; `GEMINI_MODEL=gemini-3.5-flash-lite` was verified valid against
  the configured key.
- `backend/CLAUDE.md` is **stale** on the AI model: it documents
  `gemini-2.5-flash-lite` and an Oct 2026 deprecation, but
  `constants.js` defaults to `gemini-3.5-flash-lite`.

### Deliberately not done

`lib/mock-data.ts` still backs three live UI features with no backend
equivalent — the homepage featured carousel (`buildFeaturedReport`), the
autocomplete no-key fallback (`findSuggestions`), and the complaint timeline
(`buildComplaintTimeline`). Removing the file means deleting those features.
Left in place by decision.
