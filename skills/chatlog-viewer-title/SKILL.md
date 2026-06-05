---
name: chatlog-viewer-title
description: Manage ChatLog Viewer Codex conversation titles from Codex using the project CLI. Use when the user wants to list Codex conversations like /resume, rename a Codex conversation title, generate a title with an AI CLI, search for a conversation by title/id/project, or verify that a UI title change is written back to local Codex resume data.
---

# ChatLog Viewer Title

## Overview

Use ChatLog Viewer's local title CLI instead of trying to register a native Codex slash command. The CLI shares the same title persistence path as the Web UI, so manual rename and AI-generated titles are written back to Codex transcript/state data.

Project path:

```bash
D:/DownloadFiles/code_area/chatlog-viewer
```

## Quick Commands

List recent Codex conversations:

```bash
pnpm --dir D:/DownloadFiles/code_area/chatlog-viewer title -- list --scope all --limit 30
```

List conversations for the current shell directory exactly. Prefer this over `--scope cwd` when using `pnpm --dir`, because `$PWD` is expanded before pnpm changes directory:

```bash
pnpm --dir D:/DownloadFiles/code_area/chatlog-viewer title -- list --cwd "$PWD" --exact --limit 30
```

Search by title, id, project, provider, or badge:

```bash
pnpm --dir D:/DownloadFiles/code_area/chatlog-viewer title -- list --scope all --search "关键词" --limit 20
```

Rename a conversation:

```bash
pnpm --dir D:/DownloadFiles/code_area/chatlog-viewer title -- rename codex:<session-id> "新标题"
```

Generate and persist a title:

```bash
pnpm --dir D:/DownloadFiles/code_area/chatlog-viewer title -- generate codex:<session-id>
```

Generate titles in batch for one project:

```bash
pnpm --dir D:/DownloadFiles/code_area/chatlog-viewer title -- generate-batch --cwd "$PWD" --exact --dry-run
pnpm --dir D:/DownloadFiles/code_area/chatlog-viewer title -- generate-batch --cwd "$PWD" --exact --json --continue-on-error
```

Rollback a batch title generation report:

```bash
pnpm --dir D:/DownloadFiles/code_area/chatlog-viewer title -- rollback --report ~/.backups/chatlog-viewer-title/<date>/codex-title-generate-batch-<timestamp>.json
```

Open interactive mode:

```bash
pnpm --dir D:/DownloadFiles/code_area/chatlog-viewer title
```

## Workflow

1. If the user names a conversation ambiguously, list or search first and use the returned full `codex:<id>`.
2. Use `--cwd "$PWD" --exact` for the current directory, or `--project <path> --recursive` when intentionally including subdirectories.
3. `list` excludes internal title-generation sessions by default; pass `--include-title-sessions` only when auditing cleanup.
4. For manual title changes, run `rename`; this goes through the same native Codex app-server thread naming path as the Web UI.
5. Before batch generation, prefer `generate-batch --dry-run` to audit the exact target set.
6. For AI title generation, run `generate` for one conversation or `generate-batch` for many; report `usedCli`, attempts, duration, cleanup count, failures, and the backup/report path. Generated title context is recent-message weighted, with only small opening/middle samples for orientation.
7. If batch title quality is poor, use `rollback --report <path>` to restore successful entries from the report's `oldTitle`.
8. If a title still differs in Codex `/resume`, run `list --json --search "<title-or-id>" --include-title-sessions` and inspect `id`, `filePath`, `project`, `contentStatus`, and badges before changing more data.

## Constraints

- This skill currently manages the Codex provider only.
- Do not edit Codex JSONL or SQLite files directly unless the CLI fails and the user explicitly approves a repair.
- Do not generate a title unless the user asks for AI generation; listing and manual rename are safe first steps.
