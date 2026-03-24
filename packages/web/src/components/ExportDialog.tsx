import { useState } from "react";
import { X, FileJson, FileText, Archive, Zap } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  count: number;
  onConfirm: (format: "json" | "markdown", mode: "full" | "partial") => void;
}

export function ExportDialog({ open, onClose, onConfirm, count }: Props) {
  const [format, setFormat] = useState<"json" | "markdown">("markdown");
  const [mode, setMode] = useState<"full" | "partial">("full");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-[28rem] p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold">导出对话</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          将导出 {count} 条对话。超长对话建议使用 partial export，归档场景建议使用完整导出。
        </p>

        <div className="space-y-2 mb-5">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            导出格式
          </div>
          <label
            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              format === "markdown"
                ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30"
                : "border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
            }`}
          >
            <input type="radio" name="format" checked={format === "markdown"} onChange={() => setFormat("markdown")} className="accent-blue-500" />
            <FileText className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <div>
              <div className="text-sm font-medium">Markdown</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">适合阅读和分享</div>
            </div>
          </label>

          <label
            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              format === "json"
                ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30"
                : "border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
            }`}
          >
            <input type="radio" name="format" checked={format === "json"} onChange={() => setFormat("json")} className="accent-blue-500" />
            <FileJson className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <div>
              <div className="text-sm font-medium">JSON</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">完整数据，适合程序处理</div>
            </div>
          </label>
        </div>

        <div className="space-y-2 mb-5">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            导出模式
          </div>

          <label
            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              mode === "full"
                ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30"
                : "border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
            }`}
          >
            <input type="radio" name="mode" checked={mode === "full"} onChange={() => setMode("full")} className="accent-blue-500" />
            <Archive className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <div>
              <div className="text-sm font-medium">完整导出</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">读取完整对话，适合归档，但超长对话会更慢</div>
            </div>
          </label>

          <label
            className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              mode === "partial"
                ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30"
                : "border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
            }`}
          >
            <input type="radio" name="mode" checked={mode === "partial"} onChange={() => setMode("partial")} className="accent-blue-500" />
            <Zap className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <div>
              <div className="text-sm font-medium">Partial Export</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">只导出最近 500 条消息，速度更快，适合超长对话</div>
            </div>
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => onConfirm(format, mode)}
            className="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            导出
          </button>
        </div>
      </div>
    </div>
  );
}
