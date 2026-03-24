import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConversationList } from "./ConversationList";
import type { ConversationMeta } from "../lib/api";

vi.mock("react-virtuoso", () => ({
  GroupedVirtuoso: ({
    groupCounts,
    groupContent,
    itemContent,
  }: {
    groupCounts: number[];
    groupContent: (groupIndex: number) => React.ReactNode;
    itemContent: (index: number) => React.ReactNode;
  }) => {
    let cursor = 0;
    return (
      <div>
        {groupCounts.map((count, groupIndex) => {
          const items = Array.from({ length: count }, (_, offset) => itemContent(cursor + offset));
          cursor += count;
          return (
            <div key={groupIndex}>
              {groupContent(groupIndex)}
              {items}
            </div>
          );
        })}
      </div>
    );
  },
}));

function createConversation(partial: Partial<ConversationMeta> & Pick<ConversationMeta, "id" | "provider">): ConversationMeta {
  return {
    title: "测试对话",
    project: "/tmp/project",
    projectKey: "project",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    fileSize: 128,
    filePath: "/tmp/project/session.jsonl",
    ...partial,
  };
}

describe("ConversationList", () => {
  it("会渲染分组和会话项，并支持折叠", () => {
    const conversations = [
      createConversation({ id: "codex:1", provider: "codex", title: "Alpha" }),
      createConversation({ id: "codex:2", provider: "codex", title: "Beta", projectKey: "project-2", project: "/tmp/project-2" }),
    ];

    render(
      <ConversationList
        conversations={conversations}
        selectedId={null}
        onSelect={() => {}}
        loading={false}
        selectedIds={new Set()}
        onToggleSelect={() => {}}
        onToggleSelectGroup={() => {}}
        onDrop={() => {}}
      />
    );

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("Windows 路径仅大小写不同的目录会合并成同一分组", () => {
    const conversations = [
      createConversation({
        id: "codex:1",
        provider: "codex",
        title: "Alpha",
        project: "C:/Users/mortis097/Desktop/code_area/r-bioinfo",
        projectKey: "C:/Users/mortis097/Desktop/code_area/r-bioinfo",
      }),
      createConversation({
        id: "codex:2",
        provider: "codex",
        title: "Beta",
        project: "C:/Users/mortis097/desktop/code_area/r-bioinfo",
        projectKey: "C:/Users/mortis097/desktop/code_area/r-bioinfo",
      }),
    ];

    render(
      <ConversationList
        conversations={conversations}
        selectedId={null}
        onSelect={() => {}}
        loading={false}
        selectedIds={new Set()}
        onToggleSelect={() => {}}
        onToggleSelectGroup={() => {}}
        onDrop={() => {}}
      />
    );

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getAllByText("~/desktop/code_area/r-bioinfo")).toHaveLength(1);
  });
});
