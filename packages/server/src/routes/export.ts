import { createReadStream } from "fs";
import { mkdtemp, open, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Readable } from "stream";
import { Hono } from "hono";
import type { ConversationProvider, Conversation, Message } from "../providers/types.js";
import { getErrorMessage } from "../utils/errors.js";
import { logProviderError } from "../utils/logger.js";

const PARTIAL_EXPORT_MESSAGE_LIMIT = 500;
const MAX_EXPORT_IDS = 500;

interface ExportFailure {
  id: string;
  error: string;
}

interface ExportMetaHeader {
  requested: number;
  exported: number;
  failed: number;
  failures: ExportFailure[];
  mode: "full" | "partial";
  truncated: number;
  messageLimit?: number;
}

interface PreparedExportFile {
  tempDir: string;
  filePath: string;
  meta: ExportMetaHeader;
}

function encodeExportMetaHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

export function createExportRoutes(providers: ConversationProvider[]) {
  const app = new Hono();

  app.post("/export", async (c) => {
    const body = await c.req.json<{
      ids?: unknown;
      format?: unknown;
      mode?: "full" | "partial";
    }>();

    if (!Array.isArray(body?.ids)) {
      return c.json({ error: "ids 必须是数组" }, 400);
    }

    const ids = [...new Set(
      body.ids
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )];
    if (ids.length === 0) return c.json({ error: "请提供要导出的对话 ID" }, 400);
    if (ids.length > MAX_EXPORT_IDS) {
      return c.json({ error: `单次最多导出 ${MAX_EXPORT_IDS} 条对话` }, 400);
    }

    if (body.format !== "json" && body.format !== "markdown") {
      return c.json({ error: "format 必须是 json 或 markdown" }, 400);
    }

    const format = body.format;
    const mode = body.mode === "partial" ? "partial" : "full";

    const prepared = await prepareExportFile({
      providers,
      ids,
      format,
      mode,
    });

    if (prepared.meta.exported === 0) {
      await rm(prepared.tempDir, { recursive: true, force: true });
      const firstFailure = prepared.meta.failures[0];
      return c.json({
        error: firstFailure?.error || "没有可导出的对话",
        failures: prepared.meta.failures,
      }, 404);
    }

    const exportMetaHeader = encodeExportMetaHeader(prepared.meta);
    const nodeStream = createReadStream(prepared.filePath);
    const cleanup = () => {
      void rm(prepared.tempDir, { recursive: true, force: true });
    };
    nodeStream.once("close", cleanup);
    nodeStream.once("error", cleanup);

    return new Response(Readable.toWeb(nodeStream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": format === "markdown"
          ? "text/markdown; charset=utf-8"
          : "application/json; charset=utf-8",
        "Content-Disposition": format === "markdown"
          ? `attachment; filename="chatlog-export.md"`
          : `attachment; filename="chatlog-export.json"`,
        "X-Export-Meta": exportMetaHeader,
      },
    });
  });

  return app;
}

async function prepareExportFile(options: {
  providers: ConversationProvider[];
  ids: string[];
  format: "json" | "markdown";
  mode: "full" | "partial";
}): Promise<PreparedExportFile> {
  const { providers, ids, format, mode } = options;
  const tempDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-export-"));
  const filePath = join(
    tempDir,
    format === "markdown" ? "chatlog-export.md" : "chatlog-export.json"
  );
  const handle = await open(filePath, "w");
  const failures: ExportFailure[] = [];
  let exported = 0;
  let truncated = 0;

  try {
    if (format === "json") {
      await handle.write("[");
    }

    for (const id of ids) {
      const providerName = id.split(":")[0];
      const provider = providers.find((item) => item.name === providerName);
      if (!provider) {
        failures.push({ id, error: `未知的 provider: ${providerName}` });
        continue;
      }

      try {
        const conversation = await provider.read(
          id,
          mode === "partial"
            ? { limit: PARTIAL_EXPORT_MESSAGE_LIMIT }
            : undefined
        );
        if (mode === "partial" && conversation.hasMore) {
          truncated++;
        }

        if (format === "markdown") {
          if (exported > 0) {
            await handle.write("\n\n---\n\n");
          }
          await handle.write(toMarkdown(conversation, mode, PARTIAL_EXPORT_MESSAGE_LIMIT));
        } else {
          if (exported > 0) {
            await handle.write(",");
          }
          await handle.write(JSON.stringify(conversation));
        }

        exported++;
      } catch (error) {
        logProviderError(`export.read:${id}`, provider.name, error);
        failures.push({ id, error: getErrorMessage(error) });
      }
    }

    if (format === "json") {
      await handle.write("]");
    }
  } finally {
    await handle.close();
  }

  return {
    tempDir,
    filePath,
    meta: {
      requested: ids.length,
      exported,
      failed: failures.length,
      failures,
      mode,
      truncated,
      messageLimit: mode === "partial" ? PARTIAL_EXPORT_MESSAGE_LIMIT : undefined,
    },
  };
}

function toMarkdown(
  conv: Conversation,
  mode: "full" | "partial",
  partialMessageLimit: number
): string {
  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push(`> Provider: ${conv.provider} | 项目: ${conv.project}`);
  lines.push(`> 创建: ${new Date(conv.createdAt).toLocaleString("zh-CN")} | 更新: ${new Date(conv.updatedAt).toLocaleString("zh-CN")}`);
  if (mode === "partial") {
    lines.push(
      conv.hasMore
        ? `> 导出模式: partial export（仅最近 ${partialMessageLimit} 条消息，本对话已截断）`
        : `> 导出模式: partial export（最多最近 ${partialMessageLimit} 条消息）`
    );
  }
  lines.push("");

  for (const msg of conv.messages) {
    lines.push(formatMessage(msg));
    lines.push("");
  }
  return lines.join("\n");
}

function formatMessage(msg: Message): string {
  const roleLabel: Record<string, string> = {
    user: "**用户**",
    assistant: "**助手**",
    system: "**系统**",
    tool: "**工具**",
  };
  const label = roleLabel[msg.role] || `**${msg.role}**`;

  if (msg.role === "tool") {
    return `${label} \`${msg.toolName}\`\n\n<details>\n<summary>输入</summary>\n\n\`\`\`json\n${msg.toolInput}\n\`\`\`\n</details>`;
  }

  return `${label}\n\n${msg.content}`;
}
