import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const API_TOKEN_HEADER = "X-Chatlog-Viewer-Token";

function getApiTokenPath(): string {
  return process.env.CHATLOG_VIEWER_API_TOKEN_PATH?.trim()
    || join(homedir(), ".chatlog-viewer", "session-token");
}

function loadApiToken(): string {
  const envToken = process.env.CHATLOG_VIEWER_API_TOKEN?.trim();
  if (envToken) return envToken;

  const tokenPath = getApiTokenPath();
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf-8").trim();
    if (existing) return existing;
  }

  const nextToken = randomBytes(32).toString("base64url");
  mkdirSync(dirname(tokenPath), { recursive: true });
  try {
    writeFileSync(tokenPath, `${nextToken}\n`, { encoding: "utf-8", flag: "wx" });
    return nextToken;
  } catch {
    return readFileSync(tokenPath, "utf-8").trim();
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3456",
        changeOrigin: true,
        headers: {
          [API_TOKEN_HEADER]: loadApiToken(),
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
    globals: true,
  },
});
