# Changelog

## 0.4.0

- 新增「设置 → FileSnap → 中断恢复」：预览继续或回滚未完成的回退与 redo，确认时重新检查文件，冲突时停止。
- 修改文件前持久化命名救援点及独立恢复状态；完成状态和 redo 栈一起提交，避免结果丢失后重复消费。必要元数据不写入对话，卸载不影响原生会话读取。
- 复用已发布的 FileSnap 0.5.1+，本次无需引擎更新。新恢复流程覆盖本版创建的回退及其 redo；旧版回退保留兼容路径。
- Add an independent interrupted-restore panel, durable host recovery metadata, repeatable rescue targets and conflict-checked confirmation. Block new Agent work in a workspace awaiting recovery.
- Verify actual host process termination before/after applying files, partial application, interrupted rollback, redo preservation and fresh-process conversation loading.

Limits: local workspace, one DSH process, no concurrent external writes. Changed ignore rules must be restored before recovery preview. This does not promise multi-file atomicity across machine power loss.

## 0.3.2

- Treat a missing or consumed undo record as a normal empty state in the redo dialog, command menu and headless command. Remove misleading engine-upgrade hints and restore/retry controls for this state; preserve actual engine errors.
- After a successful redo, check for remaining undo records and archive only an exhausted fork through the host's public archive API. Preserve conversations and snapshots; keep branches visible after file failures, remaining undo records or archive errors.
- Return to the original conversation after automatic archiving, including when the host archive update unmounts the old branch before the RPC returns.
- Engine requirement remains FileSnap 0.5.1+. No engine release is needed for this patch.

## 0.3.1

- Require file preview and single-use confirmation for `/redo` and the header redo button; recheck workspace, target and ignore rules before applying. Requires FileSnap 0.5.1.
- Mark branches `🟢 Active ·` / `🔴 Inactive ·` after successful rewind or redo; recognize legacy prefixes.
- Run versioned migrations automatically on plugin load (configurable with `autoMigrate`). Back up unloaded legacy logs and append native title revisions for old markers. Show startup results and keep manual retries in Settings.
- Host compatibility remains tested against DSH 0.1.2-rc.1. Source review of 0.1.5-rc.1/master finds session forks and archive APIs, but no message branch pager or public unarchive API.

Publish engine 0.5.1 before installing/publishing plugin 0.3.1.

## 0.3.0

- Bare `/rewind` opens the native searchable turn picker in the web UI, then the file preview and confirmation dialog.

- Preview the complete file impact list and require confirmation before browser or command rewinds. Recheck workspace state and ignore rules before restoring.
- Move browser actions from chat commands to independent authenticated RPC. No new `filesnap/*` session events, operation journals or command-result cards from buttons.
- Resolve snapshots using the engine index and DSH native fork lineage, including cold ancestors. New conversations reopen without the plugin installed.
- Add an independent workspace snapshot panel with records/shared content usage, per-session snapshot counts and excluded files.
- Add confirmed collection of unreferenced snapshot data; retain snapshots and redo recovery data.
- Add Settings → FileSnap → Data migrations, with a versioned task catalogue, read-only scan, confirmation, backup, stale-file checks and per-session results. The first task makes legacy session events ignorable. An offline tool is included for installations whose UI cannot start.
- Refill the complete original prompt only when the destination composer is empty; preserve drafts and images. Redo results provide an action to open the original conversation.
- Refresh bilingual documentation and the website. Historical performance/comparison evidence retains its original version labels.

Compatibility: validated with DSH 0.1.2-rc.1 and FileSnap 0.5.0. Loaded sessions are skipped by migration. Stop other DSH processes sharing the same session directory before migration. Legacy conversations need migration before opening without the old event registration. Keep ancestor conversations and snapshot data for inherited recovery points.

Integration changes: `filesnap` projection now contains structural anchors only; browser results use RPC. Custom event declarations and outcome `eventSeq` fields have been removed.
