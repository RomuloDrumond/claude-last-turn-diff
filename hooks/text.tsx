// A file's diff rows drawn as Claude Desktop's own text, where its engine's
// Text takes `mono` (2.1.299 and later): the code in Desktop's monospaced
// face. Desktop lets no text in a pane be selected (its window turns
// selection off and only its transcript turns it back on), so buttons copy,
// with `$.ui.copy`: a line's numbers and sign are a plain Button's label that
// copies its line, and the row that leads a hunk ends in a Copy hunk button.
// A gap row's words are a Button's label too: Desktop never lets a selection
// take one, so the code alone would be selected if a pane allowed it.
//
// Each line is a row: its gutter, then its code, wrapped or cut at the
// pane's edge. Split puts the old side's rows in one column and the new
// side's in another, every row one line high and its code cut at the side's
// edge, so the two columns' rows line up.
//
// The tints are GitHub's, translucent, so they read on a light and a dark
// theme; the syntax colours are theme keys, so they follow the person's
// theme. A changed word keeps the text's own colour on its mark, where a
// syntax colour is hard to read in the dark theme. Each row comes with what
// it costs against the pane's bounds, measured on the elements it built
// (size.ts). Pure, so tests read it directly.

import type { BoxProps, Color, Elements, RenderElement, RenderSurface } from 'claude-code'

import { isCutLine } from './diff'
import { TINT, gapText, runsOf } from './rows'
import type { Gap, Line, LineKind, Row, Run, SplitRow } from './rows'
import { NOTHING, plus, sizeOf } from './size'
import type { Size } from './size'
import { languageOf } from './syntax'
import type { TokenClass } from './syntax'

type Kit = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'>

// Theme keys Desktop maps to its own text colours, one per class, each
// distinct and readable in its light and its dark theme: red keywords, blue
// strings, green constants, violet functions, amber types, and comments in
// its secondary text colour.
const SYNTAX: Record<TokenClass, Color> = {
  keyword: 'error',
  string: 'permission',
  constant: 'success',
  function: 'autoAccept',
  type: 'warning',
  comment: 'inactive',
}
// A figure space: a digit wide, and kept where a button's label collapses
// ordinary spaces.
const FIGURE = ' '
const SIGN: Record<LineKind, string> = { context: FIGURE, removed: '−', added: '+' }
// The nodes a line's code may take. Past it the line drops its syntax
// colours, then marks its changed words as one stretch: a table of numbers,
// each one changed and coloured, would otherwise fill a page with a few lines.
const MAX_CODE_NODES = 24
// Characters the engine refuses in a Text, drawn as U+FFFD: the control
// characters but tab and carriage return.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

export type TextOptions = {
  path: string
  // Digits of the largest line number.
  digits: number
  // Old lines beside new ones; else interleaved.
  isSplit: boolean
  // A new file has no old line numbers to show.
  isNew: boolean
  // Long lines continue on the rows below; else they are cut at the edge.
  wrap: boolean
  // The card's index, which keeps the gutter buttons' keys unique.
  card: number
  // The hunk the row at `at` leads, to copy; undefined when it leads none
  // or the file has a single hunk, which the card's Copy diff copies.
  hunkAt: (at: number) => Copied | undefined
  // Puts text on the clipboard, `what` naming it for the toast: a gutter
  // button's or a Copy hunk button's press.
  copy: (text: string, what: string, surface: RenderSurface) => void
}

// Text a button copies, and how the toast names it.
export type Copied = { text: string; what: string }

// One row of the diff: unified, the row itself; split, the old side's row
// and the new side's.
export type TextRow = { cells: RenderElement[]; size: Size }

// How one stretch of code is drawn: its colour and its mark.
type Stretch = { text: string; color?: Color; background?: Color }

const sameLook = (a: Stretch, b: Stretch) => a.color === b.color && a.background === b.background

// Joins neighbours drawn alike, so each takes one node.
function joined(stretches: Stretch[]): Stretch[] {
  const out: Stretch[] = []
  for (const stretch of stretches) {
    const last = out[out.length - 1]
    if (last !== undefined && sameLook(last, stretch)) last.text += stretch.text
    else out.push({ ...stretch })
  }
  return out
}

// The runs as stretches: the changed words on `word` in the text's own
// colour (a blank one left unmarked), and the rest in their syntax colours
// if `isColoured`.
const stretchesOf = (runs: readonly Run[], word: Color | undefined, isColoured: boolean) =>
  joined(
    runs.map(run => {
      const isMarked = word !== undefined && run.isChanged && run.text.trim() !== ''
      return {
        text: run.text,
        ...(isMarked ? { background: word } : isColoured && run.kind !== undefined ? { color: SYNTAX[run.kind] } : {}),
      }
    }),
  )

// The runs uncoloured, every changed word from the first to the last under
// one mark.
function oneMark(runs: readonly Run[], word: Color | undefined): Stretch[] {
  const text = runs.map(run => run.text).join('')
  let from = -1
  let to = -1
  let at = 0
  for (const run of runs) {
    if (word !== undefined && run.isChanged && run.text.trim() !== '') {
      if (from < 0) from = at
      to = at + run.text.length
    }
    at += run.text.length
  }
  if (from < 0) return [{ text }]
  return [{ text: text.slice(0, from) }, { text: text.slice(from, to), background: word! }, { text: text.slice(to) }].filter(
    stretch => stretch.text !== '',
  )
}

const tintOf = (kind: LineKind) => (kind === 'context' ? undefined : TINT[kind])

const pad = (n: number | undefined, digits: number) => (n === undefined ? '' : String(n)).padStart(digits, FIGURE)

// The line numbers and sign a gutter button shows, each number as wide as
// the largest, so the columns line up.
const gutterLabel = (numbers: readonly (number | undefined)[], kind: LineKind, digits: number) =>
  [...numbers.map(n => pad(n, digits)), SIGN[kind]].join(FIGURE)

export function textLines(ui: Kit, options: TextOptions) {
  const language = languageOf(options.path)
  const numbersShown = options.isSplit || options.isNew ? 1 : 2
  // The gutter's width in the pane's columns: its label, and a column of
  // room on each side for the button's padding.
  const gutterWidth = numbersShown * (options.digits + 1) + 3
  // Split cuts every line at its side's edge.
  const isCut = options.isSplit || !options.wrap
  // A row: the gutter, a column's room, the code. Cut lines keep it one line
  // high: a coloured stretch inside a cut Text may still wrap at the edge.
  const rowLook: BoxProps = {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 1,
    ...(isCut ? { height: 1, overflow: 'hidden' } : {}),
  }

  // A line's code as one monospaced Text.
  function code(line: Line): RenderElement {
    const runs = runsOf(line, language, text => text.replace(CONTROL, '�'))
    // A blank line is a wrapping Text holding a newline: one row high, and a
    // copy keeps it as an empty line, which a cut Text would drop.
    if (runs.length === 0) return <ui.Text mono>{'\n'}</ui.Text>
    const word = tintOf(line.kind)?.word
    const draw = (stretches: Stretch[]) => (
      <ui.Text mono {...(isCut ? { wrap: 'truncate-end' as const } : {})}>
        {stretches.map(({ text, color, background }) =>
          color === undefined && background === undefined ? (
            text
          ) : (
            <ui.Text {...(color !== undefined ? { color } : {})} {...(background !== undefined ? { backgroundColor: background } : {})}>
              {text}
            </ui.Text>
          ),
        )}
      </ui.Text>
    )
    let element = draw(stretchesOf(runs, word, true))
    if (sizeOf(element).nodes > MAX_CODE_NODES) element = draw(stretchesOf(runs, word, false))
    if (sizeOf(element).nodes > MAX_CODE_NODES) element = draw(oneMark(runs, word))
    return element
  }

  // The button that shows a line's numbers and copies the line as the file
  // has it, `number` naming it; a line kept cut copies what was kept.
  function gutterButton(key: string, line: Line, numbers: readonly (number | undefined)[], number: number) {
    const text = line.spans.map(span => span.text).join('')
    const isPartial = isCutLine(text)
    const kept = isPartial ? text.slice(0, -1) : text
    const what = isPartial ? `the first ${kept.length} characters of line ${number}` : `line ${number}`
    return (
      <ui.Button
        key={key}
        plain
        dimColor={line.kind === 'context'}
        label={gutterLabel(numbers, line.kind, options.digits)}
        onPress={press => options.copy(kept, what, press.surface)}
      />
    )
  }

  // A line's row: its gutter button on the number tint, then its code, on
  // the row tint.
  function lineRow(key: string, line: Line, numbers: readonly (number | undefined)[], number: number): RenderElement {
    const tint = tintOf(line.kind)
    return (
      <ui.Box {...rowLook} {...(tint !== undefined ? { backgroundColor: tint.row } : {})}>
        <ui.Box
          width={gutterWidth}
          flexShrink={0}
          justifyContent="flex-end"
          alignItems="flex-start"
          {...(tint !== undefined ? { backgroundColor: tint.number } : {})}
        >
          {gutterButton(key, line, numbers, number)}
        </ui.Box>
        {code(line)}
      </ui.Box>
    )
  }

  // A row on the gap tint: a dim button naming the unchanged lines skipped,
  // if any, and the Copy hunk button of the hunk below, if any, at its end.
  const gapRow = (gap: Gap | undefined, at: number, hunk: Copied | undefined) => (
    <ui.Box {...rowLook} backgroundColor={TINT.gap.row}>
      <ui.Box width={gutterWidth} flexShrink={0} backgroundColor={TINT.gap.number} />
      {gap !== undefined && (
        <ui.Button key={`gap-${options.card}-${at}`} plain dimColor label={gapText(gap)} onPress={() => undefined} />
      )}
      {hunk !== undefined && <ui.Box flexGrow={1} />}
      {hunk !== undefined && (
        <ui.Button
          key={`hunk-${options.card}-${at}`}
          plain
          label="Copy hunk"
          onPress={press => options.copy(hunk.text, hunk.what, press.surface)}
        />
      )}
    </ui.Box>
  )

  // A line's row, under a gap-tinted row for its Copy hunk button when it
  // leads a hunk.
  const led = (lead: RenderElement | undefined, row: RenderElement) =>
    lead === undefined ? (
      row
    ) : (
      <ui.Box flexDirection="column">
        {lead}
        {row}
      </ui.Box>
    )

  function unifiedRow(row: Row, at: number): RenderElement {
    const hunk = options.hunkAt(at)
    if (row.kind === 'gap') return gapRow(row, at, hunk)
    const numbers = options.isNew ? [row.new] : [row.old, row.new]
    const line = lineRow(`ln-${options.card}-${at}`, row, numbers, (row.kind === 'removed' ? row.old : row.new) ?? 0)
    return led(hunk === undefined ? undefined : gapRow(undefined, at, hunk), line)
  }

  // One side of a split row: its line's row, or a tinted row where the other
  // side has a line and this one has none.
  function sideRow(line: Line | undefined, side: 'old' | 'new', at: number): RenderElement {
    if (line === undefined) return <ui.Box height={1} backgroundColor={TINT.empty} />
    return lineRow(`ln-${options.card}-${at}-${side}`, line, [line[side]], line[side] ?? 0)
  }

  // A split row's two sides; the Copy hunk button goes on the new side.
  function splitCells(row: SplitRow, at: number): RenderElement[] {
    const hunk = options.hunkAt(at)
    if (row.kind === 'gap') return [gapRow(row, at, undefined), gapRow(undefined, at, hunk)]
    const leads = hunk !== undefined
    return [
      led(leads ? gapRow(undefined, at, undefined) : undefined, sideRow(row.left, 'old', at)),
      led(leads ? gapRow(undefined, at, hunk) : undefined, sideRow(row.right, 'new', at)),
    ]
  }

  // Row `at` of the file, and what it costs.
  function row(one: Row | SplitRow, at: number): TextRow {
    const cells = options.isSplit ? splitCells(one as SplitRow, at) : [unifiedRow(one as Row, at)]
    return { cells, size: cells.reduce((sum, cell) => plus(sum, sizeOf(cell)), NOTHING) }
  }

  // A page of built rows as one element: a column of them; split, a column
  // of each side's rows, each side half the card.
  function body(rows: readonly TextRow[]): RenderElement {
    const column = (k: number, look: BoxProps) => (
      <ui.Box flexDirection="column" {...look}>
        {rows.map(one => one.cells[k])}
      </ui.Box>
    )
    if (!options.isSplit) return column(0, {})
    return (
      <ui.Box flexDirection="row" gap={1}>
        {column(0, { width: '50%', overflow: 'hidden' })}
        {column(1, { width: '50%', overflow: 'hidden' })}
      </ui.Box>
    )
  }

  return { row, body }
}
