import { useEffect, useState, useSyncExternalStore } from "react";

type Theme = "light" | "dark" | "system";

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? getSystemTheme() : theme;
}

function applyResolvedTheme(resolved: "light" | "dark") {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

function subscribeSystemTheme(callback: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", callback);
  return () => mq.removeEventListener("change", callback);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem("theme") as Theme) || "system";
  });
  const systemTheme = useSyncExternalStore<"light" | "dark">(
    subscribeSystemTheme,
    getSystemTheme,
    (): "light" | "dark" => "light"
  );
  const resolvedTheme = theme === "system" ? systemTheme : resolveTheme(theme);

  useEffect(() => {
    applyResolvedTheme(resolvedTheme);
    localStorage.setItem("theme", theme);
  }, [resolvedTheme, theme]);

  return { theme, resolvedTheme, setTheme: setThemeState };
}
