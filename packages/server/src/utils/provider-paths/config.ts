import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { mkdir, rename, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import type { AppConfig, EnvLike, LoadedConfig } from "./types.js";
import { dirnameStyledPath, getErrorCode, getErrorMessage, getPathKey, joinStyledPath, resolvePathValue } from "./path-style.js";

const configLoadCache = new Map<string, LoadedConfig>();

export function clearConfigLoadCache(): void {
  configLoadCache.clear();
}

export function getProviderConfigPath(env: EnvLike = process.env, homeDir = homedir()): string {
  // 新变量优先，旧变量兼容一版：CHATVIEW_CONFIG_PATH > CHATLOG_VIEWER_CONFIG_PATH > ~/.chatview/config.json
  const configuredPath = env.CHATVIEW_CONFIG_PATH?.trim() || env.CHATLOG_VIEWER_CONFIG_PATH?.trim();
  if (!configuredPath) return joinStyledPath(homeDir, ".chatview", "config.json");
  return resolvePathValue(configuredPath, homeDir, env);
}

export function getAppConfig(env: EnvLike = process.env, homeDir = homedir()): LoadedConfig {
  return loadAppConfig(env, homeDir);
}

export function loadAppConfig(env: EnvLike, homeDir: string): LoadedConfig {
  const configPath = getProviderConfigPath(env, homeDir);
  const cacheKey = getPathKey(configPath);
  const cached = configLoadCache.get(cacheKey);
  if (cached) return cached;

  const result: LoadedConfig = {
    config: {},
    configDir: dirnameStyledPath(configPath),
  };

  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content) as AppConfig;
    result.config = parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      console.error(`[provider-paths] 配置文件解析失败: ${configPath} ${getErrorMessage(error)}`);
    }
  }

  configLoadCache.set(cacheKey, result);
  return result;
}

export async function writeJsonFileAtomically(configPath: string, config: AppConfig): Promise<void> {
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirnameStyledPath(configPath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    await rename(temporaryPath, configPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
