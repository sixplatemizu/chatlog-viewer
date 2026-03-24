import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ChevronDown, ChevronRight, Wrench, User, Bot, Cpu } from "lucide-react";
import type { Message } from "../lib/api";
import { CodeBlock } from "./CodeBlock";

const LARGE_MESSAGE_CHAR_THRESHOLD = 16_000;
const LARGE_MESSAGE_LINE_THRESHOLD = 220;
const MESSAGE_PREVIEW_LINES = 24;

interface Props {
  message: Message;
  dark: boolean;
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

export const MessageBubble = memo(function MessageBubble({ message, dark }: Props) {
  const [toolExpanded, setToolExpanded] = useState(false);
  const contentLineCount = getLineCount(message.content);
  const isLargeMessage = message.content.length > LARGE_MESSAGE_CHAR_THRESHOLD
    || contentLineCount > LARGE_MESSAGE_LINE_THRESHOLD;
  const [contentExpanded, setContentExpanded] = useState(!isLargeMessage);
  const contentPreview = isLargeMessage
    ? buildTextPreview(message.content, MESSAGE_PREVIEW_LINES)
    : message.content;

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
    <div className={`${style.bg} px-4 py-3 min-w-0`}>
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
          {isLargeMessage && (
            <button
              type="button"
              onClick={() => setContentExpanded((prev) => !prev)}
              className="ml-auto rounded border border-gray-200 px-2 py-0.5 text-[11px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              {contentExpanded ? "折叠长消息" : "展开全文"}
            </button>
          )}
        </div>
        {!contentExpanded ? (
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
