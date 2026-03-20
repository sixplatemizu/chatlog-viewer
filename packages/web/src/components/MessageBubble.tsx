import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight, oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { ChevronDown, ChevronRight, Wrench, User, Bot, Cpu } from "lucide-react";
import type { Message } from "../lib/api";

interface Props {
  message: Message;
}

function isDark() {
  return document.documentElement.classList.contains("dark");
}

export function MessageBubble({ message }: Props) {
  const [expanded, setExpanded] = useState(false);
  const dark = isDark();

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
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 px-3 py-1.5 w-full text-left hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          )}
          <Wrench className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
          <span className="text-xs font-mono text-slate-600 dark:text-slate-400">{message.toolName}</span>
        </button>
        {expanded && message.toolInput && (
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
        </div>
        <div className="prose prose-sm dark:prose-invert max-w-none overflow-x-auto prose-pre:overflow-x-auto prose-pre:bg-gray-100 dark:prose-pre:bg-gray-800 prose-pre:text-gray-800 dark:prose-pre:text-gray-200 prose-code:text-sm">
          <ReactMarkdown
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || "");
                const codeStr = String(children).replace(/\n$/, "");
                if (match) {
                  return (
                    <SyntaxHighlighter
                      style={dark ? oneDark : oneLight}
                      language={match[1]}
                      PreTag="div"
                      customStyle={{ overflow: "auto" }}
                    >
                      {codeStr}
                    </SyntaxHighlighter>
                  );
                }
                return (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              },
              // 表格等块元素也加 overflow
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
      </div>
    </div>
  );
}
