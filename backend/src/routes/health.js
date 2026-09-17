import { Router } from "express";
import { NO_STORE } from "../lib/httpCache.js";

// Used by deploy health checks and keep-warm pings. Must stay dependency-free:
// it has to answer 200 even when Mongo or Socrata are down, otherwise a host
// will recycle the instance mid-demo.
export const healthRouter = Router();

healthRouter.get("/health", (req, res) => {
  // Never cached: a cached 200 is precisely the failure this endpoint exists
  // to catch, and would report a wedged instance as healthy for as long as the
  // entry lived.
  res.set("Cache-Control", NO_STORE);
  res.status(200).json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
});
