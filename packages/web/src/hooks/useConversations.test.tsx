import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversations } from "./useConversations";
import { ApiError, type Conversation, type ConversationListResponse, type ConversationMeta } from "../lib/api";

const {
  mockFetchProviders,
  mockFetchConversations,
  mockFetchConversation,
  mockFetchCodexProviders,
} = vi.hoisted(() => ({
  mockFetchProviders: vi.fn(),
  mockFetchConversations: vi.fn(),
  mockFetchConversation: vi.fn(),
  mockFetchCodexProviders: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchProviders: mockFetchProviders,
    fetchConversations: mockFetchConversations,
    fetchConversation: mockFetchConversation,
    fetchCodexProviders: mockFetchCodexProviders,
  };
});

function createConversation(id: string): ConversationMeta {
  return {
    id,
    provider: "codex",
    title: id,
    project: "/tmp/project",
    projectKey: "project",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3,
    fileSize: 4,
    filePath: `/tmp/${id}.jsonl`,
  };
}

function createConversationDetail(id: string): Conversation {
  return {
    ...createConversation(id),
    messages: [
      { messageId: "msg-1", role: "user", content: "原始问题", timestamp: 1, editable: true, deletable: true },
      { messageId: "msg-2", role: "assistant", content: "原始回答", timestamp: 2, editable: true, deletable: true },
    ],
    hasMore: false,
  };
}

describe("useConversations", () => {
  beforeEach(() => {
    mockFetchProviders.mockReset();
    mockFetchConversations.mockReset();
    mockFetchConversation.mockReset();
    mockFetchCodexProviders.mockReset();

    mockFetchProviders.mockResolvedValue([
      {
        name: "codex",
        displayName: "Codex",
        available: true,
        storagePath: "/tmp/codex",
      },
    ]);
    mockFetchCodexProviders.mockResolvedValue([]);
    mockFetchConversation.mockResolvedValue(createConversationDetail("codex:1"));
  });

  it("筛选后会移除当前不可见项的多选状态，并暴露 partialSearch 提示", async () => {
    const initialResponse: ConversationListResponse = {
      total: 2,
      conversations: [createConversation("codex:1"), createConversation("codex:2")],
      partialSearch: false,
      warnings: [],
    };
    const filteredResponse: ConversationListResponse = {
      total: 1,
      conversations: [createConversation("codex:2")],
      partialSearch: true,
      warnings: ["Codex 搜索索引尚未就绪，当前仅匹配标题和目录"],
    };

    let fetchCount = 0;
    mockFetchConversations.mockImplementation(async () => {
      fetchCount += 1;
      return fetchCount >= 2 ? filteredResponse : initialResponse;
    });

    const { result } = renderHook(() => useConversations());

    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(2);
    });

    act(() => {
      result.current.toggleSelect("codex:1");
      result.current.toggleSelect("codex:2");
      result.current.setSort("createdAt");
    });

    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
    });

    expect([...result.current.selectedIds]).toEqual(["codex:2"]);
    expect(result.current.partialSearch).toBe(true);
    expect(result.current.searchWarnings).toEqual(filteredResponse.warnings);
  });

  it("初始化时等待 provider 数据后只加载一次列表", async () => {
    mockFetchConversations.mockResolvedValue({
      total: 1,
      conversations: [createConversation("codex:1")],
      partialSearch: false,
      warnings: [],
    } satisfies ConversationListResponse);

    const { result } = renderHook(() => useConversations());

    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
    });

    expect(mockFetchProviders).toHaveBeenCalledTimes(1);
    expect(mockFetchCodexProviders).toHaveBeenCalledTimes(1);
    expect(mockFetchConversations).toHaveBeenCalledTimes(1);
    expect(mockFetchConversations).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      limit: 5000,
      offset: 0,
    }));
  });

  it("列表被截断时可按 nextOffset 加载下一页", async () => {
    const firstPage: ConversationListResponse = {
      total: 3,
      conversations: [createConversation("codex:1"), createConversation("codex:2")],
      listTruncated: true,
      nextOffset: 2,
      partialSearch: false,
      warnings: [],
    };
    const secondPage: ConversationListResponse = {
      total: 3,
      conversations: [createConversation("codex:3")],
      listTruncated: false,
      partialSearch: false,
      warnings: [],
    };

    mockFetchConversations.mockImplementation(async (params: { offset?: number }) => (
      params.offset === 2 ? secondPage : firstPage
    ));

    const { result } = renderHook(() => useConversations());

    await waitFor(() => {
      expect(result.current.conversations.map((item) => item.id)).toEqual(["codex:1", "codex:2"]);
    });

    expect(result.current.listTruncated).toBe(true);

    await act(async () => {
      await result.current.loadMoreConversations();
    });

    await waitFor(() => {
      expect(result.current.conversations.map((item) => item.id)).toEqual([
        "codex:1",
        "codex:2",
        "codex:3",
      ]);
    });
    expect(result.current.listTruncated).toBe(false);
    expect(mockFetchConversations).toHaveBeenCalledWith(expect.objectContaining({
      limit: 5000,
      offset: 2,
    }));
  });

  it("标题修改会先本地更新，不再同步阻塞整窗刷新", async () => {
    mockFetchConversations.mockResolvedValue({
      total: 1,
      conversations: [createConversation("codex:1")],
      partialSearch: false,
      warnings: [],
    } satisfies ConversationListResponse);

    const { result } = renderHook(() => useConversations());

    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
    });

    await act(async () => {
      await result.current.selectConversation("codex:1");
    });

    mockFetchConversation.mockClear();

    act(() => {
      result.current.applyLocalTitleChange("codex:1", "新的本地标题");
    });

    expect(result.current.conversation?.title).toBe("新的本地标题");
    expect(result.current.conversations[0]?.title).toBe("新的本地标题");
    expect(mockFetchConversation).not.toHaveBeenCalled();
  });

  it("列表接口返回 codexModelProviderCounts 时写入 state", async () => {
    mockFetchCodexProviders.mockResolvedValue([
      "v",
      "custom",
    ]);
    mockFetchConversations.mockResolvedValue({
      total: 3,
      conversations: [createConversation("codex:1")],
      codexModelProviderCounts: { v: 2, custom: 1 },
      partialSearch: false,
      warnings: [],
    } satisfies ConversationListResponse);

    const { result } = renderHook(() => useConversations());

    await waitFor(() => {
      expect(result.current.activeModelProviders.size).toBe(2);
    });

    expect(result.current.codexModelProviderCounts).toEqual({
      v: 2,
      custom: 1,
    });
  });

  it("列表接口缺少 provider 计数字段时 state 为空对象", async () => {
    mockFetchCodexProviders.mockResolvedValue([
      "v",
      "custom",
    ]);
    mockFetchConversations.mockResolvedValue({
      total: 1,
      conversations: [createConversation("codex:1")],
      partialSearch: false,
      warnings: [],
    } satisfies ConversationListResponse);

    const { result } = renderHook(() => useConversations());

    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
    });

    expect(result.current.codexModelProviderCounts).toEqual({});
  });

  it("ensureModelProviderVisible 会把新 provider 加入当前过滤集合", async () => {
    mockFetchCodexProviders.mockResolvedValue([
      "v",
      "custom",
    ]);
    mockFetchConversations.mockResolvedValue({
      total: 1,
      conversations: [createConversation("codex:1")],
      partialSearch: false,
      warnings: [],
    } satisfies ConversationListResponse);

    const { result } = renderHook(() => useConversations());

    await waitFor(() => {
      expect(result.current.activeModelProviders.size).toBe(2);
    });

    act(() => {
      result.current.toggleModelProvider("custom");
    });

    expect([...result.current.activeModelProviders]).toEqual(["v"]);

    act(() => {
      result.current.ensureModelProviderVisible("custom");
    });

    expect(new Set(result.current.activeModelProviders)).toEqual(new Set(["v", "custom"]));
  });

  it("详情 404 时会自动清理失效对话记录", async () => {
    mockFetchConversations.mockResolvedValue({
      total: 2,
      conversations: [createConversation("codex:1"), createConversation("codex:2")],
      partialSearch: false,
      warnings: [],
    } satisfies ConversationListResponse);
    mockFetchConversation.mockRejectedValueOnce(new ApiError("对话不存在: codex:1", 404));

    const onNotify = vi.fn();
    const { result } = renderHook(() => useConversations({ onNotify }));

    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(2);
    });

    await act(async () => {
      await result.current.selectConversation("codex:1");
    });

    await waitFor(() => {
      expect(result.current.conversations.map((item) => item.id)).toEqual(["codex:2"]);
    });
    expect(result.current.selectedId).toBeNull();
    expect(result.current.conversation).toBeNull();
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({
      variant: "warning",
      title: "已自动清理失效对话记录",
    }));
  });

  it("消息编辑会先本地更新，再后台静默校正", async () => {
    mockFetchConversations.mockResolvedValue({
      total: 1,
      conversations: [createConversation("codex:1")],
      partialSearch: false,
      warnings: [],
    } satisfies ConversationListResponse);

    const refreshedDetail: Conversation = {
      ...createConversation("codex:1"),
      updatedAt: 999,
      messages: [
        { messageId: "msg-1b", role: "user", content: "修改后的问题", timestamp: 1, editable: true, deletable: true },
        { messageId: "msg-2", role: "assistant", content: "原始回答", timestamp: 2, editable: true, deletable: true },
      ],
      hasMore: false,
    };

    const { result } = renderHook(() => useConversations());

    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
    });

    await act(async () => {
      await result.current.selectConversation("codex:1");
    });

    mockFetchConversation.mockReset();
    mockFetchConversation.mockResolvedValue(refreshedDetail);

    act(() => {
      result.current.applyLocalMessageUpdate("codex:1", "msg-1", "修改后的问题");
    });

    expect(result.current.conversation?.messages[0]?.content).toBe("修改后的问题");

    await waitFor(() => {
      expect(mockFetchConversation).toHaveBeenCalledWith("codex:1", {
        before: 0,
        limit: 200,
        signal: expect.any(AbortSignal),
      });
    });

    await waitFor(() => {
      expect(result.current.conversation?.messages[0]?.messageId).toBe("msg-1b");
    });
  });
});
