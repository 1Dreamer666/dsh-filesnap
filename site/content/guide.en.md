# Your first rewind

Recover a captured file, keep the original conversation, and undo the rewind if you picked the wrong point. This tutorial uses the Web UI and **dsh-filesnap 0.2.2**.


Use the rewind control beside a message, or the redo/status actions in the conversation header.

## Install the plugin

Use Node.js **^22.19 or >=24** and a DSH Web UI profile. Linux, macOS and Windows on x64 or arm64 are supported by the package. The required components are included; you do not need a separate toolchain or a Git repository.

```sh
dsh plugin --profile web add dsh-filesnap
```

Restart the corresponding Web UI profile. Version 0.2.2 includes its bundle, so there is no loader entry to add by hand. To reproduce this version, install `dsh-filesnap@0.2.2` instead.

**Upgrading from an older manual installation?** Remove the old hand-added `id: filesnap` entry from your profile's `cordis.patch.yml` before starting 0.2.2. Keep unrelated entries. See [installation troubleshooting](../../docs/troubleshooting.md).

## 1. Create a recoverable state

Start in a disposable workspace. In separate completed turns, ask the agent to create `data.txt`, change its contents, and then delete it. FileSnap must capture the earlier state before it can restore it; installing after a deletion cannot recover content that was never captured.

Hover a completed assistant turn to reveal its rewind control. Read the tooltip for the actual target and file coverage.

![The rewind control identifies the target turn and captured files](../../assets/shot-1-turn-control.png)

## 2. Rewind to the right point

Use the button or list captured points in the conversation:

```text
/rewind
```

Choose a point before the deletion. If your session lists turn 2 as that point, use:

```text
/rewind 2
```

The number means **before that explicit turn**, not “go back two turns.” Wait for active agent work to finish before restoring.

![Rewind reports restored files and the child conversation](../../assets/shot-3-rewound.png)

The button opens the recovered conversation. A typed command reports a destination to open if the UI stays in the original. Check the restored file on disk.

**Your original conversation remains available.** Recovery changes the current workspace; opening the original conversation does not automatically switch the files back.

## 3. Undo the rewind with redo

Before making more edits, enter this in the conversation opened by rewind:

```text
/redo
```

This reverses the rewind. Follow the returned original conversation to continue.

![Redo reports the reversed rewind and original continuation session](../../assets/shot-6-redo.png)

In this deletion exercise, redo deletes the file again: it returns to the state immediately before rewind. Check both the file and the active conversation at each step.

## Check coverage and storage

```text
/rewind status
```

Capture combines known paths, observed `ctx.fs` writes and edits, and a bounded scan of recent changes. Ignore rules, file-size limits and snapshot timing apply. It is not a full-disk backup or a guarantee that every shell edit was captured. Current status does not prove a particular historical point contains a file.

![Status displays workspace records and shared content storage](../../assets/shot-4-status.png)

Read the [capture architecture](../../docs/architecture.md) for the exact boundary, or the [deduplication experiment](../../docs/dedup-comparison.md) for how identical content is reused.

## Uninstalling and reopening sessions

Uninstalling the plugin **does not delete conversation logs or workspace files**. Sessions containing plugin records currently require reinstalling before reopening in DSH. A source checkout started with `pnpm dsh` may hit the same registration issue; use a built or npm-installed CLI and consult [troubleshooting](../../docs/troubleshooting.md).

## Watch the full walkthrough

The recorded demo shows the complete loop at 1.5× speed. The English version is 2:29; the Chinese version is 2:24. These are demonstrations, not performance benchmarks.

<div data-video></div>

[English walkthrough on YouTube](https://youtu.be/WPEXKesR_EM) · [中文演示 · Bilibili](https://www.bilibili.com/video/BV1BiYT6qEjs/)

Continue with the [versioned plugin comparison](../../docs/comparison.md) or [planned improvements](../../docs/roadmap.md).

Implementation details: [How it works](../../docs/architecture.md) · [UI and compatibility evidence](../../docs/faq.md).
