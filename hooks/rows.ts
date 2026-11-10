// A file's stored hunks as the rows a GitHub-style view draws: numbered
// lines on both sides, the changed words of a reworded line, and the runs of
// unchanged lines between hunks; and what every drawing of them shares: a
// line's styled runs, a gap row's words and the tints. Pure, so tests read
// it directly.
//
// Reading the hunks is cheap and finding the changed words is not, so the
// two are apart: `blocksOf` and `rowsIn` read, and `wordMarker` marks the
// lines a drawing shows, each once.

import { UNPLACED, UNPLACED_ON, diffLines } from './diff'
import { tokensOf } from './syntax'
import type { Language, TokenClass } from './syntax'

export type Span = { text: string; isChanged: boolean }

export type LineKind = 'context' | 'removed' | 'added'

export type Line = {
  kind: LineKind
  old?: number
  new?: number
  spans: Span[]
}

// The unchanged lines skipped before a hunk: how many, from which line. A
// hunk whose place in the file is not known has a gap from line 0.
export type Gap = { kind: 'gap'; count: number; from: number }

// A stretch of a line drawn in one style: changed or not, and one syntax class.
export type Run = { text: string; isChanged: boolean; kind: TokenClass | undefined }

// One row of the unified view: a line, or the unchanged lines skipped.
export type Row = Gap | Line

// One row of the split view: the old file's line beside the new file's.
export type SplitRow = Gap | { kind: 'pair'; left?: Line; right?: Line }

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
// Reworded lines longer than this are marked whole.
const MAX_WORD_DIFF_TOKENS = 300
// Below this share of unchanged characters, word marks are noise.
const MIN_KEPT_SHARE = 0.4

const whole = (text: string): Span[] => [{ text, isChanged: false }]

// Words, runs of space and single other characters, each a whole code
// point, so an emoji is never marked half changed.
function tokens(text: string): string[] {
  return text.match(/\w+|\s+|[^\w\s]/gu) ?? []
}

function joined(parts: Span[]): Span[] {
  const spans: Span[] = []
  for (const part of parts) {
    const last = spans[spans.length - 1]
    if (last && last.isChanged === part.isChanged) last.text += part.text
    else spans.push({ ...part })
  }
  return spans
}

// The removed and added versions of a reworded line, each split into the
// words it shares with the other and the words that changed; null when the
// lines differ too much for word marks to help.
export function wordSpans(before: string, after: string): [Span[], Span[]] | null {
  const a = tokens(before)
  const b = tokens(after)
  if (a.length > MAX_WORD_DIFF_TOKENS || b.length > MAX_WORD_DIFF_TOKENS) return null
  const ops = diffLines(a, b)
  const kept = ops.filter(op => op.t === ' ').reduce((sum, op) => sum + op.line.length, 0)
  if (kept < MIN_KEPT_SHARE * Math.max(before.length, after.length)) return null
  const left = joined(ops.filter(op => op.t !== '+').map(op => ({ text: op.line, isChanged: op.t === '-' })))
  const right = joined(ops.filter(op => op.t !== '-').map(op => ({ text: op.line, isChanged: op.t === '+' })))
  return [left, right]
}

// `isPlaced`: whether its header names its lines; one that does not has
// lines with no numbers, and `isContinued` when it goes on from the hunk
// before it.
type Hunk = { firstOld: number; oldLines: number; lines: Line[]; isPlaced: boolean; isContinued: boolean }

function parseHunk(text: string): Hunk | null {
  const [head = '', ...body] = text.split('\n')
  const match = HEADER.exec(head)
  const isPlaced = match !== null
  if (!isPlaced && head !== UNPLACED && head !== UNPLACED_ON) return null
  const oldLines = match?.[2] === undefined ? 1 : Number(match[2])
  const newLines = match?.[4] === undefined ? 1 : Number(match[4])
  // A side with no lines names the line it comes after.
  const firstOld = Number(match?.[1] ?? 0) + (oldLines === 0 ? 1 : 0)
  let old = firstOld
  let next = Number(match?.[3] ?? 0) + (newLines === 0 ? 1 : 0)
  const lines: Line[] = []
  for (const raw of body) {
    const mark = raw.slice(0, 1)
    const spans = whole(raw.slice(1))
    if (mark === '-') lines.push({ kind: 'removed', ...(isPlaced ? { old: old++ } : {}), spans })
    else if (mark === '+') lines.push({ kind: 'added', ...(isPlaced ? { new: next++ } : {}), spans })
    else if (mark === ' ') lines.push({ kind: 'context', ...(isPlaced ? { old: old++, new: next++ } : {}), spans })
  }
  return { firstOld, oldLines, lines, isPlaced, isContinued: head === UNPLACED_ON }
}

// What marks the changed words of one of these rows' lines, and of the line
// it is paired with: each run of removed lines is paired with the added run
// right after it, first with first. A line is marked once, when a drawing
// first shows it or its pair; a line with no pair stays as it is.
export function wordMarker(rows: readonly Row[]): (line: Line) => void {
  const pairs = new Map<Line, [Line, Line]>()
  for (let at = 0; at < rows.length; ) {
    if (rows[at]!.kind !== 'removed') {
      at++
      continue
    }
    const removedFrom = at
    while (rows[at]?.kind === 'removed') at++
    const addedFrom = at
    while (rows[at]?.kind === 'added') at++
    for (let k = 0; k < Math.min(addedFrom - removedFrom, at - addedFrom); k++) {
      const pair: [Line, Line] = [rows[removedFrom + k] as Line, rows[addedFrom + k] as Line]
      pairs.set(pair[0], pair)
      pairs.set(pair[1], pair)
    }
  }
  return line => {
    const pair = pairs.get(line)
    if (pair === undefined) return
    const [removed, added] = pair
    pairs.delete(removed)
    pairs.delete(added)
    const spans = wordSpans(removed.spans[0]!.text, added.spans[0]!.text)
    if (spans !== null) [removed.spans, added.spans] = spans
  }
}

// A run of lines drawn with no gap inside it: the unchanged lines skipped
// before it, its lines, and its hunks' text, header and body.
export type Block = { gap?: Gap; lines: Line[]; text: string }

// A file's hunks as blocks, the changed words of their lines not marked: a
// hunk that starts where the one before it ended, such as one of the parts
// a long hunk is stored in, joins it, so a removed line is still paired with
// the added line across the cut. A hunk with no place in the file is a
// block of its own, with the parts it goes on in. A hunk after one of
// those, or one that starts above where the last ended (another edit's, in
// a file that shows each edit in turn), starts over from the file's first
// line, with a gap row that sets it apart.
export function blocksOf(hunks: readonly string[]): Block[] {
  const blocks: Block[] = []
  let nextOld = 1
  // The block a hunk that goes on from the last one joins, and whether that
  // block has no place in the file.
  let open: Block | undefined
  let isOpenPlaced = true
  for (const text of hunks) {
    const hunk = parseHunk(text)
    if (hunk === null) continue
    const joins = hunk.isPlaced ? isOpenPlaced && hunk.firstOld === nextOld : !isOpenPlaced && hunk.isContinued
    if (open !== undefined && joins) {
      open.lines.push(...hunk.lines)
      open.text += '\n' + text
    } else {
      const isOver = open !== undefined && (!isOpenPlaced || hunk.firstOld < nextOld)
      const from = isOver ? 1 : nextOld
      const gap: Gap | undefined = !hunk.isPlaced
        ? { kind: 'gap', count: 0, from: 0 }
        : hunk.firstOld > from || isOver
          ? { kind: 'gap', count: hunk.firstOld - from, from }
          : undefined
      open = { ...(gap !== undefined ? { gap } : {}), lines: hunk.lines, text }
      blocks.push(open)
    }
    isOpenPlaced = hunk.isPlaced
    nextOld = hunk.isPlaced ? hunk.firstOld + hunk.oldLines : 1
  }
  return blocks
}

// The unified rows of a file's blocks, a gap row wherever lines are skipped.
export const rowsIn = (blocks: readonly Block[]): Row[] =>
  blocks.flatMap(block => (block.gap !== undefined ? [block.gap, ...block.lines] : block.lines))

// A file's hunks as unified rows, every reworded line's changed words marked.
export function rowsOf(hunks: readonly string[]): Row[] {
  const rows = rowsIn(blocksOf(hunks))
  const mark = wordMarker(rows)
  for (const row of rows) if (row.kind !== 'gap') mark(row)
  return rows
}

// The same rows side by side: unchanged lines on both sides, each removed
// run beside the added run that replaced it.
export function splitRowsOf(rows: readonly Row[]): SplitRow[] {
  const out: SplitRow[] = []
  for (let at = 0; at < rows.length; ) {
    const row = rows[at]!
    if (row.kind === 'gap') {
      out.push(row)
      at++
      continue
    }
    if (row.kind === 'context') {
      out.push({ kind: 'pair', left: row, right: row })
      at++
      continue
    }
    const removed: Line[] = []
    const added: Line[] = []
    for (let next = rows[at]; next?.kind === 'removed'; next = rows[++at]) removed.push(next)
    for (let next = rows[at]; next?.kind === 'added'; next = rows[++at]) added.push(next)
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const left = removed[k]
      const right = added[k]
      out.push({ kind: 'pair', ...(left ? { left } : {}), ...(right ? { right } : {}) })
    }
  }
  return out
}

// Text a surface may lay out as prose keeps its indentation and inner runs
// of spaces: tabs become spaces, and spaces that would collapse become
// no-break spaces (drawn the same in a terminal).
export function keepSpaces(text: string): string {
  // Most stretches of code hold none of the three.
  if (!text.includes('\t') && !text.startsWith(' ') && !text.includes('  ')) return text
  return text
    .replace(/\t/g, '    ')
    .replace(/^ +/, lead => ' '.repeat(lead.length))
    .replace(/ {2,}/g, run => ' '.repeat(run.length - 1) + ' ')
}

// GitHub's translucent tints of a diff off the terminal, which read on a
// light and a dark theme: a changed line's row, its line numbers and its
// changed words; a gap row and its numbers; a split side with no line.
export const TINT = {
  added: { row: '#2ea04326', number: '#3fb9504d', word: '#2ea04366' },
  removed: { row: '#f8514926', number: '#f851494d', word: '#f8514966' },
  gap: { row: '#388bfd1a', number: '#388bfd33' },
  empty: '#6e76811a',
} as const

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

// Which lines a gap row skips, as it names them.
const gapWhere = (gap: Gap) =>
  gap.count === 1 ? `line ${gap.from}` : `lines ${gap.from}–${gap.from + gap.count - 1}`

// What a gap row says.
export const gapText = (gap: Gap) =>
  gap.from === 0
    ? '⋯ somewhere in the file'
    : gap.count === 0
      ? '⋯ the start of the file'
      : `⋯ ${plural(gap.count, 'unchanged line')} (${gapWhere(gap)})`

// A line's text, each span as `prepare` makes it fit the drawing, as runs of
// one style each: its changed words marked, its syntax classes found in the
// prepared text.
export function runsOf(line: Line, language: Language | undefined, prepare: (text: string) => string): Run[] {
  let text = ''
  const changed: boolean[] = []
  for (const span of line.spans) {
    const part = prepare(span.text)
    text += part
    for (let k = 0; k < part.length; k++) changed.push(span.isChanged)
  }
  const kinds: (TokenClass | undefined)[] = new Array(text.length).fill(undefined)
  for (const token of tokensOf(text, language)) kinds.fill(token.kind, token.from, token.to)
  const runs: Run[] = []
  for (let at = 0; at < text.length; at++) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.isChanged === changed[at] && last.kind === kinds[at]) last.text += text[at]
    else runs.push({ text: text[at]!, isChanged: changed[at]!, kind: kinds[at] })
  }
  return runs
}
