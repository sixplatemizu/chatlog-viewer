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
      titleGenerationCliPriority: ["codex", "claude", "opencode"],
      titleGenerationCliSessionModes: {
        codex: "fresh",
        claude: "fresh",
        opencode: "fresh",
      },
      titleGenerationCliDisabled: [],
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
      { name: "codex", discoverable: true, healthy: true, hasSession: false },
      { name: "claude", discoverable: false, healthy: false, hasSession: false },
      { name: "opencode", discoverable: true, healthy: true, hasSession: false },
    ]);
  });

  it("修改路径时默认不勾选自动迁移，显式勾选后把迁移选项传给 API", async () => {
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
          titleGenerationCliPriority: ["codex", "claude", "opencode"],
          titleGenerationCliSessionModes: {
            codex: "fresh",
            claude: "fresh",
            opencode: "fresh",
          },
          titleGenerationCliDisabled: [],
        },
      });

      return {
        ...settings,
        ai: {
          ...settings.ai,
        },
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

    const checkbox = screen.getByLabelText("勾选后会在保存时迁移当前 Storage 目录内容到新路径，不覆盖目标路径中的同名文件。");
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);

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

    expect(screen.queryByLabelText("勾选后会在保存时迁移当前 Storage 目录内容到新路径，不覆盖目标路径中的同名文件。")).toBeNull();
  });

  it("会显示更准确的 CLI 发现与健康状态", async () => {
    mockFetchProviderPathSettings.mockResolvedValue(createSettings());

    render(
      <ProviderPathsDialog
        open
        onClose={() => {}}
        onNotify={() => {}}
      />
    );

    expect(await screen.findAllByText("命令已发现")).toHaveLength(2);
    expect(screen.getAllByText("健康可用")).toHaveLength(2);
    expect(screen.getByText("命令未发现")).toBeInTheDocument();
  });

  it("允许调整标题生成 CLI 优先级并保存到 API", async () => {
    const settings = createSettings();

    mockFetchProviderPathSettings.mockResolvedValue(settings);
    mockUpdateProviderPathSettings.mockImplementation(async (payload) => {
      expect(payload.ai?.titleGenerationCliPriority).toEqual(["claude", "codex", "opencode"]);
      return {
        ...settings,
        ai: {
          titleGenerationCliPriority: ["claude", "codex", "opencode"],
          titleGenerationCliSessionModes: settings.ai.titleGenerationCliSessionModes,
          titleGenerationCliDisabled: [],
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
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("下移 Codex"));
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => {
      expect(mockUpdateProviderPathSettings).toHaveBeenCalledTimes(1);
    });
  });

  it("默认使用 Fresh 模式并允许切换为固定模式", async () => {
    const settings = createSettings();

    mockFetchProviderPathSettings.mockResolvedValue(settings);
    mockUpdateProviderPathSettings.mockImplementation(async (payload) => {
      expect(payload.ai?.titleGenerationCliSessionModes).toEqual({
        codex: "fixed",
        claude: "fresh",
        opencode: "fresh",
      });
      return {
        ...settings,
        ai: {
          titleGenerationCliPriority: settings.ai.titleGenerationCliPriority,
          titleGenerationCliSessionModes: {
            codex: "fixed",
            claude: "fresh",
            opencode: "fresh",
          },
          titleGenerationCliDisabled: [],
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
    expect(screen.getAllByText("Fresh 模式")).toHaveLength(3);
    fireEvent.click(screen.getByLabelText("切换为固定模式 Codex"));
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
        { name: "codex", discoverable: true, healthy: true, hasSession: true },
        { name: "claude", discoverable: false, healthy: false, hasSession: false },
        { name: "opencode", discoverable: true, healthy: true, hasSession: false },
      ])
      .mockResolvedValueOnce([
        { name: "codex", discoverable: true, healthy: true, hasSession: false },
        { name: "claude", discoverable: false, healthy: false, hasSession: false },
        { name: "opencode", discoverable: true, healthy: true, hasSession: false },
      ]);

    render(
      <ProviderPathsDialog
        open
        onClose={() => { }}
        onNotify={onNotify}
      />
    );

    await screen.findByLabelText("重置 Codex 标题会话");
    fireEvent.click(screen.getByLabelText("重置 Codex 标题会话"));

    await waitFor(() => {
      expect(mockResetAiCliSession).toHaveBeenCalledWith("codex");
    });

    expect(onNotify).toHaveBeenCalledWith(expect.objectContaining({
      variant: "success",
      title: "会话已重置",
    }));
  });
});
