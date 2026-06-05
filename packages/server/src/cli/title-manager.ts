#!/usr/bin/env node

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultProviders } from "../app.js";
import type { ConversationMeta, ConversationProvider } from "../providers/types.js";
import { detectAvailableTitleGenerationClis } from "../utils/ai.js";
import type { TitleGenerationCli } from "../utils/provider-paths.js";
import {
  formatTitleActionError,
  generateAndPersistConversationTitle,
  type GenerateConversationTitleOptions,
  normalizeTitle,
  persistConversationTitle,
} from "../services/conversation-title.js";

export type Scope = "all" | "cwd";
export type OutputFormat = "table" | "json";
export type ProjectMode = "exact" | "recursive";

export interface CliOptions {
  scope: Scope;
  search: string;
  limit: number;
  format: OutputFormat;
  projectPath: string;
  projectMode: ProjectMode;
  includeTitleSessions: boolean;
  continueOnError: boolean;
  dryRun: boolean;
  reportPath: string;
  timeoutMs?: number;
  retries?: number;
  cliPriority?: TitleGenerationCli[];
  reuseSession?: boolean;
}

interface CliContext {
  providers: ConversationProvider[];
  provider: ConversationProvider;
}

const DEFAULT_LIMIT = 20;
const TITLE_GENERATION_BADGE_LABEL = "标题生成";
const TITLE_GENERATION_CLI_SET = new Set<TitleGenerationCli>(["codex", "claude", "opencode"]);

function printHelp(): void {
  console.log(`ChatLog Viewer Codex title manager

Usage:
  clv-title [interactive] [--scope all|cwd] [--project path] [--exact|--recursive] [--search text] [--limit n]
  clv-title list [--scope all|cwd] [--project path] [--exact|--recursive] [--search text] [--limit n] [--json]
  clv-title rename <sessionId|codex:sessionId> <title>
  clv-title generate <sessionId|codex:sessionId> [--cli codex,opencode] [--timeout ms] [--retries n]
  clv-title generate-batch [--project path|--cwd path] [--exact|--recursive] [--limit n] [--json] [--continue-on-error] [--dry-run]
  clv-title rollback --report path [--json] [--continue-on-error] [--dry-run]

Examples:
  pnpm title
  pnpm title -- list --scope all --limit 30
  pnpm title -- list --project C:/Users/mortis097 --exact
  pnpm title -- rename codex:<sessionId> "新的标题"
  pnpm title -- generate codex:<sessionId>
  pnpm title -- generate-batch --project C:/Users/mortis097 --exact --json --continue-on-error
  pnpm title -- rollback --report ~/.backups/chatlog-viewer-title/2026-06-05/codex-title-generate-batch-2026-06-05-120000.json
`);
}

function normalizeId(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes(":") ? trimmed : `codex:${trimmed}`;
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
    includeTitleSessions: false,
    continueOnError: false,
    dryRun: false,
    reportPath: "",
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
    conversation.project,
    conversation.modelProvider ?? "",
    ...(conversation.badges ?? []).map((badge) => badge.label),
  ].some((value) => value.toLowerCase().includes(normalizedSearch));
}

async function createContext(): Promise<CliContext> {
  const providers = createDefaultProviders();
  const provider = providers.find((item) => item.name === "codex");
  if (!provider) {
    throw new Error("Codex provider 不可用");
  }
  if (!(await provider.detect())) {
    throw new Error(`Codex provider 不可用，存储路径: ${provider.getStoragePath()}`);
  }
  return { providers, provider };
}

async function listConversations(
  provider: ConversationProvider,
  options: CliOptions
): Promise<ConversationMeta[]> {
  const conversations = await provider.list({ eagerSearchIndex: false });
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
    console.log(JSON.stringify(conversations, null, 2));
    return;
  }

  if (conversations.length === 0) {
    console.log("没有匹配的 Codex 对话记录");
    return;
  }

  console.log(`\n${"No.".padEnd(4)} ${"Updated".padEnd(20)} ${"Provider".padEnd(12)} ${"Title".padEnd(42)} Project`);
  console.log("-".repeat(100));
  conversations.forEach((conversation, index) => {
    const provider = conversation.modelProvider ?? "-";
    const title = truncate(conversation.title || "(无标题)", 40);
    const project = truncate(conversation.project || "-", 48);
    console.log(
      `${String(index + 1).padEnd(4)} ${formatDate(conversation.updatedAt).padEnd(20)} ${provider.padEnd(12)} ${title.padEnd(42)} ${project}`
    );
  });
  console.log("\n提示：交互模式下输入序号选择对话；脚本模式可使用完整 id。");
}

async function renameConversation(
  provider: ConversationProvider,
  id: string,
  title: string
): Promise<string> {
  const normalizedId = normalizeId(id);
  const normalizedTitle = normalizeTitle(title);
  await persistConversationTitle(provider, normalizedId, normalizedTitle);
  return normalizedTitle;
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

async function generateConversationTitle(context: CliContext, id: string, options: CliOptions): Promise<string> {
  const normalizedId = normalizeId(id);
  const result = await generateAndPersistConversationTitle(
    context.providers,
    context.provider,
    normalizedId,
    buildGenerateOptions(options)
  );
  const cleanupSuffix = result.cleanedTitleSessions > 0 ? `，已清理 ${result.cleanedTitleSessions} 条内部标题会话` : "";
  console.log(`已通过 ${result.usedCli} 生成标题（attempts=${result.attempts}）${cleanupSuffix}`);
  return result.title;
}

interface BatchReportEntry {
  id: string;
  oldTitle: string;
  newTitle?: string;
  filePath?: string;
  usedCli?: string;
  attempts?: number;
  cleanedTitleSessions?: number;
  durationMs?: number;
  status: "pending" | "success" | "failed" | "dry-run";
  error?: string;
}

interface BatchReport {
  kind: "generate-batch";
  dryRun: boolean;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  projectPath?: string;
  projectMode: ProjectMode;
  detectedCliNames?: TitleGenerationCli[];
  total: number;
  success: number;
  failed: number;
  entries: BatchReportEntry[];
}

interface RollbackReportEntry {
  id: string;
  oldTitle: string;
  generatedTitle?: string;
  status: "pending" | "rolled-back" | "failed" | "dry-run" | "skipped";
  error?: string;
}

interface RollbackReport {
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

function formatBackupDate(date: Date): { day: string; stamp: string } {
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const stamp = `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return { day, stamp };
}

async function createTitleReportPath(prefix: string): Promise<string> {
  const now = new Date();
  const { day, stamp } = formatBackupDate(now);
  const dir = join(homedir(), ".backups", "chatlog-viewer-title", day);
  await mkdir(dir, { recursive: true });
  return join(dir, `codex-title-${prefix}-${stamp}.json`);
}

async function writeBatchReport(filePath: string, report: BatchReport): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

async function writeRollbackReport(filePath: string, report: RollbackReport): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

function printBatchReport(report: BatchReport, reportPath: string, options: CliOptions): void {
  if (options.format === "json") {
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
    return;
  }

  const mode = report.dryRun ? "批量生成 dry-run 完成" : "批量生成完成";
  const duration = report.durationMs === undefined ? "" : `，耗时 ${report.durationMs}ms`;
  console.log(`${mode}：成功 ${report.success}，失败 ${report.failed}，总数 ${report.total}${duration}`);
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
    }
  }
}

async function generateBatch(context: CliContext, options: CliOptions): Promise<void> {
  const conversations = await listConversations(context.provider, options);
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
    return;
  }

  for (const entry of report.entries) {
    const entryStartedAtMs = Date.now();
    try {
      const result = await generateAndPersistConversationTitle(
        context.providers,
        context.provider,
        entry.id,
        buildGenerateOptions(options, { batch: true, availableCliNames: detectedCliNames })
      );
      entry.newTitle = result.title;
      entry.usedCli = result.usedCli;
      entry.attempts = result.attempts;
      entry.cleanedTitleSessions = result.cleanedTitleSessions;
      entry.durationMs = result.durationMs;
      entry.status = "success";
      report.success += 1;
    } catch (error) {
      entry.status = "failed";
      entry.error = formatTitleActionError(error);
      entry.durationMs = Date.now() - entryStartedAtMs;
      report.failed += 1;
      await writeBatchReport(reportPath, report);
      if (!options.continueOnError) {
        report.finishedAt = new Date().toISOString();
        report.durationMs = Date.now() - startedAtMs;
        await writeBatchReport(reportPath, report);
        throw new Error(`批量生成在 ${entry.id} 失败：${entry.error}；报告：${reportPath}`);
      }
    }
    await writeBatchReport(reportPath, report);
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAtMs;
  await writeBatchReport(reportPath, report);
  printBatchReport(report, reportPath, options);
}

function isRollbackCandidate(entry: BatchReportEntry): boolean {
  return entry.status === "success" && !!entry.id.trim() && !!entry.oldTitle.trim();
}

export function buildRollbackEntries(report: BatchReport): RollbackReportEntry[] {
  return report.entries.map((entry) => {
    if (!isRollbackCandidate(entry)) {
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

async function readBatchReport(filePath: string): Promise<BatchReport> {
  const raw = await readFile(filePath, "utf-8");
  const report = JSON.parse(raw) as BatchReport;
  if (!Array.isArray(report.entries)) {
    throw new Error("报告格式无效：缺少 entries");
  }
  return report;
}

function printRollbackReport(report: RollbackReport, reportPath: string, options: CliOptions): void {
  if (options.format === "json") {
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
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
    }
  }
}

async function rollbackFromReport(context: CliContext, options: CliOptions): Promise<void> {
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
      report.skipped += 1;
      continue;
    }

    if (options.dryRun) {
      entry.status = "dry-run";
      continue;
    }

    try {
      await persistConversationTitle(context.provider, entry.id, entry.oldTitle);
      entry.status = "rolled-back";
      report.success += 1;
    } catch (error) {
      entry.status = "failed";
      entry.error = formatTitleActionError(error);
      report.failed += 1;
      await writeRollbackReport(reportPath, report);
      if (!options.continueOnError) {
        report.finishedAt = new Date().toISOString();
        report.durationMs = Date.now() - startedAtMs;
        await writeRollbackReport(reportPath, report);
        throw new Error(`回滚在 ${entry.id} 失败：${entry.error}；报告：${reportPath}`);
      }
    }

    await writeRollbackReport(reportPath, report);
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAtMs;
  await writeRollbackReport(reportPath, report);
  printRollbackReport(report, reportPath, options);
}

function printConversationDetail(conversation: ConversationMeta): void {
  console.log(`\nID: ${conversation.id}`);
  console.log(`标题: ${conversation.title}`);
  console.log(`项目: ${conversation.project}`);
  console.log(`provider: ${conversation.modelProvider ?? "-"}`);
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
    const updatedTitle = await renameConversation(context.provider, conversation.id, nextTitle);
    console.log(`已修改标题：${updatedTitle}`);
    return;
  }
  if (action === "g" || action === "generate") {
    const generatedTitle = await generateConversationTitle(context, conversation.id, {
      scope: "all",
      search: "",
      limit: DEFAULT_LIMIT,
      format: "table",
      projectPath: "",
      projectMode: "exact",
      includeTitleSessions: false,
      continueOnError: false,
      dryRun: false,
      reportPath: "",
    });
    console.log(`已写回标题：${generatedTitle}`);
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
      const conversations = await listConversations(context.provider, currentOptions);
      printConversations(conversations, currentOptions);
      const answer = (await rl.question("\n选择序号/id，或 /search 关键词、/scope all|cwd、q 退出 > ")).trim();
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

      const selectedIndex = Number.parseInt(answer, 10);
      const conversation = Number.isFinite(selectedIndex)
        ? conversations[selectedIndex - 1]
        : conversations.find((item) => item.id === normalizeId(answer));
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

  const context = await createContext();
  if (command === "interactive") {
    await runInteractive(context, options);
    return;
  }
  if (command === "list") {
    printConversations(await listConversations(context.provider, options), options);
    return;
  }
  if (command === "rename") {
    const [id, ...titleParts] = commandArgs;
    if (!id || titleParts.length === 0) {
      throw new Error("用法：clv-title rename <sessionId|codex:sessionId> <title>");
    }
    const title = await renameConversation(context.provider, id, titleParts.join(" "));
    console.log(`已修改标题：${title}`);
    return;
  }
  if (command === "generate") {
    const [id] = commandArgs;
    if (!id) {
      throw new Error("用法：clv-title generate <sessionId|codex:sessionId>");
    }
    const title = await generateConversationTitle(context, id, options);
    console.log(`已写回标题：${title}`);
    return;
  }
  if (command === "generate-batch") {
    await generateBatch(context, options);
    return;
  }
  if (command === "rollback") {
    await rollbackFromReport(context, options);
    return;
  }

  throw new Error(`未知命令：${command}`);
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(formatTitleActionError(error));
    process.exitCode = 1;
  });
}
