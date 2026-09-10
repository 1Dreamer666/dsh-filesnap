# Quick start

This guide covers **dsh-filesnap 0.3.0**: preview file changes before rewinding, inspect usage and clean up in independent panels, and migrate older conversations from Settings.

## Install

```console
dsh plugin --profile web add dsh-filesnap
```

Restart the Web UI profile. The bundle and FileSnap engine install with the package; no manual loader row is needed. When upgrading from 0.2.1 or earlier, remove the old handwritten `id: filesnap` row. Current integration validation uses DSH 0.1.2-rc.1.

## Preview and rewind

Complete at least two turns that modify files. Click rewind in an assistant action row and review files to write, restore or delete. Confirmation restores files and opens a new conversation branch, keeping the full original conversation. Cancel or Escape creates no branch.

The original prompt is offered back in an empty composer without replacing drafts or images. To reverse a mistaken rewind, use the redo button in the new branch or type `/redo`. Branches share the workspace; switching conversations alone does not switch files.

## Disk usage and cleanup

Click the snapshot status icon in the session header. The independent panel separates workspace records from shared file content and lists snapshot counts per session. Cleanup explains its scope and requires confirmation. It collects unreferenced data while retaining snapshots and redo recovery data.

Buttons do not write results into the conversation. Manually typing `/rewind status` still uses DSH's standard command-result presentation.

## Migrate older data

Open **DSH Settings → FileSnap → Data migrations**. Select the versioned task, scan older conversations, review the list and confirm. Loaded sessions and compatible data are skipped; changed files receive original backups. [Versioned migration guide](../../docs/migrations.md).

## Watch the full walkthrough

This video shows an older release. Its command-result cards have been replaced by independent panels for buttons in 0.3.0.

<!-- VIDEO -->

[English video](https://youtu.be/WPEXKesR_EM) · [中文视频](https://www.bilibili.com/video/BV1BiYT6qEjs/)

[Recovery boundaries](../../docs/architecture.md) · [Troubleshooting](../../docs/troubleshooting.md) · [Plans](../../docs/roadmap.md)
