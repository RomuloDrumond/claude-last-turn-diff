// Unified line diffs in plain JS: Myers' O(ND) algorithm over the lines left
// once the common head and tail are trimmed, then hunks with 3 lines of
// context. No dependencies, so it runs in the hooks environment as is.

export type Op = { t: ' ' | '-' | '+'; line: string }

export type Hunks = { hunks: string[]; added: number; removed: number }

const CONTEXT = 3
// Past this many edits the trace would cost too much memory: the changed
// middle is shown as all removed, then all added.
const MAX_D = 1500
// A hunk longer than this is split into several, each with its own header,
// so one paged view never has to hold a whole rewritten file.
const MAX_HUNK_LINES = 200
// A drawn line is cut here (minified files would swamp the pane), and ends
// in CUT_MARK.
const MAX_LINE_CHARS = 400
const CUT_MARK = '…'

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

// The edit script turning a into b, or null when it needs more than maxD
// insertions and deletions.
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length
  const m = b.length
  const limit = Math.min(n + m, maxD)
  const offset = limit + 1
  const v = new Int32Array(2 * limit + 3)
  const trace: Int32Array[] = []
  let found = -1

  outer: for (let d = 0; d <= limit; d++) {
    // v as it stood after step d-1, for k in [-d-1, d+1].
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break outer
      }
    }
  }
  if (found < 0) return null

  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = found; d >= 0; d--) {
    const saved = trace[d]!
    const at = (k: number) => saved[k + d + 1]!
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', line: a[--x]! })
      y--
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: '+', line: b[--y]! })
      else ops.push({ t: '-', line: a[--x]! })
    }
  }
  return ops.reverse()
}

export function diffLines(a: string[], b: string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const middle = myers(midA, midB, MAX_D) ?? [
    ...midA.map((line): Op => ({ t: '-', line })),
    ...midB.map((line): Op => ({ t: '+', line })),
  ]
  return [
    ...a.slice(0, head).map((line): Op => ({ t: ' ', line })),
    ...middle,
    ...a.slice(a.length - tail).map((line): Op => ({ t: ' ', line })),
  ]
}

type Numbered = Op & { o: number; n: number }

function header(ops: Numbered[]): string {
  const first = ops[0]!
  const oldCount = ops.filter(op => op.t !== '+').length
  const newCount = ops.filter(op => op.t !== '-').length
  const oldStart = oldCount > 0 ? first.o : first.o - 1
  const newStart = newCount > 0 ? first.n : first.n - 1
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
}

// A line as it is kept: cut after MAX_LINE_CHARS, never between the two
// halves of a surrogate pair.
function cut(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line
  const isPairCut = /[\ud800-\udbff]/.test(line[MAX_LINE_CHARS - 1]!)
  return line.slice(0, isPairCut ? MAX_LINE_CHARS - 1 : MAX_LINE_CHARS) + CUT_MARK
}

// Whether a kept line is the start of a longer one (a line of its own that
// is that long and ends in the mark reads as one too). Its text without the
// mark is what was kept.
export const isCutLine = (line: string) => line.length >= MAX_LINE_CHARS && line.endsWith(CUT_MARK)

// Hunk texts (header and body, no trailing newline) for the change from
// `before` to `after`, with CONTEXT lines around each change.
export function unifiedHunks(before: string, after: string): Hunks {
  const ops = diffLines(splitLines(before), splitLines(after))
  let o = 1
  let n = 1
  let added = 0
  let removed = 0
  const numbered: Numbered[] = ops.map(op => {
    const row = { ...op, o, n }
    if (op.t !== '+') o++
    if (op.t !== '-') n++
    if (op.t === '+') added++
    if (op.t === '-') removed++
    return row
  })

  const ranges: [number, number][] = []
  numbered.forEach((op, at) => {
    if (op.t === ' ') return
    const start = Math.max(0, at - CONTEXT)
    const end = Math.min(numbered.length - 1, at + CONTEXT)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  })

  const hunks: string[] = []
  for (const [start, end] of ranges) {
    const rows = numbered.slice(start, end + 1)
    for (let at = 0; at < rows.length; at += MAX_HUNK_LINES) {
      const part = rows.slice(at, at + MAX_HUNK_LINES)
      hunks.push([header(part), ...part.map(op => op.t + cut(op.line))].join('\n'))
    }
  }
  return { hunks, added, removed }
}

// Hunks a tool already computed (Edit's and Write's `structuredPatch`), as
// hunk texts with the same caps.
export function patchHunks(
  patch: readonly { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: readonly string[] }[],
): Hunks {
  let added = 0
  let removed = 0
  const hunks = patch.map(part => {
    const lines = part.lines.filter(line => !line.startsWith('\\'))
    for (const line of lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
    const head = `@@ -${part.oldStart},${part.oldLines} +${part.newStart},${part.newLines} @@`
    return [head, ...lines.map(line => line.slice(0, 1) + cut(line.slice(1)))].join('\n')
  })
  return { hunks, added, removed }
}

// Hunk texts as a unified diff of the file named `name`, as git writes one;
// an absolute name keeps no a/ or b/ prefix.
export function patchOf(name: string, isNew: boolean, hunks: readonly string[]): string {
  const side = (prefix: string) => (name.startsWith('/') ? name : prefix + name)
  return [isNew ? '--- /dev/null' : `--- ${side('a/')}`, `+++ ${side('b/')}`, ...hunks, ''].join('\n')
}

// Whether hunk texts hold a line kept cut.
export const hasCutLine = (text: string) =>
  text.split('\n').some(line => /^[-+ ]/.test(line) && isCutLine(line.slice(1)))
