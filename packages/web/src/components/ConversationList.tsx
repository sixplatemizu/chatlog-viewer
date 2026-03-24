import { memo, useMemo, useState } from "react";
import { GroupedVirtuoso } from "react-virtuoso";
import { MessageSquare, FolderOpen, ChevronDown, ChevronRight } from "lucide-react";
import type { ConversationMeta } from "../lib/api";
import {
  canonicalizeProjectPath,
  getDisambiguatedProjectName,
  getProjectPathHint,
  normalizeProjectPath,
} from "../lib/project";

const PROVIDER_BADGE: Record<string, string> = {
  "claude-code": "bg-orange-500",
  codex: "bg-green-500",
  iflow: "bg-blue-500",
  "gemini-cli": "bg-purple-500",
  opencode: "bg-cyan-500",
};

const FOLDER_COLOR: Record<string, string> = {
  "claude-code": "text-orange-400",
  codex: "text-green-400",
  iflow: "text-blue-400",
  "gemini-cli": "text-purple-400",
  opencode: "text-cyan-400",
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

interface ConversationGroup {
  key: string;
  displayPath: string;
  provider: string;
  projectKey: string;
  conversations: ConversationMeta[];
  ids: string[];
}

interface FlattenedListModel {
  groups: ConversationGroup[];
  groupCounts: number[];
  visibleConversations: ConversationMeta[];
  startIndexByGroup: number[];
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

function getProjectDisplayScore(project: string, projectKey: string): number {
  const normalized = canonicalizeProjectPath(project || "");
  if (!normalized || normalized === projectKey) return 0;

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return 0;
  if (parts.length === 3 && /^[A-Za-z]:$/.test(parts[0]) && parts[1] === "Users") {
    return 1;
  }
  return parts.length + 10;
}

function pickBetterDisplayPath(current: string, candidate: string, projectKey: string): string {
  if (!current) return candidate || projectKey;
  if (!candidate) return current;

  const currentScore = getProjectDisplayScore(current, projectKey);
  const candidateScore = getProjectDisplayScore(candidate, projectKey);

  if (candidateScore > currentScore) return candidate;
  if (candidateScore === currentScore && candidate.length > current.length) return candidate;
  return current;
}

function groupByProject(conversations: ConversationMeta[]): ConversationGroup[] {
  const groups = new Map<string, ConversationGroup>();

  for (const conv of conversations) {
    const rawProjectKey = conv.projectKey || conv.project || "未知目录";
    const projectKey = canonicalizeProjectPath(rawProjectKey) || rawProjectKey;
    const key = `${conv.provider}::${projectKey}`;
    let group = groups.get(key);

    if (!group) {
      group = {
        key,
        displayPath: normalizeProjectPath(conv.project || rawProjectKey),
        provider: conv.provider,
        projectKey,
        conversations: [],
        ids: [],
      };
      groups.set(key, group);
    } else {
      group.displayPath = pickBetterDisplayPath(group.displayPath, conv.project || projectKey, projectKey);
    }

    group.conversations.push(conv);
    group.ids.push(conv.id);
  }

  return [...groups.values()];
}

function buildFlattenedListModel(groups: ConversationGroup[], collapsedGroups: Set<string>): FlattenedListModel {
  const groupCounts: number[] = [];
  const visibleConversations: ConversationMeta[] = [];
  const startIndexByGroup: number[] = [];
  let cursor = 0;

  for (const group of groups) {
    startIndexByGroup.push(cursor);
    const count = collapsedGroups.has(group.key) ? 0 : group.conversations.length;
    groupCounts.push(count);
    if (count > 0) {
      visibleConversations.push(...group.conversations);
      cursor += count;
    }
  }

  return {
    groups,
    groupCounts,
    visibleConversations,
    startIndexByGroup,
  };
}

const ConversationRow = memo(function ConversationRow({
  conv,
  checked,
  selected,
  onSelect,
  onToggleSelect,
}: {
  conv: ConversationMeta;
  checked: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggleSelect: (id: string) => void;
}) {
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData("application/x-conv-id", conv.id);
    e.dataTransfer.setData("application/x-conv-provider", conv.provider);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      className={`flex items-start gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors cursor-grab active:cursor-grabbing ${
        selected
          ? "bg-blue-50 dark:bg-blue-900/20 border-r-2 border-blue-500"
          : ""
      } ${checked && !selected ? "bg-blue-50/50 dark:bg-blue-900/10" : ""}`}
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
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-gray-900 dark:text-gray-100 truncate">
            {conv.title}
          </span>
          {conv.provider === "codex" && conv.modelProvider && (
            <span className="text-[9px] px-1.5 py-0 rounded-full bg-green-50 text-green-600 border border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-700 flex-shrink-0 leading-4">
              {conv.modelProvider}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-gray-400">
            {conv.messageCount} 条
          </span>
          <span className="text-xs text-gray-300 dark:text-gray-600">·</span>
          <span className="text-xs text-gray-400">
            {formatFileSize(conv.fileSize)}
          </span>
        </div>
      </div>
      <span className="text-xs text-gray-400 flex-shrink-0">
        {formatTime(conv.updatedAt)}
      </span>
    </div>
  );
});

export const ConversationList = memo(function ConversationList({
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

  const groups = useMemo(() => groupByProject(conversations), [conversations]);
  const groupSelectionState = useMemo(() => {
    const selectedCountByGroup = new Map<string, number>();

    for (const group of groups) {
      let selectedCount = 0;
      for (const id of group.ids) {
        if (selectedIds.has(id)) {
          selectedCount++;
        }
      }
      selectedCountByGroup.set(group.key, selectedCount);
    }

    return selectedCountByGroup;
  }, [groups, selectedIds]);
  const listModel = useMemo(
    () => buildFlattenedListModel(groups, collapsedGroups),
    [groups, collapsedGroups]
  );

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

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
    <GroupedVirtuoso
      className="h-full"
      groupCounts={listModel.groupCounts}
      increaseViewportBy={{ top: 400, bottom: 800 }}
      groupContent={(groupIndex) => {
        const group = listModel.groups[groupIndex];
        const collapsed = collapsedGroups.has(group.key);
        const displayName = getDisambiguatedProjectName(
          group.displayPath,
          group.projectKey,
          groups
            .filter((item) => item.key !== group.key)
            .map((item) => ({ project: item.displayPath, projectKey: item.projectKey }))
        );
        const hasSelected = selectedId ? group.ids.includes(selectedId) : false;
        const selectedCount = groupSelectionState.get(group.key) ?? 0;
        const allChecked = selectedCount > 0 && selectedCount === group.ids.length;
        const someChecked = selectedCount > 0 && selectedCount < group.ids.length;
        const isDragTarget = dragOverKey === group.key;

        return (
          <div
            className={`flex items-center gap-1 px-3 py-1.5 bg-gray-100/80 dark:bg-gray-700/60 border-b border-gray-200 dark:border-gray-600 sticky top-0 z-10 transition-colors ${
              hasSelected && collapsed ? "!bg-blue-50 dark:!bg-blue-900/20" : ""
            } ${isDragTarget ? "!bg-blue-100 dark:!bg-blue-800/40 ring-2 ring-blue-400 ring-inset" : ""}`}
            onDragOver={(e) => handleDragOver(e, group.key)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, group.key, group.provider, group.projectKey)}
          >
            <input
              type="checkbox"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = someChecked;
              }}
              onChange={() => onToggleSelectGroup(group.ids)}
              className="w-3.5 h-3.5 rounded accent-blue-500 cursor-pointer flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              onClick={() => toggleGroup(group.key)}
              className="flex items-center gap-1 flex-1 min-w-0 hover:bg-gray-100 dark:hover:bg-gray-700 rounded px-1 transition-colors"
              title={getProjectPathHint(group.displayPath, group.projectKey)}
            >
              {collapsed ? (
                <ChevronRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
              ) : (
                <ChevronDown className="w-3 h-3 text-gray-400 flex-shrink-0" />
              )}
              <FolderOpen className={`w-3.5 h-3.5 flex-shrink-0 ${FOLDER_COLOR[group.provider] || "text-amber-500"}`} />
              <span className="text-xs font-medium text-gray-600 dark:text-gray-300 truncate">
                {displayName}
              </span>
              <span className="text-xs text-gray-400 ml-auto flex-shrink-0">
                {group.conversations.length}
              </span>
            </button>
          </div>
        );
      }}
      itemContent={(index) => {
        const conv = listModel.visibleConversations[index];
        if (!conv) return null;

        return (
          <div className="border-b border-gray-50 dark:border-gray-700/50">
            <ConversationRow
              conv={conv}
              checked={selectedIds.has(conv.id)}
              selected={selectedId === conv.id}
              onSelect={onSelect}
              onToggleSelect={onToggleSelect}
            />
          </div>
        );
      }}
    />
  );
});
