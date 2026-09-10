# Release communication notes

Describe verified product behavior, with links to the source and workflows. This file is a draft; editing it does not publish or send anything.

## Suggested 0.3.0 introduction

**dsh-filesnap** adds conversation and tracked-file rewind to DeepSeek Harness. Review the file list before confirming, preserve the original conversation as a branch, and use `/redo` to reverse a mistaken rewind. No Git repository is required.

Version 0.3.0 adds independent storage/cleanup UI and a versioned migration page in Settings. Browser buttons use authenticated RPC instead of writing command cards or custom events into the conversation. New conversations remain readable after uninstall; legacy conversations have a scan-and-migrate workflow with backups.

```console
dsh plugin --profile web add dsh-filesnap
```

[README](../README.md) · [Migration guide](../docs/migrations.md) · [Historical source comparison](../docs/comparison.md)

## Claims to keep precise

- Cleanup currently collects unreferenced data. It does not automatically delete retained snapshots or old sessions.
- Both this plugin and SiriLee's support coordinated conversation/file recovery and Web controls. Compare branch preservation, redo, deduplication, same-window behavior and shortcuts explicitly.
- Historical storage experiments used their documented versions; do not present them as new performance measurements for this release.
- This is a community plugin, not an official DeepSeek endorsement. Do not claim “best,” “most popular,” “first” or a security guarantee without supporting evidence.
- No promises of Google or AI-search rankings. Use accurate feature descriptions, installation instructions, screenshots and source links.
