import { useMemo, useState } from "react";
import { Search, SlidersHorizontal, Download, Trash2, CheckSquare, Sparkles, ArrowRightLeft } from "lucide-react";
import type { ProviderInfo, ConversationMeta, CodexModelProvider } from "../lib/api";
import { ConversationList } from "./ConversationList";

const PROVIDER_COLORS: Record<string, string> = {
  "claude-code": "bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700",
  codex: "bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700",
  iflow: "bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700",
  "gemini-cli": "bg-purple-100 text-purple-800 border-purple-300 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700",
  opencode: "bg-cyan-100 text-cyan-800 border-cyan-300 dark:bg-cyan-900/30 dark:text-cyan-300 dark:border-cyan-700",
};

interface SidebarProps {
  providers: ProviderInfo[];
  activeProviders: Set<string>;
  toggleProvider: (name: string) => void;
  conversations: ConversationMeta[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  sort: string;
  onSortChange: (value: string) => void;
  loading: boolean;
  total: number;
  providerCounts: Record<string, number>;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onToggleSelectGroup: (ids: string[]) => void;
  onBatchExport: () => void;
  onBatchDelete: () => void;
  onBatchDeleteEmpty: () => void;
  onBatchGenerate: () => void;
  onBatchChangeModelProvider: (modelProvider: string) => void;
  batchGenerating: boolean;
  onMoveConversation: (convId: string, targetProjectKey: string, srcProvider: string, targetProvider: string) => void;
  codexModelProviders: CodexModelProvider[];
  codexModelProviderCounts: Record<string, number>;
  activeModelProviders: Set<string>;
  onToggleModelProvider: (name: string) => void;
  partialSearch: boolean;
  searchWarnings: string[];
}

export function Sidebar({
  providers,
  activeProviders,
  toggleProvider,
  conversations,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  sort,
  onSortChange,
  loading,
  total,
  providerCounts,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onDeselectAll,
  onToggleSelectGroup,
  onBatchExport,
  onBatchDelete,
  onBatchDeleteEmpty,
  onBatchGenerate,
  onBatchChangeModelProvider,
  batchGenerating,
  onMoveConversation,
  codexModelProviders,
  codexModelProviderCounts,
  activeModelProviders,
  onToggleModelProvider,
  partialSearch,
  searchWarnings,
}: SidebarProps) {
  const allChecked = conversations.length > 0 && selectedIds.size === conversations.length;
  const [batchModelProviderOverride, setBatchModelProviderOverride] = useState("");

  const footerText = useMemo(() => {
    const parts = providers
      .filter((p) => p.available && activeProviders.has(p.name))
      .map((p) => {
        const count = providerCounts[p.name] ?? 0;
        return count > 0 ? `${p.displayName}: ${count}` : "";
      })
      .filter(Boolean);

    return parts.length > 0 ? `共 ${total} 条对话 | ${parts.join(" | ")}` : `共 ${total} 条对话`;
  }, [activeProviders, providerCounts, providers, total]);

  const selectedConversations = useMemo(
    () => conversations.filter((item) => selectedIds.has(item.id)),
    [conversations, selectedIds]
  );
  const unsupportedBatchTitleConversations = useMemo(
    () => selectedConversations.filter((item) => item.capabilities?.canGenerateTitle === false),
    [selectedConversations]
  );
  const cleanupOnlySelectedConversations = useMemo(
    () => selectedConversations.filter((item) => item.cleanupCandidate),
    [selectedConversations]
  );
  const batchTitleGenerationSupported = selectedConversations.length > 0 && unsupportedBatchTitleConversations.length === 0;
  const batchTitleGenerationDisabledReason = unsupportedBatchTitleConversations[0]?.capabilities?.generateTitleDisabledReason;

  const hasSelectedNonCodexConversation = useMemo(
    () => selectedConversations.some((item) => item.provider !== "codex"),
    [selectedConversations]
  );

  const selectedCodexModelProviders = useMemo(
    () => [...new Set(
      selectedConversations
        .filter((item) => item.provider === "codex")
        .map((item) => item.modelProvider)
        .filter((item): item is string => !!item)
    )],
    [selectedConversations]
  );

  const batchModelProviderSupported = selectedConversations.length > 0
    && !hasSelectedNonCodexConversation
    && codexModelProviders.length > 0;

  const preferredBatchModelProvider = useMemo(() => {
    if (codexModelProviders.length === 0) return "";
    if (selectedCodexModelProviders.length === 1) {
      const currentProvider = selectedCodexModelProviders[0];
      return codexModelProviders.find((item) => item.name !== currentProvider)?.name ?? currentProvider;
    }
    return codexModelProviders[0]?.name ?? "";
  }, [codexModelProviders, selectedCodexModelProviders]);

  const batchModelProvider = useMemo(() => {
    if (!batchModelProviderSupported) return "";
    if (
      batchModelProviderOverride
      && codexModelProviders.some((item) => item.name === batchModelProviderOverride)
    ) {
      return batchModelProviderOverride;
    }
    return preferredBatchModelProvider;
  }, [
    batchModelProviderOverride,
    batchModelProviderSupported,
    codexModelProviders,
    preferredBatchModelProvider,
  ]);

  return (
    <div className="w-80 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex flex-col h-full">
      <div className="p-3 border-b border-gray-200 dark:border-gray-700">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="搜索对话..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <div className="flex items-center gap-2 mt-2">
          <SlidersHorizontal className="w-3.5 h-3.5 text-gray-400" />
          <select
            value={sort}
            onChange={(e) => onSortChange(e.target.value)}
            className="text-xs text-gray-600 dark:text-gray-400 bg-transparent border-none focus:outline-none cursor-pointer"
          >
            <option value="updatedAt">最近更新</option>
            <option value="createdAt">创建时间</option>
            <option value="provider">工具优先</option>
          </select>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={allChecked ? onDeselectAll : onSelectAll}
              className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
              title={allChecked ? "取消全选" : "全选"}
            >
              <CheckSquare className="w-3.5 h-3.5" />
              {allChecked ? "取消" : "全选"}
            </button>
          </div>
        </div>
      </div>

      <div className="p-3 border-b border-gray-200 dark:border-gray-700">
        <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">工具筛选</div>
        <div className="flex flex-wrap gap-1.5">
          {providers.map((p) => (
            <button
              key={p.name}
              onClick={() => p.available && toggleProvider(p.name)}
              disabled={!p.available}
              className={`
                text-xs px-2.5 py-1 rounded-full border transition-all
                ${
                  !p.available
                    ? "opacity-40 cursor-not-allowed bg-gray-50 dark:bg-gray-700 text-gray-400 border-gray-200 dark:border-gray-600"
                    : activeProviders.has(p.name)
                    ? PROVIDER_COLORS[p.name] || "bg-gray-100 text-gray-800 border-gray-300"
                    : "bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600"
                }
              `}
            >
              <span>{p.displayName}</span>
              <span className="ml-1 opacity-70">{providerCounts[p.name] ?? 0}</span>
            </button>
          ))}
        </div>

        {activeProviders.has("codex") && codexModelProviders.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-600">
            <div className="text-[10px] text-gray-400 dark:text-gray-500 mb-1.5">Codex Provider</div>
            <div className="flex flex-wrap gap-1">
              {codexModelProviders.map((mp) => (
                <button
                  key={mp.name}
                  onClick={() => onToggleModelProvider(mp.name)}
                  className={`
                    text-[10px] px-2 py-0.5 rounded-full border transition-all
                    ${
                      activeModelProviders.has(mp.name)
                        ? "bg-green-50 text-green-700 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700"
                        : "bg-gray-50 dark:bg-gray-700 text-gray-400 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600"
                    }
                  `}
                >
                  {mp.name}
                  <span className="ml-0.5 opacity-60">{codexModelProviderCounts[mp.name] ?? mp.count ?? 0}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {partialSearch && searchWarnings.length > 0 && (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <div className="font-medium">当前搜索结果可能不完整</div>
            <div className="mt-1 space-y-0.5">
              {searchWarnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <ConversationList
          conversations={conversations}
          selectedId={selectedId}
          onSelect={onSelect}
          loading={loading}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onToggleSelectGroup={onToggleSelectGroup}
          onDrop={onMoveConversation}
        />
      </div>

      {selectedIds.size > 0 ? (
        <div className="p-2 border-t border-gray-200 dark:border-gray-700 bg-blue-50 dark:bg-blue-900/30">
          <div className="flex items-center justify-between">
            <span className="text-xs text-blue-700 dark:text-blue-300 font-medium">
              已选 {selectedIds.size} 条
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={onBatchGenerate}
                disabled={batchGenerating || !batchTitleGenerationSupported}
                className="flex items-center gap-1 px-2.5 py-1 text-xs bg-purple-500 text-white rounded hover:bg-purple-600 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-600 disabled:hover:bg-gray-300 dark:disabled:bg-gray-600 dark:disabled:text-gray-300 transition-colors"
              >
                <Sparkles className="w-3 h-3" />
                AI 标题
              </button>
              <button
                onClick={onBatchExport}
                className="flex items-center gap-1 px-2.5 py-1 text-xs bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
              >
                <Download className="w-3 h-3" />
                导出
              </button>
              {cleanupOnlySelectedConversations.length > 0 && (
                <button
                  onClick={onBatchDeleteEmpty}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs bg-amber-500 text-white rounded hover:bg-amber-600 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  清理残留
                </button>
              )}
              <button
                onClick={onBatchDelete}
                className="flex items-center gap-1 px-2.5 py-1 text-xs bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
              >
                <Trash2 className="w-3 h-3" />
                删除
              </button>
              <button
                onClick={onDeselectAll}
                className="px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
              >
                取消
              </button>
            </div>
          </div>

          {cleanupOnlySelectedConversations.length > 0 && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              已选 {cleanupOnlySelectedConversations.length} 条残留记录，可直接一键清理。
            </div>
          )}

          {unsupportedBatchTitleConversations.length > 0 && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {batchTitleGenerationDisabledReason ?? "当前选择包含不支持标题生成的对话，批量标题修改已禁用"}
            </div>
          )}

          {batchModelProviderSupported && (
            <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white/80 px-2 py-2 dark:border-blue-800 dark:bg-gray-800/80">
              <ArrowRightLeft className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
              <select
                aria-label="批量切换 Codex provider"
                value={batchModelProvider}
                onChange={(e) => setBatchModelProviderOverride(e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-green-200 bg-green-50 px-2 py-1 text-xs text-green-700 outline-none transition focus:ring-2 focus:ring-green-400 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300"
              >
                {codexModelProviders.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => onBatchChangeModelProvider(batchModelProvider)}
                disabled={!batchModelProvider}
                className="rounded-md bg-green-600 px-2.5 py-1 text-xs text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                切换 Provider
              </button>
            </div>
          )}

          {!batchModelProviderSupported && hasSelectedNonCodexConversation && (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              批量 provider 切换目前仅支持 Codex 对话
            </div>
          )}
        </div>
      ) : (
        <div className="p-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <div className="text-xs text-gray-500 dark:text-gray-400 text-center">
            {footerText}
          </div>
        </div>
      )}
    </div>
  );
}
