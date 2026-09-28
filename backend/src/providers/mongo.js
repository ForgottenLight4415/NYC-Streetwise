import { MongoClient } from "mongodb";

// Connection management only — no collection logic lives here (that is cache.js).
//
// `getDb()` returns `null` when Mongo is missing or unreachable, because every
// caller can degrade: the cache treats a null db as a miss, and an absent cache
// is a slower app, not a broken one.
//
// Nothing here throws on startup, so a Mongo outage stays a per-request failure
// rather than a dead process, and the app boots fine with no URI at all.
//
// The deployment target is MongoDB Atlas (`mongodb+srv://…`). Two things follow
// from that and are load-bearing below:
//
//   1. The client is cached on `globalThis`, not just in module scope. Under
//      `node --watch` and under serverless invocation reuse, the module registry
//      can be rebuilt while the process lives on; a module-local memo then opens
//      a fresh pool per reload and walks straight into Atlas's per-cluster
//      connection cap. `globalThis` outlives the module.
//   2. The database name comes from MONGODB_DB, because an SRV URI usually
//      carries no path component to take it from.

const DEFAULT_DB_NAME = "should_i_live_here";

// One slot shared by every copy of this module in the process.
const GLOBAL_KEY = Symbol.for("nyc-streetwise.mongo");
const store = (globalThis[GLOBAL_KEY] ??= {
  connectPromise: null,
  activeClient: null,
  warnedPlaceholder: false,
});

/**
 * Atlas hands you the URI with a literal `<db_password>` in it. Left unfilled it
 * is not a "bad password" — the driver rejects the string at parse time, on
 * every single request. Detect it once and degrade to uncached, which is a
 * supported mode, instead of throwing in a loop.
 */
function hasUnfilledPlaceholder(uri) {
  return /<[^>@/]*(password|username|user|pass)[^>@/]*>/i.test(uri);
}

/** Read at call time, not import time, so a URI can arrive after boot. */
export function isMongoConfigured() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return false;

  if (hasUnfilledPlaceholder(uri)) {
    if (!store.warnedPlaceholder) {
      store.warnedPlaceholder = true;
      console.warn(
        "[mongo] MONGODB_URI still contains an unreplaced <db_password> placeholder " +
          "— treating Mongo as unconfigured. Caching is disabled until it is filled in."
      );
    }
    return false;
  }

  return true;
}

/**
 * Connects lazily and memoizes. Returns `null` when no URI is configured.
 * A failed connection clears the memo so the next request retries rather than
 * being stuck with a rejected promise for the process lifetime.
 */
export async function getDb() {
  if (!isMongoConfigured()) return null;

  if (!store.connectPromise) {
    const uri = process.env.MONGODB_URI;
    store.connectPromise = (async () => {
      // Fail fast. A hung driver would otherwise sit on the request thread well
      // past the point where the user has given up on the page. Overridable so
      // tests can exercise the unreachable-Mongo path without a stall, and so a
      // slow-to-elect Atlas cluster can be given more room.
      const timeoutMs =
        Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 8000;
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: timeoutMs,
        connectTimeoutMS: timeoutMs,
        // Atlas free tier (M0) caps a cluster at 500 connections. This app is
        // read-mostly with a tiny working set, so a small pool is plenty and
        // leaves headroom for other clients on the same cluster.
        maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 10,
        minPoolSize: 0,
        // Reclaim sockets left over from a burst rather than holding them open
        // against the cap.
        maxIdleTimeMS: 60_000,
      });
      await client.connect();
      store.activeClient = client;
      return client.db(process.env.MONGODB_DB || DEFAULT_DB_NAME);
    })().catch((err) => {
      store.connectPromise = null;
      store.activeClient = null;
      throw err;
    });
  }

  return store.connectPromise;
}

/** Closes the pool. Used by tests and by graceful shutdown. */
export async function closeMongo() {
  const client = store.activeClient;
  store.connectPromise = null;
  store.activeClient = null;
  store.warnedPlaceholder = false;
  if (client) await client.close();
}
