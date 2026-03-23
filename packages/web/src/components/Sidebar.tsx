import { useMemo } from "react";
import { Search, SlidersHorizontal, Download, Trash2, CheckSquare, Sparkles } from "lucide-react";
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
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onToggleSelectGroup: (ids: string[]) => void;
  onBatchExport: () => void;
  onBatchDelete: () => void;
  onBatchGenerate: () => void;
  batchGenerating: boolean;
  onMoveConversation: (convId: string, targetProjectKey: string, srcProvider: string, targetProvider: string) => void;
  codexModelProviders: CodexModelProvider[];
  activeModelProviders: Set<string>;
  onToggleModelProvider: (name: string) => void;
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
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onDeselectAll,
  onToggleSelectGroup,
  onBatchExport,
  onBatchDelete,
  onBatchGenerate,
  batchGenerating,
  onMoveConversation,
  codexModelProviders,
  activeModelProviders,
  onToggleModelProvider,
}: SidebarProps) {
  const allChecked = conversations.length > 0 && selectedIds.size === conversations.length;

  const providerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const conv of conversations) {
      counts.set(conv.provider, (counts.get(conv.provider) ?? 0) + 1);
    }
    return counts;
  }, [conversations]);

  const codexProviderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const conv of conversations) {
      if (conv.provider !== "codex" || !conv.modelProvider) continue;
      counts.set(conv.modelProvider, (counts.get(conv.modelProvider) ?? 0) + 1);
    }
    return counts;
  }, [conversations]);

  const footerText = useMemo(() => {
    const parts = providers
      .filter((p) => p.available && activeProviders.has(p.name))
      .map((p) => {
        const count = providerCounts.get(p.name) ?? 0;
        return count > 0 ? `${p.displayName}: ${count}` : "";
      })
      .filter(Boolean);

    return parts.length > 0 ? `共 ${total} 条对话 | ${parts.join(" | ")}` : `共 ${total} 条对话`;
  }, [activeProviders, providerCounts, providers, total]);

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
            <option value="provider">按工具分组</option>
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
              {p.displayName}
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
                  <span className="ml-0.5 opacity-60">{codexProviderCounts.get(mp.name) ?? 0}</span>
                </button>
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
        <div className="p-2 border-t border-gray-200 dark:border-gray-700 bg-blue-50 dark:bg-blue-900/30 flex items-center justify-between">
          <span className="text-xs text-blue-700 dark:text-blue-300 font-medium">
            已选 {selectedIds.size} 条
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onBatchGenerate}
              disabled={batchGenerating}
              className="flex items-center gap-1 px-2.5 py-1 text-xs bg-purple-500 text-white rounded hover:bg-purple-600 disabled:opacity-50 transition-colors"
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
