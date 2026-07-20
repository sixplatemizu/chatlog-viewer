import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { createServer } from "net";

interface JsonRpcResponse {
  id?: string | number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const APP_SERVER_START_TIMEOUT_MS = 8000;
const APP_SERVER_REQUEST_TIMEOUT_MS = 8000;

function buildCodexAppServerSpawn(port: number, codexHome?: string): {
  command: string;
  args: string[];
  options: SpawnOptions;
} {
  const listenUrl = `ws://127.0.0.1:${port}`;
  if (process.platform === "win32") {
    return {
      command: `codex app-server --listen ${listenUrl}`,
      args: [],
      options: {
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
      },
    };
  }

  return {
    command: "codex",
    args: ["app-server", "--listen", listenUrl],
    options: {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
    },
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
        } else {
          reject(new Error("无法分配 Codex app-server 端口"));
        }
      });
    });
  });
}

async function waitForReady(port: number, child: ChildProcess): Promise<void> {
  const readyUrl = `http://127.0.0.1:${port}/readyz`;
  const start = Date.now();

  while (Date.now() - start < APP_SERVER_START_TIMEOUT_MS) {
    if (child.exitCode !== null) {
      throw new Error(`Codex app-server 启动失败，退出码 ${child.exitCode}`);
    }

    try {
      const response = await fetch(readyUrl);
      if (response.ok) return;
    } catch {
      // app-server 仍在启动，稍后重试。
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("等待 Codex app-server 启动超时");
}

class CodexAppServerClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error("当前 Node.js 版本不支持 WebSocket");
    }

    const ws = new WebSocketCtor(this.url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("连接 Codex app-server 超时")), APP_SERVER_REQUEST_TIMEOUT_MS);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("连接 Codex app-server 失败"));
      }, { once: true });
    });

    ws.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    ws.addEventListener("close", () => {
      const error = new Error("Codex app-server 连接已关闭");
      for (const request of this.pending.values()) {
        request.reject(error);
      }
      this.pending.clear();
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "chatlog-viewer",
        title: "ChatLog Viewer",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized", {});
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.request("thread/name/set", { threadId, name });
  }

  private notify(method: string, params: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server 尚未连接");
    }
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    }));
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server 尚未连接");
    }

    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server 请求超时: ${method}`));
      }, APP_SERVER_REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }));

    return await response;
  }

  private handleMessage(rawData: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(rawData) as JsonRpcResponse;
    } catch {
      return;
    }

    if (message.id === undefined) return;
    const request = this.pending.get(message.id);
    if (!request) return;

    this.pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message || `Codex app-server 错误: ${message.error.code ?? "unknown"}`));
      return;
    }

    request.resolve(message.result);
  }
}

export function shouldUseCodexAppServerRename(): boolean {
  if (process.env.CHATLOG_VIEWER_CODEX_APP_SERVER_RENAME === "0") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

export async function setCodexThreadNameViaAppServer(
  threadId: string,
  name: string,
  codexHome?: string
): Promise<void> {
  const port = await getFreePort();
  const appServer = buildCodexAppServerSpawn(port, codexHome);
  const child = spawn(appServer.command, appServer.args, appServer.options);

  try {
    await waitForReady(port, child);
    const client = new CodexAppServerClient(`ws://127.0.0.1:${port}`);
    try {
      await client.connect();
      await client.initialize();
      await client.setThreadName(threadId, name);
    } finally {
      client.close();
    }
  } finally {
    if (child.exitCode === null) {
      await terminateAppServer(child);
    }
  }
}

async function terminateAppServer(child: ChildProcess): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve) => {
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }

  child.kill();
}
