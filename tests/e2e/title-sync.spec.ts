import { expect, test } from "@playwright/test";

const conversationId = "codex:e2e-title-sync";

test("UI 修改标题后列表和详情保持同步", async ({ page }) => {
  let title = "原始对话标题";

  await page.route("**/api/providers", async (route) => {
    await route.fulfill({
      json: [{
        name: "codex",
        displayName: "Codex",
        available: true,
        storagePath: "C:/Users/tester/.codex/sessions",
      }],
    });
  });
  await page.route("**/api/codex-providers", async (route) => {
    await route.fulfill({ json: ["octopus"] });
  });
  await page.route("**/api/conversations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const decodedPath = decodeURIComponent(url.pathname);
    const isConversationDetail = decodedPath === `/api/conversations/${conversationId}`;
    const isTitleUpdate = decodedPath === `/api/conversations/${conversationId}/title`;

    if (isTitleUpdate && request.method() === "PUT") {
      const body = request.postDataJSON() as { title: string };
      title = body.title;
      await route.fulfill({ json: { success: true, title } });
      return;
    }

    const meta = {
      id: conversationId,
      provider: "codex",
      title,
      titleSyncMode: "native",
      capabilities: {
        canUpdateTitle: true,
        canGenerateTitle: true,
        canEditMessage: true,
        canDeleteMessage: true,
        canMoveConversation: true,
        canDeleteConversation: true,
        supportsMetadataOnly: true,
      },
      project: "C:/Users/tester/project",
      projectKey: "C:/Users/tester/project",
      projectId: "c:/users/tester/project",
      createdAt: 1_753_056_000_000,
      updatedAt: 1_753_056_001_000,
      messageCount: 2,
      fileSize: 1024,
      filePath: "C:/Users/tester/.codex/sessions/e2e-title-sync.jsonl",
      modelProvider: "octopus",
      contentStatus: "full",
    };

    if (isConversationDetail && request.method() === "GET") {
      await route.fulfill({
        json: {
          ...meta,
          messages: [
            {
              messageId: "message-1",
              role: "user",
              content: "请检查标题同步",
              editable: true,
              deletable: true,
            },
            {
              messageId: "message-2",
              role: "assistant",
              content: "标题同步检查完成",
              editable: true,
              deletable: true,
            },
          ],
        },
      });
      return;
    }

    if (decodedPath === "/api/conversations" && request.method() === "GET") {
      await route.fulfill({
        json: {
          total: 1,
          conversations: [meta],
          providerCounts: { codex: 1 },
          codexModelProviderCounts: { octopus: 1 },
          listTruncated: false,
          partialResults: false,
          warnings: [],
        },
      });
      return;
    }

    await route.fallback();
  });

  await page.goto("/");
  await expect(page.getByText("原始对话标题")).toBeVisible();

  await page.getByText("原始对话标题").first().click();
  await expect(page.getByText("请检查标题同步")).toBeVisible();

  await page.getByTitle("编辑标题").click({ force: true });
  await page.locator('input[value="原始对话标题"]').fill("新的持久化标题");
  await page.getByTitle("保存标题").click();

  await expect(page.getByText("新的持久化标题").first()).toBeVisible();
  await expect(page.getByText("标题已同步到本地 CLI")).toBeVisible();
  await expect(page.getByText("原始对话标题")).toHaveCount(0);
});
