# dsh-filesnap architecture

[README](../README.en.md) · [中文](architecture.zh.md)

## Responsibilities

The FileSnap engine owns bounded scans, content-addressed deduplication, restores, undo recovery data and garbage collection. The DSH plugin owns capture timing, native fork boundaries, previews and UI. Engine JSON Lines output is consumed by the current invocation, never copied into chat history.

## Capture and coverage

`agent/pre-step` awaits capture before model requests and tools. Prepended `fs/write-intent` and `fs/edit-intent` observers capture pre-images, then delegate to host policy. Coverage follows `ctx.fs`, not a tool-name allowlist. Shell changes outside that seam depend on subsequent bounded turn scans.

The tracked set combines known files, observed paths and bounded recent scanning. Ignore rules, size limits and timing still constrain coverage. Manifests reuse identical content; only explicit tombstones authorize deletion. Capture failures do not block the model but offer no snapshot. Restore failures are reported per file.

## Native turns and snapshot references

No custom session events or separate operation journal are written. Native `turn/start`, messages, `parentSession` and `inheritedEventCount` identify which session owns a turn. Those identities join to the engine's snapshot index. Forks retain ancestor point ids, while their own new turns use the child id, preventing collisions between equally numbered turns.

Cold ancestors are read through `sessionPersistence.inspect`. Deleting ancestor conversations or snapshots can make inherited targets unavailable, so retain them. Captures after restart consult the engine index instead of replacing an existing turn's original state.

The `filesnap` projection folds only native structural anchors. Snapshot availability is fetched over independent RPC. Previews, operation results and cleanup results remain in current requests and browser memory, outside the projection cache.

## Rewind ordering

1. Resolve a point and prepare the file list, saving a rescue checkpoint in the engine store.
2. Obtain user confirmation with a single-use token bound to the session and point, expiring after five minutes.
3. The browser invokes DSH's `sessions.fork`, preserving deployment preset/workspace composition.
4. The host rechecks files and ignore rules, restores the point and files undo data under the child.
5. Open the child and refill the full original prompt only in an empty composer. Partial failures remain explicitly visible in the dialog.

Cancel creates no branch and restores no workspace files. Validation is not a filesystem lock; external edits may race the final write. A refused restore can leave the already-created child in the session list. Headless commands fork through the service and return a child id.

## Independent UI and transport

Public slots provide `conversation.chat.assistant-actions`, `conversation.session.header.actions` and `settings.section`. FileSnap Settings hosts the versioned migration entry.

`ctx.connection.rpc.handle('/filesnap', …)` uses the browser Connection RPC with the host's Host/Origin fence and authentication. Requests are schema-validated and operations target an already-open agent. Buttons never invoke `session.command`, so they produce no `command/run` or `command/done` cards. Manually typed commands retain DSH's standard command path.

The snapshot panel shows records, shared content, session snapshot counts and unprotected paths. Cleanup invokes only `gc`, preserving referenced snapshots and undo data without automatically deleting sessions.

## Legacy compatibility

Older builds modified the host's known-event set to read custom events, creating an uninstall dependency. This modification has been removed. The common migration entry adds `ignorable: true` to historical records without changing messages, sequence numbers or fork boundaries. [Migration workflow](migrations.md).

Tests persist new conversations through the real backend and reopen them in a separate DSH process that never loads the plugin. Migration checks cover JSONL, multi-frame Zstd, repeatability, backups, loaded sessions and logs changed after scanning.

## Service API and build

`ctx.filesnap` exposes `points`, `preview`, `rewind`, `redo`, `status`, `previewCleanup` and `cleanup`, returning `{ ok: true, value }` or `{ ok: false, refusal }`. Direct service integrations can own their confirmation flow; command and browser paths require preview tokens.

Host and client compile separately with plain shared types in [`src/wire.ts`](../src/wire.ts). Optional host peers avoid installing a second Cordis/DSH runtime. The browser bundle uses the host build preset; this release is verified against DSH 0.1.2-rc.1.
