# DSH Rewind & Redo — by FileSnap: promotion kit

[中文](PROMOTION.zh.md)

This is a maintainer-facing source of truth for repository metadata, demos and
launch copy. Keep public claims aligned with the current README and dated audit.

## Product identity

- Display name: **DSH Rewind & Redo — by FileSnap**.
- npm package and repository name: `dsh-filesnap`.
- Install command: `dsh plugin --profile web add dsh-filesnap`.
- Engine: FileSnap (npm package `filesnap`).
- Introduce the display name and package name together on first mention. Use
  `dsh-filesnap` thereafter; keep package identifiers, links and commands literal.
- Short platform titles may lead with the user's problem instead of the full
  display name. Explain the product identity in the body.
- This is a display-name update. It does not require users to migrate or reinstall.

## GitHub repository metadata

**About description**

> DSH Rewind & Redo — by FileSnap. A DeepSeek Harness plugin that restores conversations and tracked files together, preserves the original conversation in a branch, and lets /redo reverse the rewind. No Git required.

Use this exact English description for GitHub About and `package.json`.

**Website**

> https://www.npmjs.com/package/dsh-filesnap

**Topics**

```text
deepseek-harness
dsh-plugin
coding-agent
ai-agent
rewind
redo
workspace-snapshot
agent-safety
git-free
rust
```

**Social preview**

Upload [`assets/social-preview-whale-girl.jpg`](../assets/social-preview-whale-girl.jpg) in repository
Settings → Social preview. The source asset is 1280×640 and below 1 MB. It stays
in the repository but is intentionally excluded from the npm tarball.

## Message hierarchy and comparisons

1. **Storage:** identical content can be reused across retained versions, paths and sessions sharing a store. Four of seven storage exercises saved payload copies; three tied.
2. **Workflow:** rewind the conversation and tracked files together, retain the original conversation, and reverse the rewind with `/redo`.
3. **Integration experience:** the design originated in Codex rewind work; the standalone engine powers DSH and Pi.
4. **Implementation:** TypeScript integrates the host; Rust implements storage. Content addressing explains the deduplication result, not language choice alone.
5. **Limits:** known paths, observed writes and bounded recent scanning. Uninstalling does not delete conversation logs or workspace files; sessions with plugin records require reinstalling before reopening.

Directly compare SiriLee’s `dsh-rewind-plugin 0.9.1` with `dsh-filesnap 0.2.2` / `filesnap 0.4.0`, citing dates and [reproduction evidence](../docs/dedup-comparison.md). Payload copies are not total disk usage. Do not attribute Google’s unsupported FileSnap comparison to the competitor’s author.

## Cross-assistant context for every article

FileSnap’s snapshot design originated in our published [codex-rewind](https://github.com/extracurricular-ai/codex-rewind) distribution (`codexr`). The independent engine now powers the DSH integration `dsh-filesnap` and the Pi extension [pi-better-rewind-redo](https://github.com/extracurricular-ai/pi-better-rewind-redo). As of September 10, 2026, the DSH release is 0.2.2 with `filesnap ^0.4.0`; Pi’s release is 0.1.1 with `filesnap 0.5.0`; codex-rewind is 0.151.0-rewind.0 and retains its own related inlined snapshot module.

These releases provide concrete experience integrating conversation turns, file recovery and redo across coding assistants. Codex retains its inlined implementation, while DSH and Pi use different standalone engine versions; compatibility and validation scope are documented per project.

[Public releases, source and validation scope](../docs/cross-assistant.md). Describe concrete integration experience; it does not establish a lower failure rate than competitors or automatic sharing of fixes across all hosts.

## Current demonstration

Use the published full-frame walkthroughs: Chinese [Bilibili](https://www.bilibili.com/video/BV1BiYT6qEjs/) 2:24 and English [YouTube](https://youtu.be/WPEXKesR_EM) 2:29. Audio and video run at 1.5× and preserve deletion, recovery and redo. The 20-second cut is no longer the primary asset.

## Short launch post

> DSH Rewind & Redo — by FileSnap (`dsh-filesnap`): restore a DeepSeek Harness
> conversation and its tracked files together. Keep the original conversation;
> continue in a branch. Picked the wrong point? `/redo` reverses the rewind.
> No Git required.

Link to the repository, then attach the feature demo instead of a static card
when the platform supports video.

## Longer launch post

> A coding-agent rewind has two halves: the conversation and the files it
> changed. Restoring only one leaves you in a state that never existed.
>
> dsh-filesnap captures the workspace before each DeepSeek Harness turn, forks
> the conversation at an explicit point, restores the files into that fork and
> records a rescue point first. `/redo` reverses the rewind. It works without a
> Git repository and does not modify commits, branches, stash or worktree state.
>
> The snapshot engine is filesnap, a content-addressed Rust binary. Preliminary
> warm-cache repeats measured 8 ms on the plugin repository and 268 ms while
> capturing 7,995 relevant files from a 70,918-file harness checkout. Method and
> caveats are published in the repository.
>
> Uninstalling the plugin does not delete conversation logs or workspace files.
> Sessions containing plugin records require reinstalling before reopening in DSH.

## Release-note template

```md
## What changed

<One sentence describing the user-visible outcome.>

## Why it matters

- <Problem removed or workflow shortened>
- <Safety/performance effect, with evidence when relevant>

## Upgrade

<No action required, or exact steps.>

## Known limits

<Only limits affected by this release; link to the full list.>

## Verification

- tests: <count/result>
- supported profiles/platforms exercised: <list>
```

Attach one screenshot or short clip that demonstrates the release's main change.

## Claim discipline

- Date competitor comparisons and name exact package versions.
- Link performance claims to machine metadata and reproduction steps.
- Distinguish “supported by design/tests” from “observed on this deployment.”
- Keep the uninstall limitation adjacent to installation.
- Do not say “zero config” while a profile row is still required.
- Update the comparison audit before repeating “only” or “fastest” claims.
