import { useEffect, useState } from "react";

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

interface Props {
  code: string;
  dark: boolean;
  language: string;
}

export function CodeBlock({ code, dark, language }: Props) {
  const normalizedLanguage = normalizeLanguage(language);
  const [highlighter, setHighlighter] = useState<LoadedHighlighter | null>(loadedHighlighter);

  useEffect(() => {
    let active = true;

    void loadHighlighter().then((module) => {
      if (active) {
        setHighlighter(module);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  if (!highlighter || !highlighter.supportedLanguages.has(normalizedLanguage)) {
    return (
      <pre className="overflow-x-auto rounded bg-gray-100 p-4 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-200">
        <code className={`language-${normalizedLanguage}`}>{code}</code>
      </pre>
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
