import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexTitleGenerationHint,
  isWeakCodexTitle,
  pickCodexConversationTitle,
} from "./codex-title.js";

test("Codex 标题选择会让 UI 来源标题优先于所有本地标题", () => {
  const result = pickCodexConversationTitle({
    managedTitle: "UI 修改标题",
    nativeTitle: "state db 标题",
    firstUserMessage: "state db preview",
    preview: "state db preview",
    transcriptTitle: "transcript 标题",
    fallbackTitle: "fallback 标题",
  });

  assert.deepEqual(result, {
    title: "UI 修改标题",
    usedFallback: false,
  });
});

test("Codex 标题选择在没有 UI 来源时仍保留历史问候语兜底", () => {
  const result = pickCodexConversationTitle({
    nativeTitle: "hi",
    firstUserMessage: "hi",
    transcriptTitle: "hi",
    fallbackTitle: "实际问题标题",
  });

  assert.deepEqual(result, {
    title: "实际问题标题",
    usedFallback: true,
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
