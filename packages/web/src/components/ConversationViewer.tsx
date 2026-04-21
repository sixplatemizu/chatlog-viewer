import { useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  Download,
  Trash2,
  FolderOpen,
  Clock,
  MessageSquare,
  Pencil,
  Sparkles,
  Check,
  X,
  Loader2,
  ArrowRightLeft,
} from "lucide-react";
import type { Conversation, TitleSyncMode } from "../lib/api";
import {
  updateTitle,
  generateAiTitle,
  updateConversationMessage,
  deleteConversationMessage,
  deleteConversationMessages,
  getErrorMessage,
} from "../lib/api";
import type { ToastPayload } from "./ToastViewport";
import { getProjectName, getProjectPathHint } from "../lib/project";
import { MessageBubble } from "./MessageBubble";

interface Props {
  conversation: Conversation | null;
  dark: boolean;
  loading: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void | Promise<void>;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
  onTitleChanged: (id: string, title: string) => void | Promise<void>;
  onRefreshConversation?: (id: string) => void | Promise<void>;
  onMessageUpdated: (id: string, messageId: string, content: string) => void | Promise<void>;
  onMessagesDeleted: (id: string, messageIds: string[]) => void | Promise<void>;
  onNotify: (toast: ToastPayload) => void;
  codexModelProviders: string[];
  onChangeModelProvider: (id: string, newProvider: string) => void;
  folderOptions: Array<{ projectKey: string; displayName: string }>;
  onChangeFolder: (id: string, targetProjectKey: string) => void;
}

const EMPTY_MESSAGES: NonNullable<Conversation["messages"]> = [];

function getProviderDisplayName(provider: string): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude-code") return "Claude Code";
  if (provider === "iflow") return "iFlow";
  return provider;
}

function getTitleSyncInfo(
  provider: string,
  mode: TitleSyncMode | undefined
): {
  badgeLabel: string;
  badgeClassName: string;
  description: string;
  saveTitle: string;
  statusSuffix: string;
  variant: ToastPayload["variant"];
} | null {
  if (!mode) return null;

  const providerLabel = getProviderDisplayName(provider);
  if (mode === "native") {
    return {
      badgeLabel: "已同步到 CLI",
      badgeClassName:
        "rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
      description: `${providerLabel} 支持原生标题字段，修改会写回本地会话数据。`,
      saveTitle: "标题已同步到本地 CLI",
      statusSuffix: "并同步到本地 CLI",
      variant: "info",
    };
  }

  return {
    badgeLabel: "仅 viewer 覆盖",
    badgeClassName:
      "rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    description: `${providerLabel} 当前没有稳定标题字段，修改只保存在 chatlog-viewer，不会写回原始 CLI。`,
    saveTitle: "标题仅保存在 chatlog-viewer",
    statusSuffix: "仅保存在 viewer",
    variant: "warning",
  };
}

export function ConversationViewer({
  conversation,
  dark,
  loading,
  loadingEarlier,
  onLoadEarlier,
  onExport,
  onDelete,
  onTitleChanged,
  onRefreshConversation,
  onMessageUpdated,
  onMessagesDeleted,
  onNotify,
  codexModelProviders,
  onChangeModelProvider,
  folderOptions,
  onChangeFolder,
}: Props) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreIndexRef = useRef<number | null>(null);
  const lastConversationIdRef = useRef<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);

  const totalMessages = conversation?.messageCount ?? conversation?.messages.length ?? 0;
  const loadedMessages = conversation?.messages ?? EMPTY_MESSAGES;
  const hiddenCount = Math.max(0, totalMessages - loadedMessages.length);
  const deletableMessageIds = useMemo(
    () => loadedMessages
      .filter((message) => message.deletable && message.messageId)
      .map((message) => message.messageId!),
    [loadedMessages]
  );
  const selectedDeletableCount = selectedMessageIds.size;
  const titleSyncInfo = conversation
    ? getTitleSyncInfo(conversation.provider, conversation.titleSyncMode)
    : null;
  const titleUpdateDisabledReason = conversation?.capabilities?.updateTitleDisabledReason;
  const canUpdateTitle = conversation?.capabilities?.canUpdateTitle ?? true;
  const canGenerateTitle = conversation?.capabilities?.canGenerateTitle ?? canUpdateTitle;
  const isMetadataOnlyConversation = !!conversation && conversation.contentStatus === "metadata-only";
  const isHistoryOnlyConversation = !!conversation && conversation.contentStatus === "history-only";
  const isCleanupOnlyConversation = !!conversation && !!conversation.cleanupCandidate;

  const messageKeys = useMemo(
    () => loadedMessages.map((msg, index) => msg.messageId ?? `${index}-${msg.timestamp ?? "na"}-${msg.role}`),
    [loadedMessages]
  );

  useEffect(() => {
    if (!conversation?.id) {
      lastConversationIdRef.current = null;
      restoreIndexRef.current = null;
      return;
    }

    if (lastConversationIdRef.current === conversation.id) {
      return;
    }

    lastConversationIdRef.current = conversation.id;
    restoreIndexRef.current = null;

    if (virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: Math.max(loadedMessages.length - 1, 0), align: "end" });
    }
  }, [conversation?.id, loadedMessages.length]);

  useEffect(() => {
    if (restoreIndexRef.current === null || !virtuosoRef.current) return;
    virtuosoRef.current.scrollToIndex({ index: restoreIndexRef.current, align: "start" });
    restoreIndexRef.current = null;
  }, [messageKeys]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, [conversation?.id]);

  useEffect(() => {
    const loadedMessageIdSet = new Set(deletableMessageIds);
    setSelectedMessageIds((prev) => {
      const next = new Set<string>();
      let changed = false;

      for (const messageId of prev) {
        if (loadedMessageIdSet.has(messageId)) {
          next.add(messageId);
        } else {
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [deletableMessageIds]);

  const startEdit = () => {
    if (!conversation || !canUpdateTitle) return;
    setEditValue(conversation.title);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!conversation || !canUpdateTitle || !editValue.trim()) return;
    try {
      const result = await updateTitle(conversation.id, editValue.trim());
      await onTitleChanged(conversation.id, result.title);
      setEditing(false);
      if (titleSyncInfo) {
        onNotify({
          variant: titleSyncInfo.variant,
          title: titleSyncInfo.saveTitle,
          description: titleSyncInfo.description,
        });
      }
    } catch (error) {
      onNotify({
        variant: "error",
        title: "保存标题失败",
        description: getErrorMessage(error, "保存标题失败"),
      });
    }
  };

  const handleGenerate = async () => {
    if (!conversation || !canGenerateTitle || generating) return;
    setGenerating(true);
    setGenStatus("正在调用 AI CLI 生成标题...");
    try {
      const result = await generateAiTitle(conversation.id);
      if (result.success) {
        setGenStatus(
          isMetadataOnlyConversation
            ? `已通过 ${result.usedCli} 基于 metadata 生成标题`
            : titleSyncInfo
              ? `已通过 ${result.usedCli} 生成，${titleSyncInfo.statusSuffix}`
              : `已通过 ${result.usedCli} 生成`
        );
        await onTitleChanged(conversation.id, result.title);
        await onRefreshConversation?.(conversation.id);
        setTimeout(() => setGenStatus(""), 3000);
      } else {
        setGenStatus(`失败: ${result.error}`);
        setTimeout(() => setGenStatus(""), 5000);
      }
    } catch (error) {
      setGenStatus(`失败: ${getErrorMessage(error, "生成失败")}`);
      setTimeout(() => setGenStatus(""), 3000);
    }
    setGenerating(false);
  };

  const handleLoadEarlier = () => {
    if (!conversation || !conversation.hasMore || loadingEarlier) return;

    restoreIndexRef.current = Math.min(hiddenCount, 200);
    void onLoadEarlier();
  };

  const handleUpdateMessage = async (messageId: string, content: string) => {
    if (!conversation) return;

    try {
      await updateConversationMessage(conversation.id, messageId, content);
      await onMessageUpdated(conversation.id, messageId, content);
    } catch (error) {
      onNotify({
        variant: "error",
        title: "保存消息失败",
        description: getErrorMessage(error, "保存消息失败"),
      });
      throw error;
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (!conversation) return;

    try {
      await deleteConversationMessage(conversation.id, messageId);
      await onMessagesDeleted(conversation.id, [messageId]);
    } catch (error) {
      onNotify({
        variant: "error",
        title: "删除消息失败",
        description: getErrorMessage(error, "删除消息失败"),
      });
      throw error;
    }
  };

  const toggleMessageSelect = (messageId: string) => {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  const toggleSelectAllMessages = () => {
    setSelectedMessageIds((prev) => {
      if (deletableMessageIds.length > 0 && prev.size === deletableMessageIds.length) {
        return new Set();
      }
      return new Set(deletableMessageIds);
    });
  };

  const handleBatchDeleteMessages = async () => {
    if (!conversation || selectedDeletableCount === 0 || batchDeleting) return;
    const targetIds = deletableMessageIds.filter((messageId) => selectedMessageIds.has(messageId));
    if (targetIds.length === 0) return;

    const confirmed = window.confirm(
      `确定删除当前已选中的 ${targetIds.length} 条消息吗？此操作无法恢复。`
    );
    if (!confirmed) return;

    setBatchDeleting(true);
    try {
      await deleteConversationMessages(conversation.id, targetIds);
      setSelectedMessageIds(new Set());
      await onMessagesDeleted(conversation.id, targetIds);
      onNotify({
        variant: "info",
        title: "批量删除完成",
        description: `已删除 ${targetIds.length} 条消息`,
      });
    } catch (error) {
      onNotify({
        variant: "error",
        title: "批量删除消息失败",
        description: getErrorMessage(error, "批量删除消息失败"),
      });
    } finally {
      setBatchDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-gray-900">
        <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-400 bg-white dark:bg-gray-900">
        <MessageSquare className="w-12 h-12 mb-3" />
        <span className="text-lg">选择一个对话查看内容</span>
        <span className="text-sm mt-1">从左侧列表中选择对话</span>
      </div>
    );
  }

  const loadEarlierBar = conversation.hasMore ? (
    <div className="border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-700 dark:bg-gray-900/95">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          已加载最近 {loadedMessages.length} / {totalMessages} 条消息
        </div>
        <button
          onClick={handleLoadEarlier}
          disabled={loadingEarlier}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          {loadingEarlier ? "正在加载..." : `加载更早的 ${Math.min(hiddenCount, 200)} 条`}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-white dark:bg-gray-900">
      <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3 flex-shrink-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editing ? (
              <div className="flex items-center gap-2">
                <input
                  ref={inputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit();
                    if (e.key === "Escape") setEditing(false);
                  }}
                  className="flex-1 text-base font-semibold text-gray-900 dark:text-gray-100 border border-blue-400 rounded-md px-2 py-0.5 bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button onClick={saveEdit} className="p-1 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30 rounded">
                  <Check className="w-4 h-4" />
                </button>
                <button onClick={() => setEditing(false)} className="p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 group">
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
                  {conversation.title}
                </h2>
                {canUpdateTitle && (
                  <button
                    onClick={startEdit}
                    className="p-1 text-gray-300 hover:text-gray-600 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="编辑标题"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-gray-500 dark:text-gray-400">
              <span
                className="flex items-center gap-1 min-w-0 max-w-full"
                title={getProjectPathHint(conversation.project, conversation.projectKey)}
              >
                <FolderOpen className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{getProjectName(conversation.project, conversation.projectKey)}</span>
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                {new Date(conversation.createdAt).toLocaleDateString("zh-CN")}
              </span>
              <span>{totalMessages} 条消息</span>
              {conversation.provider === "codex" && conversation.modelProvider && (
                <span className="flex items-center gap-1">
                  <ArrowRightLeft className="w-3 h-3 text-gray-400" />
                  <select
                    value={conversation.modelProvider}
                    onChange={(e) => onChangeModelProvider(conversation.id, e.target.value)}
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-600 border border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-green-400 appearance-none pr-4"
                    title="切换 Codex Model Provider"
                    style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 24 24' fill='none' stroke='%2322c55e' stroke-width='3'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center" }}
                  >
                    {codexModelProviders.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </span>
              )}
              {folderOptions.length > 0 && (
                <span className="flex items-center gap-1">
                  <ArrowRightLeft className="w-3 h-3 text-gray-400" />
                  <select
                    value={conversation.projectKey}
                    onChange={(e) => {
                      if (e.target.value !== conversation.projectKey) {
                        onChangeFolder(conversation.id, e.target.value);
                      }
                    }}
                    className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-400 appearance-none pr-4 max-w-[160px] truncate"
                    title="切换到其他文件夹"
                    style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 24 24' fill='none' stroke='%233b82f6' stroke-width='3'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")", backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center" }}
                  >
                    {folderOptions.some((item) => item.projectKey === conversation.projectKey) ? null : (
                      <option value={conversation.projectKey}>{conversation.projectKey}</option>
                    )}
                    {folderOptions.map((item) => (
                      <option key={item.projectKey} value={item.projectKey}>
                        {item.displayName}
                      </option>
                    ))}
                  </select>
                </span>
              )}
              {genStatus && (
                <span className="text-purple-500 animate-pulse">{genStatus}</span>
              )}
              {selectionMode && (
                <span className="text-amber-600 dark:text-amber-400">
                  仅对当前已加载且支持删除的消息生效
                </span>
              )}
              {isCleanupOnlyConversation && (
                <span className="text-amber-600 dark:text-amber-400">
                  当前对话已退化为残留记录，可直接清理
                </span>
              )}
              {isMetadataOnlyConversation && (
                <span className="text-sky-600 dark:text-sky-400">
                  当前仅保留 metadata，可改标题、删会话、切换 provider，但无法查看真实消息正文
                </span>
              )}
              {isHistoryOnlyConversation && (
                <span className="text-indigo-600 dark:text-indigo-400">
                  当前仅保留 history 回退内容，不是完整 transcript
                </span>
              )}
              {isMetadataOnlyConversation && conversation.titleGenerationHint && (
                <span className="text-sky-600 dark:text-sky-400">
                  AI 标题将基于 metadata 生成，不是基于完整消息正文
                </span>
              )}
              {!canUpdateTitle && titleUpdateDisabledReason && (
                <span className="text-amber-600 dark:text-amber-400">
                  {titleUpdateDisabledReason}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
            {selectionMode ? (
              <>
                <button
                  onClick={toggleSelectAllMessages}
                  disabled={deletableMessageIds.length === 0 || batchDeleting}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {selectedDeletableCount === deletableMessageIds.length && deletableMessageIds.length > 0
                    ? "取消全选"
                    : "全选已加载"}
                </button>
                <button
                  onClick={handleBatchDeleteMessages}
                  disabled={selectedDeletableCount === 0 || batchDeleting}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Trash2 className={`w-3.5 h-3.5 ${batchDeleting ? "animate-pulse" : ""}`} />
                  删除选中
                  {selectedDeletableCount > 0 ? ` (${selectedDeletableCount})` : ""}
                </button>
                <button
                  onClick={() => {
                    setSelectionMode(false);
                    setSelectedMessageIds(new Set());
                  }}
                  disabled={batchDeleting}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                >
                  退出选择
                </button>
              </>
            ) : (
              deletableMessageIds.length > 0 && (
                <button
                  onClick={() => setSelectionMode(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  批量删除消息
                </button>
              )
            )}
            {canGenerateTitle && (
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-purple-500 text-white rounded-lg hover:bg-purple-600 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                {generating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                {generating ? "生成中" : "AI 标题"}
              </button>
            )}
            <button
              onClick={() => onExport(conversation.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              导出
            </button>
            <button
              onClick={() => onDelete(conversation.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {isCleanupOnlyConversation ? "清理残留记录" : "删除"}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <Virtuoso
          ref={virtuosoRef}
          className="h-full"
          data={loadedMessages}
          alignToBottom
          followOutput={false}
          increaseViewportBy={{ top: 600, bottom: 1200 }}
          computeItemKey={(index) => messageKeys[index]}
          components={{
            Header: () => loadEarlierBar,
          }}
          itemContent={(index, message) => (
            <div className="border-b border-gray-100 dark:border-gray-800 last:border-b-0">
              <MessageBubble
                message={message}
                dark={dark}
                onUpdateMessage={handleUpdateMessage}
                onDeleteMessage={handleDeleteMessage}
                selectionMode={selectionMode}
                selected={!!message.messageId && selectedMessageIds.has(message.messageId)}
                selectable={!!message.deletable && !!message.messageId}
                onToggleSelect={toggleMessageSelect}
              />
            </div>
          )}
        />
      </div>
    </div>
  );
}
