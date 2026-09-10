# Roadmap

[README](../README.md) · [中文](roadmap.zh.md) · [Current comparison](comparison.md)

Updated **2026-09-10**, against **dsh-filesnap 0.2.2**. These are planned improvements, not shipped features or release-date commitments. The priorities below guide implementation; completion requires working behavior and verification.

## Planned work

| Priority | Improvement | What completion means |
|---|---|---|
| P1 | **Snapshot cleanup commands and settings UI** | Expose engine collection and session deletion through the plugin; preview the selected scope and removals before confirming. Protect content referenced by retained snapshots and redo states. |
| P1 | **Retention policies and optional automatic cleanup** | Configure age/count/storage policies and protected sessions; show the affected recovery points and report failures. Keep automatic cleanup opt-in. |
| P1 | **Storage usage and deduplication inspection** | Show actual stored payload bytes, metadata and shared-object references separately; explain the measurement scope. Include commands/UI for inspecting storage health through the engine's `doctor` capability. |
| P1 | **Recovery preview and diff view** | Show the target turn, files to write/delete, excluded paths and shared-workspace impact before applying a rewind. |
| P2 | **Conversation-only rewind** | Allow an explicit mode that leaves workspace files unchanged; specify its fork and redo behavior and distinguish it from synchronized conversation/file recovery. |
| P2 | **Per-file recovery selection** | Select files from a captured point and preview the resulting changes; clearly show when the recovered files no longer correspond to the complete conversation state. |
| P2 | **Smoother fork and redo navigation** | Make the original/child relationship and continuation target easier to see and open, including typed-command workflows. Retain the original conversation and explain the shared workspace. |
| P1 investigation | **Session reopening without plugin-specific registration** | Investigate host-supported event registration or a compatible migration path. Verify uninstall/reinstall and supported host upgrades before claiming the current constraint is resolved. |

The engine already exposes `gc`, `doctor` and session deletion. Plugin commands, settings, policy controls and previews still need implementation. A roadmap entry is not an existing installable command.

## Current release boundaries

The current plugin does not provide a standalone conversation-only mode, cleanup UI, per-file restore picker or diff view. Rewind creates a child conversation sharing the original workspace.

**Uninstalling does not delete conversation logs or workspace files.** Sessions containing plugin records currently require reinstalling before reopening in DSH. The registration investigation above does not mean this limitation has been fixed.

Track implemented changes in release notes with the relevant plugin, engine and host versions. Storage collection must preserve retained recovery data; interaction changes must verify conversation/file state and the applicable redo behavior.
