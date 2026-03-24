import { useEffect, useMemo, useState } from "react";

type PrismLightComponent = typeof import("react-syntax-highlighter/dist/esm/prism-light").default;
type PrismStyle = typeof import("react-syntax-highlighter/dist/esm/styles/prism").oneLight;

type LoadedHighlighter = {
  SyntaxHighlighter: PrismLightComponent;
  lightStyle: PrismStyle;
  darkStyle: PrismStyle;
  supportedLanguages: Set<string>;
};

let loadedHighlighter: LoadedHighlighter | null = null;
let highlighterPromise: Promise<LoadedHighlighter> | null = null;
const LARGE_CODE_CHAR_THRESHOLD = 12_000;
const LARGE_CODE_LINE_THRESHOLD = 300;
const HUGE_CODE_CHAR_THRESHOLD = 48_000;
const HUGE_CODE_LINE_THRESHOLD = 1_200;
const CODE_PREVIEW_LINES = 40;

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  html: "markup",
  xml: "markup",
};

async function loadHighlighter(): Promise<LoadedHighlighter> {
  if (loadedHighlighter) {
    return loadedHighlighter;
  }

  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("react-syntax-highlighter/dist/esm/prism-light"),
      import("react-syntax-highlighter/dist/esm/styles/prism"),
      import("react-syntax-highlighter/dist/esm/languages/prism/javascript"),
      import("react-syntax-highlighter/dist/esm/languages/prism/jsx"),
      import("react-syntax-highlighter/dist/esm/languages/prism/typescript"),
      import("react-syntax-highlighter/dist/esm/languages/prism/tsx"),
      import("react-syntax-highlighter/dist/esm/languages/prism/json"),
      import("react-syntax-highlighter/dist/esm/languages/prism/bash"),
      import("react-syntax-highlighter/dist/esm/languages/prism/python"),
      import("react-syntax-highlighter/dist/esm/languages/prism/go"),
      import("react-syntax-highlighter/dist/esm/languages/prism/rust"),
      import("react-syntax-highlighter/dist/esm/languages/prism/java"),
      import("react-syntax-highlighter/dist/esm/languages/prism/css"),
      import("react-syntax-highlighter/dist/esm/languages/prism/markup"),
      import("react-syntax-highlighter/dist/esm/languages/prism/markdown"),
      import("react-syntax-highlighter/dist/esm/languages/prism/sql"),
      import("react-syntax-highlighter/dist/esm/languages/prism/yaml"),
    ]).then(([
      prismLightModule,
      styleModule,
      javascriptModule,
      jsxModule,
      typescriptModule,
      tsxModule,
      jsonModule,
      bashModule,
      pythonModule,
      goModule,
      rustModule,
      javaModule,
      cssModule,
      markupModule,
      markdownModule,
      sqlModule,
      yamlModule,
    ]) => {
      const SyntaxHighlighter = prismLightModule.default;
      const languageEntries = [
        ["javascript", javascriptModule.default],
        ["jsx", jsxModule.default],
        ["typescript", typescriptModule.default],
        ["tsx", tsxModule.default],
        ["json", jsonModule.default],
        ["bash", bashModule.default],
        ["python", pythonModule.default],
        ["go", goModule.default],
        ["rust", rustModule.default],
        ["java", javaModule.default],
        ["css", cssModule.default],
        ["markup", markupModule.default],
        ["markdown", markdownModule.default],
        ["sql", sqlModule.default],
        ["yaml", yamlModule.default],
      ] as const;

      const supportedLanguages = new Set<string>();
      for (const [name, language] of languageEntries) {
        SyntaxHighlighter.registerLanguage(name, language);
        supportedLanguages.add(name);
      }

      loadedHighlighter = {
        SyntaxHighlighter,
        lightStyle: styleModule.oneLight,
        darkStyle: styleModule.oneDark,
        supportedLanguages,
      };

      return loadedHighlighter;
    });
  }

  return highlighterPromise;
}

function normalizeLanguage(language: string): string {
  return LANGUAGE_ALIASES[language.toLowerCase()] || language.toLowerCase();
}

function getLineCount(code: string): number {
  return code.split(/\r?\n/).length;
}

function buildCodePreview(code: string, maxLines: number): string {
  const lines = code.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return code;
  }
  return `${lines.slice(0, maxLines).join("\n")}\n\n...`;
}

interface Props {
  code: string;
  dark: boolean;
  language: string;
}

export function CodeBlock({ code, dark, language }: Props) {
  const normalizedLanguage = normalizeLanguage(language);
  const lineCount = useMemo(() => getLineCount(code), [code]);
  const isLargeCode = code.length > LARGE_CODE_CHAR_THRESHOLD || lineCount > LARGE_CODE_LINE_THRESHOLD;
  const shouldSkipHighlight = code.length > HUGE_CODE_CHAR_THRESHOLD || lineCount > HUGE_CODE_LINE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLargeCode);
  const [highlighter, setHighlighter] = useState<LoadedHighlighter | null>(loadedHighlighter);

  useEffect(() => {
    if (!expanded || shouldSkipHighlight) {
      return;
    }

    let active = true;

    void loadHighlighter().then((module) => {
      if (active) {
        setHighlighter(module);
      }
    });

    return () => {
      active = false;
    };
  }, [expanded, shouldSkipHighlight]);

  const previewCode = useMemo(() => buildCodePreview(code, CODE_PREVIEW_LINES), [code]);

  if (!expanded) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-3 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <span>{normalizedLanguage} · {lineCount} 行 · {code.length.toLocaleString("zh-CN")} 字符</span>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="rounded border border-gray-300 px-2 py-0.5 text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            展开代码
          </button>
        </div>
        <pre className="overflow-x-auto p-4 text-sm text-gray-700 dark:text-gray-300">
          <code className={`language-${normalizedLanguage}`}>{previewCode}</code>
        </pre>
      </div>
    );
  }

  if (shouldSkipHighlight || !highlighter || !highlighter.supportedLanguages.has(normalizedLanguage)) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60">
        {shouldSkipHighlight && (
          <div className="border-b border-gray-200 px-3 py-2 text-xs text-amber-700 dark:border-gray-700 dark:text-amber-300">
            超大代码块已切换为纯文本渲染，避免高亮导致界面卡顿。
          </div>
        )}
        <pre className="overflow-x-auto p-4 text-sm text-gray-800 dark:text-gray-200">
          <code className={`language-${normalizedLanguage}`}>{code}</code>
        </pre>
      </div>
    );
  }

  const { SyntaxHighlighter, lightStyle, darkStyle } = highlighter;

  return (
    <SyntaxHighlighter
      style={dark ? darkStyle : lightStyle}
      language={normalizedLanguage}
      PreTag="div"
      customStyle={{ overflow: "auto" }}
    >
      {code}
    </SyntaxHighlighter>
  );
}
