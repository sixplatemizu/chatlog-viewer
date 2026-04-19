import { useState, useCallback, useRef } from "react";
import { useConversations } from "./hooks/useConversations";
import { useBatchActions } from "./hooks/useBatchActions";
import { useTheme } from "./hooks/useTheme";
import { Sidebar } from "./components/Sidebar";
import { ConversationViewer } from "./components/ConversationViewer";
import { ExportDialog } from "./components/ExportDialog";
import { ProviderPathsDialog } from "./components/ProviderPathsDialog";
import { ToastViewport, type ToastItem, type ToastPayload } from "./components/ToastViewport";
import { isSameProjectPath } from "./lib/project";
import {
  exportConversations,
  deleteConversation,
  deleteConversations,
  moveConversation,
  changeModelProvider,
  getErrorMessage,
} from "./lib/api";
import { Sun, Moon, Monitor, Settings2, X, Sparkles, Loader2, CheckCircle2, XCircle } from "lucide-react";

export default function App() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(1);

  const pushToast = useCallback((payload: ToastPayload) => {
    setToasts((prev) => [
      ...prev.slice(-3),
      {
        id: toastIdRef.current++,
        ...payload,
      },
    ]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const {
    providers,
    conversations,
    total,
    providerCounts,
    loading,
    activeProviders,
    toggleProvider,
    search,
    setSearch,
    sort,
    setSort,
    selectedId,
    selectConversation,
    conversation,
    loadingDetail,
    loadingEarlier,
    loadEarlierMessages,
    refresh,
    selectedIds,
    toggleSelect,
    selectAll,
    deselectAll,
    toggleSelectGroup,
    codexModelProviders,
    activeModelProviders,
    toggleModelProvider,
    codexModelProviderCounts,
    ensureModelProviderVisible,
    partialSearch,
    searchWarnings,
    reloadAllData,
    refreshConversation,
    applyLocalTitleChange,
    applyLocalMessageUpdate,
    applyLocalMessageDelete,
  } = useConversations({ onNotify: pushToast });

  const { theme, resolvedTheme, setTheme } = useTheme();

  const [exportOpen, setExportOpen] = useState(false);
  const [providerPathsOpen, setProviderPathsOpen] = useState(false);
  const [exportIds, setExportIds] = useState<string[]>([]);
  const [deleteConfirmIds, setDeleteConfirmIds] = useState<string[]>([]);

  const {
    batchGenerating,
    genProgress,
    handleBatchChangeModelProvider,
    handleBatchMove,
    handleBatchGenerate,
    handleAbortGenerate,
    closeGenProgress,
  } = useBatchActions({
    conversations,
    selectedIds,
    ensureModelProviderVisible,
    reloadAllData,
    pushToast,
  });

  // 单条导出
  const handleExport = useCallback((id: string) => {
    setExportIds([id]);
    setExportOpen(true);
  }, []);

  // 批量导出
  const handleBatchExport = useCallback(() => {
    if (selectedIds.size === 0) return;
    setExportIds([...selectedIds]);
    setExportOpen(true);
  }, [selectedIds]);

  const handleExportConfirm = useCallback(
    async (format: "json" | "markdown", mode: "full" | "partial") => {
      if (exportIds.length === 0) return;
      try {
        const { blob, meta } = await exportConversations(exportIds, format, mode);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const exportKind = mode === "partial" ? "partial" : "full";
        a.download = `chatlog-export-${exportKind}-${exportIds.length === 1 ? "1" : exportIds.length + "条"}.${format === "markdown" ? "md" : "json"}`;
        a.click();
        URL.revokeObjectURL(url);
        setExportOpen(false);

        if (meta?.mode === "partial") {
          pushToast({
            variant: meta.truncated > 0 ? "warning" : "info",
            title: `已完成 partial export：${meta.exported} 条`,
            description: meta.truncated > 0
              ? `仅导出最近 ${meta.messageLimit ?? 500} 条消息，其中 ${meta.truncated} 条对话被截断。`
              : `仅导出最近 ${meta.messageLimit ?? 500} 条消息，本次没有对话发生截断。`,
            duration: 7000,
          });
        }

        if (meta && meta.failed > 0) {
          const failurePreview = meta.failures
            .slice(0, 3)
            .map((item) => item.error)
            .join("\n");
          pushToast({
            variant: "warning",
            title: `导出部分成功：成功 ${meta.exported} 条，失败 ${meta.failed} 条`,
            description: failurePreview ? `失败示例：\n${failurePreview}` : undefined,
            duration: 8000,
          });
        }
      } catch (error) {
        pushToast({
          variant: "error",
          title: "导出失败",
          description: getErrorMessage(error, "导出失败"),
        });
      }
    },
    [exportIds, pushToast]
  );

  // 单条删除
  const handleDelete = useCallback((id: string) => {
    setDeleteConfirmIds([id]);
  }, []);

  // 批量删除
  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;
    setDeleteConfirmIds([...selectedIds]);
  }, [selectedIds]);

  const handleBatchDeleteEmpty = useCallback(() => {
    const targetIds = conversations
      .filter((item) => selectedIds.has(item.id) && item.cleanupCandidate)
      .map((item) => item.id);
    if (targetIds.length === 0) return;
    setDeleteConfirmIds(targetIds);
  }, [conversations, selectedIds]);

  const confirmDelete = useCallback(async () => {
    if (deleteConfirmIds.length === 0) return;
    try {
      const result = deleteConfirmIds.length === 1
        ? await (async () => {
            await deleteConversation(deleteConfirmIds[0]!);
            return { success: true, deleted: 1, failed: 0, failures: [] as Array<{ id: string; error: string }> };
          })()
        : await deleteConversations(deleteConfirmIds);

      deselectAll();
      setDeleteConfirmIds([]);
      await refresh();

      if (result.failed > 0) {
        const preview = result.failures
          .slice(0, 3)
          .map((item) => item.error)
          .join("\n");
        pushToast({
          variant: result.deleted > 0 ? "warning" : "error",
          title: result.deleted > 0
            ? `批量删除部分完成：成功 ${result.deleted} 条，失败 ${result.failed} 条`
            : "批量删除失败",
          description: preview || undefined,
          duration: 8000,
        });
      }
    } catch (error) {
      pushToast({
        variant: "error",
        title: "删除失败",
        description: getErrorMessage(error, "删除失败"),
      });
    }
  }, [deleteConfirmIds, refresh, deselectAll, pushToast]);

  // 拖拽移动对话到另一个文件夹
  const handleMoveConversation = useCallback(
    async (convId: string, targetProjectKey: string, srcProvider: string, targetProvider: string) => {
      // 只允许同 provider 内移动
      if (srcProvider !== targetProvider) {
        pushToast({
          variant: "warning",
          title: "不支持跨工具移动",
          description: `${srcProvider} → ${targetProvider}`,
        });
        return;
      }

      // 检查是否是同一个文件夹
      const conv = conversations.find((c) => c.id === convId);
      if (!conv || isSameProjectPath(conv.projectKey, targetProjectKey)) return;

      try {
        const res = await moveConversation(convId, targetProjectKey);
        if (res.success) {
          refresh();
        } else {
          pushToast({
            variant: "error",
            title: "移动失败",
            description: res.error,
          });
        }
      } catch (error) {
        pushToast({
          variant: "error",
          title: "移动失败",
          description: getErrorMessage(error, "移动失败"),
        });
      }
    },
    [conversations, refresh, pushToast]
  );

  // 修改 Codex 对话的 model_provider
  const handleChangeModelProvider = useCallback(
    async (id: string, newProvider: string) => {
      try {
        const res = await changeModelProvider(id, newProvider);
        if (res.success) {
          ensureModelProviderVisible(newProvider);
          await reloadAllData();
        } else {
          pushToast({
            variant: "error",
            title: "切换 provider 失败",
            description: res.error,
          });
        }
      } catch (error) {
        pushToast({
          variant: "error",
          title: "切换 provider 失败",
          description: getErrorMessage(error, "切换 provider 失败"),
        });
      }
    },
    [ensureModelProviderVisible, pushToast, reloadAllData]
  );

  const handleProviderPathsSaved = useCallback(async () => {
    await reloadAllData();
  }, [reloadAllData]);

  return (
    <div className="h-screen flex flex-col">
      {/* 顶部标题栏 */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-2.5 flex items-center justify-between flex-shrink-0">
        <h1 className="text-sm font-bold text-gray-800 dark:text-gray-100 tracking-wide">
          ChatLog Viewer
        </h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400 dark:text-gray-500">AI CLI 对话记录管理器</span>
          <button
            type="button"
            onClick={() => setProviderPathsOpen(true)}
            className="rounded-lg border border-gray-200 bg-white p-1.5 text-gray-500 transition hover:border-blue-300 hover:text-blue-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:border-blue-500 dark:hover:text-blue-300"
            title="Provider 路径设置"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <div className="flex items-center gap-0.5 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
            {([
              { key: "light" as const, icon: <Sun className="w-3.5 h-3.5" /> },
              { key: "system" as const, icon: <Monitor className="w-3.5 h-3.5" /> },
              { key: "dark" as const, icon: <Moon className="w-3.5 h-3.5" /> },
            ]).map(({ key, icon }) => (
              <button
                key={key}
                onClick={() => setTheme(key)}
                className={`p-1 rounded transition-colors ${
                  theme === key
                    ? "bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm"
                    : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                }`}
                title={key === "light" ? "浅色" : key === "dark" ? "深色" : "跟随系统"}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* 主体 */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          providers={providers}
          activeProviders={activeProviders}
          toggleProvider={toggleProvider}
          conversations={conversations}
          selectedId={selectedId}
          onSelect={selectConversation}
          search={search}
          onSearchChange={setSearch}
          sort={sort}
          onSortChange={setSort}
          loading={loading}
          total={total}
          providerCounts={providerCounts}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          onToggleSelectGroup={toggleSelectGroup}
          onBatchExport={handleBatchExport}
          onBatchDelete={handleBatchDelete}
          onBatchDeleteEmpty={handleBatchDeleteEmpty}
          onBatchGenerate={handleBatchGenerate}
          onBatchChangeModelProvider={handleBatchChangeModelProvider}
          onBatchMove={handleBatchMove}
          batchGenerating={batchGenerating}
          onMoveConversation={handleMoveConversation}
          codexModelProviders={codexModelProviders}
          codexModelProviderCounts={codexModelProviderCounts}
          activeModelProviders={activeModelProviders}
          onToggleModelProvider={toggleModelProvider}
          partialSearch={partialSearch}
          searchWarnings={searchWarnings}
        />
        <ConversationViewer
          key={conversation?.id ?? "empty"}
          conversation={conversation}
          dark={resolvedTheme === "dark"}
          loading={loadingDetail}
          loadingEarlier={loadingEarlier}
          onLoadEarlier={loadEarlierMessages}
          onExport={handleExport}
          onDelete={handleDelete}
          onTitleChanged={applyLocalTitleChange}
          onRefreshConversation={(id) => refreshConversation(id, { keepLoadedWindow: true, syncList: true, silent: true })}
          onMessageUpdated={applyLocalMessageUpdate}
          onMessagesDeleted={applyLocalMessageDelete}
          codexModelProviders={codexModelProviders}
          onChangeModelProvider={handleChangeModelProvider}
          onNotify={pushToast}
        />
      </div>

      {/* 导出弹窗 */}
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        count={exportIds.length}
        onConfirm={handleExportConfirm}
      />

      <ProviderPathsDialog
        open={providerPathsOpen}
        onClose={() => setProviderPathsOpen(false)}
        onSaved={handleProviderPathsSaved}
        onNotify={pushToast}
      />

      {/* 删除确认弹窗 */}
      {deleteConfirmIds.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-80 p-5">
            <h3 className="text-base font-semibold mb-2">确认删除</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              {deleteConfirmIds.length === 1
                ? "删除后无法恢复。若该记录底层已不存在，本次会自动清理残留项。"
                : `确定要删除或清理选中的 ${deleteConfirmIds.length} 条对话记录吗？此操作无法恢复。`}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirmIds([])}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
              >
                取消
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600"
              >
                删除{deleteConfirmIds.length > 1 ? ` (${deleteConfirmIds.length})` : ""}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 批量生成进度弹窗 */}
      {genProgress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-[420px] p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-500" />
                <h3 className="text-base font-semibold">批量生成标题</h3>
              </div>
              {!batchGenerating && (
                <button onClick={closeGenProgress} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* 进度条 */}
            <div className="mb-3">
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                <span>
                  {batchGenerating
                    ? `正在生成 ${genProgress.current}/${genProgress.total}...`
                    : `完成 ${genProgress.results.length}/${genProgress.total}`}
                </span>
                <span>{Math.round((genProgress.results.length / genProgress.total) * 100)}%</span>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                <div
                  className="bg-purple-500 h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${(genProgress.results.length / genProgress.total) * 100}%` }}
                />
              </div>
            </div>

            {/* 当前处理项 */}
            {batchGenerating && (
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 mb-3 px-1">
                <Loader2 className="w-3 h-3 animate-spin text-purple-500" />
                <span className="truncate">{genProgress.currentTitle}</span>
              </div>
            )}

            {/* 结果列表 */}
            <div className="max-h-48 overflow-y-auto space-y-1 mb-4">
              {genProgress.results.map((r, i) => (
                <div key={i} className="flex items-start gap-2 text-xs px-1 py-0.5">
                  {r.title ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                  )}
                  <span className={`truncate ${r.title ? "text-gray-700 dark:text-gray-300" : "text-red-500"}`}>
                    {r.title || r.error}
                  </span>
                </div>
              ))}
            </div>

            {/* 操作按钮 */}
            <div className="flex justify-end gap-2">
              {batchGenerating ? (
                <button
                  onClick={handleAbortGenerate}
                  className="px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                >
                  停止
                </button>
              ) : (
                <button
                  onClick={closeGenProgress}
                  className="px-4 py-2 text-sm bg-purple-500 text-white rounded-lg hover:bg-purple-600 transition-colors"
                >
                  完成
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
