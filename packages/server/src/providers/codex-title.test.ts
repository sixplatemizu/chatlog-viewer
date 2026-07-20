import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexTitleGenerationHint,
  isWeakCodexTitle,
  pickCodexConversationTitle,
} from "./codex-title.js";

test("Codex 标题选择始终以 State DB 原生 title 为准", () => {
  const result = pickCodexConversationTitle({
    nativeTitle: "state db 标题",
    firstUserMessage: "state db preview",
    preview: "state db preview",
    transcriptTitle: "transcript 标题",
    fallbackTitle: "fallback 标题",
  });

  assert.deepEqual(result, {
    title: "state db 标题",
    usedFallback: false,
  });
});

test("Codex 原生问候语标题不会被展示 fallback 擅自覆盖", () => {
  const result = pickCodexConversationTitle({
    nativeTitle: "hi",
    firstUserMessage: "hi",
    transcriptTitle: "hi",
    fallbackTitle: "实际问题标题",
  });

  assert.deepEqual(result, {
    title: "hi",
    usedFallback: false,
  });
});

test("Codex 标题工具会识别常见问候语并构造 metadata-only 标题提示", () => {
  assert.equal(isWeakCodexTitle("Hi!"), true);
  assert.equal(isWeakCodexTitle("实际问题"), false);

  assert.equal(
    buildCodexTitleGenerationHint({
      id: "session",
      rolloutPath: "",
      createdAt: 0,
      updatedAt: 0,
      source: "cli",
      modelProvider: "custom",
      cwd: "C:/Users/tester/project",
      title: "已有标题",
      firstUserMessage: "首条消息",
    }),
    "当前对话缺少 transcript，请仅根据以下 metadata 生成标题：\n现有标题: 已有标题\n首条用户消息摘要: 首条消息\n项目目录: C:/Users/tester/project\nCodex provider: custom"
  );
});
