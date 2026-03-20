import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createConversationRoutes } from "./routes/conversations.js";
import { createExportRoutes } from "./routes/export.js";
import { ClaudeCodeProvider } from "./providers/claude-code.js";
import { CodexProvider } from "./providers/codex.js";
import { IFlowProvider } from "./providers/iflow.js";
import { GeminiProvider } from "./providers/gemini-cli.js";
import { OpenCodeProvider } from "./providers/opencode.js";

const app = new Hono();

app.use("*", cors());
app.use("*", logger());

// 注册所有 provider
const providers = [
  new ClaudeCodeProvider(),
  new CodexProvider(),
  new IFlowProvider(),
  new GeminiProvider(),
  new OpenCodeProvider(),
];

// 挂载路由
app.route("/api", createConversationRoutes(providers));
app.route("/api", createExportRoutes(providers));

// 健康检查
app.get("/api/health", (c) => c.json({ status: "ok" }));

const port = 3456;
console.log(`服务器启动于 http://localhost:${port}`);
serve({ fetch: app.fetch, port });
