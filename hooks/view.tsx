// The pane: one turn's files as GitHub-style cards. Each card has a header
// with the path, the +/- counts and five squares for their mix; open, it
// lists the lines in a monospaced face with both line numbers, tinted rows
// for removed and added lines, the changed words marked, and a row for each
// run of unchanged lines. Unified interleaves the lines; split puts the old
// file beside the new one. A turn too large to draw at once shows one file
// at a time.
//
// The terminal draws the lines as Text rows painted with the theme's diff
// keys. A surface with an Svg element (the desktop) draws each file's lines
// as GitHub-style pictures (svg.ts): its Text has no monospaced face on the
// engine it ships (2.1.295 refuses `mono`), and the theme's diff keys are
// opaque fills made for a terminal that drown the text there. The `Code`
// element's diff format is no help: the desktop draws it as a plain code
// block, with no tints or line numbers. There the header, the cards and
// the warnings carry small pictures too (icons.ts), and the buttons a glyph
// before their label: a Button holds only text, never a picture.
//
// It never holds `$`: the hooks module reads the state, resolves the
// elements and hands in what the buttons do, since an engine before 2.1.300
// refuses a module that passes `$` into a function of another file.

import type { Color, Elements, RenderSurface } from 'claude-code'

import type { DiffMode, FileDiff, PaneView, TurnDiff } from '../types'
import { diffstat, emptyPicture, fileIcon, newPill, squaresOf, turnIcon, warningIcon } from './icons'
import type { Icon } from './icons'
import { keepSpaces, rowsOf, splitRowsOf } from './rows'
import type { Gap, Line, LineKind, Row, Span, SplitRow } from './rows'
import { MODE_KEY, WRAP_KEY } from './state'
import { diffPictures } from './svg'
import { titleOf } from './turns'

type Kit = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>

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
}

// What the pane draws from: the turns, newest first, where it stands, and
// the surface and width it is drawn at.
export type PaneModel = {
  list: readonly TurnDiff[]
  now: PaneView
  surface: RenderSurface
  columns: number
}

export const PANE = 'last-turn-diff'
const NBSP = ' '
// A file shows this many rows a page at a time.
const PAGE_ROWS = 150
// What every open file draws at most: a tree draws its first 100,000
// characters, and every row is several elements.
const MAX_DRAWN_CHARS = 80_000
const MAX_DRAWN_ROWS = 600
// A turn of several files past either of these shows one file at a time.
const MAX_TURN_ROWS = 400
const MAX_LISTED_FILES = 60
// Narrower than this, split view has no room and the pane draws unified.
// Desktop's pictures wrap each half, so they need less: 64 columns leave
// each half about 25 characters.
const MIN_SPLIT_COLUMNS = 90
const MIN_SPLIT_COLUMNS_DESKTOP = 64
// Narrower than this, a card's header leaves the squares out.
const MIN_SQUARES_COLUMNS = 60
// The width of one of the pane's columns on a graphical surface, in CSS
// pixels, and the columns a card's border takes.
const CELL_PX = 8
const CARD_COLUMNS = 4

const MARK = { context: NBSP, removed: '−', added: '+' } as const

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

// A turn's title; one an older version stored with the engine's tags is
// read again.
const titleIn = (turn: TurnDiff) => (turn.title.startsWith('<') ? titleOf(turn.title) : turn.title)

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

// One file's rows, paged, with what its first page costs. A new file is
// all additions: split would leave its old side empty.
function prepare(file: FileDiff, isSplitView: boolean) {
  const unified = rowsOf(file.hunks)
  const isSplit = isSplitView && !file.isNew
  const rows: (Row | SplitRow)[] = isSplit ? splitRowsOf(unified) : unified
  const width = widthOf(unified)
  const pages = pagesOf(rows)
  const first = pages[0] ?? []
  return { file, rows, isSplit, width, pages, firstChars: charsOf(first, width) }
}

export function paneTree(elements: Elements[RenderSurface], model: PaneModel, actions: PaneActions) {
  const { list, now, surface, columns } = model
  const { Box, Text, Button } = elements
  const Select = 'Select' in elements ? elements.Select : undefined
  const ui: Kit = { Box, Text, Button }
  const isTerminal = surface === 'terminal'
  // Every table names every element (one a surface lacks draws nothing), so
  // the surface decides: the terminal draws rows, the rest pictures.
  const Svg = !isTerminal && 'Svg' in elements ? elements.Svg : undefined
  // Hotkeys answer on the terminal; a desktop draws each as a badge on its
  // button, which crowds the toolbar.
  const hotkey = (key: string) => (isTerminal ? { hotkey: key } : {})
  // A button's label, a glyph before it where the pictures are drawn.
  const named = (glyph: string, label: string) => (Svg === undefined ? label : `${glyph} ${label}`)
  const picture = (icon: Icon, alt: string) =>
    Svg === undefined ? null : <Svg alt={alt} source={icon.source} width={icon.width} height={icon.height} />
  const at = Math.min(now.at, Math.max(0, list.length - 1))
  const mode: DiffMode = now.mode ?? 'unified'
  const canSplit = columns >= (isTerminal ? MIN_SPLIT_COLUMNS : MIN_SPLIT_COLUMNS_DESKTOP)
  // The pictures span the card, inside its border.
  const pictureWidth = Math.floor((columns - CARD_COLUMNS) * CELL_PX)
  const wrap = now.wrap ?? true
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

  const files = turn.files.map(file => prepare(file, mode === 'split' && canSplit))
  const isTooLarge =
    files.length > 1 &&
    (files.length > MAX_LISTED_FILES ||
      files.reduce((sum, one) => sum + lineCount(one.rows), 0) > MAX_TURN_ROWS ||
      files.reduce((sum, one) => sum + one.firstChars, 0) > MAX_DRAWN_CHARS)
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
    actions.change(was => ({ ...was, pages: { ...was.pages, [key]: to } }))
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
  const jumpTo = async (index: number) => {
    const target = turn.files[index]
    if (target === undefined) return
    await actions.change(was => ({
      ...was,
      file: index,
      toggled: was.toggled.filter(key => key !== target.key),
    }))
    if (!isTooLarge) await actions.scrollTo(`card-${index}`)
  }

  let chars = MAX_DRAWN_CHARS
  let drawnRows = MAX_DRAWN_ROWS

  const card = (index: number) => {
    const { file, rows, isSplit, width, pages } = files[index]!
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
          </Box>
        </Box>
        {open && shown.length > 0 && fits && Svg !== undefined && (
          <Box flexDirection="column">
            {diffPictures(shown, {
              width: pictureWidth,
              wrap,
              path: file.path,
              digits: width,
              isSplit,
              isNew: file.isNew,
            }).map(picture => (
              <Svg alt={`Diff of ${file.name}`} source={picture.source} height={picture.height} />
            ))}
          </Box>
        )}
        {open && shown.length > 0 && fits && Svg === undefined && (
          <Box flexDirection="column">
            {shown.map(row =>
              isSplit ? splitRow(ui, row as SplitRow, look) : unifiedRow(ui, row as Row, look),
            )}
          </Box>
        )}
        {open && shown.length > 0 && !fits && (
          <Text dimColor>Too much is open to draw this file here: collapse another file first.</Text>
        )}
        {open && pages.length > 1 && (
          <Box flexDirection="row" gap={1} alignItems="center" paddingX={isTerminal ? 0 : 1}>
            <Button
              key={`earlier-${index}`}
              label={Svg === undefined ? '◀ Earlier lines' : '↑ Earlier lines'}
              onPress={() => void turnPage(file.key, page - 1)}
            />
            <Text dimColor>
              {lineCount(pages.slice(0, page).flat()) + 1}–{lineCount(pages.slice(0, page + 1).flat())} of{' '}
              {lineCount(rows)} lines
            </Text>
            <Button
              key={`later-${index}`}
              label={Svg === undefined ? 'Later lines ▶' : 'Later lines ↓'}
              onPress={() => void turnPage(file.key, page + 1)}
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

  const jump =
    Select !== undefined && files.length > 1 ? (
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
              label={Svg === undefined ? (picker ? '◀' : '◀ Older') : picker ? '←' : '← Older'}
              {...hotkey('p')}
              onPress={() => void go(at + 1)}
            />
            {picker}
            <Button
              key="next"
              label={Svg === undefined ? (picker ? '▶' : 'Newer ▶') : picker ? '→' : 'Newer →'}
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
          <Button
            key="wrap"
            label={wrap ? named('⇥', 'Unwrap lines') : named('↵', 'Wrap lines')}
            {...hotkey('w')}
            onPress={() => void switchWrap()}
          />
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
        {jump}
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
              label={Svg === undefined ? '◀ Previous file' : '← Previous file'}
              {...hotkey('k')}
              onPress={() => void showFile(current - 1)}
            />
            <Text dimColor>
              File {current + 1} of {files.length}
            </Text>
            <Button
              key="next-file"
              label={Svg === undefined ? 'Next file ▶' : 'Next file →'}
              {...hotkey('j')}
              onPress={() => void showFile(current + 1)}
            />
          </Box>
        </Box>
      )}
      <Box flexDirection="column" gap={1}>
        {isTooLarge ? card(current) : files.map((_, index) => card(index))}
      </Box>
    </Box>
  )
}
