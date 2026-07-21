#!/usr/bin/env node

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultProviders } from "../app.js";
import type { ConversationMeta, ConversationProvider } from "../providers/types.js";
import { closeCodexAppServerClients } from "../providers/codex-app-server.js";
import { detectAvailableTitleGenerationClis } from "../utils/ai.js";
import type { TitleGenerationCli } from "../utils/provider-paths.js";
import {
  formatTitleActionError,
  generateAndPersistConversationTitle,
  type GenerateConversationTitleOptions,
  normalizeTitle,
  persistConversationTitle,
} from "../services/conversation-title.js";
import {
  buildRollbackEntries,
  buildTitleCliJsonResult,
  createTitleReportPath,
  formatCliJson,
  synchronizeBatchReport,
  synchronizeRollbackReport,
  writeBatchReport,
  writeRollbackReport,
  TITLE_CLI_SCHEMA_VERSION,
  type BatchReport,
  type ManagedProviderName,
  type ProjectMode,
  type ProviderSelection,
  type RollbackReport,
  type RollbackReportEntry,
  type TitleCliSummary,
} from "./title-report.js";

export {
  buildRollbackEntries,
  buildTitleCliJsonResult,
  formatCliJson,
  summarizeTitleEntries,
  TITLE_CLI_SCHEMA_VERSION,
} from "./title-report.js";
export type {
  BatchReport,
  BatchReportEntry,
  ManagedProviderName,
  ProjectMode,
  ProviderSelection,
  RollbackReport,
  RollbackReportEntry,
  TitleCliCommand,
  TitleCliSummary,
} from "./title-report.js";

export type Scope = "all" | "cwd";
export type OutputFormat = "table" | "json";

export interface CliOptions {
  scope: Scope;
  search: string;
  limit: number;
  format: OutputFormat;
  projectPath: string;
  projectMode: ProjectMode;
  provider: ProviderSelection;
  includeTitleSessions: boolean;
  continueOnError: boolean;
  dryRun: boolean;
  reportPath: string;
  timeoutMs?: number;
  retries?: number;
  cliPriority?: TitleGenerationCli[];
  reuseSession?: boolean;
  force: boolean;
}

interface CliContext {
  providers: ConversationProvider[];
  managedProviders: Map<ManagedProviderName, ConversationProvider>;
  availableProviderNames: Set<ManagedProviderName>;
}

const DEFAULT_LIMIT = 20;
const TITLE_GENERATION_BADGE_LABEL = "标题生成";
const TITLE_GENERATION_CLI_SET = new Set<TitleGenerationCli>(["codex", "claude", "opencode"]);
const MANAGED_PROVIDER_NAMES: ManagedProviderName[] = ["codex", "claude-code", "opencode"];
const MANAGED_PROVIDER_SET = new Set<ManagedProviderName>(MANAGED_PROVIDER_NAMES);

function printHelp(): void {
  console.log(`ChatLog Viewer title manager

Usage:
  clv-title [interactive] [--provider codex|claude-code|opencode|all] [--scope all|cwd] [--project path] [--exact|--recursive] [--search text] [--limit n]
  clv-title list [--provider codex|claude-code|opencode|all] [--scope all|cwd] [--project path] [--exact|--recursive] [--search text] [--limit n] [--json]
  clv-title rename <sessionId|provider:sessionId> <title> [--provider codex|claude-code|opencode] [--json]
  clv-title generate <sessionId|provider:sessionId> [--provider codex|claude-code|opencode] [--cli opencode,codex,claude] [--timeout ms] [--retries n] [--json]
  clv-title generate-batch [--provider codex|claude-code|opencode|all] [--project path|--cwd path] [--exact|--recursive] [--limit n] [--json] [--continue-on-error] [--dry-run]
  clv-title rollback --report path [--json] [--continue-on-error] [--dry-run] [--force]

Examples:
  pnpm title
  pnpm title -- list --provider all --scope all --limit 30
  pnpm title -- list --project C:/Users/mortis097 --exact
  pnpm title -- rename codex:<sessionId> "新的标题"
  pnpm title -- rename claude-code:<sessionId> "新的标题"
  pnpm title -- generate opencode:<sessionId> --cli opencode,codex
  pnpm title -- generate-batch --provider all --project C:/Users/mortis097 --exact --json --continue-on-error
  pnpm title -- rollback --report ~/.backups/chatlog-viewer-title/2026-06-05/conversation-title-generate-batch-2026-06-05-120000.json
`);
}

function parseProviderSelection(value: string | undefined): ProviderSelection | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "claude") return "claude-code";
  if (normalized === "open-code") return "opencode";
  if (normalized === "all" || MANAGED_PROVIDER_SET.has(normalized as ManagedProviderName)) {
    return normalized as ProviderSelection;
  }
  return null;
}

export function normalizeConversationId(value: string, defaultProvider: ProviderSelection = "codex"): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("对话 ID 不能为空");
  if (!trimmed.includes(":")) {
    if (defaultProvider === "all") {
      throw new Error("--provider all 时必须使用带 provider 前缀的完整对话 ID");
    }
    return `${defaultProvider}:${trimmed}`;
  }

  const separatorIndex = trimmed.indexOf(":");
  const providerName = parseProviderSelection(trimmed.slice(0, separatorIndex));
  const sessionId = trimmed.slice(separatorIndex + 1).trim();
  if (!providerName || providerName === "all" || !sessionId) {
    throw new Error(`不支持的对话 ID：${trimmed}`);
  }
  return `${providerName}:${sessionId}`;
}

function normalizePathForCompare(value: string | undefined): string {
  return (value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .trim()
    .toLowerCase();
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseCliPriority(value: string | undefined): TitleGenerationCli[] | undefined {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const priority = items.filter((item): item is TitleGenerationCli => TITLE_GENERATION_CLI_SET.has(item as TitleGenerationCli));
  return priority.length > 0 ? priority : undefined;
}

export function parseArgs(args: string[]): { command: string; commandArgs: string[]; options: CliOptions; help: boolean } {
  const options: CliOptions = {
    scope: "all",
    search: "",
    limit: DEFAULT_LIMIT,
    format: "table",
    projectPath: "",
    projectMode: "exact",
    provider: "codex",
    includeTitleSessions: false,
    continueOnError: false,
    dryRun: false,
    reportPath: "",
    force: false,
  };
  const commandArgs: string[] = [];
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--scope") {
      const value = args[index + 1];
      if (value === "all" || value === "cwd") {
        options.scope = value;
      }
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      const provider = parseProviderSelection(args[index + 1]);
      if (!provider) {
        throw new Error("provider 只能是 codex、claude-code、opencode 或 all");
      }
      options.provider = provider;
      index += 1;
      continue;
    }
    if (arg === "--cwd") {
      options.scope = "cwd";
      const next = args[index + 1];
      if (next && !next.startsWith("-")) {
        options.projectPath = next;
        index += 1;
      }
      continue;
    }
    if (arg === "--project") {
      options.projectPath = args[index + 1]?.trim() ?? "";
      options.scope = "cwd";
      index += 1;
      continue;
    }
    if (arg === "--exact") {
      options.projectMode = "exact";
      continue;
    }
    if (arg === "--recursive") {
      options.projectMode = "recursive";
      continue;
    }
    if (arg === "--all") {
      options.scope = "all";
      continue;
    }
    if (arg === "--search" || arg === "-s") {
      options.search = args[index + 1]?.trim() ?? "";
      index += 1;
      continue;
    }
    if (arg === "--limit" || arg === "-n") {
      options.limit = parsePositiveInteger(args[index + 1], options.limit);
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.format = "json";
      continue;
    }
    if (arg === "--include-title-sessions") {
      options.includeTitleSessions = true;
      continue;
    }
    if (arg === "--continue-on-error") {
      options.continueOnError = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--report") {
      options.reportPath = args[index + 1]?.trim() ?? "";
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      options.timeoutMs = parseOptionalPositiveInteger(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--retries") {
      options.retries = parsePositiveInteger(args[index + 1], 0);
      index += 1;
      continue;
    }
    if (arg === "--cli") {
      options.cliPriority = parseCliPriority(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--fresh") {
      options.reuseSession = false;
      continue;
    }
    if (arg === "--reuse-session") {
      options.reuseSession = true;
      continue;
    }
    commandArgs.push(arg);
  }

  const [command = "interactive", ...rest] = commandArgs;
  return { command, commandArgs: rest, options, help };
}

function formatDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
  return new Date(timestamp).toLocaleString();
}

function writeCliJson(value: unknown): void {
  process.stdout.write(formatCliJson(value));
}

function writeCliJsonError(command: string, error: unknown): void {
  process.stderr.write(formatCliJson({
    schemaVersion: TITLE_CLI_SCHEMA_VERSION,
    command,
    ok: false,
    summary: {
      total: 1,
      success: 0,
      failed: 1,
      skipped: 0,
    } satisfies TitleCliSummary,
    error: formatTitleActionError(error),
  }));
}

function truncate(value: string, maxLength: number): string {
  const chars = [...value.replace(/\s+/g, " ").trim()];
  if (chars.length <= maxLength) return chars.join("");
  return `${chars.slice(0, Math.max(1, maxLength - 1)).join("")}…`;
}

function matchesScope(conversation: ConversationMeta, options: CliOptions): boolean {
  if (options.projectPath.trim()) return true;
  if (options.scope === "all") return true;
  const cwd = normalizePathForCompare(process.env.INIT_CWD || process.cwd());
  return [
    conversation.project,
    conversation.projectId,
  ].some((value) => normalizePathForCompare(value) === cwd);
}

function resolveProjectPath(options: CliOptions): string {
  if (options.projectPath.trim()) {
    return resolve(options.projectPath.trim());
  }
  return resolve(process.env.INIT_CWD || process.cwd());
}

function resolveUserPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export function matchesProject(conversation: ConversationMeta, options: CliOptions): boolean {
  if (options.scope === "all" && !options.projectPath.trim()) return true;

  const project = normalizePathForCompare(resolveProjectPath(options));
  const values = [
    conversation.project,
    conversation.projectId,
    conversation.projectKey,
  ].map((value) => normalizePathForCompare(value));

  if (options.projectMode === "exact") {
    return values.some((value) => value === project);
  }

  return values.some((value) => value === project || value.startsWith(`${project}/`));
}

export function isTitleGenerationConversation(conversation: ConversationMeta): boolean {
  return conversation.badges?.some((badge) => badge.label === TITLE_GENERATION_BADGE_LABEL) ?? false;
}

function matchesSearch(conversation: ConversationMeta, search: string): boolean {
  const normalizedSearch = search.trim().toLowerCase();
  if (!normalizedSearch) return true;
  return [
    conversation.title,
    conversation.id,
    conversation.provider,
    conversation.project,
    conversation.modelProvider ?? "",
    ...(conversation.badges ?? []).map((badge) => badge.label),
  ].some((value) => value.toLowerCase().includes(normalizedSearch));
}

async function createContext(selection: ProviderSelection): Promise<CliContext> {
  const providers = createDefaultProviders();
  const managedProviders = new Map<ManagedProviderName, ConversationProvider>();
  for (const providerName of MANAGED_PROVIDER_NAMES) {
    const provider = providers.find((item) => item.name === providerName);
    if (provider) managedProviders.set(providerName, provider);
  }

  const namesToDetect = selection === "all" ? MANAGED_PROVIDER_NAMES : [selection];
  const detectionResults = await Promise.all(namesToDetect.map(async (providerName) => {
    const provider = managedProviders.get(providerName);
    if (!provider) return { providerName, available: false };
    try {
      return { providerName, available: await provider.detect() };
    } catch {
      return { providerName, available: false };
    }
  }));
  const availableProviderNames = new Set(
    detectionResults
      .filter((item) => item.available)
      .map((item) => item.providerName)
  );
  return { providers, managedProviders, availableProviderNames };
}

function getProviderForId(context: CliContext, id: string): ConversationProvider {
  const providerName = id.slice(0, id.indexOf(":")) as ManagedProviderName;
  const provider = context.managedProviders.get(providerName);
  if (!provider || !context.availableProviderNames.has(providerName)) {
    const storagePath = provider?.getStoragePath();
    throw new Error(
      `${provider?.displayName ?? providerName} provider 不可用${storagePath ? `，存储路径: ${storagePath}` : ""}`
    );
  }
  return provider;
}

function getSelectedProviders(context: CliContext, selection: ProviderSelection): ConversationProvider[] {
  const names = selection === "all" ? MANAGED_PROVIDER_NAMES : [selection];
  const selected = names.flatMap((providerName) => {
    const provider = context.managedProviders.get(providerName);
    return provider && context.availableProviderNames.has(providerName) ? [provider] : [];
  });
  if (selected.length === 0) {
    throw new Error(`没有可用的目标 provider：${selection}`);
  }
  return selected;
}

function resolveContextSelection(
  command: string,
  commandArgs: string[],
  options: CliOptions
): ProviderSelection {
  if (command === "list" || command === "generate-batch") {
    return options.provider;
  }
  if ((command === "rename" || command === "generate") && commandArgs[0]) {
    const id = normalizeConversationId(commandArgs[0], options.provider);
    return id.slice(0, id.indexOf(":")) as ManagedProviderName;
  }
  return "all";
}

async function listConversations(context: CliContext, options: CliOptions): Promise<ConversationMeta[]> {
  const selectedProviders = getSelectedProviders(context, options.provider);
  const conversations = (
    await Promise.all(selectedProviders.map((provider) => provider.list({ eagerSearchIndex: false })))
  ).flat();
  return filterConversations(conversations, options);
}

export function filterConversations(
  conversations: ConversationMeta[],
  options: CliOptions
): ConversationMeta[] {
  return conversations
    .filter((conversation) => matchesScope(conversation, options))
    .filter((conversation) => matchesProject(conversation, options))
    .filter((conversation) => options.includeTitleSessions || !isTitleGenerationConversation(conversation))
    .filter((conversation) => matchesSearch(conversation, options.search))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, options.limit);
}

function printConversations(conversations: ConversationMeta[], options: CliOptions): void {
  if (options.format === "json") {
    writeCliJson(conversations);
    return;
  }

  if (conversations.length === 0) {
    console.log("没有匹配的对话记录");
    return;
  }

  console.log(`\n${"No.".padEnd(4)} ${"Updated".padEnd(20)} ${"Source".padEnd(13)} ${"Model".padEnd(12)} ${"Title".padEnd(42)} Project`);
  console.log("-".repeat(114));
  conversations.forEach((conversation, index) => {
    const source = conversation.provider;
    const modelProvider = conversation.modelProvider ?? "-";
    const title = truncate(conversation.title || "(无标题)", 40);
    const project = truncate(conversation.project || "-", 48);
    console.log(
      `${String(index + 1).padEnd(4)} ${formatDate(conversation.updatedAt).padEnd(20)} ${source.padEnd(13)} ${modelProvider.padEnd(12)} ${title.padEnd(42)} ${project}`
    );
  });
  console.log("\n提示：交互模式下输入序号选择对话；脚本模式可使用完整 id。");
}

function printSingleTitleResult(
  command: "rename" | "generate",
  entry: {
    id: string;
    oldTitle: string;
    newTitle: string;
    status: "success";
    usedCli?: string;
    attempts?: number;
    cleanedTitleSessions?: number;
    durationMs?: number;
  },
  options: CliOptions
): void {
  const result = buildTitleCliJsonResult(command, [entry]);
  if (options.format === "json") {
    writeCliJson(result);
    return;
  }

  if (command === "rename") {
    console.log(`已修改标题：${entry.newTitle}`);
    return;
  }

  const cleanupSuffix = entry.cleanedTitleSessions
    ? `，已清理 ${entry.cleanedTitleSessions} 条内部标题会话`
    : "";
  console.log(
    `已通过 ${entry.usedCli} 生成标题（attempts=${entry.attempts}，耗时 ${entry.durationMs}ms）${cleanupSuffix}`
  );
  console.log(`已写回标题：${entry.newTitle}`);
}

async function renameConversation(
  context: CliContext,
  id: string,
  title: string,
  defaultProvider: ProviderSelection
): Promise<{
  id: string;
  oldTitle: string;
  newTitle: string;
  status: "success";
}> {
  const normalizedId = normalizeConversationId(id, defaultProvider);
  const provider = getProviderForId(context, normalizedId);
  const oldTitle = (await provider.read(normalizedId, { limit: 1 })).title;
  const normalizedTitle = normalizeTitle(title);
  await persistConversationTitle(provider, normalizedId, normalizedTitle);
  return {
    id: normalizedId,
    oldTitle,
    newTitle: normalizedTitle,
    status: "success",
  };
}

function buildGenerateOptions(
  options: CliOptions,
  defaults: { batch?: boolean; availableCliNames?: TitleGenerationCli[] } = {}
): GenerateConversationTitleOptions {
  return {
    priority: options.cliPriority,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    reuseSession: options.reuseSession ?? (defaults.batch ? false : undefined),
    availableCliNames: defaults.availableCliNames,
  };
}

async function generateConversationTitle(
  context: CliContext,
  id: string,
  options: CliOptions
): Promise<{
  id: string;
  oldTitle: string;
  newTitle: string;
  usedCli: string;
  attempts: number;
  cleanedTitleSessions: number;
  durationMs: number;
  status: "success";
}> {
  const normalizedId = normalizeConversationId(id, options.provider);
  const provider = getProviderForId(context, normalizedId);
  const result = await generateAndPersistConversationTitle(
    context.providers,
    provider,
    normalizedId,
    buildGenerateOptions(options)
  );
  return {
    id: normalizedId,
    oldTitle: result.oldTitle,
    newTitle: result.title,
    usedCli: result.usedCli,
    attempts: result.attempts,
    cleanedTitleSessions: result.cleanedTitleSessions,
    durationMs: result.durationMs,
    status: "success",
  };
}

export async function applyRollbackEntry(
  provider: ConversationProvider,
  entry: RollbackReportEntry,
  force = false
): Promise<void> {
  try {
    await persistConversationTitle(provider, entry.id, entry.oldTitle, {
      expectedTitle: entry.generatedTitle,
      force,
    });
    entry.status = "rolled-back";
    delete entry.error;
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 409) {
      entry.status = "skipped-conflict";
      entry.error = formatTitleActionError(error);
      return;
    }
    entry.status = "failed";
    entry.error = formatTitleActionError(error);
  }
}

function printBatchReport(report: BatchReport, reportPath: string, options: CliOptions): void {
  synchronizeBatchReport(report);
  if (options.format === "json") {
    writeCliJson({ ...report, reportPath });
    return;
  }

  const mode = report.dryRun ? "批量生成 dry-run 完成" : "批量生成完成";
  const duration = report.durationMs === undefined ? "" : `，耗时 ${report.durationMs}ms`;
  console.log(
    `${mode}：成功 ${report.success}，失败 ${report.failed}，跳过 ${report.skipped ?? 0}，总数 ${report.total}${duration}`
  );
  if (report.detectedCliNames?.length) {
    console.log(`可用 AI CLI：${report.detectedCliNames.join(", ")}`);
  }
  console.log(`备份/报告：${reportPath}`);
  for (const entry of report.entries) {
    if (entry.status === "success") {
      const durationText = entry.durationMs === undefined ? "" : `, ${entry.durationMs}ms`;
      console.log(`OK ${entry.id} ${entry.oldTitle} -> ${entry.newTitle} (${entry.usedCli}, attempts=${entry.attempts}${durationText})`);
    } else if (entry.status === "dry-run") {
      console.log(`DRY ${entry.id} ${entry.oldTitle}`);
    } else if (entry.status === "failed") {
      console.log(`FAIL ${entry.id} ${entry.oldTitle}: ${entry.error}`);
    } else if (entry.status === "skipped") {
      console.log(`SKIP ${entry.id} ${entry.oldTitle}: ${entry.error ?? "未处理"}`);
    }
  }
}

function markPendingBatchEntriesSkipped(report: BatchReport, reason: string): void {
  for (const entry of report.entries) {
    if (entry.status !== "pending") continue;
    entry.status = "skipped";
    entry.error = reason;
  }
}

async function generateBatch(context: CliContext, options: CliOptions): Promise<BatchReport> {
  const conversations = await listConversations(context, options);
  const reportPath = await createTitleReportPath("generate-batch");
  const startedAtMs = Date.now();
  const detectedCliNames = options.dryRun
    ? []
    : await detectAvailableTitleGenerationClis(options.cliPriority);
  const report: BatchReport = {
    kind: "generate-batch",
    dryRun: options.dryRun,
    startedAt: new Date().toISOString(),
    projectPath: options.scope === "cwd" || options.projectPath ? resolveProjectPath(options) : undefined,
    projectMode: options.projectMode,
    provider: options.provider,
    detectedCliNames,
    total: conversations.length,
    success: 0,
    failed: 0,
    entries: conversations.map((conversation) => ({
      id: conversation.id,
      oldTitle: conversation.title,
      filePath: conversation.filePath,
      status: options.dryRun ? "dry-run" : "pending",
    })),
  };
  await writeBatchReport(reportPath, report);

  if (options.dryRun) {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - startedAtMs;
    await writeBatchReport(reportPath, report);
    printBatchReport(report, reportPath, options);
    return report;
  }

  for (const entry of report.entries) {
    const entryStartedAtMs = Date.now();
    try {
      const result = await generateAndPersistConversationTitle(
        context.providers,
        getProviderForId(context, entry.id),
        entry.id,
        buildGenerateOptions(options, { batch: true, availableCliNames: detectedCliNames })
      );
      entry.newTitle = result.title;
      entry.usedCli = result.usedCli;
      entry.attempts = result.attempts;
      entry.cleanedTitleSessions = result.cleanedTitleSessions;
      entry.durationMs = result.durationMs;
      entry.status = "success";
    } catch (error) {
      entry.status = "failed";
      entry.error = formatTitleActionError(error);
      entry.durationMs = Date.now() - entryStartedAtMs;
      await writeBatchReport(reportPath, report);
      if (!options.continueOnError) {
        markPendingBatchEntriesSkipped(
          report,
          `前序条目 ${entry.id} 失败，且未启用 --continue-on-error`
        );
        break;
      }
    }
    await writeBatchReport(reportPath, report);
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAtMs;
  await writeBatchReport(reportPath, report);
  printBatchReport(report, reportPath, options);
  return report;
}

async function readBatchReport(filePath: string): Promise<BatchReport> {
  const raw = await readFile(filePath, "utf-8");
  const report = JSON.parse(raw) as BatchReport;
  if (!Array.isArray(report.entries)) {
    throw new Error("报告格式无效：缺少 entries");
  }
  return report;
}

function printRollbackReport(report: RollbackReport, reportPath: string, options: CliOptions): void {
  synchronizeRollbackReport(report);
  if (options.format === "json") {
    writeCliJson({ ...report, reportPath });
    return;
  }

  const mode = report.dryRun ? "回滚 dry-run 完成" : "回滚完成";
  const duration = report.durationMs === undefined ? "" : `，耗时 ${report.durationMs}ms`;
  console.log(`${mode}：成功 ${report.success}，失败 ${report.failed}，跳过 ${report.skipped}，总数 ${report.total}${duration}`);
  console.log(`回滚报告：${reportPath}`);
  for (const entry of report.entries) {
    if (entry.status === "rolled-back") {
      console.log(`OK ${entry.id} -> ${entry.oldTitle}`);
    } else if (entry.status === "dry-run") {
      console.log(`DRY ${entry.id} ${entry.generatedTitle ?? "-"} -> ${entry.oldTitle}`);
    } else if (entry.status === "failed") {
      console.log(`FAIL ${entry.id}: ${entry.error}`);
    } else if (entry.status === "skipped-conflict") {
      console.log(`SKIP ${entry.id}: ${entry.error}`);
    }
  }
}

function markPendingRollbackEntriesSkipped(report: RollbackReport, reason: string): void {
  for (const entry of report.entries) {
    if (entry.status !== "pending") continue;
    entry.status = "skipped";
    entry.error = reason;
  }
}

async function rollbackFromReport(context: CliContext, options: CliOptions): Promise<RollbackReport> {
  if (!options.reportPath.trim()) {
    throw new Error("用法：clv-title rollback --report <generate-batch-report.json>");
  }

  const sourceReportPath = resolveUserPath(options.reportPath);
  const sourceReport = await readBatchReport(sourceReportPath);
  const reportPath = await createTitleReportPath("rollback");
  const startedAtMs = Date.now();
  const report: RollbackReport = {
    kind: "rollback",
    dryRun: options.dryRun,
    sourceReportPath,
    startedAt: new Date().toISOString(),
    total: sourceReport.entries.length,
    success: 0,
    failed: 0,
    skipped: 0,
    entries: buildRollbackEntries(sourceReport),
  };
  await writeRollbackReport(reportPath, report);

  for (const entry of report.entries) {
    if (entry.status === "skipped") {
      continue;
    }

    if (options.dryRun) {
      entry.status = "dry-run";
      continue;
    }

    try {
      const normalizedId = normalizeConversationId(entry.id, "all");
      const appliedEntry = { ...entry, id: normalizedId };
      await applyRollbackEntry(getProviderForId(context, normalizedId), appliedEntry, options.force);
      entry.status = appliedEntry.status;
      entry.error = appliedEntry.error;
    } catch (error) {
      entry.status = "failed";
      entry.error = formatTitleActionError(error);
    }

    if (entry.status === "skipped-conflict") {
      await writeRollbackReport(reportPath, report);
      continue;
    }
    if (entry.status === "failed") {
      await writeRollbackReport(reportPath, report);
      if (!options.continueOnError) {
        markPendingRollbackEntriesSkipped(
          report,
          `前序条目 ${entry.id} 失败，且未启用 --continue-on-error`
        );
        break;
      }
    }

    await writeRollbackReport(reportPath, report);
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAtMs;
  await writeRollbackReport(reportPath, report);
  printRollbackReport(report, reportPath, options);
  return report;
}

function printConversationDetail(conversation: ConversationMeta): void {
  console.log(`\nID: ${conversation.id}`);
  console.log(`标题: ${conversation.title}`);
  console.log(`项目: ${conversation.project}`);
  console.log(`来源: ${conversation.provider}`);
  console.log(`model provider: ${conversation.modelProvider ?? "-"}`);
  console.log(`消息数: ${conversation.messageCount}`);
  console.log(`更新时间: ${formatDate(conversation.updatedAt)}`);
  console.log(`状态: ${conversation.contentStatus ?? "full"}`);
  console.log(`文件: ${conversation.filePath || "-"}`);
  if (conversation.badges?.length) {
    console.log(`标记: ${conversation.badges.map((badge) => badge.label).join(", ")}`);
  }
}

async function runActionMenu(
  context: CliContext,
  conversation: ConversationMeta,
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  printConversationDetail(conversation);
  const action = (await rl.question("\n操作：[r]修改标题 [g]AI生成标题 [v]重新显示详情 [b]返回 > ")).trim().toLowerCase();
  if (action === "r" || action === "rename") {
    const nextTitle = await rl.question("新标题 > ");
    const result = await renameConversation(context, conversation.id, nextTitle, conversation.provider as ManagedProviderName);
    console.log(`已修改标题：${result.newTitle}`);
    return;
  }
  if (action === "g" || action === "generate") {
    const result = await generateConversationTitle(context, conversation.id, {
      scope: "all",
      search: "",
      limit: DEFAULT_LIMIT,
      format: "table",
      projectPath: "",
      projectMode: "exact",
      provider: conversation.provider as ManagedProviderName,
      includeTitleSessions: false,
      continueOnError: false,
      dryRun: false,
      reportPath: "",
      force: false,
    });
    const cleanupSuffix = result.cleanedTitleSessions > 0
      ? `，已清理 ${result.cleanedTitleSessions} 条内部标题会话`
      : "";
    console.log(`已通过 ${result.usedCli} 生成标题（attempts=${result.attempts}）${cleanupSuffix}`);
    console.log(`已写回标题：${result.newTitle}`);
    return;
  }
  if (action === "v" || action === "view") {
    printConversationDetail(conversation);
  }
}

async function runInteractive(context: CliContext, options: CliOptions): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    let currentOptions = { ...options };

    while (true) {
      const conversations = await listConversations(context, currentOptions);
      printConversations(conversations, currentOptions);
      const answer = (await rl.question("\n选择序号/id，或 /search 关键词、/scope all|cwd、/provider codex|claude-code|opencode|all、q 退出 > ")).trim();
      if (!answer || answer === "q" || answer === "quit" || answer === "exit") break;
      if (answer.startsWith("/search")) {
        currentOptions = { ...currentOptions, search: answer.slice("/search".length).trim() };
        continue;
      }
      if (answer.startsWith("/scope")) {
        const nextScope = answer.slice("/scope".length).trim();
        if (nextScope === "all" || nextScope === "cwd") {
          currentOptions = { ...currentOptions, scope: nextScope };
        } else {
          console.log("scope 只能是 all 或 cwd");
        }
        continue;
      }
      if (answer.startsWith("/provider")) {
        const nextProvider = parseProviderSelection(answer.slice("/provider".length).trim());
        if (nextProvider) {
          currentOptions = { ...currentOptions, provider: nextProvider };
        } else {
          console.log("provider 只能是 codex、claude-code、opencode 或 all");
        }
        continue;
      }

      const selectedIndex = Number.parseInt(answer, 10);
      const conversation = Number.isFinite(selectedIndex)
        ? conversations[selectedIndex - 1]
        : conversations.find((item) => {
            try {
              return item.id === normalizeConversationId(answer, currentOptions.provider);
            } catch {
              return false;
            }
          });
      if (!conversation) {
        console.log("未找到对应对话");
        continue;
      }
      await runActionMenu(context, conversation, rl);
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { command, commandArgs, options, help } = parseArgs(process.argv.slice(2));
  if (help || command === "help") {
    printHelp();
    return;
  }

  const context = await createContext(resolveContextSelection(command, commandArgs, options));
  if (command === "interactive") {
    await runInteractive(context, options);
    return;
  }
  if (command === "list") {
    printConversations(await listConversations(context, options), options);
    return;
  }
  if (command === "rename") {
    const [id, ...titleParts] = commandArgs;
    if (!id || titleParts.length === 0) {
      throw new Error("用法：clv-title rename <sessionId|provider:sessionId> <title>");
    }
    const result = await renameConversation(context, id, titleParts.join(" "), options.provider);
    printSingleTitleResult("rename", result, options);
    return;
  }
  if (command === "generate") {
    const [id] = commandArgs;
    if (!id) {
      throw new Error("用法：clv-title generate <sessionId|provider:sessionId>");
    }
    const result = await generateConversationTitle(context, id, options);
    printSingleTitleResult("generate", result, options);
    return;
  }
  if (command === "generate-batch") {
    const report = await generateBatch(context, options);
    if (report.ok === false) process.exitCode = 1;
    return;
  }
  if (command === "rollback") {
    const report = await rollbackFromReport(context, options);
    if (report.ok === false) process.exitCode = 1;
    return;
  }

  throw new Error(`未知命令：${command}`);
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return resolve(entrypoint) === fileURLToPath(import.meta.url);
}

function redirectConsoleDiagnosticsToStderr(): () => void {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalDebug = console.debug;
  console.log = (...args: unknown[]) => console.error(...args);
  console.warn = (...args: unknown[]) => console.error(...args);
  console.debug = (...args: unknown[]) => console.error(...args);
  return () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.debug = originalDebug;
  };
}

if (isMainModule()) {
  const restoreConsole = process.argv.includes("--json")
    ? redirectConsoleDiagnosticsToStderr()
    : () => {};
  main().catch((error: unknown) => {
    const args = process.argv.slice(2);
    const command = args.find((arg) => arg !== "--") ?? "interactive";
    if (args.includes("--json")) {
      writeCliJsonError(command.startsWith("-") ? "interactive" : command, error);
    } else {
      console.error(formatTitleActionError(error));
    }
    process.exitCode = 1;
  }).finally(async () => {
    await closeCodexAppServerClients();
    restoreConsole();
  });
}
