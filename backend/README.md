# Should I Live Here — backend

NYC 311 address risk API. Send a coordinate, get two 0–100 sub-scores —
**Building Health** (25m radius) and **Block Quality** (350m radius) — each with
complaint counts and a plain-English explanation.

- **HTTP contract:** [`API.md`](API.md) — endpoints, payloads, errors
- **Spec:** [`CLAUDE.md`](CLAUDE.md) — what was decided and why
- **Build log:** [`documentation/`](documentation/README.md)

---

## Prerequisites

Pick one path. You do not need both.

| Path | You need |
| --- | --- |
| **Docker** (recommended for a fresh clone) | Docker Desktop |
| **Native Node** | Node ≥ 20.6 (22.x tested) |

**Nothing is required beyond Node.** Every dependency degrades rather than
fails: no Mongo means an uncached app that hits Socrata on every request, no
Socrata token means throttled but working requests, and no AI provider means
template explanations instead of generated ones. None of them turns an endpoint
into an error.

---

## Quick start

### Option A — Docker

Brings up the API plus MongoDB with no local installs.

```bash
cd backend
docker compose up --build
```

```bash
curl localhost:3001/health

curl -X POST localhost:3001/api/score \
  -H 'Content-Type: application/json' \
  -d '{"lat":40.7128,"lng":-74.0060}'
```

The first call for a coordinate takes ~7s (live NYC Open Data). Every call after
that is ~10ms from the Mongo cache.

Full endpoint reference — parameters, payloads, errors: [`API.md`](API.md).

Two containers run:

| Service | What it is | Host port |
| --- | --- | --- |
| `backend` | the Express API | 3001 |
| `mongo` | MongoDB 8 — the **dev** database (`complaint_cache` + the baseline document). Prod uses Atlas; nothing here is deployed. | 127.0.0.1:27017 |

### Option B — Native Node

```bash
cd backend
npm install
npm run dev          # http://localhost:3001, with --watch
```

That is the whole setup — it runs with no `.env` at all, uncached and throttled.
For a cache, start the dev Mongo and point at it:

```bash
cp .env.example .env

docker compose up -d mongo    # dev database, published on 127.0.0.1:27017
# .env already has MONGODB_URI=mongodb://127.0.0.1:27017
```

Without one the app still starts, and says so:

```
[cache] no usable MONGODB_URI — caching disabled, every lookup hits Socrata
```

`npm start` is the same without file watching. Both load `.env` automatically via
Node's built-in `--env-file-if-exists` — there is no `dotenv` dependency.

---

## Environment setup

**Every variable is optional.** The app boots and answers requests with no
`.env` at all; each one below buys speed or quality, not basic function.

```bash
cd backend
cp .env.example .env
```

| Var | Required? | What it does |
| --- | --- | --- |
| `SOCRATA_APP_TOKEN` | strongly recommended | NYC Open Data token. Without one, requests work but throttle hard under load — set it before any demo. |
| `MONGODB_URI` | no | Enables the complaint cache. `mongodb://127.0.0.1:27017` in dev, an Atlas `mongodb+srv://…` in prod. Without it every lookup hits Socrata live. |
| `MONGODB_DB` | no | `nyc-streetwise-dev` in dev, `nyc-streetwise` in prod. Defaults to `should_i_live_here` when unset. |
| `MONGO_MAX_POOL_SIZE` | no | Defaults to 10. Only raise it if you measure pool saturation. |
| `PORT` | no | Defaults to `3001`. |
| `USE_MOCK_DATA` | no | `1` serves deterministic mock data — useful for offline frontend work. |
| `AI_PROVIDER` | no | `ollama` (default) or `gemini`. |
| `OLLAMA_MODEL` | no | Defaults to `llama3.1:8b`. |
| `OLLAMA_ENDPOINT` | no | Defaults to `http://localhost:11434/api/generate`. |
| `GEMINI_API_KEY` | for `gemini` | **Never commit this.** |
| `GEMINI_MODEL` | no | Defaults to `gemini-3.5-flash-lite`. |
| `GEMINI_THINKING_BUDGET` | no | Set `0` for `gemini-2.5-*` models; leave unset for 3.x. |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | no | Defaults to 8000. Raise it if your cluster is slow to select — a cold Atlas M0 can be. |

### Where to get the credentials

- **Socrata app token** — sign in at
  [data.cityofnewyork.us](https://data.cityofnewyork.us) →
  Profile → Developer Settings → create an app token. Free, instant.
- **Gemini API key** — [aistudio.google.com](https://aistudio.google.com) →
  Get API key. Free tier is enough for a hackathon.

`.env` is gitignored. Keep it that way.

### Mongo setup (optional)

Mongo backs the complaint cache and nothing else. Skipping it costs ~7s per
uncached lookup and nothing else.

#### Dev and prod are different databases

| | Dev | Prod |
| --- | --- | --- |
| Where | Docker, on your machine | MongoDB Atlas |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | `mongodb+srv://…@nyc-streetwise.…mongodb.net/…` |
| `MONGODB_DB` | `nyc-streetwise-dev` | `nyc-streetwise` |
| Set in | `backend/.env` (gitignored) | the deploy host's env settings |
| Reference | `.env.example` | [`.env.production.example`](.env.production.example) |

**No code branches on this.** `src/providers/mongo.js` reads the URI and the
database name and passes them to the driver; local mongod and Atlas SRV look
identical to everything above it. The two database *names* differ on purpose —
an SRV URI carries no database name of its own, so `MONGODB_DB` is the only
thing standing between a local experiment and the production cache.

#### Getting the dev Mongo running

```bash
docker compose up -d mongo
```

That is it. It is published on `127.0.0.1:27017`, so it works both for the API
running in Compose (which reaches it as `mongodb://mongo:27017`) and for
`npm run dev` on the host. It is loopback-only and has no authentication —
never republish it on `0.0.0.0`.

Already have a Homebrew `mongod` on 27017? The bind will collide. Either stop it
(`brew services stop mongodb-community`) or move the container to
`"127.0.0.1:27018:27017"` in `compose.yaml` and set
`MONGODB_URI=mongodb://127.0.0.1:27018`.

#### Pointing at Atlas

Only needed if you are deploying, or deliberately reproducing a prod issue.
Copy the SRV string from **Atlas → Connect → Drivers**, replace `<db_password>`
with the real password, and percent-encode it if it contains `@ : / ? # [ ] %`.

> **The unreplaced `<db_password>` placeholder is caught for you.** Left in, it
> is not a "wrong password" — the driver rejects the string at parse time on
> every request. The app detects it, warns once, and runs uncached:
>
> ```
> [mongo] MONGODB_URI still contains an unreplaced <db_password> placeholder …
> ```
>
> That means a forgotten password shows up as a *slow* app, not a broken one.
> Check the boot logs if the cache seems to be doing nothing.

Atlas checklist: a **Database Access** user with `readWrite`, and **Network
Access** allowing wherever the app runs from. Serverless hosts have no stable
egress IP, so that is usually `0.0.0.0/0` — which makes the database password
the only thing protecting the cluster.

Check Mongo is actually reachable **from where the API runs**, before starting
it. This needs no `mongosh` install — it reuses the driver `npm install` already
put there, and reads `MONGODB_URI` straight from your `.env`:

```bash
node --env-file-if-exists=.env -e "
const {MongoClient}=require('mongodb');
new MongoClient(process.env.MONGODB_URI,{serverSelectionTimeoutMS:3000}).connect()
  .then(c=>c.db().admin().ping().then(()=>{console.log('mongo ok');return c.close()}))
  .catch(e=>{console.error('mongo NOT reachable:',e.message);process.exit(1)});
"
```

If you do have `mongosh`, `mongosh "$MONGODB_URI" --quiet --eval
'db.adminCommand("ping").ok'` does the same. For the Compose container, run it
inside: `docker compose exec mongo mongosh --quiet --eval
'db.adminCommand("ping").ok'`.

#### What gets created

Nothing to set up by hand. The app creates its own collections and indexes at
boot:

| Collection | Holds | Self-maintaining |
| --- | --- | --- |
| `complaint_cache` | 311 counts + explanations | 24h TTL, self-refreshing |
| `baseline` | the citywide percentile baseline | written by `npm run baseline` |

### Environment inside Docker

`compose.yaml` reads your `.env`, so `SOCRATA_APP_TOKEN` and `GEMINI_API_KEY`
carry through without being committed.

**Four values are deliberately overridden**, because `localhost` inside a
container means *the container*, not your machine:

| Var | Value in Docker |
| --- | --- |
| `MONGODB_URI` | `mongodb://mongo:27017` (the compose service — same database `.env`'s `127.0.0.1:27017` reaches, just addressed from inside the network) |
| `MONGODB_DB` | `nyc-streetwise-dev` |
| `OLLAMA_ENDPOINT` | `http://host.docker.internal:11434/api/generate` |
| `PORT` | `3001` |

Compose is a **dev** tool here — it never points at Atlas. To deliberately run a
container against prod, override on the command line rather than editing
`compose.yaml`, so the safe default survives:

```bash
MONGODB_URI_OVERRIDE='mongodb+srv://…' MONGODB_DB=nyc-streetwise docker compose up
```

If you ever think "the container is ignoring my `.env`", this is why — explicit
`environment:` beats `env_file:` in Compose, by design.

---

## Ollama setup (optional — AI explanations)

Each sub-score carries a 1–2 sentence explanation. Without an AI provider that
text comes from a deterministic template; with one it's generated. **This is a
polish feature, not a dependency** — `services/explain.js` catches every failure
(timeout, refused connection, rate limit) and falls back to the template, so
nothing breaks when Ollama isn't there.

### Install and run

```bash
# macOS
brew install ollama          # or download from https://ollama.com/download

ollama serve                 # leave running in its own terminal
ollama pull llama3.1:8b      # ~4.9 GB, once
```

Verify it's up:

```bash
curl -s localhost:11434/api/tags
```

Then start the backend normally — `AI_PROVIDER` defaults to `ollama`, so nothing
else is needed. To confirm you're getting real generations rather than fallback
text, check `explanationSource`:

```bash
curl "localhost:3001/api/explanation?lat=40.7128&lng=-74.0060&tier=block"
# {"explanation":"...","explanationSource":"ai"}   <- ai, not template
```

Want a different model? `OLLAMA_MODEL=llama3` (or anything you've pulled). It's
one variable.

### Ollama with Docker

**Ollama runs on your host, not in a container.** `compose.yaml` points the
backend at `host.docker.internal:11434`, so a host Ollama is picked up
automatically — start `ollama serve`, then `docker compose up`.

There is intentionally no Ollama service in `compose.yaml`. The image plus the
model is a ~5 GB pull, and Docker Desktop on Apple Silicon has no GPU
passthrough, so a containerized 8B model runs CPU-only and would routinely blow
the 45s timeout in `src/config/constants.js` — producing the same template text,
just after a long wait.

### Gemini instead

Faster, and the path a deployment would use. In `.env`:

```bash
AI_PROVIDER=gemini
GEMINI_API_KEY=your-key-here
```

Compare both providers on identical inputs before trusting either:

```bash
npm run verify:explanations
```

### If explanations come back as `"template"`

| Cause | Fix |
| --- | --- |
| `ollama serve` not running | start it; `curl localhost:11434/api/tags` should answer |
| model not pulled | `ollama pull llama3.1:8b` |
| running in Docker | that's expected unless a **host** Ollama is running |
| generation exceeded 45s | normal on a loaded CPU — use Gemini for consistency |
| a cached explanation is stale | cached text lives until the 24h TTL rolls |

---

## Common tasks

```bash
npm test                    # 313 tests, no network. Run these on the host, not in Docker.
npm run baseline            # regenerate the citywide baseline (~3 min, live API)
npm run verify:dataset      # confirm the 311 dataset hasn't moved
npm run verify:scoring      # score distribution sanity check
npm run verify:cache        # cache round-trip against a real Mongo
npm run verify:explanations # both AI adapters, same inputs, side by side
```

With Docker:

```bash
docker compose logs -f backend
docker compose exec backend npm run baseline
docker compose down                # stop; cached complaints survive
docker compose down -v             # stop and wipe the cache volume
```

Inspect the dev cache:

```bash
docker compose exec mongo mongosh --quiet \
  --eval 'db.getSiblingDB("nyc-streetwise-dev").complaint_cache.countDocuments()'
```

MongoDB Compass attaches to `mongodb://127.0.0.1:27017` — the port is already
published. For prod, use the Atlas UI or Compass with the SRV string.

---

## Notes

- **Tests don't run in the image.** `mongodb-memory-server` would download a
  Linux `mongod` on every run and needs glibc. Keep `npm test` on the host.
- **The backend never geocodes.** It takes `{lat, lng}`; turning an address into
  coordinates is frontend-side work.
- **CORS is `*`.** Fine for a hackathon, tighten before anything public.
- Docker is a dev-environment convenience and does not conflict with the Vercel
  serverless path in `CLAUDE.md` — Vercel ignores Dockerfiles.
