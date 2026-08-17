import { createApp } from "./app.js";
import { ensureCacheIndexes } from "./providers/cache.js";
import { closeMongo, isMongoConfigured } from "./providers/mongo.js";
import { loadBaseline } from "./providers/baseline.js";
import { isMockMode } from "./services/scoreService.js";

const PORT = Number(process.env.PORT) || 3001;

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

// Mongo is OPTIONAL: it backs the complaint cache and nothing else. Without it
// every request goes straight to Socrata — slower, and more likely to throttle,
// but correct. Say so at boot rather than leaving a silent performance cliff.
// isMongoConfigured() is false for both an unset URI and one still holding
// Atlas's <db_password> placeholder; it logs the specific reason itself, so this
// only has to state the consequence.
if (!isMongoConfigured()) {
  console.warn("[cache] no usable MONGODB_URI — caching disabled, every lookup hits Socrata");
} else {
  // Index creation is deliberately NOT awaited before listening. A slow Atlas
  // cluster must not stop the app from answering /health, which is what a host
  // uses to decide the deploy succeeded.
  ensureCacheIndexes()
    .then(() => console.log("[cache] indexes ready"))
    .catch((err) => console.warn("[cache] index setup failed:", err.message));
}

if (isMockMode()) {
  console.warn("[mode] USE_MOCK_DATA is set — serving MOCK data, not live 311");
} else {
  // Warmed at boot, not on the first request: it is memoized for the process
  // lifetime, so paying for it here keeps it off the first user's latency.
  // Not awaited, for the same reason index creation is not.
  loadBaseline()
    .then((baseline) =>
      console.log(
        baseline
          ? `[baseline] loaded ${baseline._id} from ${baseline.source} ` +
              `(${baseline.sampleSize ?? "?"} sample points)`
          : "[baseline] MISSING — scores will be low-confidence. Run `npm run baseline`."
      )
    )
    .catch((err) => console.warn("[baseline] load failed:", err.message));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      closeMongo().finally(() => process.exit(0));
    });
  });
}
