// A file's stored hunks as the rows a GitHub-style view draws: numbered
// lines on both sides, the changed words of a reworded line, and the runs of
// unchanged lines between hunks. Pure, so tests read it directly.

import { diffLines } from './diff'

export type Span = { text: string; isChanged: boolean }

export type LineKind = 'context' | 'removed' | 'added'

export type Line = {
  kind: LineKind
  old?: number
  new?: number
  spans: Span[]
}

export type Gap = { kind: 'gap'; count: number; from: number }

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

function tokens(text: string): string[] {
  return text.match(/\w+|\s+|[^\w\s]/g) ?? []
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
  markWords(lines)
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

// The unified rows of a file's hunks, a gap row wherever lines are skipped.
export function rowsOf(hunks: readonly string[]): Row[] {
  const rows: Row[] = []
  let nextOld = 1
  for (const text of hunks) {
    const hunk = parseHunk(text)
    if (hunk === null) continue
    if (hunk.firstOld > nextOld) rows.push({ kind: 'gap', count: hunk.firstOld - nextOld, from: nextOld })
    rows.push(...hunk.lines)
    nextOld = hunk.firstOld + hunk.oldLines
  }
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
  return text
    .replace(/\t/g, '    ')
    .replace(/^ +/, lead => ' '.repeat(lead.length))
    .replace(/ {2,}/g, run => ' '.repeat(run.length - 1) + ' ')
}
