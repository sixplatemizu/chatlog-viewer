import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderPathsDialog } from "./ProviderPathsDialog";
import type { ProviderPathSettings } from "../lib/api";

const {
  mockFetchAvailableClis,
  mockFetchProviderPathSettings,
  mockResetAiCliSession,
  mockResetAllAiCliSessions,
  mockUpdateProviderPathSettings,
} = vi.hoisted(() => ({
  mockFetchAvailableClis: vi.fn(),
  mockFetchProviderPathSettings: vi.fn(),
  mockResetAiCliSession: vi.fn(),
  mockResetAllAiCliSessions: vi.fn(),
  mockUpdateProviderPathSettings: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchAvailableClis: mockFetchAvailableClis,
    fetchProviderPathSettings: mockFetchProviderPathSettings,
    resetAiCliSession: mockResetAiCliSession,
    resetAllAiCliSessions: mockResetAllAiCliSessions,
    updateProviderPathSettings: mockUpdateProviderPathSettings,
  };
});

function createSettings(overrides?: Partial<ProviderPathSettings>): ProviderPathSettings {
  return {
    configPath: "/tmp/chatlog-viewer/config.json",
    ai: {
      titleGenerationCliPriority: ["iflow", "codex", "claude"],
    },
    providers: [
      {
        name: "claude-code",
        displayName: "Claude Code",
        configuredStoragePath: "/data/claude/projects-old",
        storagePath: "/data/claude/projects-old",
        storageExists: true,
        storageSource: "config",
      },
    ],
    ...overrides,
  };
}

describe("ProviderPathsDialog", () => {
  beforeEach(() => {
    mockFetchAvailableClis.mockReset();
    mockFetchProviderPathSettings.mockReset();
    mockResetAiCliSession.mockReset();
    mockResetAllAiCliSessions.mockReset();
    mockUpdateProviderPathSettings.mockReset();
    mockFetchAvailableClis.mockResolvedValue([
      { name: "iflow", available: true, hasSession: true },
      { name: "codex", available: true, hasSession: false },
      { name: "claude", available: false, hasSession: false },
    ]);
  });

  it("修改路径时默认勾选自动迁移并把迁移选项传给 API", async () => {
    const settings = createSettings();
    const onSaved = vi.fn();
    const onNotify = vi.fn();

    mockFetchProviderPathSettings.mockResolvedValue(settings);
    mockUpdateProviderPathSettings.mockImplementation(async (payload) => {
      expect(payload).toEqual({
        providers: {
          "claude-code": {
            storagePath: "/data/claude/projects-new",
          },
        },
        migrations: {
          "claude-code": {
            storagePath: true,
          },
        },
        ai: {
          titleGenerationCliPriority: ["iflow", "codex", "claude"],
        },
      });

      return {
        ...settings,
        providers: [
          {
            ...settings.providers[0],
            configuredStoragePath: "/data/claude/projects-new",
            storagePath: "/data/claude/projects-new",
          },
        ],
        migrationResults: [
          {
            providerName: "claude-code",
            pathType: "storagePath",
            fromPath: "/data/claude/projects-old",
            toPath: "/data/claude/projects-new",
            mode: "moved",
            message: "claude-code Storage Path 已迁移到新路径",
          },
        ],
      };
    });

    render(
      <ProviderPathsDialog
        open
        onClose={() => {}}
        onSaved={onSaved}
        onNotify={onNotify}
      />
    );

    const input = await screen.findByDisplayValue("/data/claude/projects-old");
    fireEvent.change(input, {
      target: { value: "/data/claude/projects-new" },
    });

    const checkbox = screen.getByLabelText("保存时自动迁移当前 Storage 目录内容到新路径，不覆盖目标路径中的同名文件。");
    expect(checkbox).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      expect(mockUpdateProviderPathSettings).toHaveBeenCalledTimes(1);
    });

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({
      variant: "success",
      title: "设置已保存并迁移",
    }));
  });

  it("当前路径由环境变量控制时不展示自动迁移勾选项", async () => {
    mockFetchProviderPathSettings.mockResolvedValue(createSettings({
      providers: [
        {
          name: "claude-code",
          displayName: "Claude Code",
          configuredStoragePath: "/data/claude/projects-old",
          storagePath: "/data/claude/projects-old",
          storageExists: true,
          storageSource: "env",
        },
      ],
    }));

    render(
      <ProviderPathsDialog
        open
        onClose={() => {}}
        onNotify={() => {}}
      />
    );

    const input = await screen.findByDisplayValue("/data/claude/projects-old");
    fireEvent.change(input, {
      target: { value: "/data/claude/projects-new" },
    });

    expect(screen.queryByLabelText("保存时自动迁移当前 Storage 目录内容到新路径，不覆盖目标路径中的同名文件。")).toBeNull();
  });

  it("允许调整标题生成 CLI 优先级并保存到 API", async () => {
    const settings = createSettings();

    mockFetchProviderPathSettings.mockResolvedValue(settings);
    mockUpdateProviderPathSettings.mockImplementation(async (payload) => {
      expect(payload.ai?.titleGenerationCliPriority).toEqual(["codex", "iflow", "claude"]);
      return {
        ...settings,
        ai: {
          titleGenerationCliPriority: ["codex", "iflow", "claude"],
        },
      };
    });

    render(
      <ProviderPathsDialog
        open
        onClose={() => {}}
        onNotify={() => {}}
      />
    );

    await screen.findByText("AI 标题生成优先级");
    fireEvent.click(screen.getByLabelText("下移 iFlow"));
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      expect(mockUpdateProviderPathSettings).toHaveBeenCalledTimes(1);
    });
  });

  it("允许在设置页重置单个 AI 标题固定会话", async () => {
    const onNotify = vi.fn();

    mockFetchProviderPathSettings.mockResolvedValue(createSettings());
    mockResetAiCliSession.mockResolvedValue({ success: true });
    mockFetchAvailableClis
      .mockResolvedValueOnce([
        { name: "iflow", available: true, hasSession: true },
        { name: "codex", available: true, hasSession: false },
        { name: "claude", available: false, hasSession: false },
      ])
      .mockResolvedValueOnce([
        { name: "iflow", available: true, hasSession: false },
        { name: "codex", available: true, hasSession: false },
        { name: "claude", available: false, hasSession: false },
      ]);

    render(
      <ProviderPathsDialog
        open
        onClose={() => { }}
        onNotify={onNotify}
      />
    );

    await screen.findByLabelText("重置 iFlow 标题会话");
    fireEvent.click(screen.getByLabelText("重置 iFlow 标题会话"));

    await waitFor(() => {
      expect(mockResetAiCliSession).toHaveBeenCalledWith("iflow");
    });

    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({
      variant: "success",
      title: "会话已重置",
    }));
  });
});
