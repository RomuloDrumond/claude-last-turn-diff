// A file's stored hunks as the rows a GitHub-style view draws: numbered
// lines on both sides, the changed words of a reworded line, and the runs of
// unchanged lines between hunks; and what every drawing of them shares: a
// line's styled runs, a gap row's words and the tints. Pure, so tests read
// it directly.

import { diffLines } from './diff'
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

type Hunk = { firstOld: number; oldLines: number; lines: Line[] }

function parseHunk(text: string): Hunk | null {
  const [head = '', ...body] = text.split('\n')
  const match = HEADER.exec(head)
  if (match === null) return null
  const oldLines = match[2] === undefined ? 1 : Number(match[2])
  const newLines = match[4] === undefined ? 1 : Number(match[4])
  // A side with no lines names the line it comes after.
  const firstOld = Number(match[1]) + (oldLines === 0 ? 1 : 0)
  let old = firstOld
  let next = Number(match[3]) + (newLines === 0 ? 1 : 0)
  const lines: Line[] = []
  for (const raw of body) {
    const mark = raw.slice(0, 1)
    const line = raw.slice(1)
    if (mark === '-') lines.push({ kind: 'removed', old: old++, spans: whole(line) })
    else if (mark === '+') lines.push({ kind: 'added', new: next++, spans: whole(line) })
    else if (mark === ' ') lines.push({ kind: 'context', old: old++, new: next++, spans: whole(line) })
  }
  return { firstOld, oldLines, lines }
}

// Pairs each run of removed lines with the added run right after it and
// marks the words that changed in each pair.
function markWords(lines: Line[]) {
  for (let at = 0; at < lines.length; ) {
    if (lines[at]!.kind !== 'removed') {
      at++
      continue
    }
    const removedFrom = at
    while (at < lines.length && lines[at]!.kind === 'removed') at++
    const addedFrom = at
    while (at < lines.length && lines[at]!.kind === 'added') at++
    const pairs = Math.min(addedFrom - removedFrom, at - addedFrom)
    for (let k = 0; k < pairs; k++) {
      const removed = lines[removedFrom + k]!
      const added = lines[addedFrom + k]!
      const spans = wordSpans(removed.spans[0]!.text, added.spans[0]!.text)
      if (spans !== null) [removed.spans, added.spans] = spans
    }
  }
}

// A run of lines drawn with no gap inside it: the unchanged lines skipped
// before it, its lines, and its hunks' text, header and body.
export type Block = { gap?: Gap; lines: Line[]; text: string }

// A file's hunks as blocks: a hunk that starts where the one before it
// ended, such as one of the parts a long hunk is stored in, joins it, so a
// removed line is still paired with the added line across the cut.
export function blocksOf(hunks: readonly string[]): Block[] {
  const blocks: Block[] = []
  let nextOld = 1
  for (const text of hunks) {
    const hunk = parseHunk(text)
    if (hunk === null) continue
    const last = blocks[blocks.length - 1]
    if (last !== undefined && hunk.firstOld <= nextOld) {
      last.lines.push(...hunk.lines)
      last.text += '\n' + text
    } else {
      const gap: Gap | undefined =
        hunk.firstOld > nextOld ? { kind: 'gap', count: hunk.firstOld - nextOld, from: nextOld } : undefined
      blocks.push({ ...(gap !== undefined ? { gap } : {}), lines: hunk.lines, text })
    }
    nextOld = hunk.firstOld + hunk.oldLines
  }
  for (const block of blocks) markWords(block.lines)
  return blocks
}

// The unified rows of a file's blocks, a gap row wherever lines are skipped.
export const rowsIn = (blocks: readonly Block[]): Row[] =>
  blocks.flatMap(block => (block.gap !== undefined ? [block.gap, ...block.lines] : block.lines))

export const rowsOf = (hunks: readonly string[]): Row[] => rowsIn(blocksOf(hunks))

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
export const gapWhere = (gap: Gap) =>
  gap.count === 1 ? `line ${gap.from}` : `lines ${gap.from}–${gap.from + gap.count - 1}`

// What a gap row says.
export const gapText = (gap: Gap) => `⋯ ${plural(gap.count, 'unchanged line')} (${gapWhere(gap)})`

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
