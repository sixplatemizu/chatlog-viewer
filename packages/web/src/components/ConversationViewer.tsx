import { useRef, useEffect, useState } from "react";
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
} from "lucide-react";
import type { Conversation } from "../lib/api";
import { updateTitle, generateAiTitle } from "../lib/api";
import { MessageBubble } from "./MessageBubble";

interface Props {
  conversation: Conversation | null;
  loading: boolean;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
  onTitleChanged: (id: string, newTitle: string) => void;
}

export function ConversationViewer({
  conversation,
  loading,
  onExport,
  onDelete,
  onTitleChanged,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState("");

  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
    setEditing(false);
    setGenerating(false);
    setGenStatus("");
  }, [conversation?.id]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEdit = () => {
    if (!conversation) return;
    setEditValue(conversation.title);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!conversation || !editValue.trim()) return;
    try {
      await updateTitle(conversation.id, editValue.trim());
      onTitleChanged(conversation.id, editValue.trim());
    } catch (e) {
      console.error("保存标题失败:", e);
    }
    setEditing(false);
  };

  const handleGenerate = async () => {
    if (!conversation || generating) return;
    setGenerating(true);
    setGenStatus("正在调用 AI CLI 生成标题...");
    try {
      const result = await generateAiTitle(conversation.id);
      if (result.success) {
        setGenStatus(`已通过 ${result.usedCli} 生成`);
        onTitleChanged(conversation.id, result.title);
        setTimeout(() => setGenStatus(""), 3000);
      } else {
        setGenStatus(`失败: ${result.error}`);
        setTimeout(() => setGenStatus(""), 5000);
      }
    } catch {
      setGenStatus("生成失败");
      setTimeout(() => setGenStatus(""), 3000);
    }
    setGenerating(false);
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

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-white dark:bg-gray-900">
      {/* 对话头部 */}
      <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3 flex-shrink-0">
        <div className="flex items-center justify-between">
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
                <button
                  onClick={startEdit}
                  className="p-1 text-gray-300 hover:text-gray-600 dark:hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="编辑标题"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  className="p-1 text-gray-300 hover:text-purple-600 dark:hover:text-purple-400 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                  title="AI 生成标题"
                >
                  {generating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            )}

            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400">
              <span className="flex items-center gap-1">
                <FolderOpen className="w-3.5 h-3.5" />
                {conversation.project.split(/[/\\]/).pop() || conversation.project}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                {new Date(conversation.createdAt).toLocaleDateString("zh-CN")}
              </span>
              <span>{conversation.messages.length} 条消息</span>
              {genStatus && (
                <span className="text-purple-500 animate-pulse">{genStatus}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 ml-3 flex-shrink-0">
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
              删除
            </button>
          </div>
        </div>
      </div>

      {/* 消息列表 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {conversation.messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} />
          ))}
        </div>
      </div>
    </div>
  );
}
