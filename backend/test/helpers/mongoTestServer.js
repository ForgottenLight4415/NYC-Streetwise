import { MongoMemoryServer } from "mongodb-memory-server";
import { closeMongo } from "../../src/providers/mongo.js";
import {
  resetCacheIndexMemo,
  resetTrendCacheIndexMemo,
  resetComplaintGroupsIndexMemo,
} from "../../src/providers/cache.js";
import { resetAddressLookupIndexMemo } from "../../src/providers/addressDirectory.js";

/**
 * The memoized index promises, so a new mongod does not inherit an old one.
 * Every collection with an ensure*Indexes memo belongs here — one left out
 * resolves against the previous, now-stopped server.
 */
function resetIndexMemos() {
  resetCacheIndexMemo();
  resetTrendCacheIndexMemo();
  resetComplaintGroupsIndexMemo();
  resetAddressLookupIndexMemo();
}

/**
 * Boots a real in-memory mongod and points the app's provider at it via
 * MONGODB_URI. Real mongod, not a stub: the things worth testing here are index
 * behaviour, TTL semantics, and unique-constraint races, and a hand-rolled fake
 * would assert nothing about any of them.
 *
 * The in-memory server speaks plain `mongodb://` while production is Atlas
 * `mongodb+srv://`. That difference is invisible to everything above
 * `mongo.js` — the driver resolves SRV to the same wire protocol, and no code
 * here inspects the scheme. What Atlas actually changes (pool caps, SRV having
 * no database in its path, the `<db_password>` placeholder) is covered in
 * `mongo.test.js` without needing a live cluster.
 */
export async function startMongo() {
  const mongod = await MongoMemoryServer.create();
  // closeMongo() first: the connection cache lives on globalThis and survives
  // module re-registration, so a previous suite's client could otherwise still
  // be the active one when this file's tests start.
  await closeMongo();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "test_db";
  resetIndexMemos();

  return {
    uri: mongod.getUri(),
    async stop() {
      await closeMongo();
      await mongod.stop();
      delete process.env.MONGODB_URI;
      delete process.env.MONGODB_DB;
      resetIndexMemos();
    },
  };
}
