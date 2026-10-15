# last-turn-diff

A Claude Code mod that shows the file edits Claude made in the last turn, and lets you step back through earlier turns. It works in the Claude Desktop app's Code tab and in the terminal. It doesn't use git: it builds diffs from Claude's own Edit, Write and NotebookEdit tool calls.

- **Hint above the prompt.** After a turn that edited files, a line such as `Last turn changed 3 files  +40 −12  [View changes]` appears above the prompt. It disappears after a turn that edited nothing.
- **`/lastturn` pane.** Opens a GitHub-style view of the newest turn that had edits:
  - a header with the turn label (`T7 · first words of the prompt…`) and `3 files changed  +40 −12`. A turn started by a background task's notification is labelled by the task's summary, and a slash command by its name.
  - one card per file with its path, a New badge for a created file, the +/− counts and, when the pane is wide enough, five green/red squares for their mix. Click a card's path to collapse or expand it.
  - the lines of each open file with the old and new line numbers, red and green rows for removed and added lines, and the words that changed within a reworded line marked
  - a `⋯ 23 unchanged lines (lines 12–34)` row wherever unchanged lines are skipped
- **Desktop and terminal draw the lines differently.** In the Desktop app each file's lines are a picture (SVG) in GitHub's diff style: a 12px monospaced face, tinted line-number gutters, translucent row and word tints, and syntax colours. In the terminal they are text rows painted with the theme's diff colours (`diffAdded`, `diffRemoved`, `diffAddedWord`, `diffRemovedWord`).
- **Desktop icons.** In the Desktop app the header, the cards, the hint and the warnings carry small SVG icons: a file icon (a green plus for a new file, an amber dot for a changed one), GitHub's diffstat squares, a green New pill, a warning sign, and a drawing in the empty pane. Each card has its own chevron button. The buttons start with a glyph (`↻ Refresh`, `◫ Split view`, `⊟ Collapse all`), because a `Button` can hold only text: the engine refuses an `Svg` inside one.
- **Toolbar:**
  - `◀` and `▶` (`←` and `→` in Desktop) beside the turn picker step through the turns (`p` and `n` in the terminal).
  - `Refresh` (`r`) reads the transcript again and adds any turn with edits that wasn't recorded live, for example from before the mod loaded. Turns recorded live are kept as recorded.
  - `Split view` / `Unified view` (`s`) puts the old file beside the new one, as GitHub's split diff does, or interleaves them. It shows when the pane is at least 90 columns wide in the terminal, or 64 in Desktop. Narrower panes and new files always show unified.
  - `Unwrap lines` / `Wrap lines` (`w`) cuts long lines at the pane's edge or wraps them.
  - `Collapse all` / `Expand all` (`a`) folds every card.
  - `Jump to file` opens a file and scrolls to its card.
  - The split and wrap choices are remembered across sessions. Hotkeys work in the terminal only; Desktop shows no hotkey badges.
- **Large turns.** When a turn changes several files that add up to more than 400 lines, the pane warns that the diff is too large to show at once and shows one file at a time, with `Previous file` (`k`), `Next file` (`j`) and `Jump to file`. A long file shows 150 lines at a time either way, which keeps the pane under the 100,000-character limit for what it can draw.

## How it works

- A `tool.call` hook reads the file before Edit or Write runs, lets the call through unchanged, and then reads the file again. Calls that were denied, failed, or held for review (`staged`) are skipped.
- Edits are grouped by turn, from `turn.start` to `turn.complete`. Each file's diff compares the file before its first edit in the turn with the file after its last edit in the turn. A small Myers diff in plain TypeScript computes it, with no dependencies.
- When a session starts, after `/resume`, or after a fork, the mod reads the turns back from the transcript (`$.session.messages()`). It uses the `originalFile` and `content` fields that Edit and Write store there, so the pane survives a reload. `/clear` empties the list.
- The terminal pane draws `Box`, `Text`, `Button` and `Select`. Desktop draws the same controls, but each file's lines are an `Svg` element (`hooks/svg.ts`), and its icons are small `Svg` elements beside the text (`hooks/icons.ts`). The Claude Code that Desktop bundles (2.1.295) has no monospaced `Text` (it refuses `mono` and `size`). The theme's diff colours are opaque fills made for a terminal, and they drown the text in a Desktop pane. The `Code` element's diff format draws a plain code block there, with no tints or line numbers.
- The picture is as wide as the card, drawn 1:1. The mod estimates the card's width from the pane's `bodyColumns` (about 8 CSS pixels a column) only to decide where long lines wrap. Its tints are translucent and its text colours switch with `prefers-color-scheme`, so it reads on a light or a dark theme.
- `hooks/syntax.ts` colours keywords, strings, comments, numbers, and function and type names for a handful of language families (JS/TS, C-like, Python, shell, Ruby, SQL, CSS, YAML/TOML/JSON), one line at a time.

## Limits

- **Only Edit, Write and NotebookEdit calls are recorded.** The mod doesn't see changes made through the shell (sed, formatters, `git checkout`, code generators), MCP tools, other plugins, or you.
- **Other changes can mix into the diff.** If something else changes a file between two of Claude's edits to it in the same turn, that change also appears in the file's diff for that turn.
- **Subagent edits are lost on a reload.** Subagent edits are recorded while the session runs. When the mod reads the turns back from the transcript, it can't see subagent edits, because the main transcript doesn't store them.
- **The Desktop picture is an image.** Its text can't be selected or copied, and a string or comment that spans lines is coloured line by line, so only its first line may be coloured right.
- **Notebook edits are shown per cell.** The diff covers the cell source only, not the notebook JSON.
- **Size caps:**
  - Only the 30 newest turns with edits are kept.
  - A file over 2 MB is listed without a diff.
  - Each file keeps about 150,000 characters of hunks.
  - Each turn keeps about 600,000 characters of hunks.

## Load it

You need Claude Code 2.1.286 or later.

**Terminal**, for one session:

```bash
claude --plugin-dir ~/projects/claude-last-turn-diff
```

**Claude Desktop (Code tab).** Desktop doesn't accept `--plugin-dir`. Instead, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json`. Separate several folders with `:`.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/romulodrumond/projects/claude-last-turn-diff"
  }
}
```

Then run `/reload-plugins` or start a new Desktop session, and run `/lastturn`.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

Desktop runs its own bundled Claude Code, which can be older than the `claude` on your PATH. Validate with that build too, because an older engine can refuse a module a newer one loads (2.1.295 refuses passing `$` into a function imported from another file, which is why `hooks/view.tsx` never holds `$`; it also refuses `Text` props such as `mono` and `size` and a `gap` given as a name like `'xs'`). In a Desktop session, `$CLAUDE_CODE_EXECPATH` names that build:

```bash
"$CLAUDE_CODE_EXECPATH" plugin validate .
```

The tests in `tests/` simulate Edit and Write tool calls and turn boundaries, then read the drawn pane on both the terminal and desktop surfaces. On the terminal they check the rows, tints and word marks; on Desktop, the pictures' markup. Both cover split view, wrap, collapse all, jump to file, the large-turn mode, refresh and the turn picker. They also test the SVG renderer, the highlighter and the turn titles directly.

To see the pane in Desktop, run `/reload-plugins` in a Code session after a change, then `/lastturn`.

When the engine loads the mod, it writes `.claude-plugin/types/` and a `tsconfig.json`. After that, `tsc -p .` type-checks the mod. Git ignores both generated files.

This mod borrows the idea of recording edits at `tool.call` and replaying them in a pane from Anthropic's replay-theater sample mod (Apache-2.0). No code is copied from it.
