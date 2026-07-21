import { serve } from "@hono/node-server";
import { createApp, DEFAULT_SERVER_HOSTNAME } from "./app.js";
import { compactCacheDb } from "./utils/cache.js";
import { initFileLogger } from "./utils/file-logger.js";
import { getApiTokenPath, getOrCreateApiToken } from "./utils/api-token.js";
import { closeCodexAppServerClients } from "./providers/codex-app-server.js";

// 初始化文件日志系统
initFileLogger();

const apiToken = getOrCreateApiToken();
const app = createApp(undefined, { apiToken });
const parsedPort = Number.parseInt(process.env.PORT || "3456", 10);
const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 3456;

console.log(`服务器启动于 http://${DEFAULT_SERVER_HOSTNAME}:${port}`);
console.log(`API token 已启用，token 文件: ${getApiTokenPath()}`);
const server = serve({
  fetch: app.fetch,
  hostname: DEFAULT_SERVER_HOSTNAME,
  port,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在关闭服务`);
  server.close();
  try {
    await closeCodexAppServerClients();
  } catch (error) {
    console.error("关闭 Codex app-server 失败:", error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

// 启动后异步压缩缓存 DB，回收 FTS5 墓碑。不阻塞请求处理。
setImmediate(() => {
  const result = compactCacheDb();
  if (result) {
    const beforeMb = (result.before / 1024 / 1024).toFixed(1);
    const afterMb = (result.after / 1024 / 1024).toFixed(1);
    const saved = ((result.before - result.after) / 1024 / 1024).toFixed(1);
    if (result.before - result.after > 1024 * 1024) {
      console.log(`缓存压缩完成: ${beforeMb} MB → ${afterMb} MB（回收 ${saved} MB）`);
    }
  }
});
