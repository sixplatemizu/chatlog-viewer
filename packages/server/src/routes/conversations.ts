import { Hono } from "hono";
import type { ConversationProvider, ConversationMeta } from "../providers/types.js";
import { getAllTitles, getTitle, setTitle, deleteTitle } from "../utils/title-store.js";
import { generateTitle, getAvailableClis } from "../utils/ai.js";

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

    const activeProviders = providerFilter
      ? providers.filter((p) => providerFilter.split(",").includes(p.name))
      : providers;

    const allConversations: ConversationMeta[] = [];
    const customTitles = await getAllTitles();
    for (const provider of activeProviders) {
      try {
        if (!(await provider.detect())) continue;
        const convos = await provider.list();
        // 应用自定义标题覆盖
        for (const conv of convos) {
          if (customTitles[conv.id]) {
            conv.title = customTitles[conv.id];
          }
        }
        allConversations.push(...convos);
      } catch {
        // provider 失败不影响其他
      }
    }

    let filtered = allConversations;
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

    try {
      const conversation = await provider.read(id);
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
      } catch {
        // 跳过
      }
    }
    return c.json(result);
  });

  // 可用的 AI CLI 工具
  app.get("/ai/clis", async (c) => {
    const clis = await getAvailableClis();
    return c.json(clis);
  });

  return app;
}
