// The pane: one turn's files as GitHub-style cards. Each card has a header
// with the path, the +/- counts and five squares for their mix; open, it
// lists the lines in a monospaced face with both line numbers, tinted rows
// for removed and added lines, the changed words marked, and a row for each
// run of unchanged lines. Unified interleaves the lines; split puts the old
// file beside the new one. A turn too large to draw at once shows one file
// at a time.
//
// Each surface draws the lines its own way. The terminal draws Text rows
// painted with the theme's diff keys. Claude Desktop draws its own text
// (text.tsx), where its engine's Text takes `mono` (2.1.299 and later; 2.1.295
// refuses it), with buttons that copy a line or a hunk. Before that, and on
// the other graphical surfaces, each file's lines are GitHub-style pictures
// (svg.ts). The theme's diff keys are opaque fills made for a terminal that
// drown the text off it, and the `Code` element's diff format draws a plain
// code block there, with no tints or line numbers. Off the terminal the
// header, the cards and the warnings carry small pictures too (icons.ts),
// and the buttons a glyph before their label: a Button holds only text,
// never a picture. There a card's header copies the file's diff.
//
// Claude Desktop refuses a pane of 2,000 nodes or more, or of 262,144
// characters or more, and the engine blanks a tree's text past its first
// 100,000 characters. Off the terminal a page of a file's lines ends before
// it would outgrow what the pane leaves it when that file is shown alone,
// several files show at once only when all of them fit open, and every card
// is measured against those bounds (size.ts); the terminal counts rows and
// characters.
//
// It never holds `$`: the hooks module reads the state, resolves the
// elements and hands in what the buttons do, since an engine before 2.1.300
// refuses a module that passes `$` into a function of another file.

import type { Color, Elements, RenderElement, RenderSurface } from 'claude-code'

import type { DiffMode, FileDiff, PaneView, TurnDiff } from '../types'
import { hasCutLine, patchOf } from './diff'
import { diffstat, emptyPicture, fileIcon, newPill, squaresOf, turnIcon, warningIcon } from './icons'
import type { Icon } from './icons'
import { blocksOf, gapWhere, keepSpaces, plural, rowsIn, splitRowsOf } from './rows'
import type { Gap, Line, LineKind, Row, Span, SplitRow } from './rows'
import { NOTHING, fits, minus, most, plus, sizeOf } from './size'
import type { Size } from './size'
import { MODE_KEY, WRAP_KEY } from './state'
import { MAX_PICTURE_PX, MAX_SOURCE_CHARS, diffPictures, markupOf, pictureFrame } from './svg'
import type { DiffPicture, PictureOptions } from './svg'
import { textLines } from './text'
import type { Copied, TextRow } from './text'
import { titleOf } from './turns'

type Kit = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>

// How the lines are drawn: Text rows in the theme's diff colours, Desktop's
// own text, or pictures.
type Drawing = 'rows' | 'text' | 'pictures'

// How the terminal paints the diff: the theme's own diff colors.
const ROW: Record<LineKind, Color | undefined> = { context: undefined, removed: 'diffRemoved', added: 'diffAdded' }
const WORD: Record<LineKind, Color | undefined> = { context: undefined, removed: 'diffRemovedWord', added: 'diffAddedWord' }
// A file card's header on a graphical surface, GitHub's muted tint.
const HEADER = '#8b949e1a'

type Look = { width: number; wrap: boolean }

// What the pane's controls do, done by the hooks module, which holds `$`.
export type PaneActions = {
  // Writes the pane's view: `change` gets it as stored and returns the next.
  change: (change: (was: PaneView) => PaneView) => Promise<unknown>
  // Keeps a display choice across sessions.
  remember: (key: string, value: boolean | string) => Promise<void>
  // Scrolls the pane to one of its keyed elements.
  scrollTo: (key: string) => Promise<void>
  refresh: () => Promise<void>
  // Puts text on the clipboard of the surface pressed on, and says so,
  // naming what was copied as `what` does.
  copy: (text: string, what: string, surface: RenderSurface) => Promise<void>
}

// What the pane draws from: the turns, newest first, where it stands, and
// the surface and width it is drawn at.
export type PaneModel = {
  list: readonly TurnDiff[]
  now: PaneView
  surface: RenderSurface
  columns: number
  // Whether this is Claude Desktop on an engine whose Text takes `mono`,
  // which draws the lines as text.
  hasMonoText: boolean
}

// What an open card shows: one page of its lines, and where that page stands.
type Shown = {
  page: number
  isPaged: boolean
  // The page's first and last lines, counted from the file's first.
  firstLine: number
  lastLine: number
  // The lines, or what is said in their place; null when there are none.
  body: RenderElement | null
}

export const PANE = 'last-turn-diff'
const NBSP = ' '
// A file shows this many rows a page at a time; off the terminal, at most
// this many.
const PAGE_ROWS = 150
// What every open file draws at most on the terminal: a tree draws its
// first 100,000 characters, and every row is several elements.
const MAX_DRAWN_CHARS = 80_000
const MAX_DRAWN_ROWS = 600
// What a pane may hold off the terminal: a little under the 2,000 nodes and
// 262,144 characters Claude Desktop takes, and the engine's 100,000
// characters of text.
const PANE_BUDGET: Size = { nodes: 1990, chars: 250_000, text: 90_000 }
// A turn of several files past either of these shows one file at a time.
const MAX_TURN_ROWS = 400
const MAX_LISTED_FILES = 60
// A Select holds at most this many options.
const MAX_OPTIONS = 64
// A Jump to file option names at most this many characters of a path, its
// end: 64 long paths would take much of the text the engine draws.
const MAX_OPTION_PATH = 80
// Narrower than this, split view has no room and the pane draws unified.
// Desktop's pictures wrap each half, so they need less: 64 columns leave
// each half about 25 characters.
const MIN_SPLIT_COLUMNS = 90
const MIN_SPLIT_COLUMNS_PICTURES = 64
// Narrower than this, a card's header leaves the squares out.
const MIN_SQUARES_COLUMNS = 60
// The width of one of the pane's columns on a graphical surface, in CSS
// pixels, and the columns a card's border takes.
const CELL_PX = 8
const CARD_COLUMNS = 4

const MARK = { context: NBSP, removed: '−', added: '+' } as const

// A turn's title; one an older version stored with the engine's tags is
// read again.
const titleIn = (turn: TurnDiff) => (turn.title.startsWith('<') ? titleOf(turn.title) : turn.title)

const lineCount = (rows: readonly (Row | SplitRow)[]) => rows.filter(row => row.kind !== 'gap').length

// A path as a Jump to file option names it: its end, if it is long.
function shortPath(name: string): string {
  const chars = [...name]
  return chars.length > MAX_OPTION_PATH ? `…${chars.slice(1 - MAX_OPTION_PATH).join('')}` : name
}

function pagesOf<T>(rows: readonly T[]): T[][] {
  const pages: T[][] = []
  for (let at = 0; at < rows.length; at += PAGE_ROWS) pages.push(rows.slice(at, at + PAGE_ROWS))
  return pages
}

// How a file's rows are drawn off the terminal, all from the same drawing:
// what a page costs before its first row, what each row adds, and a page of
// them as an element.
type Drawer = {
  frame: Size
  costOf: (at: number) => Size
  bodyOf: (from: number, to: number) => RenderElement
}

// Where each page of a file's rows starts off the terminal, as far as the
// start of the page after `last`: a page ends after PAGE_ROWS rows, or before
// the row that would take it past `budget`, and holds at least one row.
function pageStarts(drawer: Drawer, count: number, budget: Size, last: number): number[] {
  const starts = [0]
  let used = drawer.frame
  for (let at = 0; at < count; at++) {
    const from = starts[starts.length - 1]!
    const cost = drawer.costOf(at)
    if (at > from && (at - from >= PAGE_ROWS || !fits(plus(used, cost), budget))) {
      starts.push(at)
      if (starts.length > last + 1) break
      used = drawer.frame
    }
    used = plus(used, cost)
  }
  return starts
}

// What a row of pictures costs: its markup, and its share of the pictures
// it may fill past a page's first. A picture ends before the row that would
// take its markup or its height past the element's bounds, and a row takes
// less than half of either, so every picture but the last holds at least
// half of one; `each` is what a picture costs besides its rows.
function pictureRowCost(markup: { chars: number; height: number }, each: Size): Size {
  const share = markup.chars / (MAX_SOURCE_CHARS / 2) + markup.height / (MAX_PICTURE_PX / 2)
  return { nodes: share * each.nodes, chars: markup.chars + share * each.chars, text: share * each.text }
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

// What a diffstat's squares say, for a reader that cannot see them.
const diffstatAlt = (counts: { added: number; removed: number }) =>
  `${plural(counts.added, 'line')} added, ${counts.removed} removed`

// A path as its folder, drawn dim, and its file name.
function splitPath(name: string): [string, string] {
  const cell = name.indexOf(' · cell ')
  const cut = name.lastIndexOf('/', cell < 0 ? name.length : cell)
  return cut < 0 ? ['', name] : [name.slice(0, cut + 1), name.slice(cut + 1)]
}

function charsOf(rows: readonly (Row | SplitRow)[], width: number): number {
  const lineChars = (line: Line | undefined) =>
    line === undefined ? 0 : 2 * width + 6 + line.spans.reduce((sum, span) => sum + span.text.length, 0)
  return rows.reduce((sum, row) => {
    if (row.kind === 'gap') return sum + 2 * width + 40
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

const numbers = (ui: Kit, sides: (number | undefined)[], look: Look) =>
  sides.map(n => <ui.Text dimColor>{gutter(n, look.width)}</ui.Text>)

const mark = (ui: Kit, kind: LineKind) => (
  <ui.Text dimColor={kind === 'context'}>
    {MARK[kind]}
    {NBSP}
  </ui.Text>
)

function gapRow(ui: Kit, gap: Gap, look: Look) {
  return (
    <ui.Box flexDirection="row">
      <ui.Text dimColor wrap="truncate-end">
        {NBSP.repeat(look.width)} ⋯ {plural(gap.count, 'unchanged line')} ({gapWhere(gap)})
      </ui.Text>
    </ui.Box>
  )
}

function unifiedRow(ui: Kit, row: Row, look: Look) {
  if (row.kind === 'gap') return gapRow(ui, row, look)
  return (
    <ui.Box flexDirection="row" backgroundColor={ROW[row.kind]}>
      {numbers(ui, [row.old, row.new], look)}
      {mark(ui, row.kind)}
      {code(ui, row, look)}
    </ui.Box>
  )
}

function half(ui: Kit, line: Line | undefined, side: 'old' | 'new', look: Look) {
  if (line === undefined) return <ui.Box width="50%" />
  return (
    <ui.Box width="50%" flexDirection="row" backgroundColor={ROW[line.kind]}>
      {numbers(ui, [line[side]], look)}
      {mark(ui, line.kind)}
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

// One file's rows, the digits of its largest line number, and the text of
// each run of lines with no gap inside it, which a Copy hunk button copies.
// A new file is all additions: split would leave its old side empty.
function prepare(file: FileDiff, isSplitView: boolean) {
  const blocks = blocksOf(file.hunks)
  const unified = rowsIn(blocks)
  const isSplit = isSplitView && !file.isNew
  const rows: (Row | SplitRow)[] = isSplit ? splitRowsOf(unified) : unified
  return { file, rows, isSplit, width: widthOf(unified), hunks: blocks.map(block => block.text) }
}

// How a toast names text copied from hunks, saying when their long lines
// were kept cut.
const copiedName = (name: string, text: string) =>
  hasCutLine(text) ? `${name}, its long lines cut to their first 400 characters` : name

export function paneTree(elements: Elements[RenderSurface], model: PaneModel, actions: PaneActions) {
  const { list, now, surface, columns } = model
  const { Box, Text, Button } = elements
  const Select = 'Select' in elements ? elements.Select : undefined
  const ui: Kit = { Box, Text, Button }
  const isTerminal = surface === 'terminal'
  // Every table names every element (one a surface lacks draws nothing), so
  // the surface decides: the terminal draws rows, Desktop its own text where
  // its Text takes `mono`, the other graphical surfaces pictures.
  const Svg = !isTerminal && 'Svg' in elements ? elements.Svg : undefined
  const drawing: Drawing = Svg === undefined ? 'rows' : model.hasMonoText ? 'text' : 'pictures'
  // Hotkeys answer on the terminal; a desktop draws each as a badge on its
  // button, which crowds the toolbar.
  const hotkey = (key: string) => (isTerminal ? { hotkey: key } : {})
  // A button's label, a glyph before it off the terminal.
  const named = (glyph: string, label: string) => (isTerminal ? label : `${glyph} ${label}`)
  const picture = (icon: Icon, alt: string) =>
    Svg === undefined ? null : <Svg alt={alt} source={icon.source} width={icon.width} height={icon.height} />
  const at = Math.min(now.at, Math.max(0, list.length - 1))
  const mode: DiffMode = now.mode ?? 'unified'
  const canSplit = columns >= (drawing === 'pictures' ? MIN_SPLIT_COLUMNS_PICTURES : MIN_SPLIT_COLUMNS)
  const isSplitView = mode === 'split' && canSplit
  // Desktop's text cuts every line in split view: each side is a column of
  // rows one line high.
  const canWrap = !(drawing === 'text' && isSplitView)
  // The pictures span the card, inside its border.
  const pictureWidth = Math.floor((columns - CARD_COLUMNS) * CELL_PX)
  const wrap = canWrap && (now.wrap ?? true)
  const turn: TurnDiff | undefined = list[at]

  const refreshButton = (
    <Button key="refresh" label={named('↻', 'Refresh')} {...hotkey('r')} onPress={() => void actions.refresh()} />
  )

  if (turn === undefined) {
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2} alignItems="center">
          {picture(emptyPicture(), 'No edits yet')}
          <Box flexDirection="column" flexShrink={1}>
            <Text dimColor>No file edits recorded in this session yet.</Text>
            <Text dimColor>Edits made through Edit, Write and NotebookEdit show here after each turn.</Text>
          </Box>
        </Box>
        <Box flexDirection="row">{refreshButton}</Box>
      </Box>
    )
  }

  const files = turn.files.map(file => prepare(file, isSplitView))
  const isTooLargeToList =
    files.length > 1 &&
    (files.length > MAX_LISTED_FILES || files.reduce((sum, one) => sum + lineCount(one.rows), 0) > MAX_TURN_ROWS)
  const current = Math.min(now.file ?? 0, files.length - 1)
  const isOpen = (file: FileDiff) => !now.toggled.includes(file.key)
  const isAllOpen = turn.files.every(isOpen)

  const go = (to: number) =>
    actions.change(was => ({
      ...was,
      at: Math.max(0, Math.min(to, list.length - 1)),
      toggled: [],
      pages: {},
      file: 0,
    }))
  const toggle = (key: string) =>
    actions.change(was => ({
      ...was,
      toggled: was.toggled.includes(key) ? was.toggled.filter(one => one !== key) : [...was.toggled, key],
    }))
  const turnPage = (key: string, to: number) =>
    actions.change(was => ({ ...was, pages: { ...was.pages, [key]: Math.max(0, to) } }))
  const switchMode = async () => {
    const next: DiffMode = mode === 'unified' ? 'split' : 'unified'
    await actions.change(was => ({ ...was, mode: next, pages: {} }))
    await actions.remember(MODE_KEY, next)
  }
  const switchWrap = async () => {
    await actions.change(was => ({ ...was, wrap: !wrap }))
    await actions.remember(WRAP_KEY, !wrap)
  }
  const showFile = (to: number) =>
    actions.change(was => ({ ...was, file: Math.max(0, Math.min(to, files.length - 1)) }))
  const jumpTo = async (index: number, isTooLarge: boolean) => {
    const target = turn.files[index]
    if (target === undefined) return
    await actions.change(was => ({
      ...was,
      file: index,
      toggled: was.toggled.filter(key => key !== target.key),
    }))
    if (!isTooLarge) await actions.scrollTo(`card-${index}`)
  }

  const copyDiff = (file: FileDiff, where: RenderSurface) => {
    const patch = patchOf(file.name, file.isNew, file.hunks)
    return actions.copy(patch, copiedName(`the diff of ${file.name}`, patch), where)
  }

  // Said in place of a card's lines when the pane has no room left for them.
  const notice = (index: number, isTooLarge: boolean) => (
    <Text dimColor>
      {!isTooLarge && files.some((one, other) => other !== index && isOpen(one.file))
        ? 'Too much is open to draw this file here: collapse another file first.'
        : "This file's lines are too large to draw here."}
    </Text>
  )

  const card = (index: number, shown: Shown | undefined, isTooLarge: boolean) => {
    const { file, rows } = files[index]!
    const open = shown !== undefined
    const squares = squaresOf(file.added, file.removed)
    const [folder, base] = splitPath(file.name)
    const fold = () => void (isTooLarge ? undefined : toggle(file.key))
    // The terminal draws the chevron in the path's button; the desktop draws
    // it as a button of its own, the file's icon between the two.
    const path = [<Text dimColor>{folder}</Text>, <Text bold>{base}</Text>]

    return (
      <Box key={`card-${index}`} flexDirection="column" borderStyle="round" borderDimColor>
        <Box
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          gap={1}
          {...(isTerminal ? {} : { backgroundColor: HEADER })}
          paddingX={isTerminal ? 0 : 1}
        >
          {Svg === undefined ? (
            <Button key={`toggle-${index}`} plain onPress={fold}>
              {open ? '▾ ' : '▸ '}
              {path}
            </Button>
          ) : (
            <Box flexDirection="row" alignItems="center" flexShrink={1}>
              <Button key={`chevron-${index}`} plain label={open ? '⏷' : '⏵'} onPress={fold} />
              {picture(fileIcon(file.isNew), file.isNew ? 'New file' : 'Changed file')}
              <Button key={`toggle-${index}`} plain onPress={fold}>
                {path}
              </Button>
            </Box>
          )}
          <Box flexDirection="row" flexShrink={0} gap={1} alignItems="center">
            {file.isNew && (Svg === undefined ? <Text color="success">New</Text> : picture(newPill(), 'New'))}
            {file.note !== undefined && <Text dimColor>{file.note}</Text>}
            <Text>
              <Text color="success">+{file.added}</Text> <Text color="error">−{file.removed}</Text>
              {columns >= MIN_SQUARES_COLUMNS && Svg === undefined && (
                <Text>
                  {' '}
                  <Text color="success">{'■'.repeat(squares.added)}</Text>
                  <Text color="error">{'■'.repeat(squares.removed)}</Text>
                  <Text dimColor>{'■'.repeat(squares.none)}</Text>
                </Text>
              )}
            </Text>
            {columns >= MIN_SQUARES_COLUMNS && picture(diffstat(file.added, file.removed), diffstatAlt(file))}
            {Svg !== undefined && file.hunks.length > 0 && (
              <Button key={`copy-${index}`} plain label="Copy diff" onPress={press => void copyDiff(file, press.surface)} />
            )}
          </Box>
        </Box>
        {shown?.body}
        {shown?.isPaged && (
          <Box flexDirection="row" gap={1} alignItems="center" paddingX={isTerminal ? 0 : 1}>
            <Button
              key={`earlier-${index}`}
              label={isTerminal ? '◀ Earlier lines' : '↑ Earlier lines'}
              onPress={() => void turnPage(file.key, shown.page - 1)}
            />
            <Text dimColor>
              {shown.firstLine}–{shown.lastLine} of{' '}
              {lineCount(rows)} lines
            </Text>
            <Button
              key={`later-${index}`}
              label={isTerminal ? 'Later lines ▶' : 'Later lines ↓'}
              onPress={() => void turnPage(file.key, shown.page + 1)}
            />
          </Box>
        )}
      </Box>
    )
  }

  const picker =
    Select !== undefined && list.length > 1 ? (
      <Select
        key="turn"
        value={String(at)}
        options={list.map((one, index) => ({
          value: String(index),
          label: `T${one.n} · ${titleIn(one)} · ${plural(one.files.length, 'file')}`,
        }))}
        onSelect={value => void go(Number(value))}
      />
    ) : null

  // The jump list, at file `alone`: every file, or, past what a Select
  // holds, those around that one.
  const jump = (isTooLarge: boolean, alone: number) => {
    if (Select === undefined || files.length <= 1) return null
    const first = Math.max(0, Math.min(alone - MAX_OPTIONS / 2, files.length - MAX_OPTIONS))
    return (
      <Select
        key="jump"
        label="Jump to file"
        value={String(alone)}
        options={turn.files.slice(first, first + MAX_OPTIONS).map((file, index) => ({
          value: String(first + index),
          label: `${shortPath(file.name)}  +${file.added} −${file.removed}`,
        }))}
        onSelect={value => void jumpTo(Number(value), isTooLarge)}
      />
    )
  }

  // The cards a pane draws, by index: file `alone`, or every file.
  const drawnCards = (isTooLarge: boolean, alone: number) => (isTooLarge ? [alone] : files.map((_, index) => index))

  // The whole pane, each card it draws open as `shownOf` says; one file at
  // a time, at file `alone`.
  const paneOf = (isTooLarge: boolean, shownOf: (index: number) => Shown | undefined, alone = current) => (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          {picture(turnIcon(), 'Prompt')}
          <Text bold wrap="truncate-end">
            T{turn.n} · {titleIn(turn)}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text>
            {plural(turn.files.length, 'file')} changed{'  '}
            <Text color="success">+{turn.added}</Text> <Text color="error">−{turn.removed}</Text>
          </Text>
          {picture(diffstat(turn.added, turn.removed), diffstatAlt(turn))}
          {list.length > 1 && (
            <Text dimColor>
              {Svg === undefined ? ' ' : ''}· turn {at + 1} of {list.length} with edits
            </Text>
          )}
        </Box>
      </Box>
      <Box flexDirection="column" gap={isTerminal ? 0 : 1}>
        {list.length > 1 && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button
              key="prev"
              label={isTerminal ? (picker ? '◀' : '◀ Older') : picker ? '←' : '← Older'}
              {...hotkey('p')}
              onPress={() => void go(at + 1)}
            />
            {picker}
            <Button
              key="next"
              label={isTerminal ? (picker ? '▶' : 'Newer ▶') : picker ? '→' : 'Newer →'}
              {...hotkey('n')}
              onPress={() => void go(at - 1)}
            />
          </Box>
        )}
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          {canSplit && (
            <Button
              key="mode"
              label={mode === 'unified' ? named('◫', 'Split view') : named('▤', 'Unified view')}
              {...hotkey('s')}
              onPress={() => void switchMode()}
            />
          )}
          {canWrap && (
            <Button
              key="wrap"
              label={wrap ? named('⇥', 'Unwrap lines') : named('↵', 'Wrap lines')}
              {...hotkey('w')}
              onPress={() => void switchWrap()}
            />
          )}
          {!isTooLarge && files.length > 1 && (
            <Button
              key="all"
              label={isAllOpen ? named('⊟', 'Collapse all') : named('⊞', 'Expand all')}
              {...hotkey('a')}
              onPress={() =>
                void actions.change(was => ({
                  ...was,
                  toggled: isAllOpen ? turn.files.map(file => file.key) : [],
                }))
              }
            />
          )}
          {refreshButton}
        </Box>
        {jump(isTooLarge, alone)}
      </Box>
      {isTooLarge && (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            {picture(warningIcon(), 'Warning')}
            <Text color="warning">
              This turn's diff is too large to show at once, so it shows one file at a time.
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button
              key="prev-file"
              label={isTerminal ? '◀ Previous file' : '← Previous file'}
              {...hotkey('k')}
              onPress={() => void showFile(alone - 1)}
            />
            <Text dimColor>
              File {alone + 1} of {files.length}
            </Text>
            <Button
              key="next-file"
              label={isTerminal ? 'Next file ▶' : 'Next file →'}
              {...hotkey('j')}
              onPress={() => void showFile(alone + 1)}
            />
          </Box>
        </Box>
      )}
      <Box flexDirection="column" gap={1}>
        {drawnCards(isTooLarge, alone).map(index => card(index, shownOf(index), isTooLarge))}
      </Box>
    </Box>
  )

  if (drawing === 'rows') {
    // The terminal pages each file by rows, and counts the characters a
    // page draws.
    const paged = files.map(one => pagesOf(one.rows))
    const isTooLarge =
      isTooLargeToList ||
      (files.length > 1 &&
        files.reduce((sum, one, index) => sum + charsOf(paged[index]![0] ?? [], one.width), 0) > MAX_DRAWN_CHARS)
    let chars = MAX_DRAWN_CHARS
    let drawnRows = MAX_DRAWN_ROWS
    const shown: (Shown | undefined)[] = []
    for (const index of drawnCards(isTooLarge, current)) {
      const { file, isSplit, width } = files[index]!
      const pages = paged[index]!
      if (!isTooLarge && !isOpen(file)) continue
      const page = Math.max(0, Math.min(now.pages[file.key] ?? 0, pages.length - 1))
      const lines = pages[page] ?? []
      const size = charsOf(lines, width)
      const isRoomy = size <= chars && lines.length <= drawnRows
      if (isRoomy) {
        chars -= size
        drawnRows -= lines.length
      }
      const look: Look = { width, wrap }
      shown[index] = {
        page,
        isPaged: pages.length > 1,
        firstLine: lineCount(pages.slice(0, page).flat()) + 1,
        lastLine: lineCount(pages.slice(0, page + 1).flat()),
        body:
          lines.length === 0 ? null : isRoomy ? (
            <Box flexDirection="column">
              {lines.map(row => (isSplit ? splitRow(ui, row as SplitRow, look) : unifiedRow(ui, row as Row, look)))}
            </Box>
          ) : (
            notice(index, isTooLarge)
          ),
      }
    }
    return paneOf(isTooLarge, index => shown[index])
  }

  // Off the terminal, each file's drawer, built when first asked for.
  const drawers: Drawer[] = []
  const drawerOf = (index: number) => (drawers[index] ??= drawerFor(index))
  function drawerFor(index: number): Drawer {
    const { file, rows, isSplit, width: digits, hunks } = files[index]!
    if (drawing === 'text') {
      // The hunk each row leads: the first row, and each gap row. A file of
      // one hunk leaves it to the card's Copy diff.
      const leads = new Map<number, number>()
      rows.forEach((row, at) => {
        if (at === 0 || row.kind === 'gap') leads.set(at, leads.size)
      })
      const hunkAt = (at: number): Copied | undefined => {
        const k = leads.get(at)
        if (k === undefined || hunks.length < 2 || leads.size !== hunks.length) return undefined
        const hunk = `${hunks[k]!}\n`
        return { text: hunk, what: copiedName(`hunk ${k + 1} of ${hunks.length}`, hunk) }
      }
      const text = textLines(ui, {
        path: file.path,
        digits,
        isSplit,
        isNew: file.isNew,
        wrap,
        card: index,
        hunkAt,
        copy: (copied, what, where) => void actions.copy(copied, what, where),
      })
      const built: TextRow[] = []
      const rowAt = (at: number) => (built[at] ??= text.row(rows[at]!, at))
      return {
        frame: sizeOf(text.body([])),
        costOf: at => rowAt(at).size,
        bodyOf: (from, to) => text.body(rows.slice(from, to).map((_, k) => rowAt(from + k))),
      }
    }
    const options: PictureOptions = { width: pictureWidth, wrap, path: file.path, digits, isSplit, isNew: file.isNew }
    const pictures = (all: DiffPicture[]) => (
      <Box flexDirection="column">
        {all.map(one =>
          Svg === undefined ? null : <Svg alt={`Diff of ${file.name}`} source={one.source} height={one.height} />,
        )}
      </Box>
    )
    // A page holds at least one picture.
    const frame = sizeOf(pictures([pictureFrame(options)]))
    const each = minus(frame, sizeOf(pictures([])))
    const costs: Size[] = []
    return {
      frame,
      costOf: at => (costs[at] ??= pictureRowCost(markupOf(rows[at]!, options), each)),
      bodyOf: (from, to) => pictures(diffPictures(rows.slice(from, to), options)),
    }
  }

  // A card open with its pager at its widest and no lines.
  const bare = (index: number): Shown => {
    const total = lineCount(files[index]!.rows)
    return { page: 0, isPaged: true, firstLine: total, lastLine: total, body: null }
  }

  // What a page of a file may hold: what the pane leaves beside everything
  // else it draws when it shows that file alone, so any page fits there.
  const budgets: Size[] = []
  const budgetOf = (index: number) =>
    (budgets[index] ??= minus(PANE_BUDGET, sizeOf(paneOf(true, k => (k === index ? bare(index) : undefined), index))))

  // A card open at page `wanted`, or at its last page when it has fewer.
  const shownAt = (index: number, wanted: number): Shown => {
    const { rows } = files[index]!
    const drawer = drawerOf(index)
    const starts = pageStarts(drawer, rows.length, budgetOf(index), wanted)
    const page = Math.max(0, Math.min(wanted, starts.length - 1))
    const from = starts[page]!
    const to = starts[page + 1] ?? rows.length
    return {
      page,
      isPaged: starts.length > 1,
      firstLine: lineCount(rows.slice(0, from)) + 1,
      lastLine: lineCount(rows.slice(0, to)),
      body: to > from ? drawer.bodyOf(from, to) : null,
    }
  }

  // The most any page of a file takes, measure by measure.
  const largestPage = (index: number) => {
    const { rows } = files[index]!
    const drawer = drawerOf(index)
    const starts = pageStarts(drawer, rows.length, budgetOf(index), Infinity)
    let largest = NOTHING
    starts.forEach((from, page) => {
      let size = drawer.frame
      for (let at = from; at < (starts[page + 1] ?? rows.length); at++) size = plus(size, drawer.costOf(at))
      largest = most(largest, size)
    })
    return largest
  }

  // Several files show at once when the pane holds every one of them open
  // at its largest page.
  const isTooLarge =
    isTooLargeToList ||
    (files.length > 1 &&
      !fits(files.reduce((sum, _, index) => plus(sum, largestPage(index)), sizeOf(paneOf(false, bare))), PANE_BUDGET))

  // Each open card's page; then, card by card, the lines while the pane has
  // room for them, and what is said in their place past that.
  const shown: (Shown | undefined)[] = []
  for (const index of drawnCards(isTooLarge, current)) {
    const { file } = files[index]!
    if (isTooLarge || isOpen(file)) shown[index] = shownAt(index, now.pages[file.key] ?? 0)
  }
  const said = (index: number): Shown | undefined => {
    const one = shown[index]
    return one === undefined || one.body === null ? one : { ...one, body: notice(index, isTooLarge) }
  }
  let room = minus(PANE_BUDGET, sizeOf(paneOf(isTooLarge, said)))
  for (const index of drawnCards(isTooLarge, current)) {
    const body = shown[index]?.body
    if (body === undefined || body === null) continue
    const cost = minus(sizeOf(body), sizeOf(notice(index, isTooLarge)))
    if (fits(cost, room)) room = minus(room, cost)
    else shown[index] = said(index)
  }
  return paneOf(isTooLarge, index => shown[index])
}
