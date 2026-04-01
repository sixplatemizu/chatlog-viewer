import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationViewer } from "./ConversationViewer";
import type { Conversation } from "../lib/api";

const { mockDeleteConversationMessages, mockGenerateAiTitle } = vi.hoisted(() => ({
  mockDeleteConversationMessages: vi.fn(),
  mockGenerateAiTitle: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    deleteConversationMessages: mockDeleteConversationMessages,
    generateAiTitle: mockGenerateAiTitle,
  };
});

vi.mock("react-virtuoso", () => {
  return {
    Virtuoso: ({ data, components, itemContent }: {
      data: unknown[];
      components?: { Header?: () => React.ReactNode };
      itemContent: (index: number, item: unknown) => React.ReactNode;
    }) => (
      <div>
        {components?.Header?.()}
        {data.map((item, index) => (
          <div key={index}>{itemContent(index, item)}</div>
        ))}
      </div>
    ),
  };
});

const baseConversation: Conversation = {
  id: "codex:test-1",
  provider: "codex",
  title: "测试对话",
  titleSyncMode: "native",
  capabilities: {
    canUpdateTitle: true,
    canGenerateTitle: true,
  },
  project: "/tmp/project",
  projectKey: "/tmp/project",
  createdAt: 1,
  updatedAt: 2,
  messageCount: 3,
  fileSize: 100,
  filePath: "/tmp/project/test.jsonl",
  modelProvider: "openai",
  contentStatus: "full",
  hasMore: true,
  messages: [
    { messageId: "text:1", role: "user", content: "hello", timestamp: 1, deletable: true },
    { messageId: "text:2", role: "assistant", content: "world", timestamp: 2, deletable: true },
  ],
};

describe("ConversationViewer", () => {
  beforeEach(() => {
    mockDeleteConversationMessages.mockReset();
    mockGenerateAiTitle.mockReset();
  });

  it("批量删除模式会选择已加载消息并触发批量删除", async () => {
    const onMessagesDeleted = vi.fn().mockResolvedValue(undefined);
    const onNotify = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockDeleteConversationMessages.mockResolvedValue({ success: true, deleted: 2 });

    render(
      <ConversationViewer
        conversation={baseConversation}
        dark={false}
        loading={false}
        loadingEarlier={false}
        onLoadEarlier={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        onTitleChanged={() => {}}
        onMessageUpdated={() => {}}
        onMessagesDeleted={onMessagesDeleted}
        onNotify={onNotify}
        codexModelProviders={[{ name: "openai", count: 1 }]}
        onChangeModelProvider={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /批量删除消息/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选已加载/i }));
    fireEvent.click(screen.getByRole("button", { name: /删除选中 \(2\)/i }));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(mockDeleteConversationMessages).toHaveBeenCalledWith("codex:test-1", ["text:1", "text:2"]);
    });
    await waitFor(() => {
      expect(onMessagesDeleted).toHaveBeenCalledWith("codex:test-1", ["text:1", "text:2"]);
    });

    confirmSpy.mockRestore();
  });

  it("右侧显式 AI 标题按钮会触发生成并刷新当前对话", async () => {
    const onTitleChanged = vi.fn().mockResolvedValue(undefined);
    const onRefreshConversation = vi.fn().mockResolvedValue(undefined);
    mockGenerateAiTitle.mockResolvedValue({
      success: true,
      title: "新的 AI 标题",
      usedCli: "iflow",
    });

    render(
      <ConversationViewer
        conversation={baseConversation}
        dark={false}
        loading={false}
        loadingEarlier={false}
        onLoadEarlier={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        onTitleChanged={onTitleChanged}
        onRefreshConversation={onRefreshConversation}
        onMessageUpdated={() => {}}
        onMessagesDeleted={() => {}}
        onNotify={() => {}}
        codexModelProviders={[{ name: "openai", count: 1 }]}
        onChangeModelProvider={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "AI 标题" }));

    await waitFor(() => {
      expect(mockGenerateAiTitle).toHaveBeenCalledWith("codex:test-1");
    });
    await waitFor(() => {
      expect(onTitleChanged).toHaveBeenCalledWith("codex:test-1", "新的 AI 标题");
    });
    await waitFor(() => {
      expect(onRefreshConversation).toHaveBeenCalledWith("codex:test-1");
    });

    expect(screen.getByText("已同步到 CLI")).toBeInTheDocument();
  });

  it("metadata-only 对话会显示 metadata 提示而不是残留清理提示", () => {
    render(
      <ConversationViewer
        conversation={{
          ...baseConversation,
          messageCount: 0,
          transcriptMissing: true,
          contentStatus: "metadata-only",
          titleGenerationHint: "当前对话缺少 transcript，请仅根据 metadata 生成标题",
          messages: [{ role: "system", content: "当前仅保留 metadata" }],
        }}
        dark={false}
        loading={false}
        loadingEarlier={false}
        onLoadEarlier={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        onTitleChanged={() => {}}
        onMessageUpdated={() => {}}
        onMessagesDeleted={() => {}}
        onNotify={() => {}}
        codexModelProviders={[{ name: "openai", count: 1 }]}
        onChangeModelProvider={() => {}}
      />
    );

    expect(screen.getByText("当前仅保留 metadata，可改标题、删会话、切换 provider，但无法查看真实消息正文")).toBeInTheDocument();
    expect(screen.getByText("AI 标题将基于 metadata 生成，不是基于完整消息正文")).toBeInTheDocument();
    expect(screen.queryByText("当前对话已退化为残留记录，可直接清理")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
  });

  it("metadata-only 对话生成标题后会显示 metadata 状态文案", async () => {
    const onTitleChanged = vi.fn().mockResolvedValue(undefined);
    mockGenerateAiTitle.mockResolvedValue({
      success: true,
      title: "metadata 标题",
      usedCli: "codex",
    });

    render(
      <ConversationViewer
        conversation={{
          ...baseConversation,
          messageCount: 0,
          transcriptMissing: true,
          contentStatus: "metadata-only",
          titleGenerationHint: "当前对话缺少 transcript，请仅根据 metadata 生成标题",
          messages: [{ role: "system", content: "当前仅保留 metadata" }],
        }}
        dark={false}
        loading={false}
        loadingEarlier={false}
        onLoadEarlier={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        onTitleChanged={onTitleChanged}
        onMessageUpdated={() => {}}
        onMessagesDeleted={() => {}}
        onNotify={() => {}}
        codexModelProviders={[{ name: "openai", count: 1 }]}
        onChangeModelProvider={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "AI 标题" }));

    await waitFor(() => {
      expect(mockGenerateAiTitle).toHaveBeenCalledWith("codex:test-1");
    });
    await waitFor(() => {
      expect(onTitleChanged).toHaveBeenCalledWith("codex:test-1", "metadata 标题");
    });

    expect(screen.getByText("已通过 codex 基于 metadata 生成标题")).toBeInTheDocument();
  });

  it("cleanupCandidate 对话会显示清理残留记录入口", () => {
    render(
      <ConversationViewer
        conversation={{
          ...baseConversation,
          cleanupCandidate: true,
          contentStatus: "metadata-only",
          messageCount: 0,
          transcriptMissing: true,
          messages: [{ role: "system", content: "当前仅剩残留记录" }],
        }}
        dark={false}
        loading={false}
        loadingEarlier={false}
        onLoadEarlier={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        onTitleChanged={() => {}}
        onMessageUpdated={() => {}}
        onMessagesDeleted={() => {}}
        onNotify={() => {}}
        codexModelProviders={[{ name: "openai", count: 1 }]}
        onChangeModelProvider={() => {}}
      />
    );

    expect(screen.getByText("当前对话已退化为残留记录，可直接清理")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清理残留记录" })).toBeInTheDocument();
  });

  it("iFlow 对话会明确显示仅 viewer 覆盖", () => {
    render(
      <ConversationViewer
        conversation={{
          ...baseConversation,
          id: "iflow:test-1",
          provider: "iflow",
          titleSyncMode: "overlay",
          capabilities: {
            canUpdateTitle: false,
            canGenerateTitle: false,
            updateTitleDisabledReason: "iFlow 当前已禁用修改标题",
            generateTitleDisabledReason: "iFlow 当前已禁用修改标题",
          },
        }}
        dark={false}
        loading={false}
        loadingEarlier={false}
        onLoadEarlier={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        onTitleChanged={() => {}}
        onMessageUpdated={() => {}}
        onMessagesDeleted={() => {}}
        onNotify={() => {}}
        codexModelProviders={[]}
        onChangeModelProvider={() => {}}
      />
    );

    expect(screen.getByText("仅 viewer 覆盖")).toBeInTheDocument();
    expect(screen.getByText("iFlow 当前已禁用修改标题")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AI 标题" })).not.toBeInTheDocument();
  });

  it("没有会话时显示空态", () => {
    render(
      <ConversationViewer
        conversation={null}
        dark={false}
        loading={false}
        loadingEarlier={false}
        onLoadEarlier={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        onTitleChanged={() => {}}
        onMessageUpdated={() => {}}
        onMessagesDeleted={() => {}}
        onNotify={() => {}}
        codexModelProviders={[]}
        onChangeModelProvider={() => {}}
      />
    );

    expect(screen.getByText("选择一个对话查看内容")).toBeInTheDocument();
  });

  it("有更多消息时显示加载更早按钮并触发回调", () => {
    const handleLoadEarlier = vi.fn();

    render(
      <ConversationViewer
        conversation={baseConversation}
        dark={false}
        loading={false}
        loadingEarlier={false}
        onLoadEarlier={handleLoadEarlier}
        onExport={() => {}}
        onDelete={() => {}}
        onTitleChanged={() => {}}
        onMessageUpdated={() => {}}
        onMessagesDeleted={() => {}}
        onNotify={() => {}}
        codexModelProviders={[{ name: "openai", count: 1 }]}
        onChangeModelProvider={() => {}}
      />
    );

    const button = screen.getByRole("button", { name: /加载更早的 1 条/i });
    fireEvent.click(button);

    expect(handleLoadEarlier).toHaveBeenCalledTimes(1);
    expect(screen.getByText("已加载最近 2 / 3 条消息")).toBeInTheDocument();
  });
});
