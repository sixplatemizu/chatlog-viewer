import { Hono } from "hono";
import type { ConversationProvider, Conversation, Message } from "../providers/types.js";
import { getErrorMessage } from "../utils/errors.js";
import { logProviderError } from "../utils/logger.js";

function encodeExportMetaHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

export function createExportRoutes(providers: ConversationProvider[]) {
  const app = new Hono();

  app.post("/export", async (c) => {
    const body = await c.req.json<{ ids: string[]; format: "json" | "markdown" }>();
    const { ids, format } = body;

    if (!ids?.length) return c.json({ error: "请提供要导出的对话 ID" }, 400);

    const conversations: Conversation[] = [];
    const failures: Array<{ id: string; error: string }> = [];
    for (const id of ids) {
      const providerName = id.split(":")[0];
      const provider = providers.find((p) => p.name === providerName);
      if (!provider) {
        failures.push({ id, error: `未知的 provider: ${providerName}` });
        continue;
      }
      try {
        conversations.push(await provider.read(id));
      } catch (error) {
        logProviderError(`export.read:${id}`, provider.name, error);
        failures.push({ id, error: getErrorMessage(error) });
      }
    }

    if (conversations.length === 0) {
      const firstFailure = failures[0];
      return c.json({
        error: firstFailure?.error || "没有可导出的对话",
        failures,
      }, 404);
    }

    const exportMetaHeader = encodeExportMetaHeader({
      requested: ids.length,
      exported: conversations.length,
      failed: failures.length,
      failures,
    });

    if (format === "markdown") {
      const md = conversations.map(toMarkdown).join("\n\n---\n\n");
      return c.text(md, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="chatlog-export.md"`,
        "X-Export-Meta": exportMetaHeader,
      });
    }

    return c.json(conversations, 200, {
      "Content-Disposition": `attachment; filename="chatlog-export.json"`,
      "X-Export-Meta": exportMetaHeader,
    });
  });

  return app;
}

function toMarkdown(conv: Conversation): string {
  const lines: string[] = [];
  lines.push(`# ${conv.title}`);
  lines.push(`> Provider: ${conv.provider} | 项目: ${conv.project}`);
  lines.push(`> 创建: ${new Date(conv.createdAt).toLocaleString("zh-CN")} | 更新: ${new Date(conv.updatedAt).toLocaleString("zh-CN")}`);
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
