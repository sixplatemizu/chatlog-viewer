import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConversations } from "./useConversations";
import type { ConversationListResponse, ConversationMeta } from "../lib/api";

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
    mockFetchConversation.mockResolvedValue(null);
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
      return fetchCount >= 3 ? filteredResponse : initialResponse;
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
});
