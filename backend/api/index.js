import { createApp } from "../src/app.js";

// Vercel serverless entrypoint. Vercel's Node.js runtime invokes this with
// plain (req, res) — the same signature Express apps already implement
// natively (an Express app IS a valid http.Server request listener) — so no
// adapter is needed. (An earlier version wrapped this with serverless-http,
// which targets AWS Lambda's event/context calling convention; Vercel doesn't
// use that convention for Node.js functions, so it broke every request.)
//
// createApp() runs once at module scope so the app (and the Mongo connection
// it lazily opens, memoized on globalThis in src/providers/mongo.js) is
// reused across warm invocations instead of rebuilt per request.
export default createApp();
