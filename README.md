<div align="center">

# last-turn-diff

**See exactly what Claude just changed.**<br>
A GitHub-style diff of every file Claude edited in the last turn, right inside Claude Code.<br>
In Claude Desktop's Code tab and in the terminal. No git needed.

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FRomuloDrumond%2Fclaude-last-turn-diff%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=version&style=flat-square&color=2ea043)](https://github.com/RomuloDrumond/claude-last-turn-diff/releases)
[![Claude Code 2.1.286+](https://img.shields.io/badge/Claude%20Code-2.1.286%2B-d97757?style=flat-square)](https://claude.com/claude-code)
[![Desktop and terminal](https://img.shields.io/badge/works%20in-Desktop%20%C2%B7%20terminal-6e7781?style=flat-square)](#in-the-terminal)
[![MIT](https://img.shields.io/badge/license-MIT-0969da?style=flat-square)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/pane-dark.png">
  <img alt="The Last turn diff pane in Claude Desktop: a turn header with 3 files changed +13 −2, a toolbar, and one card per file with line numbers, green and red rows and syntax colours" src="docs/images/pane-light.png" width="760">
</picture>

</div>

## Install

```
/plugin install last-turn-diff --marketplace RomuloDrumond/claude-last-turn-diff
```

Run it in the terminal or in a Claude Desktop Code session (Claude Code 2.1.286 or later), then `/reload-plugins`. After Claude edits files, click **View changes** above the prompt or run `/lastturn`.

## What you get

- **One card per file**, GitHub style: old and new line numbers, green and red rows, the changed words marked inside a reworded line, and `⋯ 23 unchanged lines` where the diff skips ahead.
- **Every turn, not just the last.** Step back through earlier turns with the arrows or the turn picker. Each is labelled with the first words of its prompt.
- **Split or unified**, wrapped or cut, collapsed or expanded. Your split and wrap choices are remembered across sessions.
- **Made for Desktop.** Each file is drawn as a crisp SVG with syntax colours that follow your light or dark theme, plus file icons, diffstat squares and a New badge.
- **Works in the terminal too**, with the same pane drawn in your theme's diff colours, with hotkeys for its buttons.
- **No git required.** Diffs come from Claude's own Edit, Write and NotebookEdit calls, so you see only what Claude did, even in a dirty working tree or outside a repository.

### Split view

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/split-dark.png">
  <img alt="Split view: the old file on the left and the new one on the right, a long line wrapped, and the other two files collapsed" src="docs/images/split-light.png">
</picture>

### A hint after every turn with edits

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/band-dark.png">
  <img alt="Above the prompt: Last turn changed 3 files +13 −2, five diffstat squares and a View changes button" src="docs/images/band-light.png" width="560">
</picture>

The hint disappears after a turn that edited nothing.

### In the terminal

<img alt="The same pane in a terminal: bracketed buttons with hotkeys, and tinted diff rows inside rounded cards" src="docs/images/terminal.png" width="760">

## Controls

| Button | Terminal key | What it does |
| --- | :---: | --- |
| `←` `→` and the turn picker | `p` `n` | Step through earlier turns with edits |
| `Split view` / `Unified view` | `s` | Old file beside the new one, or interleaved. Needs a pane 64 columns wide in Desktop, 90 in the terminal. New files are always unified. |
| `Unwrap lines` / `Wrap lines` | `w` | Cut long lines at the pane's edge, or wrap them |
| `Collapse all` / `Expand all` | `a` | Fold every card. Click a card's path to fold just that one. |
| `Jump to file` | | Open a file and scroll to its card |
| `Refresh` | `r` | Read the transcript again and add any turn with edits that wasn't recorded live |
| `Previous file` / `Next file` | `k` `j` | Shown for large turns, which show one file at a time |

A turn whose files add up to more than 400 changed lines shows one file at a time, and a long file shows 150 lines at a time, which keeps the pane under the 100,000-character limit for what it can draw. Hotkeys work in the terminal only.

## Limits

- **Only Edit, Write and NotebookEdit calls are recorded.** The mod doesn't see changes made through the shell (sed, formatters, `git checkout`, code generators), MCP tools, other plugins, or you.
- **Other changes can mix into the diff.** If something else changes a file between two of Claude's edits to it in the same turn, that change also appears in the file's diff for that turn.
- **Subagent edits are lost on a reload.** They are recorded while the session runs, but the main transcript doesn't store them, so they can't be read back.
- **The Desktop diff is an image.** Its text can't be selected or copied, and a string or comment that spans lines is coloured line by line, so only its first line may be coloured right.
- **Notebook edits are shown per cell.** The diff covers the cell source only, not the notebook JSON.
- **Size caps:** the 30 newest turns with edits are kept; a file over 2 MB is listed without a diff; each file keeps about 150,000 characters of hunks, and each turn about 600,000.

<details>
<summary><b>How it works</b></summary>

<br>

- A `tool.call` hook reads the file before Edit or Write runs, lets the call through unchanged, and then reads the file again. Calls that were denied, failed, or held for review (`staged`) are skipped.
- Edits are grouped by turn, from `turn.start` to `turn.complete`. Each file's diff compares the file before its first edit in the turn with the file after its last edit in the turn. A small Myers diff in plain TypeScript computes it, with no dependencies.
- When a session starts, after `/resume`, or after a fork, the mod reads the turns back from the transcript (`$.session.messages()`). It uses the `originalFile` and `content` fields that Edit and Write store there, so the pane survives a reload. `/clear` empties the list.
- The terminal pane draws `Box`, `Text`, `Button` and `Select`. Desktop draws the same controls, but each file's lines are an `Svg` element (`hooks/svg.ts`), and its icons are small `Svg` elements beside the text (`hooks/icons.ts`). The Claude Code that Desktop bundles (2.1.295) has no monospaced `Text` (it refuses `mono` and `size`). The theme's diff colours are opaque fills made for a terminal, and they drown the text in a Desktop pane. The `Code` element's diff format draws a plain code block there, with no tints or line numbers.
- A `Button` can hold only text: the engine refuses an `Svg` inside one. So Desktop's buttons start with a glyph (`↻ Refresh`, `◫ Split view`, `⊟ Collapse all`), and the icons sit beside them.
- The picture is as wide as the card, drawn 1:1. The mod estimates the card's width from the pane's `bodyColumns` (about 8 CSS pixels a column) only to decide where long lines wrap. Its tints are translucent and its text colours switch with `prefers-color-scheme`, so it reads on a light or a dark theme.
- `hooks/syntax.ts` colours keywords, strings, comments, numbers, and function and type names for a handful of language families (JS/TS, C-like, Python, shell, Ruby, SQL, CSS, YAML/TOML/JSON), one line at a time.

</details>

<details>
<summary><b>Develop</b></summary>

<br>

Load the mod from a checkout. In the **terminal**, for one session:

```bash
claude --plugin-dir /path/to/claude-last-turn-diff
```

**Claude Desktop** doesn't accept `--plugin-dir`. Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json` instead (separate several folders with `:`), then run `/reload-plugins` or start a new Desktop session:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-last-turn-diff"
  }
}
```

Validate and test:

```bash
claude plugin validate .
claude plugin test .
```

Desktop runs its own bundled Claude Code, which can be older than the `claude` on your PATH. Validate with that build too, because an older engine can refuse a module a newer one loads (2.1.295 refuses passing `$` into a function imported from another file, which is why `hooks/view.tsx` never holds `$`; it also refuses `Text` props such as `mono` and `size` and a `gap` given as a name like `'xs'`). In a Desktop session, `$CLAUDE_CODE_EXECPATH` names that build:

```bash
"$CLAUDE_CODE_EXECPATH" plugin validate .
```

The tests in `tests/` simulate Edit and Write tool calls and turn boundaries, then read the drawn pane on both the terminal and desktop surfaces. On the terminal they check the rows, tints and word marks; on Desktop, the pictures' markup. Both cover split view, wrap, collapse all, jump to file, the large-turn mode, refresh and the turn picker. They also test the SVG renderer, the highlighter and the turn titles directly.

When the engine loads the mod, it writes `.claude-plugin/types/` and a `tsconfig.json`. After that, `tsc -p .` type-checks the mod. Git ignores both generated files.

The images in this README are drawn from the mod's real output. `docs/screenshots/fixture.ts` mounts the pane on a small made-up project, and `make.ts` draws what it prints as pages styled like Claude Desktop and a terminal, then photographs them with headless Chrome. After changing the UI, rebuild them:

```bash
cd docs/screenshots && bun install && bun make.ts
```

To release, bump `version` in `.claude-plugin/plugin.json` and run `claude plugin tag --push .`. Installs are cached by version, so bump it for every release.

</details>

## Credits

This mod borrows the idea of recording edits at `tool.call` and replaying them in a pane from Anthropic's replay-theater sample mod (Apache-2.0). No code is copied from it.

Released under the [MIT License](LICENSE).
