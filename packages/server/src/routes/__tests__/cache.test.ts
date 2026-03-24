import test from "node:test";
import assert from "node:assert/strict";
import {
  getIndexedCacheSnapshot,
  getIndexedListCache,
  hasFreshIndexedListCache,
  queryConversationIndex,
  setIndexedListCache,
  invalidateListCache,
} from "../../utils/cache.js";
import { SEARCH_INDEX_VERSION } from "../../utils/search-index.js";
import type { ConversationMeta } from "../../providers/types.js";

function createConversationMeta(id: string): ConversationMeta {
  return {
    id,
    provider: "codex",
    title: "测试对话",
    project: "/tmp/project",
    projectKey: "project",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3,
    fileSize: 4,
    filePath: `/tmp/${id}.jsonl`,
  };
}

test("indexed list cache 可以命中并读取列表", () => {
  const cacheKey = `test-indexed-${Date.now()}`;
  const items = [createConversationMeta("codex:1")];

  setIndexedListCache(cacheKey, items);
  const cached = getIndexedListCache(cacheKey, 60_000);

  assert.deepEqual(cached, items);

  invalidateListCache(cacheKey);
});

test("indexed list cache 过期后返回 null", () => {
  const cacheKey = `test-indexed-expired-${Date.now()}`;
  const items = [createConversationMeta("codex:2")];

  setIndexedListCache(cacheKey, items);
  const cached = getIndexedListCache(cacheKey, -1);

  assert.equal(cached, null);

  invalidateListCache(cacheKey);
});

test("conversation index 支持按消息内容搜索", () => {
  const cacheKey = `test-index-search-${Date.now()}`;
  const needle = `needle-${Date.now()}`;

  setIndexedListCache(cacheKey, [{
    meta: createConversationMeta("codex:3"),
    searchText: `hello ${needle} world`,
  }]);

  const snapshot = getIndexedCacheSnapshot(cacheKey);
  assert.equal(snapshot?.[0]?.searchText, `hello ${needle} world`);

  const matched = queryConversationIndex({
    cacheKeys: [cacheKey],
    search: needle,
  });
  assert.equal(matched.some((item) => item.id === "codex:3"), true);

  invalidateListCache(cacheKey);
});

test("indexed cache snapshot 会保留并读回 searchChunks", () => {
  const cacheKey = `test-index-chunks-${Date.now()}`;

  setIndexedListCache(cacheKey, [{
    meta: createConversationMeta("codex:chunks"),
    searchText: "摘要文本",
    searchChunks: ["chunk-1", "chunk-2"],
  }]);

  const snapshot = getIndexedCacheSnapshot(cacheKey);

  assert.deepEqual(snapshot?.[0]?.searchChunks, ["chunk-1", "chunk-2"]);

  invalidateListCache(cacheKey);
});

test("conversation index 仅返回当前 cacheKey 的结果，避免旧路径索引串入", () => {
  const oldCacheKey = `test-index-old-${Date.now()}`;
  const newCacheKey = `test-index-new-${Date.now()}`;

  setIndexedListCache(oldCacheKey, [{
    meta: createConversationMeta("codex:old"),
    searchText: "shared-needle",
  }]);
  setIndexedListCache(newCacheKey, [{
    meta: createConversationMeta("codex:new"),
    searchText: "shared-needle",
  }]);

  const matched = queryConversationIndex({
    cacheKeys: [newCacheKey],
    search: "shared-needle",
  });

  assert.deepEqual(matched.map((item) => item.id), ["codex:new"]);

  invalidateListCache(oldCacheKey);
  invalidateListCache(newCacheKey);
});

test("短词搜索会回退到 FTS LIKE 查询并保持可命中", () => {
  const cacheKey = `test-index-short-${Date.now()}`;

  setIndexedListCache(cacheKey, [{
    meta: createConversationMeta("codex:short"),
    searchText: "中文短词命中",
  }]);

  const matched = queryConversationIndex({
    cacheKeys: [cacheKey],
    search: "短词",
  });

  assert.equal(matched.some((item) => item.id === "codex:short"), true);

  invalidateListCache(cacheKey);
});

test("conversation index 可以仅依赖 searchChunks 命中深层消息内容", () => {
  const cacheKey = `test-index-chunk-search-${Date.now()}`;
  const needle = `deep-needle-${Date.now()}`;

  setIndexedListCache(cacheKey, [{
    meta: createConversationMeta("codex:chunk-only"),
    searchText: "only summary text",
    searchChunks: [
      `head-${Date.now()}`,
      `${"x".repeat(8_000)}${needle}${"y".repeat(8_000)}`,
    ],
  }]);

  const matched = queryConversationIndex({
    cacheKeys: [cacheKey],
    search: needle,
  });

  assert.equal(matched.some((item) => item.id === "codex:chunk-only"), true);

  invalidateListCache(cacheKey);
});

test("partial indexed list cache 在需要完整搜索索引时不会命中", () => {
  const cacheKey = `test-index-partial-${Date.now()}`;
  const items = [createConversationMeta("codex:4")];

  setIndexedListCache(cacheKey, items, { searchReady: false });

  assert.deepEqual(getIndexedListCache(cacheKey, 60_000), items);
  assert.equal(getIndexedListCache(cacheKey, 60_000, { requireSearchReady: true }), null);
  assert.equal(hasFreshIndexedListCache(cacheKey, 60_000, { requireSearchReady: true }), false);

  invalidateListCache(cacheKey);
});

test("旧版本搜索索引不会被当成当前可搜索缓存", () => {
  const cacheKey = `test-index-version-${Date.now()}`;
  const needle = `legacy-needle-${Date.now()}`;

  setIndexedListCache(cacheKey, [{
    meta: createConversationMeta("codex:legacy"),
    searchText: needle,
  }], {
    searchVersion: SEARCH_INDEX_VERSION - 1,
  });

  assert.deepEqual(getIndexedListCache(cacheKey, 60_000), [createConversationMeta("codex:legacy")]);
  assert.equal(getIndexedListCache(cacheKey, 60_000, { requireSearchReady: true }), null);
  assert.equal(hasFreshIndexedListCache(cacheKey, 60_000, { requireSearchReady: true }), false);
  assert.deepEqual(queryConversationIndex({
    cacheKeys: [cacheKey],
    search: needle,
  }), []);

  invalidateListCache(cacheKey);
});
