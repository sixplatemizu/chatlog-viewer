import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, RefreshCw, Save, Settings2, Sparkles, X } from "lucide-react";
import {
  fetchAvailableClis,
  fetchProviderPathSettings,
  getErrorMessage,
  resetAiCliSession,
  resetAllAiCliSessions,
  updateProviderPathSettings,
  type AvailableCliInfo,
  type ProviderPathInfo,
  type ProviderPathSettings,
  type TitleGenerationCli,
  type TitleGenerationCliSessionMode,
} from "../lib/api";
import type { ToastPayload } from "./ToastViewport";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
  onNotify: (toast: ToastPayload) => void;
}

interface ProviderDraft {
  storagePath: string;
  stateDbPath: string;
}

interface ProviderMigrationDraft {
  storagePath?: boolean;
  stateDbPath?: boolean;
}

const SOURCE_LABELS = {
  env: "环境变量",
  config: "配置文件",
  auto: "自动发现",
  default: "默认值",
} as const;

const SOURCE_STYLES = {
  env: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
  config: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700",
  auto: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700",
  default: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:border-slate-600",
} as const;

const TITLE_GENERATION_CLI_LABELS: Record<TitleGenerationCli, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};

const DEFAULT_TITLE_GENERATION_SESSION_MODES: Record<TitleGenerationCli, TitleGenerationCliSessionMode> = {
  codex: "fixed",
  claude: "fixed",
  opencode: "fixed",
};

function buildCliStateMap(clis: AvailableCliInfo[]): Partial<Record<TitleGenerationCli, AvailableCliInfo>> {
  return Object.fromEntries(clis.map((cli) => [cli.name, cli])) as Partial<Record<TitleGenerationCli, AvailableCliInfo>>;
}

function buildDrafts(settings: ProviderPathSettings): Record<string, ProviderDraft> {
  return Object.fromEntries(
    settings.providers.map((provider) => [
      provider.name,
      {
        storagePath: provider.configuredStoragePath ?? "",
        stateDbPath: provider.configuredStateDbPath ?? "",
      },
    ])
  );
}

function normalizeComparablePath(value: string | undefined): string {
  const normalized = (value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:\//.test(normalized)) return normalized.toLowerCase();
  return normalized;
}

function shouldOfferMigration(
  currentPath: string | undefined,
  currentExists: boolean | undefined,
  currentSource: keyof typeof SOURCE_LABELS | undefined,
  nextPath: string
): boolean {
  if (currentSource === "env" || !currentExists) return false;

  const trimmedNextPath = nextPath.trim();
  if (!trimmedNextPath) return false;

  return normalizeComparablePath(currentPath) !== normalizeComparablePath(trimmedNextPath);
}

function PathStatus({ exists }: { exists?: boolean }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] ${
        exists
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
          : "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
      }`}
    >
      {exists ? "已发现" : "未发现"}
    </span>
  );
}

function ResolvedPathRow({
  label,
  path,
  source,
  exists,
}: {
  label: string;
  path?: string;
  source?: keyof typeof SOURCE_LABELS;
  exists?: boolean;
}) {
  if (!path || !source) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">{label}</div>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] ${SOURCE_STYLES[source]}`}>
          {SOURCE_LABELS[source]}
        </span>
        <PathStatus exists={exists} />
      </div>
      <div className="rounded-lg bg-gray-50 px-3 py-2 font-mono text-[11px] leading-5 text-gray-700 dark:bg-gray-900/60 dark:text-gray-300">
        {path}
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  draft,
  migration,
  saving,
  onChange,
  onToggleMigration,
}: {
  provider: ProviderPathInfo;
  draft: ProviderDraft;
  migration: ProviderMigrationDraft;
  saving: boolean;
  onChange: (providerName: string, field: keyof ProviderDraft, value: string) => void;
  onToggleMigration: (providerName: string, field: keyof ProviderMigrationDraft, value: boolean) => void;
}) {
  const storageHint = provider.storageSource === "env"
    ? "当前由环境变量覆盖，保存配置后仍需移除对应 env 才会生效。"
    : "留空表示移除配置覆盖，回退到环境变量 / 自动发现 / 默认值。";
  const stateDbHint = provider.stateDbSource === "env"
    ? "当前由环境变量覆盖，保存配置后仍需移除对应 env 才会生效。"
    : "留空表示移除配置覆盖，回退到环境变量 / 自动发现 / 默认值。";
  const canMigrateStorage = shouldOfferMigration(
    provider.storagePath,
    provider.storageExists,
    provider.storageSource,
    draft.storagePath
  );
  const canMigrateStateDb = provider.stateDbPath !== undefined && shouldOfferMigration(
    provider.stateDbPath,
    provider.stateDbExists,
    provider.stateDbSource,
    draft.stateDbPath
  );
  const migrateStorageChecked = canMigrateStorage && migration.storagePath !== false;
  const migrateStateDbChecked = canMigrateStateDb && migration.stateDbPath !== false;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800/70">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{provider.displayName}</div>
          <div className="text-[11px] text-gray-500 dark:text-gray-400">{provider.name}</div>
        </div>
      </div>

      <div className="space-y-3">
        <ResolvedPathRow
          label="当前 Storage Path"
          path={provider.storagePath}
          source={provider.storageSource}
          exists={provider.storageExists}
        />

        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">配置覆盖 Storage Path</div>
          <input
            type="text"
            value={draft.storagePath}
            disabled={saving}
            onChange={(e) => onChange(provider.name, "storagePath", e.target.value)}
            placeholder="留空则使用自动发现 / 默认值"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
          <div className="text-[11px] text-gray-400 dark:text-gray-500">{storageHint}</div>
          {canMigrateStorage && (
            <label className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2 text-[11px] text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300">
              <input
                type="checkbox"
                checked={migrateStorageChecked}
                disabled={saving}
                onChange={(e) => onToggleMigration(provider.name, "storagePath", e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded accent-blue-500"
              />
              <span>保存时自动迁移当前 Storage 目录内容到新路径，不覆盖目标路径中的同名文件。</span>
            </label>
          )}
        </div>

        {provider.stateDbPath !== undefined && (
          <>
            <ResolvedPathRow
              label="当前 State DB"
              path={provider.stateDbPath}
              source={provider.stateDbSource}
              exists={provider.stateDbExists}
            />

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-gray-500 dark:text-gray-400">配置覆盖 State DB</div>
              <input
                type="text"
                value={draft.stateDbPath}
                disabled={saving}
                onChange={(e) => onChange(provider.name, "stateDbPath", e.target.value)}
                placeholder="留空则跟随自动发现 / 默认值"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
              <div className="text-[11px] text-gray-400 dark:text-gray-500">{stateDbHint}</div>
              {canMigrateStateDb && (
                <label className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2 text-[11px] text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300">
                  <input
                    type="checkbox"
                    checked={migrateStateDbChecked}
                    disabled={saving}
                    onChange={(e) => onToggleMigration(provider.name, "stateDbPath", e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 rounded accent-blue-500"
                  />
                  <span>保存时自动迁移当前 State DB 文件到新路径，避免路径切换后元数据丢失。</span>
                </label>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TitleGenerationPriorityCard({
  priority,
  sessionModes,
  cliStates,
  saving,
  resettingCli,
  onMove,
  onToggleSessionMode,
  onResetCli,
  onResetAll,
}: {
  priority: TitleGenerationCli[];
  sessionModes: Record<TitleGenerationCli, TitleGenerationCliSessionMode>;
  cliStates: Partial<Record<TitleGenerationCli, AvailableCliInfo>>;
  saving: boolean;
  resettingCli: TitleGenerationCli | "all" | null;
  onMove: (index: number, direction: -1 | 1) => void;
  onToggleSessionMode: (cli: TitleGenerationCli) => void;
  onResetCli: (cli: TitleGenerationCli) => void;
  onResetAll: () => void;
}) {
  const hasAnySession = priority.some((cli) => cliStates[cli]?.hasSession);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800/70">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-purple-500" />
          <div>
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">AI 标题生成优先级</div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              生成标题时会按以下顺序依次尝试；固定模式会复用最近一次标题生成会话，不固定模式每次新建但仍记录最近会话。
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onResetAll}
          disabled={saving || resettingCli !== null || !hasAnySession}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${resettingCli === "all" ? "animate-spin" : ""}`} />
          全部重置会话
        </button>
      </div>

      <div className="space-y-2">
        {priority.map((cli, index) => {
          const cliState = cliStates[cli];
          const discoverable = cliState?.discoverable ?? false;
          const healthy = cliState?.healthy ?? false;
          const hasSession = cliState?.hasSession ?? false;
          const sessionMode = sessionModes[cli] ?? "fixed";
          const fixedMode = sessionMode === "fixed";

          return (
            <div
              key={cli}
              className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/60"
            >
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-purple-100 text-xs font-semibold text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                {index + 1}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-800 dark:text-gray-100">
                  {TITLE_GENERATION_CLI_LABELS[cli]}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] ${
                      discoverable
                        ? "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-900/30 dark:text-sky-300"
                        : "border-gray-200 bg-gray-100 text-gray-500 dark:border-gray-600 dark:bg-gray-700/60 dark:text-gray-300"
                    }`}
                  >
                    {discoverable ? "命令已发现" : "命令未发现"}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] ${
                      healthy
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                        : (discoverable
                          ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                          : "border-gray-200 bg-gray-100 text-gray-500 dark:border-gray-600 dark:bg-gray-700/60 dark:text-gray-300")
                    }`}
                  >
                    {healthy ? "健康可用" : (discoverable ? "健康检查失败" : "未执行健康检查")}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] ${
                      fixedMode
                        ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                        : "border-gray-200 bg-gray-100 text-gray-500 dark:border-gray-600 dark:bg-gray-700/60 dark:text-gray-300"
                    }`}
                  >
                    {fixedMode ? "固定模式" : "不固定模式"}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] ${
                      hasSession
                        ? "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
                        : "border-gray-200 bg-gray-100 text-gray-500 dark:border-gray-600 dark:bg-gray-700/60 dark:text-gray-300"
                    }`}
                  >
                    {hasSession ? "有最近会话" : "无最近会话"}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onToggleSessionMode(cli)}
                disabled={saving || resettingCli !== null}
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                aria-label={`${fixedMode ? "切换为不固定模式" : "切换为固定模式"} ${TITLE_GENERATION_CLI_LABELS[cli]}`}
              >
                {fixedMode ? "改为不固定" : "改为固定"}
              </button>
              <button
                type="button"
                onClick={() => onResetCli(cli)}
                disabled={saving || resettingCli !== null || !hasSession}
                className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                aria-label={`重置 ${TITLE_GENERATION_CLI_LABELS[cli]} 标题会话`}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${resettingCli === cli ? "animate-spin" : ""}`} />
                重置会话
              </button>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onMove(index, -1)}
                  disabled={saving || resettingCli !== null || index === 0}
                  className="rounded-md border border-gray-200 p-1 text-gray-500 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  aria-label={`上移 ${TITLE_GENERATION_CLI_LABELS[cli]}`}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onMove(index, 1)}
                  disabled={saving || resettingCli !== null || index === priority.length - 1}
                  className="rounded-md border border-gray-200 p-1 text-gray-500 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  aria-label={`下移 ${TITLE_GENERATION_CLI_LABELS[cli]}`}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ProviderPathsDialog({ open, onClose, onSaved, onNotify }: Props) {
  const [settings, setSettings] = useState<ProviderPathSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [migrationDrafts, setMigrationDrafts] = useState<Record<string, ProviderMigrationDraft>>({});
  const [titleGenerationCliPriority, setTitleGenerationCliPriority] = useState<TitleGenerationCli[]>([]);
  const [titleGenerationCliSessionModes, setTitleGenerationCliSessionModes] = useState<Record<TitleGenerationCli, TitleGenerationCliSessionMode>>(
    DEFAULT_TITLE_GENERATION_SESSION_MODES
  );
  const [cliStates, setCliStates] = useState<Partial<Record<TitleGenerationCli, AvailableCliInfo>>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resettingCli, setResettingCli] = useState<TitleGenerationCli | "all" | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const [settingsResult, clisResult] = await Promise.allSettled([
        fetchProviderPathSettings(),
        fetchAvailableClis(),
      ]);

      if (settingsResult.status === "rejected") {
        throw settingsResult.reason;
      }

      const nextSettings = settingsResult.value;
      setSettings(nextSettings);
      setDrafts(buildDrafts(nextSettings));
      setMigrationDrafts({});
      setTitleGenerationCliPriority(nextSettings.ai.titleGenerationCliPriority);
      setTitleGenerationCliSessionModes({
        ...DEFAULT_TITLE_GENERATION_SESSION_MODES,
        ...nextSettings.ai.titleGenerationCliSessionModes,
      });

      if (clisResult.status === "fulfilled") {
        setCliStates(buildCliStateMap(clisResult.value));
      } else {
        setCliStates({});
        onNotify({
          variant: "error",
          title: "读取 AI CLI 状态失败",
          description: getErrorMessage(clisResult.reason, "读取 AI CLI 状态失败"),
        });
      }
    } catch (error) {
      onNotify({
        variant: "error",
        title: "加载路径设置失败",
        description: getErrorMessage(error, "加载路径设置失败"),
      });
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    if (!open) return;
    void loadSettings();
  }, [loadSettings, open]);

  const handleDraftChange = useCallback((providerName: string, field: keyof ProviderDraft, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [providerName]: {
        ...(prev[providerName] ?? { storagePath: "", stateDbPath: "" }),
        [field]: value,
      },
    }));
    setMigrationDrafts((prev) => ({
      ...prev,
      [providerName]: {
        ...(prev[providerName] ?? {}),
        [field]: undefined,
      },
    }));
  }, []);

  const handleMigrationChange = useCallback(
    (providerName: string, field: keyof ProviderMigrationDraft, value: boolean) => {
      setMigrationDrafts((prev) => ({
        ...prev,
        [providerName]: {
          ...(prev[providerName] ?? {}),
          [field]: value,
        },
      }));
    },
    []
  );

  const handleMoveTitleGenerationCli = useCallback((index: number, direction: -1 | 1) => {
    setTitleGenerationCliPriority((prev) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= prev.length) {
        return prev;
      }

      const next = [...prev];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  }, []);

  const handleToggleTitleGenerationSessionMode = useCallback((cli: TitleGenerationCli) => {
    setTitleGenerationCliSessionModes((prev) => ({
      ...prev,
      [cli]: (prev[cli] ?? "fixed") === "fixed" ? "fresh" : "fixed",
    }));
  }, []);

  const refreshCliStates = useCallback(async () => {
    const nextClis = await fetchAvailableClis();
    setCliStates(buildCliStateMap(nextClis));
  }, []);

  const handleResetCli = useCallback(async (cli: TitleGenerationCli) => {
    setResettingCli(cli);
    try {
      await resetAiCliSession(cli);
      await refreshCliStates();
      onNotify({
        variant: "success",
        title: "会话已重置",
        description: `${TITLE_GENERATION_CLI_LABELS[cli]} 的固定标题会话已清除，下次生成会自动新建。`,
      });
    } catch (error) {
      onNotify({
        variant: "error",
        title: "重置会话失败",
        description: getErrorMessage(error, "重置会话失败"),
      });
    } finally {
      setResettingCli(null);
    }
  }, [onNotify, refreshCliStates]);

  const handleResetAllClis = useCallback(async () => {
    setResettingCli("all");
    try {
      await resetAllAiCliSessions();
      await refreshCliStates();
      onNotify({
        variant: "success",
        title: "会话已全部重置",
        description: "所有标题生成 CLI 的固定会话已清除，下次生成会自动新建。",
      });
    } catch (error) {
      onNotify({
        variant: "error",
        title: "重置全部会话失败",
        description: getErrorMessage(error, "重置全部会话失败"),
      });
    } finally {
      setResettingCli(null);
    }
  }, [onNotify, refreshCliStates]);

  const handleSave = useCallback(async () => {
    if (!settings) return;

    setSaving(true);
    try {
      const migrations = Object.fromEntries(
        settings.providers.flatMap((provider) => {
          const draft = drafts[provider.name] ?? { storagePath: "", stateDbPath: "" };
          const migrationDraft = migrationDrafts[provider.name] ?? {};
          const nextSelection: { storagePath?: boolean; stateDbPath?: boolean } = {};

          if (
            shouldOfferMigration(provider.storagePath, provider.storageExists, provider.storageSource, draft.storagePath)
            && migrationDraft.storagePath !== false
          ) {
            nextSelection.storagePath = true;
          }

          if (
            provider.stateDbPath !== undefined
            && shouldOfferMigration(provider.stateDbPath, provider.stateDbExists, provider.stateDbSource, draft.stateDbPath)
            && migrationDraft.stateDbPath !== false
          ) {
            nextSelection.stateDbPath = true;
          }

          return Object.keys(nextSelection).length > 0 ? [[provider.name, nextSelection]] : [];
        })
      );

      const nextSettings = await updateProviderPathSettings({
        providers: Object.fromEntries(
          settings.providers.map((provider) => [
            provider.name,
            {
              storagePath: drafts[provider.name]?.storagePath.trim() || null,
              ...(provider.stateDbPath !== undefined
                ? { stateDbPath: drafts[provider.name]?.stateDbPath.trim() || null }
                : {}),
            },
          ])
        ),
        migrations,
        ai: {
          titleGenerationCliPriority,
          titleGenerationCliSessionModes: titleGenerationCliSessionModes,
        },
      });

      setSettings(nextSettings);
      setDrafts(buildDrafts(nextSettings));
      setMigrationDrafts({});
      setTitleGenerationCliPriority(nextSettings.ai.titleGenerationCliPriority);
      setTitleGenerationCliSessionModes({
        ...DEFAULT_TITLE_GENERATION_SESSION_MODES,
        ...nextSettings.ai.titleGenerationCliSessionModes,
      });
      await onSaved?.();

      const migrationMessages = nextSettings.migrationResults?.map((item) => item.message) ?? [];
      onNotify({
        variant: "success",
        title: migrationMessages.length > 0 ? "设置已保存并迁移" : "设置已保存",
        description: migrationMessages.length > 0
          ? `已写入配置文件并刷新设置。\n${migrationMessages.join("\n")}`
          : "已写入配置文件并刷新设置。",
      });
    } catch (error) {
      onNotify({
        variant: "error",
        title: "保存设置失败",
        description: getErrorMessage(error, "保存设置失败"),
      });
    } finally {
      setSaving(false);
    }
  }, [drafts, migrationDrafts, onNotify, onSaved, settings, titleGenerationCliPriority, titleGenerationCliSessionModes]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4">
      <div className="flex h-[min(48rem,calc(100vh-2rem))] w-[min(64rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-blue-500" />
            <div>
              <div className="text-base font-semibold text-gray-900 dark:text-gray-100">Provider 与 AI 设置</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">查看当前解析结果，并保存 config override 与标题生成优先级</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            aria-label="关闭设置"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-gray-200 px-5 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          配置文件：
          <span className="ml-1 font-mono text-[11px] text-gray-700 dark:text-gray-300">
            {settings?.configPath ?? "加载中..."}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
            </div>
          ) : settings ? (
            <div className="space-y-4">
              <TitleGenerationPriorityCard
                priority={titleGenerationCliPriority}
                sessionModes={titleGenerationCliSessionModes}
                cliStates={cliStates}
                saving={saving}
                resettingCli={resettingCli}
                onMove={handleMoveTitleGenerationCli}
                onToggleSessionMode={handleToggleTitleGenerationSessionMode}
                onResetCli={(cli) => void handleResetCli(cli)}
                onResetAll={() => void handleResetAllClis()}
              />
              {settings.providers.map((provider) => (
                <ProviderCard
                  key={provider.name}
                  provider={provider}
                  draft={drafts[provider.name] ?? { storagePath: "", stateDbPath: "" }}
                  migration={migrationDrafts[provider.name] ?? {}}
                  saving={saving}
                  onChange={handleDraftChange}
                  onToggleMigration={handleMigrationChange}
                />
              ))}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-gray-400">
              无法加载路径设置
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 px-5 py-4 dark:border-gray-700">
          <button
            type="button"
            onClick={() => void loadSettings()}
            disabled={loading || saving || resettingCli !== null}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            重新读取
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={resettingCli !== null}
              className="rounded-lg px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              关闭
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={loading || saving || resettingCli !== null || !settings}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-wait disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              保存配置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
