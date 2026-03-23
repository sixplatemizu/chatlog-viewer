import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationViewer } from "./ConversationViewer";
import type { Conversation } from "../lib/api";

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
    { role: "user", content: "hello", timestamp: 1 },
    { role: "assistant", content: "world", timestamp: 2 },
  ],
};

describe("ConversationViewer", () => {
  it("没有会话时显示空态", () => {
    render(
      <ConversationViewer
        conversation={null}
        loading={false}
        loadingEarlier={false}
        onLoadEarlier={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        onTitleChanged={() => {}}
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
        loading={false}
        loadingEarlier={false}
        onLoadEarlier={handleLoadEarlier}
        onExport={() => {}}
        onDelete={() => {}}
        onTitleChanged={() => {}}
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
