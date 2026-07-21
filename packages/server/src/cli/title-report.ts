import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TitleGenerationCli } from "../utils/provider-paths.js";

export type ProjectMode = "exact" | "recursive";
export type ManagedProviderName = "codex" | "claude-code" | "opencode";
export type ProviderSelection = ManagedProviderName | "all";
export type TitleCliCommand = "list" | "rename" | "generate" | "generate-batch" | "rollback";

export interface TitleCliSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

export interface BatchReportEntry {
  id: string;
  oldTitle: string;
  newTitle?: string;
  filePath?: string;
  usedCli?: string;
  attempts?: number;
  cleanedTitleSessions?: number;
  durationMs?: number;
  status: "pending" | "success" | "failed" | "skipped" | "dry-run";
  error?: string;
}

export interface BatchReport {
  schemaVersion?: number;
  command?: "generate-batch";
  ok?: boolean;
  summary?: TitleCliSummary;
  kind: "generate-batch";
  dryRun: boolean;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  projectPath?: string;
  projectMode: ProjectMode;
  provider?: ProviderSelection;
  detectedCliNames?: TitleGenerationCli[];
  total: number;
  success: number;
  failed: number;
  skipped?: number;
  entries: BatchReportEntry[];
}

export interface RollbackReportEntry {
  id: string;
  oldTitle: string;
  generatedTitle?: string;
  status: "pending" | "rolled-back" | "failed" | "dry-run" | "skipped" | "skipped-conflict";
  error?: string;
}

export interface RollbackReport {
  schemaVersion?: number;
  command?: "rollback";
  ok?: boolean;
  summary?: TitleCliSummary;
  kind: "rollback";
  dryRun: boolean;
  sourceReportPath: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  entries: RollbackReportEntry[];
}

export const TITLE_CLI_SCHEMA_VERSION = 1;

const TITLE_SUCCESS_STATUSES = new Set(["success", "rolled-back"]);

export function formatCliJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function summarizeTitleEntries(
  entries: ReadonlyArray<{ status: string }>,
  successStatuses: ReadonlySet<string> = TITLE_SUCCESS_STATUSES
): TitleCliSummary {
  return entries.reduce<TitleCliSummary>((summary, entry) => {
    summary.total += 1;
    if (successStatuses.has(entry.status)) {
      summary.success += 1;
    } else if (entry.status === "failed") {
      summary.failed += 1;
    } else {
      summary.skipped += 1;
    }
    return summary;
  }, {
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
  });
}

export function buildTitleCliJsonResult<T extends { status: string }>(
  command: Exclude<TitleCliCommand, "list">,
  entries: readonly T[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const summary = summarizeTitleEntries(entries);
  return {
    ...extra,
    schemaVersion: TITLE_CLI_SCHEMA_VERSION,
    command,
    ok: summary.failed === 0 && !entries.some((entry) => entry.status === "pending"),
    summary,
    entries,
  };
}

export function synchronizeBatchReport(report: BatchReport): void {
  const summary = summarizeTitleEntries(report.entries);
  report.schemaVersion = TITLE_CLI_SCHEMA_VERSION;
  report.command = "generate-batch";
  report.summary = summary;
  report.total = summary.total;
  report.success = summary.success;
  report.failed = summary.failed;
  report.skipped = summary.skipped;
  report.ok = summary.failed === 0 && !report.entries.some((entry) => entry.status === "pending");
}

export function synchronizeRollbackReport(report: RollbackReport): void {
  const summary = summarizeTitleEntries(report.entries);
  report.schemaVersion = TITLE_CLI_SCHEMA_VERSION;
  report.command = "rollback";
  report.summary = summary;
  report.total = summary.total;
  report.success = summary.success;
  report.failed = summary.failed;
  report.skipped = summary.skipped;
  report.ok = summary.failed === 0 && !report.entries.some((entry) => entry.status === "pending");
}

function formatBackupDate(date: Date): { day: string; stamp: string } {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const stamp = `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return { day, stamp };
}

export async function createTitleReportPath(prefix: string): Promise<string> {
  const { day, stamp } = formatBackupDate(new Date());
  const dir = join(homedir(), ".backups", "chatlog-viewer-title", day);
  await mkdir(dir, { recursive: true });
  return join(dir, `conversation-title-${prefix}-${stamp}.json`);
}

export async function writeBatchReport(filePath: string, report: BatchReport): Promise<void> {
  synchronizeBatchReport(report);
  await writeFile(filePath, formatCliJson(report), "utf-8");
}

export async function writeRollbackReport(filePath: string, report: RollbackReport): Promise<void> {
  synchronizeRollbackReport(report);
  await writeFile(filePath, formatCliJson(report), "utf-8");
}

export function buildRollbackEntries(report: BatchReport): RollbackReportEntry[] {
  return report.entries.map((entry) => {
    if (entry.status !== "success" || !entry.id.trim() || !entry.oldTitle.trim()) {
      return {
        id: entry.id,
        oldTitle: entry.oldTitle,
        generatedTitle: entry.newTitle,
        status: "skipped",
      };
    }

    return {
      id: entry.id,
      oldTitle: entry.oldTitle,
      generatedTitle: entry.newTitle,
      status: "pending",
    };
  });
}
