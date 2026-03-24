import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Save, Settings2, X } from "lucide-react";
import {
  fetchProviderPathSettings,
  getErrorMessage,
  updateProviderPathSettings,
  type ProviderPathInfo,
  type ProviderPathSettings,
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
  saving,
  onChange,
}: {
  provider: ProviderPathInfo;
  draft: ProviderDraft;
  saving: boolean;
  onChange: (providerName: string, field: keyof ProviderDraft, value: string) => void;
}) {
  const storageHint = provider.storageSource === "env"
    ? "当前由环境变量覆盖，保存配置后仍需移除对应 env 才会生效。"
    : "留空表示移除配置覆盖，回退到环境变量 / 自动发现 / 默认值。";
  const stateDbHint = provider.stateDbSource === "env"
    ? "当前由环境变量覆盖，保存配置后仍需移除对应 env 才会生效。"
    : "留空表示移除配置覆盖，回退到环境变量 / 自动发现 / 默认值。";

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
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ProviderPathsDialog({ open, onClose, onSaved, onNotify }: Props) {
  const [settings, setSettings] = useState<ProviderPathSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const nextSettings = await fetchProviderPathSettings();
      setSettings(nextSettings);
      setDrafts(buildDrafts(nextSettings));
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
  }, []);

  const handleSave = useCallback(async () => {
    if (!settings) return;

    setSaving(true);
    try {
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
      });

      setSettings(nextSettings);
      setDrafts(buildDrafts(nextSettings));
      await onSaved?.();
      onNotify({
        variant: "success",
        title: "路径设置已保存",
        description: "已写入配置文件并刷新 provider 解析结果。",
      });
    } catch (error) {
      onNotify({
        variant: "error",
        title: "保存路径设置失败",
        description: getErrorMessage(error, "保存路径设置失败"),
      });
    } finally {
      setSaving(false);
    }
  }, [drafts, onNotify, onSaved, settings]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4">
      <div className="flex h-[min(48rem,calc(100vh-2rem))] w-[min(64rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-blue-500" />
            <div>
              <div className="text-base font-semibold text-gray-900 dark:text-gray-100">Provider 路径设置</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">查看当前解析结果，并保存 config override</div>
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
              {settings.providers.map((provider) => (
                <ProviderCard
                  key={provider.name}
                  provider={provider}
                  draft={drafts[provider.name] ?? { storagePath: "", stateDbPath: "" }}
                  saving={saving}
                  onChange={handleDraftChange}
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
            disabled={loading || saving}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            重新读取
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              关闭
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={loading || saving || !settings}
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
