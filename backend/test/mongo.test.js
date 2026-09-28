import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { startMongo } from "./helpers/mongoTestServer.js";
import { getDb, isMongoConfigured, closeMongo } from "../src/providers/mongo.js";

// Connection-management behaviour only. Collection semantics (indexes, TTL,
// read/write round trips) belong to cache.test.js.
//
// The suite runs against an in-memory mongod, not a live Atlas cluster — a test
// that needs network and a real password is a test nobody runs. What it does
// cover is every Atlas-specific decision in mongo.js that can be exercised
// offline: the <db_password> placeholder guard, the database name coming from
// MONGODB_DB rather than the URI path, and the globalThis connection cache that
// keeps a reloaded module from opening a second pool against the cluster's
// connection cap.

const ATLAS_URI =
  "mongodb+srv://forgottenlight:<db_password>@nyc-streetwise.7aqt3oz.mongodb.net/?retryWrites=true&w=majority&appName=nyc-streetwise";

let mongo;

beforeAll(async () => {
  mongo = await startMongo();
});

afterAll(async () => {
  await mongo.stop();
});

describe("isMongoConfigured", () => {
  const original = () => process.env.MONGODB_URI;

  afterEach(() => {
    process.env.MONGODB_URI = mongo.uri;
  });

  it("is false with no URI at all", () => {
    delete process.env.MONGODB_URI;
    expect(isMongoConfigured()).toBe(false);
  });

  it("is false for an empty URI, not just an absent one", () => {
    process.env.MONGODB_URI = "";
    expect(isMongoConfigured()).toBe(false);
  });

  it("is true for a plain mongodb:// URI", () => {
    expect(original()).toMatch(/^mongodb:\/\//);
    expect(isMongoConfigured()).toBe(true);
  });

  it("is true for a filled-in Atlas mongodb+srv:// URI", () => {
    process.env.MONGODB_URI = ATLAS_URI.replace("<db_password>", "s3cret");
    expect(isMongoConfigured()).toBe(true);
  });
});

describe("the <db_password> placeholder", () => {
  // Atlas hands out the URI with the placeholder still in it. Pasted as-is, the
  // driver throws a parse error on EVERY request — not a slow cache, a 500 loop
  // in a code path whose whole contract is that it degrades quietly.
  let warn;

  afterEach(() => {
    warn?.mockRestore();
    process.env.MONGODB_URI = mongo.uri;
  });

  it("treats an unreplaced placeholder as unconfigured", async () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await closeMongo();
    process.env.MONGODB_URI = ATLAS_URI;

    expect(isMongoConfigured()).toBe(false);
    // The real point: getDb() returns null instead of throwing MongoParseError.
    await expect(getDb()).resolves.toBeNull();
  });

  it("says so, once, rather than failing silently", async () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await closeMongo();
    process.env.MONGODB_URI = ATLAS_URI;

    isMongoConfigured();
    isMongoConfigured();
    isMongoConfigured();

    const messages = warn.mock.calls.map((c) => c.join(" "));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/db_password/);
  });

  it("does not mistake a real password containing angle brackets for the placeholder", async () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await closeMongo();
    // Percent-encoded, as Atlas requires; the guard must key on the placeholder
    // token, not on the presence of < or >.
    process.env.MONGODB_URI = ATLAS_URI.replace("<db_password>", "a%3Cb%3Ec");

    expect(isMongoConfigured()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("getDb", () => {
  it("returns null rather than throwing when no URI is set", async () => {
    const uri = process.env.MONGODB_URI;
    await closeMongo();
    delete process.env.MONGODB_URI;
    try {
      await expect(getDb()).resolves.toBeNull();
    } finally {
      process.env.MONGODB_URI = uri;
    }
  });

  it("takes the database name from MONGODB_DB", async () => {
    // An SRV URI has no path component, so this is the ONLY thing choosing the
    // database on Atlas. Getting it wrong writes the cache to a ghost database
    // that looks empty in the Atlas UI.
    const db = await getDb();
    expect(db.databaseName).toBe("test_db");
  });

  it("memoizes: concurrent callers share one connection, not one each", async () => {
    const dbs = await Promise.all([getDb(), getDb(), getDb(), getDb()]);
    for (const db of dbs) expect(db).toBe(dbs[0]);
  });

  it("caches the client on globalThis so a module reload reuses the pool", async () => {
    const db = await getDb();

    // vi.resetModules() drops the module registry the way `node --watch` and a
    // reused serverless container do. A module-scoped memo would be lost here
    // and the reimported copy would dial a second pool at Atlas.
    vi.resetModules();
    const reloaded = await import("../src/providers/mongo.js");

    expect(await reloaded.getDb()).toBe(db);
  });

  it("retries after a failure instead of caching the rejection forever", async () => {
    const good = process.env.MONGODB_URI;
    await closeMongo();
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1/unreachable";
    process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS = "300";

    try {
      await expect(getDb()).rejects.toThrow();

      // Cluster comes back; the very next call must succeed. A memoized
      // rejected promise would keep the cache dead for the process lifetime.
      process.env.MONGODB_URI = good;
      const db = await getDb();
      expect(db.databaseName).toBe("test_db");
    } finally {
      delete process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS;
      process.env.MONGODB_URI = good;
    }
  });
});

describe("closeMongo", () => {
  it("is safe to call when nothing was ever opened", async () => {
    await closeMongo();
    await expect(closeMongo()).resolves.toBeUndefined();
  });

  it("drops the pool and reconnects on the next call", async () => {
    const before = await getDb();
    await closeMongo();
    const after = await getDb();

    expect(after).not.toBe(before);
    expect(after.databaseName).toBe("test_db");
    // Still usable, i.e. genuinely reconnected rather than handed a dead handle.
    await expect(after.admin().ping()).resolves.toBeTruthy();
  });
});
