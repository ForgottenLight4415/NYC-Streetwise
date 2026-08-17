# Handoff — "Should I Live Here" backend

Running log for the backend/data layer (Person 1). Newest milestone at the top of
each section. Spec lives in `../CLAUDE.md`; per-milestone detail in the `mN-*.md`
files alongside this one.

**Last updated:** 2026-08-16, after authentication was removed for the hosted
demo build.

> ### Note — authentication has been removed
>
> A short-lived JWT auth layer (accounts, sessions, tenant/landlord roles) sat in
> front of `/api/score`, `/api/complaints`, and `/api/explanation`. It has been
> deleted along with its routes, providers, collections, and tests, so the demo
> can be hosted without an account step.
>
> **Every endpoint is public again, and response shapes never changed** — no
> field was added, removed, or renamed by either the addition or the removal.
> Mongo is optional once more; it backs the complaint cache and nothing else.

---

## Where things stand

| Milestone | Status |
| --- | --- |
| M0 — scaffolding, constants | done |
| M1 — P0 mocked API in frozen contract | done |
| M2 — P1 Socrata client + open-item verification | done, decisions resolved |
| M3 — P2 real getCounts + Mongo cache | done (tests backfilled for M0–M2 too) |
| M4 — P3 baseline + pure scoring | done |
| M5 — P4 swap mock for real | done |
| M6 — P3.5 AI explanation layer (new scope) | done |
| P5 — demo hardening | next |
| Docker local stack (not a milestone) | done — see [docker.md](docker.md) |

**Runnable today:** `npm start` serves all three endpoints in the frozen contract
with **live NYC 311 data**, scored against a committed citywide baseline. Needs
nothing to boot; `SOCRATA_APP_TOKEN` for unthrottled live data and `MONGODB_URI`
for the cache (dev: compose mongod; prod: Atlas) are both optional. `USE_MOCK_DATA=1` serves the mock for offline
frontend work.

Each sub-score also carries a plain-English `explanation`. `/api/score` never
waits on the AI; `GET /api/explanation` is the slow path the frontend calls to
upgrade template text in place.

**Tested today:** `npm test` — **299 tests, all passing, no network**.
**Verified today, live:**
- `npm run verify:scoring` — all checks pass. Block-tier median score **49**,
  full 6–98 spread, all three bands populated. That median is the headline: a
  coordinate at the citywide median scores ~50, which is what the baseline is for.
- `npm run verify:cache` — all 10 checks pass; cold 1.6–2.5s, warm **2ms**.
- `npm run verify:dataset` — dataset has not moved, all M2 findings hold.
- `npm run baseline` — 251 points per tier, 0 failures, ~3 min.
- `npm run verify:explanations` — **both** AI adapters run against identical
  inputs. Gemini 0.7–0.9s, Ollama 2.2–2.9s, output close enough to read as one
  product after the prompt was tightened.

---

## Decisions taken

### Setup
- **ESM + Node's built-in `--env-file-if-exists`, no `dotenv`.** One fewer
  dependency, and the app boots with no `.env`, so teammates can clone and run
  before credentials are distributed.
- **`createApp()` split from `index.js`.** Tests build the same app in-process
  without binding a port — one wiring path, no test/prod divergence.
- **Vitest** as the test runner (user choice).
- **Local only this session.** No deploy; no external hosting accounts touched.
- **Docker is a dev-environment tool, not a deploy decision.** `docker compose up`
  in `backend/` gives a teammate the API + Mongo with no local installs. It does
  not replace or block the Vercel path (Vercel ignores Dockerfiles), and
  `npm run dev` on the host is unchanged. Rationale and the deliberate omission
  of an Ollama container are in [docker.md](docker.md).

### Domain
- **Radii: 25m building, 350m block** — midpoints of the spec's ranges. Single
  constants in `RADIUS_TIERS`, so retuning is one line.
- **Score scale: 0–100 where 100 = fewest complaints.** Bands good ≥70, fair ≥40.
  The direction is the thing to remember: high score = good news for a renter.
- **`TYPE_TO_BUCKET` is derived, not hand-maintained.** This is what mechanically
  enforces CLAUDE.md's critical rule that string variants sum into one bucket
  number before scoring. Summing happens in the provider, so nothing downstream
  can accidentally average per-string.
- **`BUCKET_WEIGHTS` exists, all 1s, currently unused.** Present so that a future
  weight change is made explicitly rather than by padding a bucket's type list —
  the failure mode CLAUDE.md decision 6 warns about.

### Client behavior
- Two HTTP calls per address (one per tier), issued **in parallel**.
- Retry **only** on 429/5xx — a malformed SoQL 400 fails identically every time.
- **Jittered** backoff, so demo-day concurrent retries don't resynchronize.
- App token read **at call time**, not import time, so it can arrive later.
- Counts **zero-filled** before summing: Socrata omits empty buckets entirely,
  and a missing bucket becomes `NaN` in the scoring mean.

### Cache (M3)
- **Mongo is optional.** Every cache path degrades to "miss" when it is
  unconfigured, unreachable, or slow; `writeCounts` returns `false` rather than
  throwing. A cache outage costs latency, not a 500.
- **Index creation is not awaited before `listen()`** — a slow Atlas cluster must
  not delay `/health`, which is what a host uses to judge the deploy.
- **Socrata is queried with the ROUNDED coordinate**, not the caller's raw one.
  Otherwise two addresses sharing a cache key describe different circles, and the
  same address returns different numbers depending on who asked first.
- **Partial cached documents count as a miss**, zero counts count as a **hit**.
  A missing bucket would become `NaN`; an all-zero building result is real data
  that M4 flags as low-confidence.
- **`createdAt` is a BSON `Date`.** Mongo's TTL monitor silently ignores string
  dates, producing a cache that looks right and never expires.
- **Compound index is `unique`** + upsert, so concurrent misses cannot leave two
  documents for one circle.
- **`Promise.allSettled`, not `Promise.all`.** With `all`, a failing building
  tier abandoned the block tier's write mid-flight, discarding an HTTP call that
  had already succeeded.

### Scoring + baseline (M4)
- **Each tier's baseline is sampled from its OWN source.** Building points come
  only from HPD building-interior complaints; block points from all types. A
  pooled sample put street corners (Illegal Parking, Street Condition) into the
  building distribution — 36.5% of building points had zero complaints — and
  dragged the building median to ~1. Full numbers in the M4/M5 doc.
- **Ties resolve to the favourable percentile, so zero complaints always scores
  100.** The alternative silently scored a zero count as 50 whenever a bucket's
  median was 0. The risk that creates (a mid-street coordinate looking perfect)
  is carried by the confidence flag, not by distorting the curve.
- **`zeroShare` is a scoring input, not a diagnostic.** These buckets are
  zero-inflated; without it the first complaint interpolates as barely worse
  than none.
- **Baseline lives in Mongo AND in committed `src/config/baseline.json`.** Mongo
  wins when present (refresh without redeploy); the file means a fresh clone
  with no Mongo and no credentials still produces real scores.
- **An incomplete baseline is rejected wholesale**, never used partially — a
  missing bucket would score against `undefined` and hand out a free 100.
- **The baseline records the radii it was sampled at.** Retuning `RADIUS_TIERS`
  without rerunning `npm run baseline` now marks scores `stale_baseline_radius`
  instead of silently shifting every number.
- **Sampling is seeded and deterministic**, so a rerun hits the cache instead of
  paying for ~500 fresh Socrata calls.

### Integration (M5)
- **Socrata failure returns 503 `upstream_unavailable`, not 500.** The frontend
  can act on the first and not the second. M6 adds the stale-cache fallback.
- **Mock is opt-in (`USE_MOCK_DATA=1`), not deleted.** It generates counts only
  and runs them through the real scorer, so mock and live cannot drift in shape.
  `meta.mock: true` marks the payload.
- **`/api/complaints` truncation is reported in headers**, keeping the body a
  bare array. Wrapping it in an object would have been cleaner and would have
  broken every existing caller.

### AI explanations (M6)
- **Only `"ai"` output is cached, never a template.** A cached template is free
  to rebuild, and storing it would make `/api/score` report `"ai"` — so the
  frontend would skip its second call and never get a real explanation.
- **The explanation lives on the counts document**, so one TTL covers both and a
  count refresh discards text written about the old numbers.
- **`writeExplanation` does not touch `createdAt`.** Refreshing it would let a
  frequently-explained address keep stale counts alive forever.
- **The AI is skipped when every count is zero.** llama3.1:8b called zero
  complaints "areas of concern"; the template is both correct and honest there.
- **An unknown `AI_PROVIDER` throws** rather than defaulting. A typo in a Vercel
  env var would otherwise silently disable the whole feature.
- **`GEMINI_THINKING_BUDGET` is configurable and off by default**, because
  whether the field is accepted is model-dependent — and getting it wrong
  produces a truncated 200, not an error. See roadblock 11.
- **Prompt divergence is fixed in `prompt.js`, never per adapter.** Three rules
  exist solely to stop Llama and Gemini drifting into two different voices.

---

## Goals achieved

- Frozen API contract is live and serving — frontend is unblocked (P0's whole purpose).
- Mock data is **deterministic per coordinate**, so the same address always
  returns the same report. Random mocks make frontend work miserable.
- All three of CLAUDE.md's verifiable open items (2, 3, 4) resolved against the
  live API, with findings written back into CLAUDE.md itself.
- Real counts confirmed to discriminate: a quiet Staten Island block returns 19
  noise complaints where Bushwick returns 1,653.
- **A test suite exists.** 135 tests, no network, covering M0–M3. The suite has
  already paid for itself twice: it caught the non-deterministic mock and the
  `Promise.all` write-abandonment race, neither of which was visible by hand.
- Cache layer proven against a real mongod **and the live API**, degrading
  cleanly to "miss" when Mongo is absent or unreachable. The cache is worth
  ~1000x on latency (1.6–2.5s cold → 2ms warm), which is what makes the demo
  feel instant on a pre-warmed address.
- Both verification scripts are re-runnable one-liners: `npm run verify:dataset`
  (did the dataset move?) and `npm run verify:cache` (does the cache path work
  end to end?). Both were used in anger during the M3 outage.
- **The app serves real scores end to end** (M5). Bushwick building 91 / block 36;
  Midtown 86 / 41; a quiet Staten Island block 100 / 85. The scale discriminates
  and the direction is right.
- **The score is defensible, not a count map** (M4). A citywide baseline over
  251 sample points per tier centres the block scale at ~50, verified by
  `npm run verify:scoring` — a third re-runnable check, added this milestone.
- **A wrong baseline was caught and corrected before it shipped.** The first
  build had a third of the building sample sitting on street corners; the
  correction moved the heat/hot-water median from 1 to 30 and turned a real
  Bushwick building from "fair" (67) into "good" (91). `verify:scoring` is what
  surfaced it — no unit test would have.
- **Every score now comes with a plain-English reason** (M6), and the AI can
  fail in any way at all without the user seeing an error or the score slowing
  down. Verified against both adapters, live.
- **Both of CLAUDE.md's model assumptions turned out to be wrong, and both were
  caught by running the thing rather than reading about it** — the specified
  Gemini model is already unavailable, and its replacement needs the opposite
  thinking-budget setting. See roadblocks 10 and 11.

---

## Roadblocks hit, and what we did

### 1. `npm run dev` crashed without a `.env` file
`node --env-file=.env` **exits with an error** when the file is absent, so a
teammate cloning the repo would hit a crash before receiving any credentials.
**Fixed:** switched to `--env-file-if-exists=.env`, which warns and continues.
Verified by booting with no `.env` present.

### 2. Building Health returned all zeros everywhere
First live smoke test gave `{heatHotWater:0, unsanitaryCondition:0, plumbing:0}`
at every location, which looked like a broken client.
**Diagnosis:** the client was fine. My test coordinates were points picked off a
map and landed mid-street. Re-tested using coordinates taken from real 311
records — i.e. actual building points, which is what Google Places returns — and
25m correctly captures thousands of complaints with <1% bleed vs 50m.
**Left behind a real risk — see Watch items below.**

### 3. `within_circle` on `latitude` fails confusingly
The obvious-looking `latitude`/`longitude` fields are numbers and are rejected
with `query.soql.type-mismatch`. The geo column is `location` (a Point).
**Fixed:** confirmed and pinned as `LOCATION_FIELD`.

### 4. Socrata cold-query latency is 11s — REVISED to 1.6–2.5s
First call of a given query shape took ~11s; repeats took 180ms–1.4s.
**Re-measured in M3 through the real cache path: cold 1.6–2.5s, warm 2ms.** The
11s figure was the very first query of a novel shape, which is a worse case than
a warm dataset-side cache — budget ~2.5s for a cold address, not 11s.
**Mitigated for now** by the retry policy; **properly addressed in M6** by
pre-warming the cache for demo addresses. Do not skip that step — 2.5s of dead
air on stage is still bad, and the cache turns it into 2ms.

### 5. Socrata was DOWN for hours during M3 (2026-08-15) — outage over, checks rerun
Every request to the dataset returned `503 Site Currently Unavailable` — not our
client, a plain `curl` got the same. The retry policy behaved correctly and
`npm run verify:cache` reports the outage instead of dumping a stack trace, which
let the Mongo half be verified while the API was down.
**Resolved the same day:** the API returned, and every live check has since been
run and passes. The dataset did not move during the outage.
**The demo risk is not resolved** — this dataset is now known to go fully dark
for hours at a time. See watch items.

### 6. The mock was not actually deterministic
`mockComplaints` built `created_date` from `Date.now()`, so two identical
requests milliseconds apart returned different payloads, breaking the one
property the frontend relies on. Caught by the new route test.
**Fixed:** the timestamp base is quantized to the UTC day.

### 7. A third of the building baseline was street corners (M4) — FIXED
The first baseline drew both tiers from one pooled sample of all complaint
types. `npm run verify:scoring` then reported **36.5% of building-tier points
had zero complaints in every building bucket**.
**Diagnosis:** Illegal Parking and Street Condition geocode to street locations,
not buildings, so a third of the "building" sample was not buildings. They
dragged the building median to ~1, and real residential buildings were scored
against a distribution that was mostly not buildings — telling renters a
building was worse than its actual peers.
**Fixed:** building-tier points are now drawn only from HPD building-interior
complaints. heatHotWater median 1 → **30**, p90 72 → **245**, zero-share 45% →
**6%**. A Bushwick building went from 67 ("fair") to 91 ("good"), and the second
number is the right one.
**Lesson worth keeping:** this was invisible to the unit tests and obvious in a
distribution check. Run `verify:scoring` after any baseline rebuild.

### 8. Zero-count buckets scored 50 instead of 100 (M4) — FIXED
A live mid-street lookup returned building score 83 where it should have been
100. The tie-collapsing rule kept the *highest* percentile at a duplicated
count, so a bucket whose median was 0 scored a zero count as "average".
**Fixed:** ties now resolve to the most favourable percentile, with a regression
test. Found by eyeballing live output, not by a test.

### 9. `$order=unique_key` timed out the sampler (M4) — FIXED
Sampling candidate coordinates timed out at 30s. Measured against a plain curl:
the same query is **0.23s unordered and 9.7s with `$order=unique_key`** — it
sorts the whole matched set. Sampling is unordered now; reproducibility comes
from the seeded date slices instead.

### 10. CLAUDE.md's Gemini model is ALREADY dead (M6) — FIXED
The spec pins `gemini-2.5-flash-lite` and notes a 2026-10-16 shutdown as "fine
for the hackathon timeline". It is not fine now: with a working key it returns
`404 "This model is no longer available to new users"` **today**. It still
appears in the models list, which makes this easy to misdiagnose.
**Fixed:** swapped to `gemini-3.5-flash-lite` (same tier, available, ~0.8s).
The spec's own instruction — keep the model string in one place and confirm that
before relying on it — is what made this a one-constant change.

### 11. A thinking model silently truncated its own answer (M6) — FIXED
`gemini-2.5-flash` with `maxOutputTokens: 120` and no thinking config returned
**HTTP 200** with the body "Living here, you would" — 111 thinking tokens had
eaten the output budget (`finishReason: MAX_TOKENS`). A 200 with a truncated
fragment is far worse than an error, because nothing downstream flags it.
Worse, the fix is not portable: `gemini-3.5-flash-lite` **rejects** the same
`thinkingConfig` with a 400.
**Fixed three ways:** the budget is a constant (off by default, matching the
default model); a 400 retries once without the field so model swaps degrade
rather than break; and a `MAX_TOKENS`-with-no-text response now produces an
error that names the fix instead of the string "MAX_TOKENS".

### 12. The model invented an arithmetic claim (M6) — FIXED
llama3.1:8b described 2876-vs-1253 as "nearly three times as many". It is 2.3×.
Grounded in real numbers, still factually wrong — and wrong in a renting decision.
**Fixed:** the prompt now forbids ratios, percentages, and "X times more"
comparisons outright. `verify:explanations` warns if one reappears.

### 13. Route tests were quietly making live AI calls (M6) — FIXED
The new explanation route tests passed on my machine and would have failed in CI:
they reached a real Ollama server because one happened to be running locally.
**Fixed:** the AI provider is mocked in `routes.test.js` and
`scoreService.test.js`, so the suite is machine-independent and stays offline.

### 14. The error handler dispatched on `err.status`, and `SocrataError` has one — FIXED
A short-lived "4xx means client error" branch in the central error handler
caught `SocrataError` first, because `SocrataError.status` is the **upstream's**
status, not ours. Two existing tests went red immediately — a Socrata 503 started
returning `{"error":"socrata 503: down"}` instead of `upstream_unavailable`.

The tests caught the 503. The case they did **not** cover is a Socrata **400**,
which would have forwarded Socrata's error body — SoQL query text included —
straight to the browser.
**Fixed:** the handler dispatches on error *type*, never a bare status number.
`SocrataError` first, then `instanceof BadRequestError`. The rule is now a
comment at the top of the handler, because the collision is invisible until it
bites.

---

## DECISIONS RESOLVED (2026-08-15) — these extend the API contract

**Both were IMPLEMENTED in M4.** Two further additive fields (`bucketScores`,
`meta`) were added during M4/M5 and need the same nod — see "Resulting contract
extension" below for the full current payload.

### A. `streetCondition` nulls → keep the bucket, expose reliability

Five of six buckets are ~0.01–0.5% null. `streetCondition` is 25.60%, driven
entirely by DOT's `Street Condition` (32.6%), and the nulls are **not uniform**:
Manhattan 19.1% → Queens 31.1%. A uniform undercount would cancel out against a
baseline built from the same data; a 19→31% spread does not, and systematically
flatters Queens and the Bronx.

**Decision:** keep `streetCondition` in the score (preserving 3 even buckets per
sub-score) but mark it as lower-confidence in the response, so the frontend can
visually de-emphasize it rather than presenting it as equally solid.

Rejected: dropping the bucket (loses a real signal for a modest bias);
geocoding the 60k null rows by `incident_address` (correct, not hackathon-scoped).

### B. Zero-complaint building → return a `lowConfidence` marker

A mid-street coordinate returns zero building complaints, which would score as a
**perfect building** — a lookup failure presented to a renter as good news.

**Decision:** when all three building buckets return 0, mark the sub-score
low-confidence instead of returning a clean high score.

Still needed regardless: Person 2 confirming Google Places returns
rooftop-precision coordinates, not street-interpolated ones. The guard is a
safety net, not a substitute for good input.

### Resulting contract extension — ADDITIVE ONLY, needs team sign-off

Both decisions add fields; **no existing field changes name, type, or meaning**,
so a frontend that ignores the new keys keeps working unchanged. That is
deliberate — CLAUDE.md freezes the contract, and additive extension is the only
change that doesn't break the freeze in spirit.

```jsonc
{
  "address": null,
  "buildingHealth": {
    "score": 100, "band": "good",            // unchanged
    "counts": { ... }, "radiusMeters": 25,   // unchanged
    "confidence": "low",                      // "normal" | "low"
    "confidenceReason": "no_complaints_found",// null when normal
    "bucketScores": { "heatHotWater": 100 },  // NEW in M4: per-bucket 0-100
    "bucketConfidence": {}                    // only lists non-normal buckets
  },
  "blockQuality": {
    "score": 51, "band": "fair",
    "counts": { ... }, "radiusMeters": 350,
    "confidence": "normal",
    "confidenceReason": null,
    "bucketScores": { "noise": 26 },
    "bucketConfidence": { "streetCondition": "low" }
  },
  "meta": {                                   // NEW in M4/M5
    "windowMonths": 24,
    "baselineVersion": "v1",
    "baselineSource": "mongo",                // or "file"
    "coord": { "lat": 40.698, "lng": -73.921 },  // the ROUNDED coord we queried
    "cache": { "building": "hit", "block": "hit" }
  }
}
```

`confidenceReason` is one of `no_complaints_found`, `no_baseline`, or
`stale_baseline_radius`.

**Action for the team:** Person 2 should confirm the frontend tolerates these
extra keys. Nothing breaks if they are ignored. `bucketScores` is the only way
the UI can explain *why* a score is what it is, so it is worth using.

---

## Next steps — P5 (demo hardening)

1. **Pre-warm the cache for the demo addresses — scores AND explanations.**
   Non-negotiable: cold is 1.6–2.5s, warm is 2ms, and Socrata has already gone
   fully dark for hours once. Without an explanation pre-warm the demo opens on
   template text and visibly swaps a second later.
2. **Decide the TTL question — it is a spec change, so it needs sign-off.** The
   24h TTL will *delete* pre-warmed documents mid-outage, which is exactly when
   they are needed. Either lengthen it, or drop it and check freshness in-app.
3. **Serve stale cache on live-API failure.** Today an uncached address during an
   outage returns 503 `upstream_unavailable`. A stale-but-labelled score beats an
   error on stage — `confidence` already exists to carry that label.
4. **Keep the backend warm** — free tiers cold-start and look broken mid-demo.
   `/health` is there for exactly this.
5. **Re-run the live checks against the real Atlas cluster**, not the local
   mongod, once the Atlas URI exists: `verify:cache`, then `npm run baseline` so
   the baseline document lands there too.
6. **Exercise `AI_PROVIDER=gemini` on the deployed target**, not just locally.
   It works against the live API from Node; it has never run inside a serverless
   function.
7. **Run `npm run verify:explanations` one last time before demo day** with both
   adapters, and read the output for tone rather than for errors.

**Credentials status:** `SOCRATA_APP_TOKEN` is set in `.env` (gitignored).
`MONGODB_URI` in `.env` is the **dev** database — the compose mongod on
`127.0.0.1:27017`, database `nyc-streetwise-dev`.

The **prod** Atlas cluster (`nyc-streetwise.7aqt3oz.mongodb.net`, database
`nyc-streetwise`) exists and its connection string is recorded in
[`.env.production.example`](../.env.production.example), but the `<db_password>`
placeholder in it has **not** been filled in — that is the one remaining step
before deploy, along with pasting the whole set into the deploy host's env
settings. The app tolerates the placeholder (warns once, runs uncached), so the
failure mode is a silently slow deploy rather than a crash. Verify against a
real password before trusting the prod cache.

Mongo is optional throughout. It is not required to start, and not required for
the *baseline* either — `src/config/baseline.json` is committed and is used
automatically when Mongo has no document.

## Watch items (not blocking, don't lose)

- **~~`/api/complaints` truncates its window~~ — DECIDED IN M5.** The 1000-row
  cap with `$order: created_date DESC` means a dense block returns only its most
  recent months (Bushwick 350m: 1000 rows covering 148 of 730 days), and the
  truncation is uneven between neighbourhoods.
  **Resolution:** the body stays a bare array (frozen shape); truncation is
  reported in `X-Complaints-Truncated` / `X-Complaints-Limit` headers, exposed
  cross-origin. A `limit` parameter allows up to 5000.
  **Still needs Person 2 to know one thing: never count from this endpoint.**
  It is "the most recent N points"; counts come from `/api/score`.
- **The building score does not normalise for building size.** A 200-unit tower
  and a 4-unit walkup with the same per-unit complaint rate do not score the
  same — the tower scores worse, because a 25m circle picks up every unit's
  complaints. Fixing it needs unit counts (PLUTO). Worth a caveat in the UI if
  anyone asks why a big building scores badly.
- **The baseline is a committed artifact, not a live computation.** If
  `WINDOW_MONTHS` or `RADIUS_TIERS` changes, rerun `npm run baseline` or every
  score silently shifts. The scorer catches a radius change
  (`stale_baseline_radius`); it does NOT catch a window change.
- **Baseline sampling is biased toward complaint-generating locations.** A
  building nobody has ever complained about cannot be sampled, so the baseline
  sits slightly high and real scores are slightly generous. Stated here so
  nobody rediscovers it as a bug.
- **`AI_PROVIDER=gemini` has never run on Vercel.** It has been verified live
  from local Node against the real API. The adapter is stateless HTTP so there is
  no known serverless blocker, but "no known blocker" is not "tested".
- **Explanations are not pre-warmed.** P5 should generate them for the demo
  addresses alongside the score pre-warm, or the demo opens on template text and
  visibly swaps a second later.
- **Gemini free-tier rate limits are still unverified** (CLAUDE.md open item 6).
  The cache keeps volume low and a 429 degrades to the template, so this is a
  cost question, not a correctness one — but check the real numbers before
  pointing a live audience at it.
- **`llama3.1:8b` occasionally adds an ungrounded qualifier** — e.g. "relatively
  low considering the size of this building", when the model is never told the
  size. Not an invented specific (no address, date, or incident), but it is the
  8B model reaching. Gemini has not done this. Re-check with
  `npm run verify:explanations` after any prompt change.
- **A cached explanation survives until its counts refresh.** After tightening
  the prompt, previously-cached text stays until the 24h TTL rolls. If a prompt
  fix must take effect immediately, clear `explanation` on the affected
  `complaint_cache` documents.
- **Socrata 503s are real, not theoretical.** It was down for hours during M3.
  Today an uncached address during an outage returns a **503
  `upstream_unavailable`** (M5 — it was a 500). Two things follow for
  **M6**, and they interact:
  (a) pre-warm the demo addresses — non-negotiable now;
  (b) the 24h TTL will *delete* those pre-warmed documents mid-outage. Serving
  stale data on live-API failure therefore needs the TTL lengthened (or dropped,
  with freshness checked in-app) — the current TTL is exactly as CLAUDE.md
  specifies, so **changing it is a spec change and needs sign-off**, not a quiet
  edit. Decide this before demo day, not during it.
- **CORS is `*`.** Fine for a hackathon; tighten before anything public.
- **In Docker, `localhost` is the container.** `compose.yaml` therefore overrides
  `MONGODB_URI` / `MONGODB_DB` / `OLLAMA_ENDPOINT` from `.env`. If someone
  reports "the container ignores my `.env`", this is why — explicit
  `environment:` wins over `env_file:` by design. Compose only ever points at
  the **dev** Mongo; pointing a container at Atlas is an explicit
  `MONGODB_URI_OVERRIDE=… docker compose up`. Note the containerized backend reaches a **host** Ollama
  via `host.docker.internal`; that path is untested (Ollama was not running
  during verification, so only the template fallback was exercised).
- **`MONGO_SERVER_SELECTION_TIMEOUT_MS`** overrides the 8s Mongo connect timeout
  (raised from 5s when prod moved to Atlas — a cold M0 cluster can be slow to
  elect a primary, and a spurious timeout there costs a cache miss on every
  request). Also used by tests to exercise the unreachable-Mongo path without a
  stall. `MONGO_MAX_POOL_SIZE` (default 10) bounds the pool against Atlas's
  500-connection cap.
- **Dataset floor is 2020-01-01.** `WINDOW_MONTHS` beyond ~68 truncates silently.
- **`Heat/Hot Water` and `Unsanitary Condition` (title case) match zero rows** in
  the window — only the uppercase variants exist. Kept deliberately as cheap
  insurance against HPD changing case; harmless, but don't be confused by them.
- **`DEP Street Condition` is nearly extinct** — 28 rows in 24 months.
- **Frontend is address-keyed, backend is coordinate-keyed.** `frontend/lib/api.ts`
  calls `/api/report?address=`; this backend takes `{lat, lng}` and never
  geocodes. Bridging is frontend-side work, but nobody should discover it at
  demo time.
