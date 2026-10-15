// A file's diff rows drawn as SVG pictures in GitHub's diff style: a 12px
// monospaced face on 20px rows, line numbers on tinted gutters, tinted rows,
// the changed words marked, and syntax colours. A surface whose Text has no
// monospaced face (the desktop's engine before 2.1.300 refuses `mono`) shows
// these through its Svg element. The tints are translucent and the text
// colours switch with `prefers-color-scheme`, so a light or a dark theme
// reads them. Pure, so tests read it directly.

import type { Line, LineKind, Row, SplitRow } from './rows'
import { languageOf, tokensOf } from './syntax'
import type { TokenClass } from './syntax'

// One cell of SF Mono or Menlo at 12px, the face's 0.6em advance.
export const CHAR_PX = 7.22
const ROW_PX = 20
const BASELINE_PX = 14
const NUMBER_PAD_PX = 8
// The +/- column before the code.
const SIGN_PX = 18
const RIGHT_PAD_PX = 8
// The fewest characters a wrapped line keeps, however narrow the pane.
const MIN_CHARS = 16
// One picture's markup stays under the Svg element's 131,072 characters.
const MAX_SOURCE_CHARS = 120_000

const STYLE =
  '<style>' +
  'text{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:12px;white-space:pre;fill:#e6edf3}' +
  '.ra{fill:#2ea04326}.na{fill:#3fb9504d}.wa{fill:#2ea04366}' +
  '.rd{fill:#f8514926}.nd{fill:#f851494d}.wd{fill:#f8514966}' +
  '.rh{fill:#388bfd1a}.nh{fill:#388bfd33}.re{fill:#6e76811a}.sep{fill:#6e768166}' +
  '.n{fill:#6e7681}.m{fill:#8b949e}' +
  '.keyword{fill:#ff7b72}.string{fill:#a5d6ff}.comment{fill:#8b949e}.constant{fill:#79c0ff}.function{fill:#d2a8ff}.type{fill:#ffa657}' +
  '@media (prefers-color-scheme:light){text{fill:#1f2328}.n,.m,.comment{fill:#59636e}' +
  '.keyword{fill:#cf222e}.string{fill:#0a3069}.constant{fill:#0550ae}.function{fill:#6639ba}.type{fill:#953800}}' +
  '</style>'

const ROW_CLASS: Record<LineKind, string | undefined> = { context: undefined, removed: 'rd', added: 'ra' }
const NUMBER_CLASS: Record<LineKind, string | undefined> = { context: undefined, removed: 'nd', added: 'na' }
const WORD_CLASS: Record<LineKind, string | undefined> = { context: undefined, removed: 'wd', added: 'wa' }
const SIGN: Record<LineKind, string> = { context: '', removed: '−', added: '+' }

export type DiffPicture = { source: string; width: number; height: number }

export type PictureOptions = {
  // The picture's width in CSS pixels.
  width: number
  // Long lines continue on the rows below; else they are cut with an ellipsis.
  wrap: boolean
  // The file's path, which names its language.
  path: string
  // Digits of the largest line number.
  digits: number
  // Old lines beside new ones; else interleaved.
  isSplit: boolean
  // A new file has no old line numbers to show.
  isNew: boolean
}

type Run = { text: string; at: number; isChanged: boolean; kind: TokenClass | undefined }

// A side of the picture, in its own viewport: the whole picture unified,
// one half of it split. `chars` is how many characters a row holds.
type Side = { numberWidth: number; numbers: number; codeX: number; chars: number }

const px = (n: number) => String(Math.round(n * 10) / 10)

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Characters XML refuses, lone surrogates among them, drawn as U+FFFD.
const clean = (text: string) =>
  text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    '�',
  )

function sideOf(width: number, numbers: number, digits: number): Side {
  const numberWidth = digits * CHAR_PX + 2 * NUMBER_PAD_PX
  const codeX = numbers * numberWidth + SIGN_PX
  const chars = Math.max(MIN_CHARS, Math.floor((width - codeX - RIGHT_PAD_PX) / CHAR_PX))
  return { numberWidth, numbers, codeX, chars }
}

// A line's text with tabs as four spaces, each character marked changed or
// not and with its syntax class, then cut into the rows it is drawn on.
function rowsOfLine(line: Line, side: Side, wrap: boolean, language: ReturnType<typeof languageOf>): Run[][] {
  let text = ''
  const changed: boolean[] = []
  for (const span of line.spans) {
    const part = clean(span.text.replace(/\t/g, '    ').replace(/\r/g, ''))
    text += part
    for (let k = 0; k < part.length; k++) changed.push(span.isChanged)
  }
  const kinds: (TokenClass | undefined)[] = new Array(text.length).fill(undefined)
  for (const token of tokensOf(text, language)) kinds.fill(token.kind, token.from, token.to)

  const cuts: [number, number][] = []
  if (!wrap || text.length <= side.chars) {
    cuts.push([0, Math.min(text.length, wrap ? text.length : side.chars)])
  } else {
    for (let from = 0; from < text.length; ) {
      let to = Math.min(text.length, from + side.chars)
      if (to < text.length) {
        // After the row's last space, as text wraps, unless that leaves
        // the row less than half full.
        const space = text.lastIndexOf(' ', to - 1)
        if (space >= from + side.chars / 2) to = space + 1
        // Never between the two halves of a surrogate pair.
        else if (/[\ud800-\udbff]/.test(text[to - 1]!)) to--
      }
      cuts.push([from, to])
      from = to
    }
  }

  const rows = cuts.map(([from, to]) => {
    const runs: Run[] = []
    for (let at = from; at < to; at++) {
      const last = runs[runs.length - 1]
      if (last !== undefined && last.isChanged === changed[at] && last.kind === kinds[at]) last.text += text[at]
      else runs.push({ text: text[at]!, at: at - from, isChanged: changed[at]!, kind: kinds[at] })
    }
    return runs
  })
  if (!wrap && text.length > side.chars) {
    const runs = rows[0]!
    const last = runs[runs.length - 1]
    if (last !== undefined) last.text = last.text.slice(0, -1)
    runs.push({ text: '…', at: side.chars - 1, isChanged: false, kind: 'comment' })
  }
  return rows
}

// A rectangle; a width given as a string is a share of the viewport ("100%").
function rect(className: string, x: number, y: number, width: number | string, height: number) {
  const across = typeof width === 'string' ? width : px(width)
  return `<rect class="${className}" x="${px(x)}" y="${px(y)}" width="${across}" height="${px(height)}"/>`
}

// One side of one row: its tints, line numbers, sign and code.
function lineMarkup(
  side: Side,
  line: Line,
  numbers: (number | undefined)[],
  rows: Run[][],
  y: number,
  height: number,
): string {
  let out = ''
  const rowClass = ROW_CLASS[line.kind]
  const numberClass = NUMBER_CLASS[line.kind]
  const wordClass = WORD_CLASS[line.kind]
  if (rowClass !== undefined) out += rect(rowClass, 0, y, '100%', height)
  if (numberClass !== undefined) out += rect(numberClass, 0, y, side.numbers * side.numberWidth, height)
  const base = y + BASELINE_PX
  numbers.forEach((n, k) => {
    if (n === undefined) return
    const right = (k + 1) * side.numberWidth - NUMBER_PAD_PX
    out += `<text class="n" x="${px(right)}" y="${px(base)}" text-anchor="end">${n}</text>`
  })
  const sign = SIGN[line.kind]
  if (sign !== '') out += `<text x="${px(side.codeX - SIGN_PX + 5)}" y="${px(base)}">${sign}</text>`
  rows.forEach((runs, k) => {
    const top = y + k * ROW_PX
    if (wordClass !== undefined) {
      for (const run of runs) {
        if (!run.isChanged || run.text.trim() === '') continue
        out += `<rect class="${wordClass}" x="${px(side.codeX + run.at * CHAR_PX)}" y="${px(top + 1)}" width="${px(run.text.length * CHAR_PX)}" height="${ROW_PX - 2}" rx="2"/>`
      }
    }
    const spans = runs
      .filter(run => run.text !== '')
      .map(run => {
        const kind = run.kind !== undefined ? ` class="${run.kind}"` : ''
        return `<tspan x="${px(side.codeX + run.at * CHAR_PX)}"${kind}>${escape(run.text)}</tspan>`
      })
      .join('')
    if (spans !== '') out += `<text y="${px(top + BASELINE_PX)}">${spans}</text>`
  })
  return out
}

function gapMarkup(gap: Extract<Row, { kind: 'gap' }>, side: Side, y: number): string {
  const where = gap.count === 1 ? `line ${gap.from}` : `lines ${gap.from}–${gap.from + gap.count - 1}`
  const label = `⋯ ${gap.count} unchanged line${gap.count === 1 ? '' : 's'} (${where})`
  return (
    rect('rh', 0, y, '100%', ROW_PX) +
    rect('nh', 0, y, side.numbers * side.numberWidth, ROW_PX) +
    `<text class="m" x="${px(side.codeX - SIGN_PX + 5)}" y="${px(y + BASELINE_PX)}">${escape(label)}</text>`
  )
}

// The rows of one file (one page of them) as pictures, each under the
// element's size: one, unless the page is very long. A picture is as wide
// as the room it is drawn in, its tints drawn across it at 1:1; `width`,
// what the room is thought to be, only decides where long lines wrap.
export function diffPictures(rows: readonly (Row | SplitRow)[], options: PictureOptions): DiffPicture[] {
  const width = Math.max(200, Math.floor(options.width))
  const language = languageOf(options.path)
  const unified = sideOf(width, options.isNew ? 1 : 2, options.digits)
  const half = sideOf(width / 2, 1, options.digits)

  const pictures: DiffPicture[] = []
  // Unified, everything is drawn in `body`; split, the gaps are, and each
  // half's lines in a viewport of its own, which clips them at the middle.
  let body = ''
  let left = ''
  let right = ''
  let height = 0
  const close = () => {
    if (height === 0) return
    const halves = options.isSplit
      ? `<svg width="50%" height="${height}">${left}</svg>` +
        `<svg x="50%" width="50%" height="${height}">${right}</svg>` +
        `<rect class="sep" x="50%" y="0" width="1" height="${height}"/>`
      : ''
    pictures.push({
      source:
        `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="100%" height="${height}">` +
        STYLE +
        body +
        halves +
        '</svg>',
      width,
      height,
    })
    body = left = right = ''
    height = 0
  }

  for (const row of rows) {
    // The row's markup at `y`: for the whole picture, the left and the right half.
    const draw = (y: number): [string, string, string, number] => {
      if (row.kind === 'gap') return [gapMarkup(row, options.isSplit ? half : unified, y), '', '', ROW_PX]
      if (row.kind === 'pair') {
        const leftRows = row.left !== undefined ? rowsOfLine(row.left, half, options.wrap, language) : []
        const rightRows = row.right !== undefined ? rowsOfLine(row.right, half, options.wrap, language) : []
        const tall = Math.max(1, leftRows.length, rightRows.length) * ROW_PX
        const one = (line: Line | undefined, lines: Run[][], number: number | undefined) =>
          line === undefined ? rect('re', 0, y, '100%', tall) : lineMarkup(half, line, [number], lines, y, tall)
        return ['', one(row.left, leftRows, row.left?.old), one(row.right, rightRows, row.right?.new), tall]
      }
      const lines = rowsOfLine(row, unified, options.wrap, language)
      const tall = Math.max(1, lines.length) * ROW_PX
      const numbers = options.isNew ? [row.new] : [row.old, row.new]
      return [lineMarkup(unified, row, numbers, lines, y, tall), '', '', tall]
    }
    let drawn = draw(height)
    const size = drawn[0].length + drawn[1].length + drawn[2].length
    if (height > 0 && body.length + left.length + right.length + size > MAX_SOURCE_CHARS) {
      close()
      drawn = draw(0)
    }
    body += drawn[0]
    left += drawn[1]
    right += drawn[2]
    height += drawn[3]
  }
  close()
  return pictures
}
