# Docker — containerized local stack

Not a numbered milestone; a side addition after M6. Goal was **local
team reproducibility**: let Person 2 and Person 3 get a working API on
`localhost:3001` without installing Node 22, installing Mongo, or distributing
credentials first.

User-facing instructions live in [`../README.md`](../README.md) — Docker, env, and
Ollama setup all in one place. This file records what was decided and why.

## What was added

| File | Purpose |
| --- | --- |
| `../Dockerfile` | `node:22-alpine`, `npm ci --omit=dev`, `CMD npm start` |
| `../.dockerignore` | keeps `node_modules`, `.env`, `test/`, docs out of the image |
| `../compose.yaml` | `backend` + `mongo` services, one named volume |
| `../README.md` | backend front door — Docker, env, and Ollama setup |

No application source changed. The backend needed **zero** modification to
containerize — the M0 decisions (env-driven config, `createApp()` split from the
listener, optional Mongo, dependency-free `/health`) already covered everything a
container needs.

## Decisions

- **No Ollama container**, despite the AI layer defaulting to `AI_PROVIDER=ollama`.
  The image plus `llama3.1:8b` is a ~5 GB pull, and Docker Desktop on Apple
  Silicon has no GPU passthrough — a containerized 8B model runs CPU-only and
  would routinely exceed the 45s `AI_TIMEOUT_MS.ollama` ceiling, producing
  template text anyway after a long wait. Instead `compose.yaml` points
  `OLLAMA_ENDPOINT` at `host.docker.internal:11434`, so a **host** Ollama is used
  if one is running and the template fallback covers it when one is not.
- **`env_file` with `required: false`.** Passes `SOCRATA_APP_TOKEN` /
  `GEMINI_API_KEY` through from the gitignored `.env` without committing them,
  while still starting cleanly for a teammate who has no `.env` at all. Needs
  Compose ≥ 2.24; 2.40 is installed.
- **Explicit `environment:` overrides `env_file`** for `MONGODB_URI`,
  `MONGODB_DB` and `OLLAMA_ENDPOINT`. The local `.env` points the first and last
  at `localhost`, which inside a container is the container. This is the single
  most likely thing to confuse someone debugging the stack.
- **Compose is dev-only, and only ever talks to the dev Mongo.** Prod is Atlas
  and is configured on the deploy host, not here. The `MONGODB_URI` override is
  written as `${MONGODB_URI_OVERRIDE:-mongodb://mongo:27017}` — a separate
  variable rather than `${MONGODB_URI:-…}` on purpose, because Compose
  interpolates from `./.env`, so the plain form would let whatever is in `.env`
  quietly become the container's database. Deliberately running a container
  against Atlas is then an explicit `MONGODB_URI_OVERRIDE=… docker compose up`.
- **Alpine is safe here** only because `mongodb-memory-server` — the one package
  that needs glibc — is a devDependency that `--omit=dev` excludes. Which is also
  why **tests are not run in the image**: a Linux `mongod` would be downloaded on
  every run. `npm test` stays on the host.
- **Mongo publishes `127.0.0.1:27017`.** Loopback only — this mongod has no
  authentication, so it must never bind `0.0.0.0`. It is published (it was not,
  originally) so that `npm run dev` on the host and the containerised API use
  the *same* dev database instead of silently diverging depending on how you
  started the app.
- **`HEALTHCHECK` uses Node's global `fetch`**, not curl — the alpine image has
  no curl and adding one for a healthcheck is not worth a layer.
- **Independent of the Vercel path** in `CLAUDE.md`. Vercel ignores Dockerfiles,
  so `serverless-http` / `api/index.js` remain unbuilt and unaffected. This is a
  dev-environment tool, not a deploy decision.

## Verified

Built and run end to end on 2026-08-15:

- Image **254 MB**; `node_modules` confirmed not leaked in.
- `docker compose up -d` → both services report `healthy`.
- `/health` → 200. Boot log shows `[baseline] loaded v1 from file (251 sample
  points)` and `[cache] indexes ready`.
- `POST /api/score` at `40.7128,-74.0060` → **7.0s cold, 9ms warm**, proving the
  container reaches both live Socrata and the `mongo` service. `complaint_cache`
  held 2 documents afterwards (one per radius tier).
- `GET /api/complaints` → array in the frontend heatmap shape.
- `POST /api/score` with `lat: 99` → **400**, so validation survives the port.
- `docker compose down && up` → cache survived on the named volume (warm 24ms).
- Host regression: `npm test` → **299 passing**, unchanged.

## Not verified

- **The `explanationSource: "ai"` path.** Ollama was not running on the host
  during verification, so the container correctly fell back to template text
  (ECONNREFUSED, caught by `services/explain.js`) — that proves the *fallback*,
  not the success case. Start `ollama serve` on the host and re-hit
  `GET /api/explanation` to confirm `host.docker.internal` actually carries a
  real generation. Expected to work; untested.
- **Anything on Linux or Windows.** Verified on macOS/Apple Silicon only.
  `extra_hosts: host-gateway` is included for Linux but was not exercised.
