import { Hono } from "hono";
import type { ConversationProvider, ConversationMeta } from "../providers/types.js";
import { CodexProvider } from "../providers/codex.js";
import { getAllTitles, getTitle, setTitle, deleteTitle } from "../utils/title-store.js";
import { generateTitle, getAvailableClis } from "../utils/ai.js";
import { logProviderError } from "../utils/logger.js";

export function createConversationRoutes(providers: ConversationProvider[]) {
  const app = new Hono();

  // 可用 provider 列表
  app.get("/providers", async (c) => {
    const list = await Promise.all(
      providers.map(async (p) => ({
        name: p.name,
        displayName: p.displayName,
        available: await p.detect(),
        storagePath: p.getStoragePath(),
      }))
    );
    return c.json(list);
  });

  // 对话列表
  app.get("/conversations", async (c) => {
    const providerFilter = c.req.query("provider");
    const search = c.req.query("search")?.toLowerCase();
    const sort = c.req.query("sort") || "updatedAt";
    const modelProviderFilter = c.req.query("modelProvider");

    let activeProviders = providers;
    if (providerFilter !== undefined) {
      const providerNames = providerFilter
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      activeProviders = providerNames.length > 0
        ? providers.filter((p) => providerNames.includes(p.name))
        : [];
    }

    const allConversations: ConversationMeta[] = [];
    const customTitles = await getAllTitles();
    for (const provider of activeProviders) {
      try {
        if (!(await provider.detect())) continue;
        const convos = await provider.list();
        allConversations.push(
          ...convos.map((conv) => ({
            ...conv,
            title: customTitles[conv.id] ?? conv.title,
          }))
        );
      } catch (error) {
        logProviderError("conversations.list", provider.name, error);
      }
    }

    let filtered = allConversations;

    // 按 modelProvider 筛选（仅 Codex）
    if (modelProviderFilter !== undefined) {
      const mpSet = new Set(
        modelProviderFilter
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
      );
      filtered = filtered.filter((c) => {
        if (c.provider !== "codex") return true;
        if (!c.modelProvider) return true;
        return mpSet.has(c.modelProvider);
      });
    }

    if (search) {
      filtered = filtered.filter(
        (c) =>
          c.title.toLowerCase().includes(search) ||
          c.project.toLowerCase().includes(search)
      );
    }

    // 排序
    if (sort === "createdAt") {
      filtered.sort((a, b) => b.createdAt - a.createdAt);
    } else if (sort === "provider") {
      filtered.sort((a, b) => a.provider.localeCompare(b.provider));
    } else {
      filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    return c.json({
      total: filtered.length,
      conversations: filtered,
    });
  });

  // 对话详情
  app.get("/conversations/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const providerName = id.split(":")[0];
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);

    const limitParam = c.req.query("limit");
    const beforeParam = c.req.query("before");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    const before = beforeParam ? Number.parseInt(beforeParam, 10) : undefined;

    try {
      const conversation = await provider.read(id, {
        limit: Number.isFinite(limit) && limit! > 0 ? limit : undefined,
        before: Number.isFinite(before) && before! >= 0 ? before : undefined,
      });
      const customTitle = await getTitle(id);
      if (customTitle) conversation.title = customTitle;
      return c.json(conversation);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  // 删除对话
  app.delete("/conversations/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const providerName = id.split(":")[0];
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);

    try {
      await provider.delete(id);
      await deleteTitle(id);
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // 修改标题
  app.put("/conversations/:id/title", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const body = await c.req.json<{ title: string }>();
    if (!body.title?.trim()) return c.json({ error: "标题不能为空" }, 400);

    await setTitle(id, body.title.trim());
    return c.json({ success: true, title: body.title.trim() });
  });

  // AI 生成标题
  app.post("/conversations/:id/generate-title", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const providerName = id.split(":")[0];
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);

    try {
      const conversation = await provider.read(id);
      const result = await generateTitle(conversation.messages);
      // 自动保存生成的标题
      await setTitle(id, result.title);
      return c.json({ success: true, title: result.title, usedCli: result.usedCli });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // 移动对话到另一个项目文件夹
  app.post("/conversations/:id/move", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const providerName = id.split(":")[0];
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return c.json({ error: "未知的 provider" }, 404);
    if (!provider.move) return c.json({ error: `${provider.displayName} 不支持移动对话` }, 400);

    const body = await c.req.json<{ targetProjectKey: string }>();
    if (!body.targetProjectKey?.trim()) return c.json({ error: "目标文件夹不能为空" }, 400);

    try {
      await provider.move(id, body.targetProjectKey.trim());
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // 列出某个 provider 的所有项目文件夹
  app.get("/projects", async (c) => {
    const providerFilter = c.req.query("provider");
    const result: { provider: string; projectKey: string; displayName: string }[] = [];

    for (const p of providers) {
      if (providerFilter && p.name !== providerFilter) continue;
      if (!p.listProjects) continue;
      try {
        const projects = await p.listProjects();
        for (const pk of projects) {
          result.push({
            provider: p.name,
            projectKey: pk,
            displayName: pk,
          });
        }
      } catch (error) {
        logProviderError("projects.list", p.name, error);
      }
    }
    return c.json(result);
  });

  // 可用的 AI CLI 工具
  app.get("/ai/clis", async (c) => {
    const clis = await getAvailableClis();
    return c.json(clis);
  });

  // Codex model_provider 列表
  app.get("/codex-providers", (c) => {
    const codex = providers.find((p) => p.name === "codex") as CodexProvider | undefined;
    if (!codex) return c.json([]);
    return c.json(codex.listModelProviders());
  });

  // 修改 Codex 对话的 model_provider
  app.put("/conversations/:id/model-provider", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    if (!id.startsWith("codex:")) {
      return c.json({ error: "仅支持修改 Codex 对话的 model provider" }, 400);
    }

    const codex = providers.find((p) => p.name === "codex") as CodexProvider | undefined;
    if (!codex) return c.json({ error: "Codex provider 不可用" }, 404);

    const body = await c.req.json<{ modelProvider: string }>();
    if (!body.modelProvider?.trim()) {
      return c.json({ error: "model provider 不能为空" }, 400);
    }

    try {
      await codex.changeModelProvider(id, body.modelProvider.trim());
      return c.json({ success: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  return app;
}
