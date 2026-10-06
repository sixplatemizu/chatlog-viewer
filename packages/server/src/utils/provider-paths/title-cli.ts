import { homedir } from "os";
import type { EnvLike, TitleGenerationCli, TitleGenerationCliSessionMode } from "./types.js";
import { loadAppConfig } from "./config.js";

export const TITLE_GENERATION_CLI_ORDER: TitleGenerationCli[] = ["codex", "claude", "opencode"];
export const TITLE_GENERATION_CLI_SET = new Set<TitleGenerationCli>(TITLE_GENERATION_CLI_ORDER);
export const TITLE_GENERATION_CLI_SESSION_MODE_SET = new Set<TitleGenerationCliSessionMode>(["fixed", "fresh"]);

export function normalizeTitleGenerationCliPriority(
  priority?: readonly string[],
  disabled?: readonly string[]
): TitleGenerationCli[] {
  const disabledSet = new Set(disabled ?? []);
  const normalized: TitleGenerationCli[] = [];
  const seen = new Set<TitleGenerationCli>();

  for (const item of priority ?? []) {
    if (!TITLE_GENERATION_CLI_SET.has(item as TitleGenerationCli)) continue;
    const cli = item as TitleGenerationCli;
    if (disabledSet.has(cli)) continue;
    if (seen.has(cli)) continue;
    seen.add(cli);
    normalized.push(cli);
  }

  for (const cli of TITLE_GENERATION_CLI_ORDER) {
    if (disabledSet.has(cli)) continue;
    if (seen.has(cli)) continue;
    normalized.push(cli);
  }

  return normalized;
}

export function getTitleGenerationCliPriority(
  env: EnvLike = process.env,
  homeDir = homedir()
): TitleGenerationCli[] {
  const loaded = loadAppConfig(env, homeDir).config.ai;
  return normalizeTitleGenerationCliPriority(
    loaded?.titleGenerationCliPriority,
    loaded?.titleGenerationCliDisabled
  );
}

export function getRawTitleGenerationCliPriority(
  env: EnvLike = process.env,
  homeDir = homedir()
): TitleGenerationCli[] {
  const priority = loadAppConfig(env, homeDir).config.ai?.titleGenerationCliPriority;
  if (!Array.isArray(priority)) return [...TITLE_GENERATION_CLI_ORDER];
  return priority.filter((item): item is TitleGenerationCli => TITLE_GENERATION_CLI_SET.has(item as TitleGenerationCli));
}

export function getTitleGenerationCliDisabled(
  env: EnvLike = process.env,
  homeDir = homedir()
): TitleGenerationCli[] {
  const disabled = loadAppConfig(env, homeDir).config.ai?.titleGenerationCliDisabled;
  if (!Array.isArray(disabled)) return [];
  return disabled.filter((item): item is TitleGenerationCli => TITLE_GENERATION_CLI_SET.has(item as TitleGenerationCli));
}

export function normalizeTitleGenerationCliSessionModes(
  modes?: Partial<Record<string, unknown>>
): Record<TitleGenerationCli, TitleGenerationCliSessionMode> {
  const normalized = Object.fromEntries(
    TITLE_GENERATION_CLI_ORDER.map((cli) => [cli, "fresh"])
  ) as Record<TitleGenerationCli, TitleGenerationCliSessionMode>;

  if (!modes || typeof modes !== "object") return normalized;

  for (const cli of TITLE_GENERATION_CLI_ORDER) {
    const mode = modes[cli];
    if (TITLE_GENERATION_CLI_SESSION_MODE_SET.has(mode as TitleGenerationCliSessionMode)) {
      normalized[cli] = mode as TitleGenerationCliSessionMode;
    }
  }

  return normalized;
}

export function getTitleGenerationCliSessionModes(
  env: EnvLike = process.env,
  homeDir = homedir()
): Record<TitleGenerationCli, TitleGenerationCliSessionMode> {
  return normalizeTitleGenerationCliSessionModes(
    loadAppConfig(env, homeDir).config.ai?.titleGenerationCliSessionModes
  );
}

export function getTitleGenerationCliSessionReuse(
  env: EnvLike = process.env,
  homeDir = homedir()
): Record<TitleGenerationCli, boolean> {
  const modes = getTitleGenerationCliSessionModes(env, homeDir);
  return Object.fromEntries(
    TITLE_GENERATION_CLI_ORDER.map((cli) => [cli, modes[cli] === "fixed"])
  ) as Record<TitleGenerationCli, boolean>;
}
