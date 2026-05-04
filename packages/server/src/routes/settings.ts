import { Hono } from "hono";
import { homedir } from "os";
import type { ConversationProvider } from "../providers/types.js";
import { CodexProvider } from "../providers/codex.js";
import { getAvailableClis, resetSession } from "../utils/ai.js";
import { getErrorMessage } from "../utils/errors.js";
import {
  getAppConfig,
  getProviderConfigPath,
  getProviderPaths,
  getTitleGenerationCliPriority,
  getTitleGenerationCliSessionModes,
  normalizeTitleGenerationCliPriority,
  normalizeTitleGenerationCliSessionModes,
  updateProviderConfigs,
  type ProviderPathMigrationSelection,
  type ProviderPathConfig,
  type ResolvedProviderName,
  type TitleGenerationCli,
  type TitleGenerationCliSessionMode,
} from "../utils/provider-paths.js";

const RESOLVED_PROVIDER_NAMES = new Set<ResolvedProviderName>(["claude-code", "codex", "opencode", "iflow"]);
const TITLE_GENERATION_CLI_NAMES = new Set<TitleGenerationCli>(["codex", "claude", "opencode"]);

function isResolvedProviderName(name: string): name is ResolvedProviderName {
  return RESOLVED_PROVIDER_NAMES.has(name as ResolvedProviderName);
}

function isTitleGenerationCli(name: string): name is TitleGenerationCli {
  return TITLE_GENERATION_CLI_NAMES.has(name as TitleGenerationCli);
}

function normalizeOptionalPathInput(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("路径必须是字符串");
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildProviderPathSettings(providers: ConversationProvider[]) {
  const loadedConfig = getAppConfig();
  const configuredProviders = loadedConfig.config.providers ?? {};

  return providers.flatMap((provider) => {
    if (!isResolvedProviderName(provider.name)) return [];

    const resolvedProviderName = provider.name;
    const resolved = getProviderPaths(resolvedProviderName);
    const configured = configuredProviders[resolvedProviderName];

    return [{
      name: resolvedProviderName,
      displayName: provider.displayName,
      configuredStoragePath: configured?.storagePath,
      configuredStateDbPath: configured?.stateDbPath,
      ...resolved,
    }];
  });
}

export function createSettingsRoutes(providers: ConversationProvider[]) {
  const app = new Hono();

  app.get("/settings/provider-paths", async (c) => {
    return c.json({
      configPath: getProviderConfigPath(),
      providers: buildProviderPathSettings(providers),
      ai: {
        titleGenerationCliPriority: getTitleGenerationCliPriority(),
        titleGenerationCliSessionModes: getTitleGenerationCliSessionModes(),
      },
    });
  });

  app.put("/settings/provider-paths", async (c) => {
    const body = await c.req.json<{
      providers?: Record<string, { storagePath?: unknown; stateDbPath?: unknown }>;
      migrations?: Record<string, { storagePath?: unknown; stateDbPath?: unknown }>;
      ai?: { titleGenerationCliPriority?: unknown; titleGenerationCliSessionModes?: unknown };
    }>();

    if (!body || typeof body !== "object" || !body.providers || typeof body.providers !== "object") {
      return c.json({ error: "providers 配置不能为空" }, 400);
    }

    const updates: Partial<Record<ResolvedProviderName, ProviderPathConfig>> = {};
    const migrations: Partial<Record<ResolvedProviderName, ProviderPathMigrationSelection>> = {};
    let titleGenerationCliPriority: TitleGenerationCli[] | undefined;
    let titleGenerationCliSessionModes: Record<TitleGenerationCli, TitleGenerationCliSessionMode> | undefined;

    try {
      for (const [providerName, value] of Object.entries(body.providers)) {
        if (!isResolvedProviderName(providerName)) continue;
        if (!value || typeof value !== "object") {
          return c.json({ error: `${providerName} 配置格式错误` }, 400);
        }

        const nextConfig: ProviderPathConfig = {};

        if ("storagePath" in value) {
          nextConfig.storagePath = normalizeOptionalPathInput(value.storagePath);
        }

        if ("stateDbPath" in value) {
          if (providerName !== "codex" && providerName !== "opencode" && value.stateDbPath !== null && value.stateDbPath !== undefined) {
            return c.json({ error: `${providerName} 不支持 state db 路径配置` }, 400);
          }
          nextConfig.stateDbPath = normalizeOptionalPathInput(value.stateDbPath);
        }

        updates[providerName] = nextConfig;
      }

      if (body.migrations && typeof body.migrations === "object") {
        for (const [providerName, value] of Object.entries(body.migrations)) {
          if (!isResolvedProviderName(providerName) || !value || typeof value !== "object") continue;

          const nextSelection: ProviderPathMigrationSelection = {};

          if ("storagePath" in value) {
            if (typeof value.storagePath !== "boolean") {
              return c.json({ error: `${providerName} storagePath 迁移标记必须是布尔值` }, 400);
            }
            nextSelection.storagePath = value.storagePath;
          }

          if ("stateDbPath" in value) {
            if (providerName !== "codex" && providerName !== "opencode") {
              return c.json({ error: `${providerName} 不支持 state db 迁移配置` }, 400);
            }
            if (typeof value.stateDbPath !== "boolean") {
              return c.json({ error: `${providerName} stateDbPath 迁移标记必须是布尔值` }, 400);
            }
            nextSelection.stateDbPath = value.stateDbPath;
          }

          if (nextSelection.storagePath || nextSelection.stateDbPath) {
            migrations[providerName] = nextSelection;
          }
        }
      }

      if (body.ai !== undefined) {
        if (!body.ai || typeof body.ai !== "object") {
          return c.json({ error: "ai 配置格式错误" }, 400);
        }

        if ("titleGenerationCliPriority" in body.ai) {
          if (!Array.isArray(body.ai.titleGenerationCliPriority)) {
            return c.json({ error: "标题生成 CLI 优先级必须是数组" }, 400);
          }
          titleGenerationCliPriority = normalizeTitleGenerationCliPriority(
            body.ai.titleGenerationCliPriority
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
          );
        }

        if ("titleGenerationCliSessionModes" in body.ai) {
          if (
            !body.ai.titleGenerationCliSessionModes
            || typeof body.ai.titleGenerationCliSessionModes !== "object"
            || Array.isArray(body.ai.titleGenerationCliSessionModes)
          ) {
            return c.json({ error: "标题生成 CLI 会话模式必须是对象" }, 400);
          }
          titleGenerationCliSessionModes = normalizeTitleGenerationCliSessionModes(
            body.ai.titleGenerationCliSessionModes as Record<string, unknown>
          );
        }
      }
    } catch (error) {
      return c.json({ error: getErrorMessage(error) }, 400);
    }

    const updated = await updateProviderConfigs(updates, process.env, homedir(), {
      migrations,
      ...((titleGenerationCliPriority || titleGenerationCliSessionModes) ? {
        ai: {
          titleGenerationCliPriority,
          titleGenerationCliSessionModes,
        },
      } : {}),
    });

    return c.json({
      configPath: getProviderConfigPath(),
      providers: buildProviderPathSettings(providers),
      ai: {
        titleGenerationCliPriority: getTitleGenerationCliPriority(),
        titleGenerationCliSessionModes: getTitleGenerationCliSessionModes(),
      },
      migrationResults: updated.migrationResults,
    });
  });

  app.get("/ai/clis", async (c) => {
    const clis = await getAvailableClis();
    return c.json(clis);
  });

  app.delete("/ai/clis/sessions", async (c) => {
    await resetSession();
    return c.json({ success: true });
  });

  app.delete("/ai/clis/:name/session", async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    if (!isTitleGenerationCli(name)) {
      return c.json({ error: "未知的 AI CLI" }, 404);
    }

    await resetSession(name);
    return c.json({ success: true });
  });

  app.get("/codex-providers", (c) => {
    const codex = providers.find((p) => p.name === "codex") as CodexProvider | undefined;
    if (!codex) return c.json([]);
    return c.json(codex.listModelProviders());
  });

  return app;
}
