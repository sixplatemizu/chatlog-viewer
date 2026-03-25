import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationViewer } from "./ConversationViewer";
import type { Conversation } from "../lib/api";

const { mockDeleteConversationMessages } = vi.hoisted(() => ({
  mockDeleteConversationMessages: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    deleteConversationMessages: mockDeleteConversationMessages,
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
  project: "/tmp/project",
  projectKey: "/tmp/project",
  createdAt: 1,
  updatedAt: 2,
  messageCount: 3,
  fileSize: 100,
  filePath: "/tmp/project/test.jsonl",
  modelProvider: "openai",
  hasMore: true,
  messages: [
    { messageId: "text:1", role: "user", content: "hello", timestamp: 1, deletable: true },
    { messageId: "text:2", role: "assistant", content: "world", timestamp: 2, deletable: true },
  ],
};

describe("ConversationViewer", () => {
  beforeEach(() => {
    mockDeleteConversationMessages.mockReset();
  });

  it("批量删除模式会选择已加载消息并触发批量删除", async () => {
    const onConversationChanged = vi.fn().mockResolvedValue(undefined);
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
        onConversationChanged={onConversationChanged}
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
      expect(onConversationChanged).toHaveBeenCalledWith("codex:test-1");
    });

    confirmSpy.mockRestore();
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
        onConversationChanged={() => {}}
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
        onConversationChanged={() => {}}
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
