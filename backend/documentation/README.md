# Backend documentation

Per-milestone records for the "Should I Live Here" backend (Person 1 — data layer).

| Doc | Covers |
| --- | --- |
| [handoff.md](handoff.md) | **Start here.** Running log of decisions, roadblocks, and next steps. |
| [m0-scaffolding.md](m0-scaffolding.md) | Project setup, dependencies, `constants.js` |
| [m1-mock-api.md](m1-mock-api.md) | P0 — Express skeleton + mocked endpoints in the frozen contract |
| [m2-socrata-client.md](m2-socrata-client.md) | P1 — Socrata client + live-API verification of CLAUDE.md open items |
| [m3-cache.md](m3-cache.md) | P2 — Mongo cache, cache-first `getCounts`, and the M0–M2 test backfill |
| [m4-m5-scoring-integration.md](m4-m5-scoring-integration.md) | P3/P4 — citywide baseline, pure scoring, and the swap from mock to live data |
| [m6-ai-explanations.md](m6-ai-explanations.md) | P3.5 — AI explanation layer, both adapters, template fallback, model findings |
| [docker.md](docker.md) | Containerized local stack (backend + Mongo) for teammates — decisions and what was verified |

Setup — Docker, environment variables, Ollama — is in
[`../README.md`](../README.md). The HTTP contract itself is documented in
[`../API.md`](../API.md) — endpoints, payloads, errors, and integration notes for
the frontend.

`CLAUDE.md` in the repo root remains the **spec**; these docs record what was
actually built and why. Where the two disagree, CLAUDE.md wins and the doc is
stale — say so in a PR rather than quietly diverging.
