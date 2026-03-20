import { useState } from "react";
import { X, FileJson, FileText } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  onConfirm: (format: "json" | "markdown") => void;
}

export function ExportDialog({ open, onClose, onConfirm }: Props) {
  const [format, setFormat] = useState<"json" | "markdown">("markdown");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-96 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold">导出对话</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-2 mb-5">
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

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => onConfirm(format)}
            className="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            导出
          </button>
        </div>
      </div>
    </div>
  );
}
