import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  ChevronDown,
  ChevronRight,
  Wrench,
  User,
  Bot,
  Cpu,
  Pencil,
  Trash2,
  Check,
  X,
  Loader2,
} from "lucide-react";
import type { Message } from "../lib/api";
import { CodeBlock } from "./CodeBlock";

const LARGE_MESSAGE_CHAR_THRESHOLD = 16_000;
const LARGE_MESSAGE_LINE_THRESHOLD = 220;
const MESSAGE_PREVIEW_LINES = 24;

interface Props {
  message: Message;
  dark: boolean;
  onUpdateMessage?: (messageId: string, content: string) => void | Promise<void>;
  onDeleteMessage?: (messageId: string) => void | Promise<void>;
  selectionMode?: boolean;
  selected?: boolean;
  selectable?: boolean;
  onToggleSelect?: (messageId: string) => void;
}

function getLineCount(text: string): number {
  return text.split(/\r?\n/).length;
}

function buildTextPreview(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return text;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n\n...`;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  dark,
  onUpdateMessage,
  onDeleteMessage,
  selectionMode = false,
  selected = false,
  selectable = false,
  onToggleSelect,
}: Props) {
  const [toolExpanded, setToolExpanded] = useState(false);
  const contentLineCount = getLineCount(message.content);
  const isLargeMessage = message.content.length > LARGE_MESSAGE_CHAR_THRESHOLD
    || contentLineCount > LARGE_MESSAGE_LINE_THRESHOLD;
  const [contentExpanded, setContentExpanded] = useState(!isLargeMessage);
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(message.content);
  const [pending, setPending] = useState(false);
  const contentPreview = isLargeMessage
    ? buildTextPreview(message.content, MESSAGE_PREVIEW_LINES)
    : message.content;
  const canEdit = !!message.editable && !!message.messageId && !!onUpdateMessage;
  const canDelete = !!message.deletable && !!message.messageId && !!onDeleteMessage;

  useEffect(() => {
    setDraftContent(message.content);
    setEditing(false);
    setPending(false);
  }, [message.content, message.messageId]);

  useEffect(() => {
    if (!selectionMode) return;
    setEditing(false);
    setDraftContent(message.content);
  }, [selectionMode, message.content]);

  const ROLE_STYLES: Record<string, { bg: string; icon: React.ReactNode; label: string }> = {
    user: {
      bg: "bg-white dark:bg-gray-900",
      icon: <User className="w-4 h-4" />,
      label: "用户",
    },
    assistant: {
      bg: "bg-gray-50 dark:bg-gray-800/50",
      icon: <Bot className="w-4 h-4" />,
      label: "助手",
    },
    system: {
      bg: "bg-yellow-50 dark:bg-yellow-900/20",
      icon: <Cpu className="w-4 h-4" />,
      label: "系统",
    },
    tool: {
      bg: "bg-slate-50 dark:bg-slate-800/50",
      icon: <Wrench className="w-3.5 h-3.5" />,
      label: "工具",
    },
  };

  const style = ROLE_STYLES[message.role] || ROLE_STYLES.system;

  const handleSave = async () => {
    if (!canEdit || !message.messageId || pending || !draftContent.trim()) return;
    setPending(true);
    try {
      await onUpdateMessage(message.messageId, draftContent);
      setEditing(false);
    } finally {
      setPending(false);
    }
  };

  const handleDelete = async () => {
    if (!canDelete || !message.messageId || pending) return;
    if (!window.confirm("确定删除这条消息吗？此操作无法恢复。")) return;
    setPending(true);
    try {
      await onDeleteMessage(message.messageId);
    } finally {
      setPending(false);
    }
  };

  if (message.role === "tool") {
    return (
      <div className={`${style.bg} border-l-2 border-slate-300 dark:border-slate-600 ml-6`}>
        <button
          onClick={() => setToolExpanded(!toolExpanded)}
          className="flex items-center gap-2 px-3 py-1.5 w-full text-left hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors"
        >
          {toolExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
          <Wrench className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
          <span className="text-xs font-mono text-slate-600 dark:text-slate-400">{message.toolName}</span>
        </button>
        {toolExpanded && message.toolInput && (
          <div className="px-3 pb-2">
            <pre className="text-xs bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded p-2 overflow-x-auto max-h-60 overflow-y-auto">
              {message.toolInput}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`${style.bg} px-4 py-3 min-w-0 group`}>
      <div className="max-w-4xl mx-auto min-w-0">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-gray-500 dark:text-gray-400">{style.icon}</span>
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{style.label}</span>
          {message.timestamp && (
            <span className="text-xs text-gray-300 dark:text-gray-600">
              {new Date(message.timestamp).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
            {selectionMode && selectable && message.messageId ? (
              <label className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => onToggleSelect?.(message.messageId!)}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-red-500 focus:ring-red-400 dark:border-gray-600 dark:bg-gray-900"
                  aria-label={selected ? "取消选择消息" : "选择消息"}
                />
                <span>{selected ? "已选" : "选择"}</span>
              </label>
            ) : null}
            {!selectionMode && canEdit && !editing && (
              <button
                type="button"
                onClick={() => {
                  setDraftContent(message.content);
                  setContentExpanded(true);
                  setEditing(true);
                }}
                disabled={pending}
                className="rounded p-1 text-gray-300 opacity-0 transition hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100 disabled:cursor-wait disabled:opacity-60 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                title="编辑消息"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {!selectionMode && canDelete && !editing && (
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={pending}
                className="rounded p-1 text-gray-300 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 disabled:cursor-wait disabled:opacity-60 dark:hover:bg-red-900/30 dark:hover:text-red-300"
                title="删除消息"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
            {isLargeMessage && !editing && (
              <button
                type="button"
                onClick={() => setContentExpanded((prev) => !prev)}
                className="rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                {contentExpanded ? "折叠长消息" : "展开全文"}
              </button>
            )}
          </div>
        </div>
        {editing ? (
          <div className="rounded-lg border border-blue-200 bg-white/80 p-3 dark:border-blue-700 dark:bg-gray-900/50">
            <textarea
              value={draftContent}
              onChange={(event) => setDraftContent(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void handleSave();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                  setDraftContent(message.content);
                }
              }}
              className="min-h-32 w-full resize-y rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-200 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 dark:focus:border-blue-500 dark:focus:ring-blue-900"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraftContent(message.content);
                }}
                disabled={pending}
                className="rounded-md px-2 py-1 text-xs text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-60 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              >
                <span className="inline-flex items-center gap-1">
                  <X className="h-3.5 w-3.5" />
                  取消
                </span>
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={pending || !draftContent.trim()}
                className="rounded-md bg-blue-600 px-2.5 py-1 text-xs text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="inline-flex items-center gap-1">
                  <Check className="h-3.5 w-3.5" />
                  保存
                </span>
              </button>
            </div>
          </div>
        ) : !contentExpanded ? (
          <div className="rounded-lg border border-gray-200 bg-white/70 px-3 py-2 text-sm whitespace-pre-wrap break-words text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
            {contentPreview}
          </div>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none overflow-x-auto prose-pre:overflow-x-auto prose-pre:bg-gray-100 dark:prose-pre:bg-gray-800 prose-pre:text-gray-800 dark:prose-pre:text-gray-200 prose-code:text-sm">
            <ReactMarkdown
              components={{
                code({ className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || "");
                  const codeStr = String(children).replace(/\n$/, "");
                  if (match) {
                    return <CodeBlock dark={dark} language={match[1]} code={codeStr} />;
                  }
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
                table({ children, ...props }) {
                  return (
                    <div className="overflow-x-auto">
                      <table {...props}>{children}</table>
                    </div>
                  );
                },
                pre({ children, ...props }) {
                  return (
                    <pre className="overflow-x-auto" {...props}>
                      {children}
                    </pre>
                  );
                },
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
});
