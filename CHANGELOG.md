# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.3.0] - unreleased

### Added
- Backflow (off by default, `backflowEnabled`): under each answer, **→ Next prompt** sends it along with your next main prompt as labelled context (previewed, undoable), **+ Note** keeps it on the Notes page, **Copy** copies it.
- Refresh to latest (`/st refresh`): the snapshot moves to the current main conversation, earlier answers kept, later prompts told what is new; `contextMode: follow` refreshes before every question.
- Pane pages: Thread, History (`/st list`, closed threads read-only), Notes, Settings (`/st settings`, written through `$.config.set`).
- Full README, `marketplace.json`, `scripts/release.sh`.

### Changed
- Quieter pane: the level's model and thinking pickers, its tools switch and its mode share one row under the crumbs; answer actions fold behind ⋯ (an answer waiting for the next prompt shows ↩ Undo instead); tool calls fold into one line; Stop, New layer and Close stay in view.
- How answers are drawn and the pane's language moved to the Settings page.
- Copy is offered in the terminal only (plugins have no clipboard in the desktop app; answers are selectable).

### Removed
- The Topic field: in the terminal the selection is the topic; elsewhere a level is labelled by its first question.

## [0.2.0] - 2026-10-22

### Added
- Nested side threads: one chain, up to `maxDepth` levels (default 5, at least 3); breadcrumb navigation with read-only upper layers; "New layer" and closing a layer with everything below it; `/st up`, `/st close`.
- Answers with tools: a fork subagent that shares the main context (soft snapshot), or the plugin's own agent type on another model (hard snapshot); light mode stays tool-less.
- Per-layer model (`/st model <name>`, pane picker); a new layer inherits its parent's model.
- One-line tool summaries per answer, read from the subagent's own transcript; Stop ends a subagent with TaskStop.
- Side threads are saved per session under `~/.claude/plugins/data/subthread/` (or `$CLAUDE_PLUGIN_DATA`) and restored on resume.
- Per-layer thinking effort (`/st effort <level>`, pane picker); a new layer inherits its parent's.
- `/st new` opens the next level; with a thread open, plain `/st` only brings the pane back.
- The pane and its notices in English or Simplified Chinese, switched from the pane and remembered.
- Selectable answers: drawn in read-only text fields (edits are undone), with a switch to formatted Markdown; the choice is remembered.
- Settings: `defaultStrategy`, `maxDepth`, `autoModeSpawn`, `language`.

### Changed
- In auto mode, a question you send may start its subagent although auto mode cannot rule on the spawn itself; the subagent's tool calls are still ruled on by auto mode. Turn off `autoModeSpawn` to answer without tools in auto mode instead.

## [0.1.0] - 2026-10-22

### Added
- `/subthread` (alias `/st`): open a side thread on the current selection, optionally with a question.
- Side-thread pane: questions and answers, Stop, Close layer, and a Topic field for pasted text (the desktop app does not expose the selection to plugins).
- One level (L1), hard snapshot of the main conversation, tool-less answers through `$.model.complete`.
- Harness-agnostic `core/` with a Claude Code adapter in `hooks/`.
