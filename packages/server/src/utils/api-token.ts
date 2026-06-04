import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const API_TOKEN_HEADER = "X-Chatlog-Viewer-Token";

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function getApiTokenPath(
  env: Record<string, string | undefined> = process.env,
  homeDir = homedir()
): string {
  return env.CHATLOG_VIEWER_API_TOKEN_PATH?.trim()
    || join(homeDir, ".chatlog-viewer", "session-token");
}

export function getOrCreateApiToken(
  env: Record<string, string | undefined> = process.env,
  homeDir = homedir()
): string {
  const envToken = env.CHATLOG_VIEWER_API_TOKEN?.trim();
  if (envToken) return envToken;

  const tokenPath = getApiTokenPath(env, homeDir);
  try {
    const existing = readFileSync(tokenPath, "utf-8").trim();
    if (existing) return existing;
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }

  const nextToken = randomBytes(32).toString("base64url");
  mkdirSync(dirname(tokenPath), { recursive: true });

  try {
    writeFileSync(tokenPath, `${nextToken}\n`, { encoding: "utf-8", flag: "wx" });
    return nextToken;
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") {
      throw error;
    }
    const existing = readFileSync(tokenPath, "utf-8").trim();
    if (!existing) {
      throw new Error(`API token 文件为空: ${tokenPath}`);
    }
    return existing;
  }
}
