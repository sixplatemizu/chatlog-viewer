import { useState } from "react";
import { MessageSquare, FolderOpen, ChevronDown, ChevronRight } from "lucide-react";
import type { ConversationMeta } from "../lib/api";

const PROVIDER_BADGE: Record<string, string> = {
  "claude-code": "bg-orange-500",
  codex: "bg-green-500",
  iflow: "bg-blue-500",
  "gemini-cli": "bg-purple-500",
  opencode: "bg-cyan-500",
};

interface Props {
  conversations: ConversationMeta[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectGroup: (ids: string[]) => void;
  onDrop: (convId: string, targetProjectKey: string, sourceProvider: string, targetProvider: string) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - ts;

  if (diff < 86400000 && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  if (diff < 604800000) {
    const days = ["日", "一", "二", "三", "四", "五", "六"];
    return `周${days[d.getDay()]}`;
  }
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function getProjectDisplayName(project: string): string {
  const parts = project.split("/").filter(Boolean);
  if (parts.length <= 1) return project || "未知目录";
  return parts.slice(-2).join("/");
}

function groupByProject(conversations: ConversationMeta[]) {
  const groups = new Map<string, { displayPath: string; provider: string; projectKey: string; convos: ConversationMeta[] }>();
  for (const conv of conversations) {
    const pk = conv.projectKey || conv.project || "未知目录";
    // 用 provider + projectKey 做 key，避免不同 provider 同路径合并
    const key = `${conv.provider}::${pk}`;
    if (!groups.has(key)) {
      groups.set(key, { displayPath: conv.project || pk, provider: conv.provider, projectKey: pk, convos: [] });
    }
    groups.get(key)!.convos.push(conv);
  }
  return [...groups.entries()].sort((a, b) => {
    const aMax = Math.max(...a[1].convos.map((c) => c.updatedAt));
    const bMax = Math.max(...b[1].convos.map((c) => c.updatedAt));
    return bMax - aMax;
  });
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  loading,
  selectedIds,
  onToggleSelect,
  onToggleSelectGroup,
  onDrop,
}: Props) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-gray-400">
        <MessageSquare className="w-8 h-8 mb-2" />
        <span className="text-sm">暂无对话记录</span>
      </div>
    );
  }

  const groups = groupByProject(conversations);
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleDragStart = (e: React.DragEvent, convId: string, provider: string) => {
    e.dataTransfer.setData("application/x-conv-id", convId);
    e.dataTransfer.setData("application/x-conv-provider", provider);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, key: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverKey(key);
  };

  const handleDragLeave = () => {
    setDragOverKey(null);
  };

  const handleDrop = (e: React.DragEvent, targetKey: string, targetProvider: string, targetProjectKey: string) => {
    e.preventDefault();
    setDragOverKey(null);
    const convId = e.dataTransfer.getData("application/x-conv-id");
    const srcProvider = e.dataTransfer.getData("application/x-conv-provider");
    if (convId) onDrop(convId, targetProjectKey, srcProvider, targetProvider);
  };

  return (
    <div>
      {groups.map(([key, { displayPath, provider: groupProvider, projectKey: groupPk, convos }]) => {
        const collapsed = collapsedGroups.has(key);
        const displayName = getProjectDisplayName(displayPath);
        const hasSelected = convos.some((c) => c.id === selectedId);
        const groupIds = convos.map((c) => c.id);
        const allChecked = groupIds.every((id) => selectedIds.has(id));
        const someChecked = !allChecked && groupIds.some((id) => selectedIds.has(id));
        const isDragTarget = dragOverKey === key;

        return (
          <div key={key}>
            {/* 文件夹组头 — 拖放目标 */}
            <div
              className={`flex items-center gap-1 px-3 py-1.5 bg-gray-100/80 dark:bg-gray-700/60 border-b border-gray-200 dark:border-gray-600 sticky top-0 z-10 transition-colors ${
                hasSelected && collapsed ? "!bg-blue-50 dark:!bg-blue-900/20" : ""
              } ${isDragTarget ? "!bg-blue-100 dark:!bg-blue-800/40 ring-2 ring-blue-400 ring-inset" : ""}`}
              onDragOver={(e) => handleDragOver(e, key)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, key, groupProvider, groupPk)}
            >
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => { if (el) el.indeterminate = someChecked; }}
                onChange={() => onToggleSelectGroup(groupIds)}
                className="w-3.5 h-3.5 rounded accent-blue-500 cursor-pointer flex-shrink-0"
                onClick={(e) => e.stopPropagation()}
              />
              <button
                onClick={() => toggleGroup(key)}
                className="flex items-center gap-1 flex-1 min-w-0 hover:bg-gray-100 dark:hover:bg-gray-700 rounded px-1 transition-colors"
                title={displayPath}
              >
                {collapsed ? (
                  <ChevronRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
                ) : (
                  <ChevronDown className="w-3 h-3 text-gray-400 flex-shrink-0" />
                )}
                <FolderOpen className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                <span className="text-xs font-medium text-gray-600 dark:text-gray-300 truncate">
                  {displayName}
                </span>
                <span className="text-xs text-gray-400 ml-auto flex-shrink-0">
                  {convos.length}
                </span>
              </button>
            </div>

            {/* 对话列表 — 可拖拽 */}
            {!collapsed && (
              <div className="divide-y divide-gray-50 dark:divide-gray-700/50">
                {convos.map((conv) => {
                  const checked = selectedIds.has(conv.id);
                  return (
                    <div
                      key={conv.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, conv.id, conv.provider)}
                      className={`flex items-start gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors cursor-grab active:cursor-grabbing ${
                        selectedId === conv.id
                          ? "bg-blue-50 dark:bg-blue-900/20 border-r-2 border-blue-500"
                          : ""
                      } ${checked && selectedId !== conv.id ? "bg-blue-50/50 dark:bg-blue-900/10" : ""}`}
                      onClick={() => onSelect(conv.id)}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggleSelect(conv.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="w-3.5 h-3.5 mt-1 rounded accent-blue-500 cursor-pointer flex-shrink-0"
                      />
                      <div
                        className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${
                          PROVIDER_BADGE[conv.provider] || "bg-gray-400"
                        }`}
                        title={conv.provider}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-gray-900 dark:text-gray-100 truncate">
                          {conv.title}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-gray-400">
                            {conv.messageCount} 条
                          </span>
                        </div>
                      </div>
                      <span className="text-xs text-gray-400 flex-shrink-0">
                        {formatTime(conv.updatedAt)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
