# last-turn-diff

A Claude Code mod that shows the file edits Claude made in the last turn, and lets you step back through earlier turns. It works in the Claude Desktop app's Code tab and in the terminal. It doesn't use git: it builds diffs from Claude's own Edit, Write and NotebookEdit tool calls.

- **Hint above the prompt.** After a turn that edited files, a line such as `Last turn changed 3 files  +40 −12  [View changes]` appears above the prompt. It disappears after a turn that edited nothing.
- **`/lastturn` pane.** Opens a GitHub-style view of the newest turn that had edits:
  - a header with the turn label (`T7 · first words of the prompt…`) and `3 files changed  +40 −12`
  - one card per file with its path, an Added or Modified badge, the +/− counts and five green/red squares for their mix. Click a card to collapse or expand it.
  - the lines of each open file with the old and new line numbers, red and green rows for removed and added lines, and the words that changed within a reworded line marked
  - a `⋯ 23 unchanged lines (lines 12–34)` row wherever unchanged lines are skipped
- **Toolbar:**
  - `◀ Older` (`p`), `Newer ▶` (`n`) and a turn picker step through the turns.
  - `⟳ Refresh` (`r`) reads the transcript again and adds any turn with edits that wasn't recorded live, for example from before the mod loaded. Turns recorded live are kept as recorded.
  - `Split view` / `Unified view` (`s`) puts the old file beside the new one, as GitHub's split diff does, or interleaves them. New files always show unified.
  - `Unwrap lines` / `Wrap lines` (`w`) cuts long lines at the pane's edge or wraps them.
  - `Collapse all` / `Expand all` (`a`) folds every card.
  - `Jump to file` opens a file and scrolls to its card.
  - The split and wrap choices are remembered across sessions.
- **Large turns.** When a turn changes several files that add up to more than 400 lines, the pane warns that the diff is too large to show at once and shows one file at a time, with `◀ Previous file` (`k`), `Next file ▶` (`j`) and `Jump to file`. A long file shows 150 lines at a time either way, which keeps the pane under the 100,000-character limit for what it can draw.

The colors come from the theme keys Claude Code uses for its own diffs (`diffAdded`, `diffRemoved`, `diffAddedWord`, `diffRemovedWord`), so they follow the light or dark theme.

## How it works

- A `tool.call` hook reads the file before Edit or Write runs, lets the call through unchanged, and then reads the file again. Calls that were denied, failed, or held for review (`staged`) are skipped.
- Edits are grouped by turn, from `turn.start` to `turn.complete`. Each file's diff compares the file before its first edit in the turn with the file after its last edit in the turn. A small Myers diff in plain TypeScript computes it, with no dependencies.
- When a session starts, after `/resume`, or after a fork, the mod reads the turns back from the transcript (`$.session.messages()`). It uses the `originalFile` and `content` fields that Edit and Write store there, so the pane survives a reload. `/clear` empties the list.
- The pane and the hint draw only `Box`, `Text`, `Button` and, where the surface has it, `Select`. The desktop supports all of them; there is no `Raster` or `Image`. Rows are plain text, so there is no syntax colouring.

## Limits

- **Only Edit, Write and NotebookEdit calls are recorded.** The mod doesn't see changes made through the shell (sed, formatters, `git checkout`, code generators), MCP tools, other plugins, or you.
- **Other changes can mix into the diff.** If something else changes a file between two of Claude's edits to it in the same turn, that change also appears in the file's diff for that turn.
- **Subagent edits are lost on a reload.** Subagent edits are recorded while the session runs. When the mod reads the turns back from the transcript, it can't see subagent edits, because the main transcript doesn't store them.
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

Desktop runs its own bundled Claude Code, which can be older than the `claude` on your PATH. Validate with that build too, because an older engine can refuse a module a newer one loads (2.1.295 refuses passing `$` into a function imported from another file, which is why `hooks/view.tsx` never holds `$`). In a Desktop session, `$CLAUDE_CODE_EXECPATH` names that build:

```bash
"$CLAUDE_CODE_EXECPATH" plugin validate .
```

The tests in `tests/` simulate Edit and Write tool calls and turn boundaries, then read the drawn pane (rows, tints, word marks, split view, wrap, collapse all, jump to file, the large-turn mode, refresh, turn picker) on both the terminal and desktop surfaces.

When the engine loads the mod, it writes `.claude-plugin/types/` and a `tsconfig.json`. After that, `tsc -p .` type-checks the mod. Git ignores both generated files.

This mod borrows the idea of recording edits at `tool.call` and replaying them in a pane from Anthropic's replay-theater sample mod (Apache-2.0). No code is copied from it.
