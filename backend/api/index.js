import serverless from "serverless-http";
import { createApp } from "../src/app.js";

// Vercel serverless entrypoint. createApp() is called once at module scope so
// the Express app (and everything it pulls in) is reused across warm
// invocations rather than rebuilt per request. Mongo connections are already
// lazy + memoized on globalThis (see src/providers/mongo.js), so no extra
// warmup is needed here.
const app = createApp();

export default serverless(app);
