---
name: chatlog-viewer-title
description: Manage ChatLog Viewer conversation titles for Codex, Claude Code, and OpenCode with the project title CLI. Use when the user wants to list or search conversations across providers, rename a title with native persistence, generate titles with an AI CLI, run or roll back batch title generation, or verify that UI and local CLI titles stay synchronized.
---

# ChatLog Viewer Title

## Overview

Use ChatLog Viewer's local title CLI to manage Codex, Claude Code, and OpenCode conversations. The CLI and Web UI share the same persistence service:

- Codex uses the native app-server naming path and verifies State DB plus `session_index.jsonl`.
- Claude Code appends native `/rename` metadata and updates `sessions-index.json`.
- OpenCode updates SQLite `session.title`.

The target conversation provider and the AI title-generation CLI are independent. For example, OpenCode can generate a title for a Codex conversation, then ChatLog Viewer persists it through Codex's native title path.

Project path:

```bash
D:/DownloadFiles/code_area/chatlog-viewer
```

## Quick Commands

List recent conversations across all managed providers:

```bash
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- list --provider all --scope all --limit 30
```

List one provider for the current shell directory exactly. Prefer `--cwd "$PWD"` when using `pnpm --dir`, because the shell expands `$PWD` before pnpm changes directory:

```bash
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- list --provider claude-code --cwd "$PWD" --exact --limit 30
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- list --provider opencode --project "$PWD" --recursive --limit 30
```

Search by title, ID, project, provider, model provider, or badge:

```bash
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- list --provider all --scope all --search "关键词" --limit 20
```

Rename conversations with native persistence:

```bash
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- rename codex:<session-id> "新标题"
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- rename claude-code:<session-id> "新标题"
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- rename opencode:<session-id> "新标题"
```

Generate and persist a title. `--cli` chooses AI engines, not the target provider:

```bash
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- generate claude-code:<session-id> --cli opencode,codex,claude --json
```

Generate titles in batch for one project:

```bash
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- generate-batch --provider all --cwd "$PWD" --exact --dry-run
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- generate-batch --provider all --cwd "$PWD" --exact --json --continue-on-error
```

Rollback a batch report:

```bash
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- rollback --report ~/.backups/chatlog-viewer-title/<date>/conversation-title-generate-batch-<timestamp>.json
```

Open interactive mode across all providers:

```bash
pnpm --silent --dir D:/DownloadFiles/code_area/chatlog-viewer title -- --provider all
```

## Workflow

1. List or search first when the conversation is ambiguous. With `--provider all`, use the returned full `codex:<id>`, `claude-code:<id>`, or `opencode:<id>`.
2. Use `--cwd "$PWD" --exact` for one directory, or `--project <path> --recursive` when intentionally including subdirectories.
3. `list` excludes internal title-generation sessions by default. Pass `--include-title-sessions` when auditing them.
4. Use `rename` for manual changes. It writes through the target provider's native title implementation and verifies the persisted value.
5. Run `generate-batch --dry-run` before a real batch to audit the exact target set.
6. Use `generate` or `generate-batch` only when AI generation is requested. Report `usedCli`, attempts, duration, cleanup count, failures, and the backup/report path. Context uses only the latest ~10 non-tool messages (no head/middle samples).
7. Use `rollback --report <path>` when generated titles need to be restored to the report's `oldTitle` values.
8. When checking synchronization, compare the full conversation ID and provider. Do not infer that an AI engine named `opencode` means the target conversation is an OpenCode conversation.

## Structured Output

Use `--json` for `rename`, `generate`, `generate-batch`, and `rollback`. stdout contains exactly one JSON document; AI CLI diagnostics are written to stderr.

```json
{
  "schemaVersion": 1,
  "command": "generate-batch",
  "ok": false,
  "summary": {
    "total": 20,
    "success": 19,
    "failed": 1,
    "skipped": 0
  },
  "entries": [
    {
      "id": "codex:<session-id>",
      "oldTitle": "旧标题",
      "newTitle": "新标题",
      "status": "success",
      "usedCli": "opencode",
      "attempts": 1,
      "cleanedTitleSessions": 1,
      "durationMs": 1234
    }
  ],
  "reportPath": "C:/Users/<user>/.backups/chatlog-viewer-title/<date>/conversation-title-generate-batch-<timestamp>.json"
}
```

Judge the result from `ok` and `summary`, then inspect each `entries[].status`. `dry-run`, unprocessed entries after an early stop, and rollback conflicts count as `skipped`. A completed command with any failed entry exits non-zero. Fatal errors produce the same versioned error shape on stderr and leave stdout empty.

## AI Session Storage

Fresh mode is the default. Codex runs with `--ephemeral`, Claude Code runs with `--no-session-persistence`, and OpenCode deletes the generated session by exact `sessionID` after the title is persisted. OpenCode stores real session, message, and part data globally in `~/.local/share/opencode/opencode.db`; `~/.chatlog-viewer/ai-title-sessions/opencode` is only the isolated working directory and fixed-session marker location.

## Constraints

- The title CLI manages Codex, Claude Code, and OpenCode. It does not manage iFlow titles.
- Do not edit provider JSONL or SQLite files directly unless the CLI fails and the user explicitly approves a repair.
- Do not generate a title unless the user asks for AI generation; listing and manual rename are safe first steps.
