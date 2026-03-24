import test from "node:test";
import assert from "node:assert/strict";
import { createExportRoutes } from "../export.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
} from "../../providers/types.js";

function createConversationMeta(partial: Partial<ConversationMeta> & Pick<ConversationMeta, "id" | "provider">): ConversationMeta {
  return {
    title: "测试对话",
    project: "/tmp/project",
    projectKey: "project",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    fileSize: 1,
    filePath: "/tmp/project/session.jsonl",
    ...partial,
  };
}

function createProvider(overrides: Partial<ConversationProvider> & { name: string; displayName: string }): ConversationProvider {
  return {
    name: overrides.name,
    displayName: overrides.displayName,
    detect: overrides.detect ?? (async () => true),
    list: overrides.list ?? (async () => []),
    read: overrides.read ?? (async (id: string) => ({
      ...createConversationMeta({ id, provider: overrides.name }),
      messages: [],
    }) as Conversation),
    delete: overrides.delete ?? (async () => {}),
    move: overrides.move,
    listProjects: overrides.listProjects,
    getStoragePath: overrides.getStoragePath ?? (() => `/tmp/${overrides.name}`),
  };
}

test("export 全部失败时返回 404 和 failures", async () => {
  const app = createExportRoutes([]);
  const res = await app.request("http://localhost/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: ["missing:1"], format: "json" }),
  });

  assert.equal(res.status, 404);
  const data = await res.json() as { error: string; failures: Array<{ id: string; error: string }> };
  assert.equal(data.error, "未知的 provider: missing");
  assert.equal(data.failures.length, 1);
});

test("export 部分失败时返回成功内容和 meta 头", async () => {
  const app = createExportRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      read: async (id: string) => {
        if (id === "codex:missing") {
          throw new Error("对话不存在: codex:missing");
        }
        return {
          ...createConversationMeta({ id, provider: "codex", title: "成功导出" }),
          messages: [],
        } as Conversation;
      },
    }),
  ]);

  const res = await app.request("http://localhost/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: ["codex:ok", "codex:missing"], format: "json" }),
  });

  assert.equal(res.status, 200);
  const metaHeader = res.headers.get("X-Export-Meta");
  assert.ok(metaHeader);

  const meta = JSON.parse(Buffer.from(metaHeader!, "base64url").toString("utf-8")) as {
    requested: number;
    exported: number;
    failed: number;
    failures: Array<{ id: string; error: string }>;
  };
  assert.equal(meta.requested, 2);
  assert.equal(meta.exported, 1);
  assert.equal(meta.failed, 1);
  assert.equal(meta.failures[0]?.id, "codex:missing");

  const data = await res.json() as Conversation[];
  assert.equal(data.length, 1);
  assert.equal(data[0]?.id, "codex:ok");
});
