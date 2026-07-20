import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { createConversationRoutes } from "./routes/conversations.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createExportRoutes } from "./routes/export.js";
import { ClaudeCodeProvider } from "./providers/claude-code.js";
import { CodexProvider } from "./providers/codex.js";
import { IFlowProvider } from "./providers/iflow.js";
import { OpenCodeProvider } from "./providers/opencode.js";
import type { ConversationProvider } from "./providers/types.js";
import { API_TOKEN_HEADER } from "./utils/api-token.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const MAX_API_BODY_SIZE = 2 * 1024 * 1024;

export const DEFAULT_SERVER_HOSTNAME = "127.0.0.1";

export interface CreateAppOptions {
  apiToken?: string;
  allowedOrigins?: string[];
}

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
  return isAllowedOriginForList(origin, getAllowedOriginsFromEnv());
}

function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function getAllowedOriginsFromEnv(): string[] {
  const configured = process.env.CHATLOG_VIEWER_ALLOWED_ORIGINS?.trim();
  if (!configured) return DEFAULT_ALLOWED_ORIGINS;
  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function buildAllowedOriginSet(origins: string[]): Set<string> {
  return new Set(
    origins
      .map((origin) => normalizeOrigin(origin))
      .filter((origin): origin is string => !!origin)
  );
}

function isAllowedOriginForList(origin: string, allowedOrigins: string[]): boolean {
  const normalized = normalizeOrigin(origin);
  return normalized !== null && buildAllowedOriginSet(allowedOrigins).has(normalized);
}

function isAllowedOriginInSet(origin: string, allowedOriginSet: Set<string>): boolean {
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowedOriginSet.has(normalized);
}

export function createDefaultProviders(): ConversationProvider[] {
  return [
    new ClaudeCodeProvider(),
    new CodexProvider(),
    new OpenCodeProvider(),
    new IFlowProvider(),
  ];
}

export function createApp(
  providers: ConversationProvider[] = createDefaultProviders(),
  options: CreateAppOptions = {}
) {
  const app = new Hono();
  const allowedOrigins = options.allowedOrigins ?? getAllowedOriginsFromEnv();
  const allowedOriginSet = buildAllowedOriginSet(allowedOrigins);
  const apiToken = options.apiToken?.trim();

  app.onError((error, c) => {
    if (error instanceof SyntaxError) {
      return c.json({ error: "请求 JSON 格式错误" }, 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message || "服务器内部错误" }, 500);
  });

  app.use("*", logger());

  app.use("/api/*", async (c, next) => {
    const hostHeader = c.req.header("host");
    if (hostHeader && !isLoopbackHost(hostHeader)) {
      return c.json({ error: "仅允许从本机访问 API" }, 403);
    }

    const origin = c.req.header("origin");
    if (origin && !isAllowedOriginInSet(origin, allowedOriginSet)) {
      return c.json({ error: "仅允许来自本地页面的请求" }, 403);
    }

    if (
      apiToken
      && c.req.method !== "OPTIONS"
      && c.req.path !== "/api/health"
      && c.req.header(API_TOKEN_HEADER) !== apiToken
    ) {
      return c.json({ error: "缺少或无效的 API token" }, 401);
    }

    await next();
  });

  app.use("/api/*", cors({
    origin: (origin) => (origin && isAllowedOriginInSet(origin, allowedOriginSet) ? origin : ""),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", API_TOKEN_HEADER],
  }));

  app.use("/api/*", bodyLimit({
    maxSize: MAX_API_BODY_SIZE,
    onError: (c) => c.json({ error: "请求体不能超过 2 MiB" }, 413),
  }));

  app.route("/api", createConversationRoutes(providers));
  app.route("/api", createSettingsRoutes(providers));
  app.route("/api", createExportRoutes(providers));
  app.get("/api/health", (c) => c.json({ status: "ok" }));

  return app;
}
