// The pane: one turn's files as GitHub-style cards. Each card has the path,
// an Added or Modified badge, the +/- counts and five squares for their
// mix; open, it lists the lines with both line numbers, tinted rows for
// removed and added lines, the changed words marked, and a row for each run
// of unchanged lines. Unified interleaves the lines; split puts the old file
// beside the new one.
//
// It draws only Box, Text, Button and, where the surface has it, Select: the
// desktop, VS Code and mobile have no Raster or Image.

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderInput } from 'claude-code'

import type { DiffMode, FileDiff, PaneView, TurnDiff } from '../types'
import { keepSpaces, rowsOf, splitRowsOf } from './rows'
import type { Gap, Line, Row, Span, SplitRow } from './rows'
import { MODE_KEY, NEWEST } from './state'

type $ = EngineInterface
type Kit = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>

const turns = atom({ plugin: 'last-turn-diff', key: 'turns' } as const, [])
const view = atom({ plugin: 'last-turn-diff', key: 'view' } as const, NEWEST)

const NBSP = ' '
// A file shows this many rows a page at a time.
const PAGE_ROWS = 150
// Files open by default until their first pages add up to this many rows.
const OPEN_BY_DEFAULT_ROWS = 250
// What all open files draw at most: a tree draws its first 100,000
// characters, and every row is several elements.
const MAX_DRAWN_CHARS = 85_000
const MAX_DRAWN_ROWS = 700
const MAX_LISTED_FILES = 150
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

function opensByDefault(files: readonly FileDiff[]): Set<string> {
  const open = new Set<string>()
  let rows = 0
  for (const file of files) {
    const count = Math.min(PAGE_ROWS, rowsOf(file.hunks).length)
    if (count === 0) continue
    if (open.size > 0 && rows + count > OPEN_BY_DEFAULT_ROWS) break
    open.add(file.key)
    rows += count
  }
  return open
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

function spansOf(ui: Kit, line: Line) {
  const word = WORD[line.kind]
  const spans = line.spans.map((span: Span) => ({ ...span, text: keepSpaces(span.text) }))
  if (spans.every(span => span.text === '')) return NBSP
  return spans.map(span =>
    span.isChanged && word !== undefined ? <ui.Text backgroundColor={word}>{span.text}</ui.Text> : span.text,
  )
}

function gapRow(ui: Kit, gap: Gap, width: number) {
  const where = gap.count === 1 ? `line ${gap.from}` : `lines ${gap.from}–${gap.from + gap.count - 1}`
  return (
    <ui.Box flexDirection="row">
      <ui.Text dimColor wrap="truncate-end">
        {NBSP.repeat(width)} ⋯ {plural(gap.count, 'unchanged line')} ({where})
      </ui.Text>
    </ui.Box>
  )
}

function unifiedRow(ui: Kit, row: Row, width: number) {
  if (row.kind === 'gap') return gapRow(ui, row, width)
  return (
    <ui.Box flexDirection="row" backgroundColor={BACKGROUND[row.kind]}>
      <ui.Text dimColor>{gutter(row.old, width)}</ui.Text>
      <ui.Text dimColor>{gutter(row.new, width)}</ui.Text>
      <ui.Text dimColor={row.kind === 'context'}>{MARK[row.kind]}{NBSP}</ui.Text>
      <ui.Box flexGrow={1} flexShrink={1}>
        <ui.Text>{spansOf(ui, row)}</ui.Text>
      </ui.Box>
    </ui.Box>
  )
}

function half(ui: Kit, line: Line | undefined, side: 'old' | 'new', width: number) {
  if (line === undefined) return <ui.Box width="50%" />
  return (
    <ui.Box width="50%" flexDirection="row" backgroundColor={BACKGROUND[line.kind]}>
      <ui.Text dimColor>{gutter(line[side], width)}</ui.Text>
      <ui.Text dimColor={line.kind === 'context'}>{MARK[line.kind]}{NBSP}</ui.Text>
      <ui.Box flexGrow={1} flexShrink={1}>
        <ui.Text>{spansOf(ui, line)}</ui.Text>
      </ui.Box>
    </ui.Box>
  )
}

function splitRow(ui: Kit, row: SplitRow, width: number) {
  if (row.kind === 'gap') return gapRow(ui, row, width)
  return (
    <ui.Box flexDirection="row" gap={1}>
      {half(ui, row.left, 'old', width)}
      {half(ui, row.right, 'new', width)}
    </ui.Box>
  )
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

export async function paneOf($: $, e: RenderInput<'Pane'>) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Select = 'Select' in elements ? elements.Select : undefined
  const ui: Kit = { Box, Text, Button }
  const list = await read($, turns)
  const now: PaneView = await read($, view)
  const at = Math.min(now.at, Math.max(0, list.length - 1))
  const mode: DiffMode = now.mode ?? 'unified'
  const turn: TurnDiff | undefined = list[at]

  if (turn === undefined) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No file edits recorded in this session yet.</Text>
        <Text dimColor>Edits made through Edit, Write and NotebookEdit show here after each turn.</Text>
      </Box>
    )
  }

  const go = (to: number) =>
    update($, view, was => ({ ...was, at: Math.max(0, Math.min(to, list.length - 1)), toggled: [], pages: {} }))
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
    try {
      await $.store.set(MODE_KEY, next)
    } catch {
      // Remembering the choice is a convenience: the pane switched anyway.
    }
  }

  const listed = turn.files.slice(0, MAX_LISTED_FILES)
  const byDefault = opensByDefault(listed)
  const isOpen = (file: FileDiff) => byDefault.has(file.key) !== now.toggled.includes(file.key)
  const isAllOpen = listed.every(isOpen)
  let chars = MAX_DRAWN_CHARS - 4_000
  let drawnRows = MAX_DRAWN_ROWS

  const cards = listed.map((file, index) => {
    const open = isOpen(file)
    const unified = rowsOf(file.hunks)
    const rows: (Row | SplitRow)[] = mode === 'split' ? splitRowsOf(unified) : unified
    const width = widthOf(unified)
    const pages = pagesOf(rows)
    const page = Math.min(now.pages[file.key] ?? 0, Math.max(0, pages.length - 1))
    const shown = pages[page] ?? []
    const size = charsOf(shown, width)
    const fits = size <= chars && shown.length <= drawnRows
    if (open && fits) {
      chars -= size
      drawnRows -= shown.length
    }
    const squares = squaresOf(file)
    const badge = file.isNew ? 'Added' : 'Modified'

    return (
      <Box key={`card-${index}`} flexDirection="column" borderStyle="round" borderDimColor>
        <Button key={`toggle-${index}`} plain onPress={() => void toggle(file.key)}>
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
            {shown.map(row => (mode === 'split' ? splitRow(ui, row as SplitRow, width) : unifiedRow(ui, row as Row, width)))}
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
  })

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
        <Button
          key="mode"
          label={mode === 'unified' ? 'Split view' : 'Unified view'}
          hotkey="s"
          onPress={() => void switchMode()}
        />
        <Button
          key="all"
          label={isAllOpen ? 'Collapse all' : 'Expand all'}
          hotkey="a"
          onPress={() =>
            void update($, view, was => ({
              ...was,
              toggled: listed
                .filter(file => (isAllOpen ? byDefault.has(file.key) : !byDefault.has(file.key)))
                .map(file => file.key),
            }))
          }
        />
      </Box>
      <Box flexDirection="column">{cards}</Box>
      {turn.files.length > listed.length && (
        <Text dimColor>{turn.files.length - listed.length} more files not listed.</Text>
      )}
    </Box>
  )
}
