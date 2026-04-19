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

const emptyProviderCounts = {
  codex: 0,
  "claude-code": 0,
  iflow: 0,
};

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
    transcriptMissing: partial.transcriptMissing,
    contentStatus: partial.contentStatus,
    cleanupCandidate: partial.cleanupCandidate,
    titleGenerationHint: partial.titleGenerationHint,
  };
}

describe("Sidebar", () => {
  it("Codex provider pill 显示 codexModelProviderCounts 中的对话数", () => {
    render(
      <Sidebar
        providers={providers}
        activeProviders={new Set(["codex", "claude-code"])}
        toggleProvider={() => {}}
        conversations={[
          createConversation({ id: "codex:1", provider: "codex", modelProvider: "openai" }),
          createConversation({ id: "codex:2", provider: "codex", modelProvider: "openai" }),
          createConversation({ id: "codex:3", provider: "codex", modelProvider: "azure" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
        search=""
        onSearchChange={() => {}}
        sort="updatedAt"
        onSortChange={() => {}}
        loading={false}
        total={3}
        providerCounts={{ codex: 3, "claude-code": 0, iflow: 0 }}
        selectedIds={new Set()}
        onToggleSelect={() => {}}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onToggleSelectGroup={() => {}}
        onBatchExport={() => {}}
        onBatchDelete={() => {}}
        onBatchDeleteEmpty={() => {}}
        onBatchGenerate={() => {}}
        onBatchChangeModelProvider={() => {}}
        onBatchMove={() => {}}
        batchGenerating={false}
        onMoveConversation={() => {}}
        codexModelProviderCounts={{ openai: 2, azure: 1 }}
        codexModelProviders={[
          "openai",
          "azure",
        ]}
        activeModelProviders={new Set()}
        onToggleModelProvider={() => {}}
        partialSearch={false}
        searchWarnings={[]}
      />
    );

    expect(screen.getByRole("button", { name: /openai\s*2/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /azure\s*1/ })).toBeInTheDocument();
  });

  it("工具筛选按钮会显示各 provider 总对话数", () => {
    render(
      <Sidebar
        providers={providers}
        activeProviders={new Set(["codex", "claude-code", "iflow"])}
        toggleProvider={() => {}}
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        search=""
        onSearchChange={() => {}}
        sort="updatedAt"
        onSortChange={() => {}}
        loading={false}
        total={0}
        providerCounts={{ codex: 5, "claude-code": 3, iflow: 1 }}
        selectedIds={new Set()}
        onToggleSelect={() => {}}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onToggleSelectGroup={() => {}}
        onBatchExport={() => {}}
        onBatchDelete={() => {}}
        onBatchDeleteEmpty={() => {}}
        onBatchGenerate={() => {}}
        onBatchChangeModelProvider={() => {}}
        onBatchMove={() => {}}
        batchGenerating={false}
        onMoveConversation={() => {}}
        codexModelProviderCounts={{}}
        codexModelProviders={[]}
        activeModelProviders={new Set()}
        onToggleModelProvider={() => {}}
        partialSearch={false}
        searchWarnings={[]}
      />
    );

    expect(screen.getByRole("button", { name: /Codex\s*5/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Claude Code\s*3/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /iFlow\s*1/ })).toBeInTheDocument();
  });

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
        providerCounts={emptyProviderCounts}
        selectedIds={new Set(["codex:1", "codex:2"])}
        onToggleSelect={() => {}}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onToggleSelectGroup={() => {}}
        onBatchExport={() => {}}
        onBatchDelete={() => {}}
        onBatchDeleteEmpty={() => {}}
        onBatchGenerate={() => {}}
        onBatchChangeModelProvider={onBatchChangeModelProvider}
        onBatchMove={() => {}}
        batchGenerating={false}
        onMoveConversation={() => {}}
        codexModelProviderCounts={{}} codexModelProviders={[
          "openai",
          "azure",
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

  it("Codex provider pill 使用列表接口返回的 codexModelProviderCounts", () => {
    render(
      <Sidebar
        providers={providers}
        activeProviders={new Set(["codex"])}
        toggleProvider={() => {}}
        conversations={[]}
        selectedId={null}
        onSelect={() => {}}
        search=""
        onSearchChange={() => {}}
        sort="updatedAt"
        onSortChange={() => {}}
        loading={false}
        total={3}
        providerCounts={emptyProviderCounts}
        selectedIds={new Set()}
        onToggleSelect={() => {}}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onToggleSelectGroup={() => {}}
        onBatchExport={() => {}}
        onBatchDelete={() => {}}
        onBatchDeleteEmpty={() => {}}
        onBatchGenerate={() => {}}
        onBatchChangeModelProvider={() => {}}
        onBatchMove={() => {}}
        batchGenerating={false}
        onMoveConversation={() => {}}
        codexModelProviderCounts={{ openai: 2, azure: 1 }}
        codexModelProviders={[
          "openai",
          "azure",
        ]}
        activeModelProviders={new Set(["openai", "azure"])}
        onToggleModelProvider={() => {}}
        partialSearch={false}
        searchWarnings={[]}
      />
    );

    expect(screen.getByRole("button", { name: /openai/i })).toHaveTextContent("openai2");
    expect(screen.getByRole("button", { name: /azure/i })).toHaveTextContent("azure1");
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
        providerCounts={emptyProviderCounts}
        selectedIds={new Set(["codex:1", "claude-code:1"])}
        onToggleSelect={() => {}}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onToggleSelectGroup={() => {}}
        onBatchExport={() => {}}
        onBatchDelete={() => {}}
        onBatchDeleteEmpty={() => {}}
        onBatchGenerate={() => {}}
        onBatchChangeModelProvider={() => {}}
        onBatchMove={() => {}}
        batchGenerating={false}
        onMoveConversation={() => {}}
        codexModelProviderCounts={{}} codexModelProviders={["openai"]}
        activeModelProviders={new Set(["openai"])}
        onToggleModelProvider={() => {}}
        partialSearch={false}
        searchWarnings={[]}
      />
    );

    expect(screen.queryByRole("combobox", { name: "批量切换 Codex provider" })).not.toBeInTheDocument();
    expect(screen.getByText("批量 provider 切换目前仅支持 Codex 对话")).toBeInTheDocument();
  });

  it("仅选中 cleanupCandidate 时显示批量清理入口", () => {
    const onBatchDeleteEmpty = vi.fn();

    render(
      <Sidebar
        providers={providers}
        activeProviders={new Set(["codex", "iflow"])}
        toggleProvider={() => {}}
        conversations={[
          createConversation({ id: "codex:1", provider: "codex", cleanupCandidate: true, transcriptMissing: true, messageCount: 0 }),
          createConversation({ id: "iflow:1", provider: "iflow", messageCount: 0 }),
        ]}
        selectedId={null}
        onSelect={() => {}}
        search=""
        onSearchChange={() => {}}
        sort="updatedAt"
        onSortChange={() => {}}
        loading={false}
        total={2}
        providerCounts={emptyProviderCounts}
        selectedIds={new Set(["codex:1", "iflow:1"])}
        onToggleSelect={() => {}}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onToggleSelectGroup={() => {}}
        onBatchExport={() => {}}
        onBatchDelete={() => {}}
        onBatchDeleteEmpty={onBatchDeleteEmpty}
        onBatchGenerate={() => {}}
        onBatchChangeModelProvider={() => {}}
        onBatchMove={() => {}}
        batchGenerating={false}
        onMoveConversation={() => {}}
        codexModelProviderCounts={{}} codexModelProviders={["openai"]}
        activeModelProviders={new Set(["openai"])}
        onToggleModelProvider={() => {}}
        partialSearch={false}
        searchWarnings={[]}
      />
    );

    expect(screen.getByText("已选 1 条残留记录，可直接一键清理。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清理残留" }));
    expect(onBatchDeleteEmpty).toHaveBeenCalledTimes(1);
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
        providerCounts={emptyProviderCounts}
        selectedIds={new Set(["codex:1", "iflow:1"])}
        onToggleSelect={() => {}}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onToggleSelectGroup={() => {}}
        onBatchExport={() => {}}
        onBatchDelete={() => {}}
        onBatchDeleteEmpty={() => {}}
        onBatchGenerate={() => {}}
        onBatchChangeModelProvider={() => {}}
        onBatchMove={() => {}}
        batchGenerating={false}
        onMoveConversation={() => {}}
        codexModelProviderCounts={{}} codexModelProviders={["openai"]}
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
