import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createConversationRoutes } from "./routes/conversations.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createExportRoutes } from "./routes/export.js";
import { ClaudeCodeProvider } from "./providers/claude-code.js";
import { CodexProvider } from "./providers/codex.js";
import { IFlowProvider } from "./providers/iflow.js";
import type { ConversationProvider } from "./providers/types.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const DEFAULT_SERVER_HOSTNAME = "127.0.0.1";

function normalizeHostHeader(host: string): string | null {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("[")) {
    const closingBracketIndex = trimmed.indexOf("]");
    return closingBracketIndex >= 0 ? trimmed.slice(0, closingBracketIndex + 1) : trimmed;
  }

  return trimmed.split(":")[0] || null;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostHeader(host);
  return normalized !== null && LOOPBACK_HOSTS.has(normalized);
}

export function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function createDefaultProviders(): ConversationProvider[] {
  return [
    new ClaudeCodeProvider(),
    new CodexProvider(),
    new IFlowProvider(),
  ];
}

export function createApp(providers: ConversationProvider[] = createDefaultProviders()) {
  const app = new Hono();

  app.use("*", logger());

  app.use("/api/*", async (c, next) => {
    const hostHeader = c.req.header("host");
    if (hostHeader && !isLoopbackHost(hostHeader)) {
      return c.json({ error: "仅允许从本机访问 API" }, 403);
    }

    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin)) {
      return c.json({ error: "仅允许来自本地页面的请求" }, 403);
    }

    await next();
  });

  app.use("/api/*", cors({
    origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : ""),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }));

  app.route("/api", createConversationRoutes(providers));
  app.route("/api", createSettingsRoutes(providers));
  app.route("/api", createExportRoutes(providers));
  app.get("/api/health", (c) => c.json({ status: "ok" }));

  return app;
}
