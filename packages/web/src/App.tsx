import { useState, useCallback, useRef } from "react";
import { useConversations } from "./hooks/useConversations";
import { useTheme } from "./hooks/useTheme";
import { Sidebar } from "./components/Sidebar";
import { ConversationViewer } from "./components/ConversationViewer";
import { ExportDialog } from "./components/ExportDialog";
import { exportConversations, deleteConversation, generateAiTitle, moveConversation } from "./lib/api";
import { Sun, Moon, Monitor, X, Sparkles, Loader2, CheckCircle2, XCircle } from "lucide-react";

interface GenProgress {
  total: number;
  current: number;
  currentTitle: string;
  results: { id: string; title?: string; error?: string }[];
}

export default function App() {
  const {
    providers,
    conversations,
    total,
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
    refresh,
    selectedIds,
    toggleSelect,
    selectAll,
    deselectAll,
    toggleSelectGroup,
  } = useConversations();

  const { theme, setTheme } = useTheme();

  const [exportOpen, setExportOpen] = useState(false);
  const [exportIds, setExportIds] = useState<string[]>([]);
  const [deleteConfirmIds, setDeleteConfirmIds] = useState<string[]>([]);

  // 批量生成状态
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState<GenProgress | null>(null);
  const abortRef = useRef(false);

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
    async (format: "json" | "markdown") => {
      if (exportIds.length === 0) return;
      try {
        const blob = await exportConversations(exportIds, format);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `chatlog-export-${exportIds.length === 1 ? "1" : exportIds.length + "条"}.${format === "markdown" ? "md" : "json"}`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error("导出失败:", e);
      }
      setExportOpen(false);
    },
    [exportIds]
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

  const confirmDelete = useCallback(async () => {
    if (deleteConfirmIds.length === 0) return;
    try {
      for (const id of deleteConfirmIds) {
        await deleteConversation(id);
      }
      deselectAll();
      refresh();
    } catch (e) {
      console.error("删除失败:", e);
    }
    setDeleteConfirmIds([]);
  }, [deleteConfirmIds, refresh, deselectAll]);

  // 标题更新后同步刷新列表和详情
  const handleTitleChanged = useCallback(
    (id: string, newTitle: string) => {
      refresh();
      if (conversation && conversation.id === id) {
        conversation.title = newTitle;
      }
    },
    [refresh, conversation]
  );

  // 拖拽移动对话到另一个文件夹
  const handleMoveConversation = useCallback(
    async (convId: string, targetProjectKey: string, srcProvider: string, targetProvider: string) => {
      // 只允许同 provider 内移动
      if (srcProvider !== targetProvider) {
        alert(`不支持跨工具移动（${srcProvider} → ${targetProvider}）`);
        return;
      }

      // 检查是否是同一个文件夹
      const conv = conversations.find((c) => c.id === convId);
      if (!conv || conv.projectKey === targetProjectKey) return;

      try {
        const res = await moveConversation(convId, targetProjectKey);
        if (res.success) {
          refresh();
        } else {
          alert(`移动失败: ${res.error}`);
        }
      } catch (e) {
        console.error("移动失败:", e);
      }
    },
    [conversations, refresh]
  );

  // 批量 AI 生成标题
  const handleBatchGenerate = useCallback(async () => {
    if (selectedIds.size === 0 || batchGenerating) return;
    const ids = [...selectedIds];
    setBatchGenerating(true);
    abortRef.current = false;
    setGenProgress({ total: ids.length, current: 0, currentTitle: "", results: [] });

    const results: GenProgress["results"] = [];
    for (let i = 0; i < ids.length; i++) {
      if (abortRef.current) break;

      const id = ids[i];
      const conv = conversations.find((c) => c.id === id);
      setGenProgress((prev) => ({
        ...prev!,
        current: i + 1,
        currentTitle: conv?.title || id,
      }));

      try {
        const res = await generateAiTitle(id);
        if (res.success) {
          results.push({ id, title: res.title });
        } else {
          results.push({ id, error: res.error || "未知错误" });
        }
      } catch {
        results.push({ id, error: "请求失败" });
      }
      setGenProgress((prev) => ({ ...prev!, results: [...results] }));
    }

    refresh();
    setBatchGenerating(false);
  }, [selectedIds, batchGenerating, conversations, refresh]);

  const handleAbortGenerate = useCallback(() => {
    abortRef.current = true;
  }, []);

  const closeGenProgress = useCallback(() => {
    setGenProgress(null);
  }, []);

  return (
    <div className="h-screen flex flex-col">
      {/* 顶部标题栏 */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-2.5 flex items-center justify-between flex-shrink-0">
        <h1 className="text-sm font-bold text-gray-800 dark:text-gray-100 tracking-wide">
          ChatLog Viewer
        </h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400 dark:text-gray-500">AI CLI 对话记录管理器</span>
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
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          onToggleSelectGroup={toggleSelectGroup}
          onBatchExport={handleBatchExport}
          onBatchDelete={handleBatchDelete}
          onBatchGenerate={handleBatchGenerate}
          batchGenerating={batchGenerating}
          onMoveConversation={handleMoveConversation}
        />
        <ConversationViewer
          conversation={conversation}
          loading={loadingDetail}
          onExport={handleExport}
          onDelete={handleDelete}
          onTitleChanged={handleTitleChanged}
        />
      </div>

      {/* 导出弹窗 */}
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        onConfirm={handleExportConfirm}
      />

      {/* 删除确认弹窗 */}
      {deleteConfirmIds.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-80 p-5">
            <h3 className="text-base font-semibold mb-2">确认删除</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              {deleteConfirmIds.length === 1
                ? "删除后无法恢复，确定要删除这个对话吗？"
                : `确定要删除选中的 ${deleteConfirmIds.length} 条对话吗？此操作无法恢复。`}
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
    </div>
  );
}
