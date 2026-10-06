import { homedir } from "os";
import type {
  AiConfig,
  AppConfig,
  EnvLike,
  ProviderPathConfig,
  ResolvedProviderName,
  TitleGenerationCli,
  UpdateProviderConfigsOptions,
  UpdatedProviderConfigResult,
} from "./types.js";
import { getProviderConfigPath, loadAppConfig, writeJsonFileAtomically } from "./config.js";
import { normalizeTitleGenerationCliPriority, normalizeTitleGenerationCliSessionModes, TITLE_GENERATION_CLI_SET } from "./title-cli.js";
import { prepareProviderPathMigrations } from "./migration.js";
import { clearProviderPathCache } from "./resolve.js";
import { getErrorMessage } from "./path-style.js";

export async function updateProviderConfigs(
  updates: Partial<Record<ResolvedProviderName, ProviderPathConfig>>,
  env: EnvLike = process.env,
  homeDir = homedir(),
  options: UpdateProviderConfigsOptions = {}
): Promise<UpdatedProviderConfigResult> {
  const configPath = getProviderConfigPath(env, homeDir);
  const loadedConfig = loadAppConfig(env, homeDir);
  const nextConfig: AppConfig = {
    ...loadedConfig.config,
    providers: {
      ...(loadedConfig.config.providers ?? {}),
    },
  };

  for (const providerName of Object.keys(updates) as ResolvedProviderName[]) {
    const incoming = updates[providerName];
    if (!incoming) continue;

    const previous = nextConfig.providers?.[providerName] ?? {};
    const nextProviderConfig: ProviderPathConfig = { ...previous };

    if ("storagePath" in incoming) {
      const storagePath = incoming.storagePath?.trim();
      if (storagePath) nextProviderConfig.storagePath = storagePath;
      else delete nextProviderConfig.storagePath;
    }

    if ("stateDbPath" in incoming) {
      const stateDbPath = incoming.stateDbPath?.trim();
      if (stateDbPath) nextProviderConfig.stateDbPath = stateDbPath;
      else delete nextProviderConfig.stateDbPath;
    }

    if (!nextProviderConfig.storagePath && !nextProviderConfig.stateDbPath) {
      delete nextConfig.providers?.[providerName];
    } else {
      nextConfig.providers ??= {};
      nextConfig.providers[providerName] = nextProviderConfig;
    }
  }

  if (nextConfig.providers && Object.keys(nextConfig.providers).length === 0) {
    delete nextConfig.providers;
  }

  if (options.ai) {
    const nextAiConfig: AiConfig = { ...(nextConfig.ai ?? {}) };

    if ("titleGenerationCliPriority" in options.ai) {
      nextAiConfig.titleGenerationCliPriority = normalizeTitleGenerationCliPriority(
        options.ai.titleGenerationCliPriority
      );
    }

    if ("titleGenerationCliSessionModes" in options.ai) {
      nextAiConfig.titleGenerationCliSessionModes = normalizeTitleGenerationCliSessionModes(
        options.ai.titleGenerationCliSessionModes
      );
    }

    if ("titleGenerationCliDisabled" in options.ai) {
      const disabled = options.ai.titleGenerationCliDisabled;
      if (Array.isArray(disabled)) {
        nextAiConfig.titleGenerationCliDisabled = disabled.filter(
          (item): item is TitleGenerationCli => TITLE_GENERATION_CLI_SET.has(item as TitleGenerationCli)
        );
      } else {
        delete nextAiConfig.titleGenerationCliDisabled;
      }
    }

    nextConfig.ai = nextAiConfig;
  }

  const preparedMigrations = await prepareProviderPathMigrations(
    options.migrations ?? {},
    loadedConfig,
    nextConfig,
    env,
    homeDir
  );

  try {
    await writeJsonFileAtomically(configPath, nextConfig);
  } catch (error) {
    for (const migration of [...preparedMigrations].reverse()) {
      await migration.rollback().catch(() => undefined);
    }
    throw error;
  }

  for (const migration of preparedMigrations) {
    try {
      await migration.commit();
    } catch (error) {
      migration.result.cleanupWarning = `迁移已生效，但旧路径 staging 清理失败: ${getErrorMessage(error)}`;
      console.error(`[provider-paths] ${migration.result.cleanupWarning}`);
    }
  }
  clearProviderPathCache();
  return {
    ...loadAppConfig(env, homeDir),
    migrationResults: preparedMigrations.map((migration) => migration.result),
  };
}
