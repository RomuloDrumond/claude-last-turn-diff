// The pane: one turn's files as GitHub-style cards. Each card has the path,
// an Added or Modified badge, the +/- counts and five squares for their
// mix; open, it lists the lines with both line numbers, tinted rows for
// removed and added lines, the changed words marked, and a row for each run
// of unchanged lines. Unified interleaves the lines; split puts the old file
// beside the new one. A turn too large to draw at once shows one file at a
// time, with a warning and Previous/Next file.
//
// It draws only Box, Text, Button and, where the surface has it, Select: the
// desktop, VS Code and mobile have no Raster or Image.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderInput } from 'claude-code'

import type { DiffMode, FileDiff, PaneView, TurnDiff } from '../types'
import { keepSpaces, rowsOf, splitRowsOf } from './rows'
import type { Gap, Line, Row, Span, SplitRow } from './rows'
import { MODE_KEY, NEWEST, WRAP_KEY } from './state'

type $ = EngineInterface
type Kit = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>
type Look = { width: number; wrap: boolean }

export type PaneActions = { refresh: () => Promise<void> }

const turns = atom({ plugin: 'last-turn-diff', key: 'turns' } as const, [])
const view = atom({ plugin: 'last-turn-diff', key: 'view' } as const, NEWEST)

export const PANE = 'last-turn-diff'
const NBSP = ' '
// A file shows this many rows a page at a time.
const PAGE_ROWS = 150
// What every open file draws at most: a tree draws its first 100,000
// characters, and every row is several elements. A turn whose files do not
// fit with each one open shows one file at a time.
const MAX_DRAWN_CHARS = 80_000
const MAX_DRAWN_ROWS = 600
const MAX_LISTED_FILES = 60
const SQUARES = 5

const BACKGROUND = { context: undefined, removed: 'diffRemoved', added: 'diffAdded' } as const
const WORD = { context: undefined, removed: 'diffRemovedWord', added: 'diffAddedWord' } as const
const MARK = { context: NBSP, removed: '−', added: '+' } as const

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const lineCount = (rows: readonly (Row | SplitRow)[]) => rows.filter(row => row.kind !== 'gap').length

function pagesOf<T>(rows: readonly T[]): T[][] {
  const pages: T[][] = []
  for (let at = 0; at < rows.length; at += PAGE_ROWS) pages.push(rows.slice(at, at + PAGE_ROWS))
  return pages
}

function widthOf(rows: readonly Row[]): number {
  const most = rows.reduce(
    (top, row) => (row.kind === 'gap' ? top : Math.max(top, row.old ?? 0, row.new ?? 0)),
    0,
  )
  return Math.max(2, String(most).length)
}

const gutter = (n: number | undefined, width: number) =>
  (n === undefined ? '' : String(n)).padStart(width, NBSP) + NBSP

function squaresOf(file: FileDiff): { added: number; removed: number; none: number } {
  const total = file.added + file.removed
  const filled = Math.min(SQUARES, total)
  const added = total === 0 ? 0 : Math.round((filled * file.added) / total)
  return { added, removed: filled - added, none: SQUARES - filled }
}

function charsOf(rows: readonly (Row | SplitRow)[], width: number): number {
  const lineChars = (line: Line | undefined) =>
    line === undefined ? 0 : 2 * width + 6 + line.spans.reduce((sum, span) => sum + span.text.length, 0)
  return rows.reduce((sum, row) => {
    if (row.kind === 'gap') return sum + width + 40
    if (row.kind === 'pair') return sum + lineChars(row.left) + lineChars(row.right)
    return sum + lineChars(row)
  }, 0)
}

function code(ui: Kit, line: Line, look: Look) {
  const word = WORD[line.kind]
  const spans = line.spans.map((span: Span) => ({ ...span, text: keepSpaces(span.text) }))
  const shown = spans.every(span => span.text === '')
    ? NBSP
    : spans.map(span =>
        span.isChanged && word !== undefined ? <ui.Text backgroundColor={word}>{span.text}</ui.Text> : span.text,
      )
  return (
    <ui.Box flexGrow={1} flexShrink={1}>
      <ui.Text wrap={look.wrap ? 'wrap' : 'truncate-end'}>{shown}</ui.Text>
    </ui.Box>
  )
}

function gapRow(ui: Kit, gap: Gap, look: Look) {
  const where = gap.count === 1 ? `line ${gap.from}` : `lines ${gap.from}–${gap.from + gap.count - 1}`
  return (
    <ui.Box flexDirection="row">
      <ui.Text dimColor wrap="truncate-end">
        {NBSP.repeat(look.width)} ⋯ {plural(gap.count, 'unchanged line')} ({where})
      </ui.Text>
    </ui.Box>
  )
}

function unifiedRow(ui: Kit, row: Row, look: Look) {
  if (row.kind === 'gap') return gapRow(ui, row, look)
  return (
    <ui.Box flexDirection="row" backgroundColor={BACKGROUND[row.kind]}>
      <ui.Text dimColor>{gutter(row.old, look.width)}</ui.Text>
      <ui.Text dimColor>{gutter(row.new, look.width)}</ui.Text>
      <ui.Text dimColor={row.kind === 'context'}>{MARK[row.kind]}{NBSP}</ui.Text>
      {code(ui, row, look)}
    </ui.Box>
  )
}

function half(ui: Kit, line: Line | undefined, side: 'old' | 'new', look: Look) {
  if (line === undefined) return <ui.Box width="50%" />
  return (
    <ui.Box width="50%" flexDirection="row" backgroundColor={BACKGROUND[line.kind]}>
      <ui.Text dimColor>{gutter(line[side], look.width)}</ui.Text>
      <ui.Text dimColor={line.kind === 'context'}>{MARK[line.kind]}{NBSP}</ui.Text>
      {code(ui, line, look)}
    </ui.Box>
  )
}

function splitRow(ui: Kit, row: SplitRow, look: Look) {
  if (row.kind === 'gap') return gapRow(ui, row, look)
  return (
    <ui.Box flexDirection="row" gap={1}>
      {half(ui, row.left, 'old', look)}
      {half(ui, row.right, 'new', look)}
    </ui.Box>
  )
}

// One file's rows in the pane's mode, paged, with what its first page costs.
function prepare(file: FileDiff, mode: DiffMode) {
  const unified = rowsOf(file.hunks)
  const rows: (Row | SplitRow)[] = mode === 'split' ? splitRowsOf(unified) : unified
  const width = widthOf(unified)
  const pages = pagesOf(rows)
  const first = pages[0] ?? []
  return { file, rows, width, pages, firstRows: first.length, firstChars: charsOf(first, width) }
}

async function remember($: $, key: string, value: unknown) {
  try {
    await $.store.set(key, value)
  } catch {
    // Remembering a choice is a convenience: the pane changed anyway.
  }
}

export async function paneOf($: $, e: RenderInput<'Pane'>, actions: PaneActions) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Select = 'Select' in elements ? elements.Select : undefined
  const ui: Kit = { Box, Text, Button }
  const list = await read($, turns)
  const now: PaneView = await read($, view)
  const at = Math.min(now.at, Math.max(0, list.length - 1))
  const mode: DiffMode = now.mode ?? 'unified'
  const wrap = now.wrap ?? true
  const turn: TurnDiff | undefined = list[at]

  const refreshButton = (
    <Button key="refresh" label="⟳ Refresh" hotkey="r" onPress={() => void actions.refresh()} />
  )

  if (turn === undefined) {
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>No file edits recorded in this session yet.</Text>
          <Text dimColor>Edits made through Edit, Write and NotebookEdit show here after each turn.</Text>
        </Box>
        <Box flexDirection="row">{refreshButton}</Box>
      </Box>
    )
  }

  const files = turn.files.map(file => prepare(file, mode))
  const isTooLarge =
    files.length > MAX_LISTED_FILES ||
    files.reduce((sum, one) => sum + one.firstRows, 0) > MAX_DRAWN_ROWS ||
    files.reduce((sum, one) => sum + one.firstChars, 0) > MAX_DRAWN_CHARS
  const current = Math.min(now.file ?? 0, files.length - 1)
  const isOpen = (file: FileDiff) => !now.toggled.includes(file.key)
  const isAllOpen = turn.files.every(isOpen)

  const go = (to: number) =>
    update($, view, was => ({
      ...was,
      at: Math.max(0, Math.min(to, list.length - 1)),
      toggled: [],
      pages: {},
      file: 0,
    }))
  const toggle = (key: string) =>
    update($, view, was => ({
      ...was,
      toggled: was.toggled.includes(key) ? was.toggled.filter(one => one !== key) : [...was.toggled, key],
    }))
  const turnPage = (key: string, to: number) =>
    update($, view, was => ({ ...was, pages: { ...was.pages, [key]: to } }))
  const switchMode = async () => {
    const next: DiffMode = mode === 'unified' ? 'split' : 'unified'
    await update($, view, was => ({ ...was, mode: next, pages: {} }))
    await remember($, MODE_KEY, next)
  }
  const switchWrap = async () => {
    await update($, view, was => ({ ...was, wrap: !wrap }))
    await remember($, WRAP_KEY, !wrap)
  }
  const showFile = (to: number) =>
    update($, view, was => ({ ...was, file: Math.max(0, Math.min(to, files.length - 1)) }))
  const jumpTo = async (index: number) => {
    const target = turn.files[index]
    if (target === undefined) return
    await update($, view, was => ({
      ...was,
      file: index,
      toggled: was.toggled.filter(key => key !== target.key),
    }))
    if (isTooLarge) return
    try {
      await $.ui.scroll({ to: { key: `card-${index}` }, in: PANE, block: 'start' })
    } catch {
      // The surface could not scroll: the file is open, further down.
    }
  }

  let chars = MAX_DRAWN_CHARS
  let drawnRows = MAX_DRAWN_ROWS

  const card = (index: number) => {
    const { file, rows, width, pages } = files[index]!
    const open = isTooLarge || isOpen(file)
    const page = Math.min(now.pages[file.key] ?? 0, Math.max(0, pages.length - 1))
    const shown = pages[page] ?? []
    const size = charsOf(shown, width)
    const fits = size <= chars && shown.length <= drawnRows
    if (open && fits) {
      chars -= size
      drawnRows -= shown.length
    }
    const look: Look = { width, wrap }
    const squares = squaresOf(file)
    const badge = file.isNew ? 'Added' : 'Modified'

    return (
      <Box key={`card-${index}`} flexDirection="column" borderStyle="round" borderDimColor>
        <Button key={`toggle-${index}`} plain onPress={() => void (isTooLarge ? undefined : toggle(file.key))}>
          {open ? '▾ ' : '▸ '}
          <Text bold>{file.name}</Text>
          {'  '}
          <Text dimColor>{badge}</Text>
          {'  '}
          <Text color="success">+{file.added}</Text> <Text color="error">−{file.removed}</Text>{' '}
          <Text color="success">{'■'.repeat(squares.added)}</Text>
          <Text color="error">{'■'.repeat(squares.removed)}</Text>
          <Text dimColor>{'■'.repeat(squares.none)}</Text>
          {file.note !== undefined ? <Text dimColor>{'  '}({file.note})</Text> : ''}
        </Button>
        {open && shown.length > 0 && fits && (
          <Box flexDirection="column">
            {shown.map(row =>
              mode === 'split' ? splitRow(ui, row as SplitRow, look) : unifiedRow(ui, row as Row, look),
            )}
          </Box>
        )}
        {open && shown.length > 0 && !fits && (
          <Text dimColor>Too much is open to draw this file here: collapse another file first.</Text>
        )}
        {open && pages.length > 1 && (
          <Box flexDirection="row" gap={1}>
            <Button key={`earlier-${index}`} label="◀ Earlier lines" onPress={() => void turnPage(file.key, page - 1)} />
            <Text dimColor>
              {lineCount(pages.slice(0, page).flat()) + 1}–{lineCount(pages.slice(0, page + 1).flat())} of{' '}
              {lineCount(rows)} lines
            </Text>
            <Button key={`later-${index}`} label="Later lines ▶" onPress={() => void turnPage(file.key, page + 1)} />
          </Box>
        )}
      </Box>
    )
  }

  const jump =
    Select !== undefined ? (
      <Select
        key="jump"
        label="Jump to file"
        value={String(current)}
        options={turn.files.map((file, index) => ({
          value: String(index),
          label: `${file.name}  +${file.added} −${file.removed}`,
        }))}
        onSelect={value => void jumpTo(Number(value))}
      />
    ) : null

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          T{turn.n} · {turn.title}
        </Text>
        <Text>
          {plural(turn.files.length, 'file')} changed{'  '}
          <Text color="success">+{turn.added}</Text> <Text color="error">−{turn.removed}</Text>
          <Text dimColor>
            {'  '}· turn {at + 1} of {list.length} with edits
          </Text>
        </Text>
      </Box>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="prev" label="◀ Older" hotkey="p" onPress={() => void go(at + 1)} />
          {Select !== undefined && list.length > 1 && (
            <Select
              key="turn"
              value={String(at)}
              options={list.map((one, index) => ({
                value: String(index),
                label: `T${one.n} · ${one.title} · ${plural(one.files.length, 'file')}`,
              }))}
              onSelect={value => void go(Number(value))}
            />
          )}
          <Button key="next" label="Newer ▶" hotkey="n" onPress={() => void go(at - 1)} />
          {refreshButton}
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button
            key="mode"
            label={mode === 'unified' ? 'Split view' : 'Unified view'}
            hotkey="s"
            onPress={() => void switchMode()}
          />
          <Button
            key="wrap"
            label={wrap ? 'Unwrap lines' : 'Wrap lines'}
            hotkey="w"
            onPress={() => void switchWrap()}
          />
          {!isTooLarge && (
            <Button
              key="all"
              label={isAllOpen ? 'Collapse all' : 'Expand all'}
              hotkey="a"
              onPress={() =>
                void update($, view, was => ({
                  ...was,
                  toggled: isAllOpen ? turn.files.map(file => file.key) : [],
                }))
              }
            />
          )}
          {jump}
        </Box>
      </Box>
      {isTooLarge && (
        <Box flexDirection="column">
          <Text color="warning">
            ⚠ This turn's diff is too large to show at once, so it shows one file at a time. Use Previous and
            Next file{Select !== undefined ? ' or Jump to file' : ''} to move between files.
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="prev-file" label="◀ Previous file" hotkey="k" onPress={() => void showFile(current - 1)} />
            <Text dimColor>
              File {current + 1} of {files.length}
            </Text>
            <Button key="next-file" label="Next file ▶" hotkey="j" onPress={() => void showFile(current + 1)} />
          </Box>
        </Box>
      )}
      <Box flexDirection="column">{isTooLarge ? card(current) : files.map((_, index) => card(index))}</Box>
    </Box>
  )
}
