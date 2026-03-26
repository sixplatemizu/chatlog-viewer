import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import type { ConversationMeta, ProviderInfo } from "../lib/api";

vi.mock("./ConversationList", () => ({
  ConversationList: () => <div data-testid="conversation-list" />,
}));

const providers: ProviderInfo[] = [
  { name: "codex", displayName: "Codex", available: true, storagePath: "/tmp/codex" },
  { name: "claude-code", displayName: "Claude Code", available: true, storagePath: "/tmp/claude" },
  { name: "iflow", displayName: "iFlow", available: true, storagePath: "/tmp/iflow" },
];

function createConversation(partial: Partial<ConversationMeta> & Pick<ConversationMeta, "id" | "provider">): ConversationMeta {
  return {
    id: partial.id,
    provider: partial.provider,
    title: partial.title ?? "测试对话",
    capabilities: partial.capabilities,
    project: partial.project ?? "/tmp/project",
    projectKey: partial.projectKey ?? "/tmp/project",
    createdAt: partial.createdAt ?? 1,
    updatedAt: partial.updatedAt ?? 1,
    messageCount: partial.messageCount ?? 1,
    fileSize: partial.fileSize ?? 1,
    filePath: partial.filePath ?? "/tmp/project/session.jsonl",
    modelProvider: partial.modelProvider,
  };
}

describe("Sidebar", () => {
  it("全部选中 Codex 对话时显示批量 provider 切换控件", () => {
    const onBatchChangeModelProvider = vi.fn();

    render(
      <Sidebar
        providers={providers}
        activeProviders={new Set(["codex", "claude-code"])}
        toggleProvider={() => {}}
        conversations={[
          createConversation({ id: "codex:1", provider: "codex", modelProvider: "openai" }),
          createConversation({ id: "codex:2", provider: "codex", modelProvider: "openai" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
        search=""
        onSearchChange={() => {}}
        sort="updatedAt"
        onSortChange={() => {}}
        loading={false}
        total={2}
        selectedIds={new Set(["codex:1", "codex:2"])}
        onToggleSelect={() => {}}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onToggleSelectGroup={() => {}}
        onBatchExport={() => {}}
        onBatchDelete={() => {}}
        onBatchGenerate={() => {}}
        onBatchChangeModelProvider={onBatchChangeModelProvider}
        batchGenerating={false}
        onMoveConversation={() => {}}
        codexModelProviders={[
          { name: "openai", count: 2 },
          { name: "azure", count: 1 },
        ]}
        activeModelProviders={new Set(["openai", "azure"])}
        onToggleModelProvider={() => {}}
        partialSearch={false}
        searchWarnings={[]}
      />
    );

    const select = screen.getByRole("combobox", { name: "批量切换 Codex provider" });
    fireEvent.change(select, { target: { value: "azure" } });
    fireEvent.click(screen.getByRole("button", { name: "切换 Provider" }));

    expect(onBatchChangeModelProvider).toHaveBeenCalledWith("azure");
  });

  it("混选其他 CLI 对话时显示不支持提示", () => {
    render(
      <Sidebar
        providers={providers}
        activeProviders={new Set(["codex", "claude-code"])}
        toggleProvider={() => {}}
        conversations={[
          createConversation({ id: "codex:1", provider: "codex", modelProvider: "openai" }),
          createConversation({ id: "claude-code:1", provider: "claude-code" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
        search=""
        onSearchChange={() => {}}
        sort="updatedAt"
        onSortChange={() => {}}
        loading={false}
        total={2}
        selectedIds={new Set(["codex:1", "claude-code:1"])}
        onToggleSelect={() => {}}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onToggleSelectGroup={() => {}}
        onBatchExport={() => {}}
        onBatchDelete={() => {}}
        onBatchGenerate={() => {}}
        onBatchChangeModelProvider={() => {}}
        batchGenerating={false}
        onMoveConversation={() => {}}
        codexModelProviders={[{ name: "openai", count: 1 }]}
        activeModelProviders={new Set(["openai"])}
        onToggleModelProvider={() => {}}
        partialSearch={false}
        searchWarnings={[]}
      />
    );

    expect(screen.queryByRole("combobox", { name: "批量切换 Codex provider" })).not.toBeInTheDocument();
    expect(screen.getByText("批量 provider 切换目前仅支持 Codex 对话")).toBeInTheDocument();
  });

  it("选中 iFlow 对话时会禁用批量 AI 标题按钮", () => {
    render(
      <Sidebar
        providers={providers}
        activeProviders={new Set(["codex", "iflow"])}
        toggleProvider={() => {}}
        conversations={[
          createConversation({ id: "codex:1", provider: "codex", modelProvider: "openai" }),
          createConversation({
            id: "iflow:1",
            provider: "iflow",
            capabilities: {
              canUpdateTitle: false,
              canGenerateTitle: false,
              updateTitleDisabledReason: "iFlow 当前没有稳定的原生标题字段，已禁用修改标题",
              generateTitleDisabledReason: "iFlow 当前没有稳定的原生标题字段，已禁用修改标题",
            },
          }),
        ]}
        selectedId={null}
        onSelect={() => {}}
        search=""
        onSearchChange={() => {}}
        sort="updatedAt"
        onSortChange={() => {}}
        loading={false}
        total={2}
        selectedIds={new Set(["codex:1", "iflow:1"])}
        onToggleSelect={() => {}}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onToggleSelectGroup={() => {}}
        onBatchExport={() => {}}
        onBatchDelete={() => {}}
        onBatchGenerate={() => {}}
        onBatchChangeModelProvider={() => {}}
        batchGenerating={false}
        onMoveConversation={() => {}}
        codexModelProviders={[{ name: "openai", count: 1 }]}
        activeModelProviders={new Set(["openai"])}
        onToggleModelProvider={() => {}}
        partialSearch={false}
        searchWarnings={[]}
      />
    );

    expect(screen.getByRole("button", { name: "AI 标题" })).toBeDisabled();
    expect(screen.getByText("iFlow 当前没有稳定的原生标题字段，已禁用修改标题")).toBeInTheDocument();
  });
});
