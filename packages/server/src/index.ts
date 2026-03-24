import { serve } from "@hono/node-server";
import { createApp, DEFAULT_SERVER_HOSTNAME } from "./app.js";

const app = createApp();
const parsedPort = Number.parseInt(process.env.PORT || "3456", 10);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3456;

console.log(`服务器启动于 http://${DEFAULT_SERVER_HOSTNAME}:${port}`);
serve({
  fetch: app.fetch,
  hostname: DEFAULT_SERVER_HOSTNAME,
  port,
});
