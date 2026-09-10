# DSH Rewind & Redo — by FileSnap

[![npm](https://img.shields.io/npm/v/dsh-filesnap?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-filesnap)
[![CI](https://github.com/extracurricular-ai/dsh-filesnap/actions/workflows/ci.yml/badge.svg)](https://github.com/extracurricular-ai/dsh-filesnap/actions/workflows/ci.yml)
[![License](https://img.shields.io/npm/l/dsh-filesnap?color=1f6feb)](LICENSE)

English | [中文](README.zh.md)

**dsh-filesnap restores conversations and tracked files together in DeepSeek Harness (DSH).** Preview the files to write, restore or delete, then confirm. Keep the original conversation in a branch, and use `/redo` to reverse a mistaken rewind. No Git required.

**0.3.0 adds independent file previews, storage and cleanup panels, and a versioned data migration page.** Buttons return results over independent RPC without writing operation logs to the conversation. New conversations remain readable after uninstall; older conversations can be scanned and migrated from Settings.

![dsh-filesnap: rewind conversations and workspace files](assets/social-preview-whale-girl.jpg)

[English walkthrough (older version) · 2:29](https://youtu.be/WPEXKesR_EM) · [中文演示（旧版）· 2:24](https://www.bilibili.com/video/BV1BiYT6qEjs/)

## Install

```console
dsh plugin --profile web add dsh-filesnap
```

Requires DeepSeek Harness (integration verified with **0.1.2-rc.1**) and Node.js `^22.19` or `>=24`. Linux, macOS and Windows on x64/arm64 are supported. The FileSnap 0.5.0+ engine installs with the plugin. For headless use, replace `web` with `headless`.

Restart the profile. No manual loader entry is needed. When upgrading from 0.2.1 or earlier, remove the manually added `id: filesnap` entry from `~/.dsh/profiles/<profile>/cordis.patch.yml` to avoid a duplicate with the bundle.

## Rewind and redo

1. Let DSH complete at least two turns. Assistant action rows offer rewind when a corresponding snapshot is available.
2. Click rewind and review the target turn and complete file list. Cancel or Escape closes the dialog without creating a branch or restoring workspace files.
3. Confirm to create a branch, restore the files and open the recovered conversation. The original prompt is offered back in an empty composer, preserving existing drafts and attachments.
4. To reverse the rewind, click the redo action in the new branch or run `/redo`. Button results appear in an independent panel.

If files, ignore rules or the turn change after preview, preview again. Confirmation tokens expire after five minutes and are single-use. Partial restore failures identify affected paths. [Full workflow and limits](docs/rewind-preview.md).

## Workspace snapshots and cleanup

Click **Show snapshot status** in the session header to open the independent **Workspace snapshots** panel:

- See **workspace records** and **shared file content** separately. Shared content spans workspaces and is not this project's exclusive disk usage.
- Inspect the snapshot turn count per session and the unprotected files with their reasons.
- Open cleanup, review its scope and confirm. It collects only unreferenced data, keeping retained snapshots, redo recovery data and workspace files.
- Usage refreshes after cleanup. These are current usage figures, not estimated savings; referenced content cannot be reclaimed.

Old sessions and snapshots are not automatically deleted. Automatic retention policies are not implemented. Button results do not append chat cards.

## Data migrations and uninstall

Open **DSH Settings → FileSnap → Data migrations**. This is the shared entry for future versions: select a migration, scan, review the session list, then confirm.

The first task is **Legacy session compatibility → 0.3.0+**. It marks old `filesnap/*` events as ignorable, preserving message content, sequence numbers and fork boundaries. Each changed artifact gets an original backup beside it. Compatible data is skipped. Loaded sessions are skipped too: close them and scan again; if still loaded, restart DSH and visit Settings before opening those conversations.

**New conversations contain no custom events and remain readable after uninstall. Older conversations need migration first.** The current task supports DSH JSONL and Zstd logs and leaves other plugins' events unchanged. [Migration and offline recovery](docs/migrations.md).

## Commands

| Command | Result |
|---|---|
| `/rewind` | List recoverable turns in this conversation. |
| `/rewind <turn>` | Preview file changes for the state before that turn. |
| `/rewind <turn> --confirm <token>` | Confirm with the preview token. |
| `/redo` | Reverse the rewind received by this branch. |
| `/rewind status` | Report protection and disk usage. |
| `/rewind cleanup` | Preview collection scope and return a confirmation token. |
| `/rewind cleanup --confirm <token>` | Collect unreferenced data. |

Typed commands use DSH's standard command-result presentation without a model turn. Browser buttons use RPC directly. A headless rewind returns the new conversation id for the caller to open.

## Choosing between this and dsh-rewind-plugin

Both support coordinated conversation/file recovery and Web controls. SiriLee's plugin emphasizes rewind in the same window, conversation-only mode and shortcuts. This plugin emphasizes **preserved original branches, `/redo`, and content deduplication across paths and snapshots**.

There is no verified “universally best” ranking. Read the [source comparison](docs/comparison.md) and [UI FAQ](docs/faq.md). The original storage experiments used plugin **0.2.2** with engine **0.4.0**; they are not fresh measurements of this release. [Seven dedup experiments](docs/dedup-comparison.md).

## Coverage and limits

- Recovery needs a prior capture. Binary files, Git-ignored files and observed `ctx.fs` edits outside the project can be protected. Ignore rules, size limits and timing still apply.
- Capture happens before tools run; write/edit hooks observe pre-images. This is not a whole-computer backup.
- Branches share the workspace. Opening a conversation does not switch file copies. Inherited snapshots resolve through native lineage, so retain ancestor conversations and their snapshot data.
- The first turn has no preceding completed turn to keep, so no browser rewind is offered at that boundary.
- Preview is not a workspace lock. External editors can race the final write; a refused restore may leave an already-created empty branch in the session list.
- Conversation-only mode, per-file restore selection, line diffs and new global shortcuts are not implemented.

## Configuration

| Field | Default | Purpose |
|---|---|---|
| `command` | automatic | Optional engine executable. |
| `dataDir` | platform data directory | Separate snapshot storage outside the project. |
| `timeoutMs` | `120000` | Per-invocation time limit. |
| `graceMs` | `2000` | Termination grace after cancellation or timeout. |
| `maxOutputBytes` | `1048576` | Per-stream memory limit. |
| `declareEdits` | `true` | Observe pre-edit content through the filesystem interface. |

## Further reading

[Architecture](docs/architecture.md) · [Migrations](docs/migrations.md) · [Troubleshooting](docs/troubleshooting.md) · [Roadmap](docs/roadmap.md) · [Benchmarks](docs/benchmarks.md) · [Cross-assistant work](docs/cross-assistant.md) · [Contributing](CONTRIBUTING.md)

[Discussions](https://github.com/extracurricular-ai/dsh-filesnap/discussions) · [Issues](https://github.com/extracurricular-ai/dsh-filesnap/issues) · [License](LICENSE)
