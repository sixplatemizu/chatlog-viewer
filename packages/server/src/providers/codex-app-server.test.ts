import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexAppServerManager,
  type CodexAppServerSession,
} from "./codex-app-server.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("Codex app-server manager 会复用会话并串行执行改名请求", async () => {
  const calls: string[] = [];
  let createCount = 0;
  let closeCount = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;

  const session: CodexAppServerSession = {
    isAlive: () => true,
    setThreadName: async (threadId, name) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await wait(10);
      calls.push(`${threadId}:${name}`);
      activeRequests -= 1;
    },
    close: async () => {
      closeCount += 1;
    },
  };
  const manager = new CodexAppServerManager({
    createSession: async () => {
      createCount += 1;
      return session;
    },
    idleTimeoutMs: 0,
  });

  await Promise.all([
    manager.setThreadName("thread-1", "标题一"),
    manager.setThreadName("thread-2", "标题二"),
    manager.setThreadName("thread-3", "标题三"),
  ]);
  await manager.close();

  assert.equal(createCount, 1);
  assert.equal(closeCount, 1);
  assert.equal(maxActiveRequests, 1);
  assert.deepEqual(calls, [
    "thread-1:标题一",
    "thread-2:标题二",
    "thread-3:标题三",
  ]);
});

test("Codex app-server manager 会在请求失败后重建会话并重试一次", async () => {
  let createCount = 0;
  let firstCloseCount = 0;
  let secondCloseCount = 0;
  const successfulCalls: string[] = [];

  const manager = new CodexAppServerManager({
    createSession: async () => {
      createCount += 1;
      if (createCount === 1) {
        return {
          isAlive: () => true,
          setThreadName: async () => {
            throw new Error("连接已关闭");
          },
          close: async () => {
            firstCloseCount += 1;
          },
        };
      }
      return {
        isAlive: () => true,
        setThreadName: async (threadId, name) => {
          successfulCalls.push(`${threadId}:${name}`);
        },
        close: async () => {
          secondCloseCount += 1;
        },
      };
    },
    idleTimeoutMs: 0,
  });

  await manager.setThreadName("thread-retry", "重试标题");
  await manager.close();

  assert.equal(createCount, 2);
  assert.equal(firstCloseCount, 1);
  assert.equal(secondCloseCount, 1);
  assert.deepEqual(successfulCalls, ["thread-retry:重试标题"]);
});

test("Codex app-server manager 会在空闲超时后关闭会话", async () => {
  let createCount = 0;
  let closeCount = 0;

  const manager = new CodexAppServerManager({
    createSession: async () => {
      createCount += 1;
      let alive = true;
      return {
        isAlive: () => alive,
        setThreadName: async () => {},
        close: async () => {
          alive = false;
          closeCount += 1;
        },
      };
    },
    idleTimeoutMs: 20,
  });

  await manager.setThreadName("thread-idle-1", "空闲标题一");
  await wait(60);
  assert.equal(closeCount, 1);

  await manager.setThreadName("thread-idle-2", "空闲标题二");
  assert.equal(createCount, 2);
  await manager.close();
  assert.equal(closeCount, 2);
});
