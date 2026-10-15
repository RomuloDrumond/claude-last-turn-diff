import type { SessionMessage } from 'claude-code'

import type { FileDiff, TurnDiff } from '../types'
import { patchHunks, unifiedHunks } from './diff'
import type { Hunks } from './diff'

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit'])

// Texts past this are not diffed: the file is listed as too large.
export const MAX_TEXT_CHARS = 2_000_000
// What one file keeps of its hunks, and one turn of all its files, so the
// session's state stays well under the host's limit.
const MAX_FILE_CHARS = 150_000
const MAX_TURN_CHARS = 600_000
const TITLE_WORDS = 8
const TITLE_CHARS = 60

// One landed edit: the text before and after it. `before` is null for a file
// the edit created and undefined when unknown; `patch` is what the tool itself
// reported, used when a text is missing.
export type Step = {
  key: string
  path: string
  cell?: string
  before: string | null | undefined
  after: string | undefined
  patch?: Hunks
}

type Patch = Parameters<typeof patchHunks>[0]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

function patchOf(value: unknown): Hunks | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const parts = value.filter(
    (part): part is Patch[number] =>
      isRecord(part) &&
      typeof part.oldStart === 'number' &&
      typeof part.newStart === 'number' &&
      Array.isArray(part.lines),
  )
  return parts.length > 0
    ? patchHunks(
        parts.map(part => ({
          ...part,
          oldLines: typeof part.oldLines === 'number' ? part.oldLines : 0,
          newLines: typeof part.newLines === 'number' ? part.newLines : 0,
          lines: part.lines.filter((line): line is string => typeof line === 'string'),
        })),
      )
    : undefined
}

function replaced(text: string, oldString: string, newString: string, all: boolean): string | undefined {
  if (oldString === '') return undefined
  if (all) return text.split(oldString).join(newString)
  const at = text.indexOf(oldString)
  return at < 0 ? undefined : text.slice(0, at) + newString + text.slice(at + oldString.length)
}

// One Edit, Write or NotebookEdit call as the step it took, from its input and
// the result the tool reported (live, or as the transcript stored it). `read`
// holds the file as read before and after the call, when the caller read it.
export function stepOf(
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
  read: { before?: string | null; after?: string } = {},
): Step | null {
  const out = isRecord(result) ? result : {}
  if (out.staged === true || typeof out.error === 'string') return null

  if (tool === 'NotebookEdit') {
    const path = str(out.notebook_path) ?? str(input.notebook_path)
    if (path === undefined) return null
    const mode = str(out.edit_mode) ?? str(input.edit_mode) ?? 'replace'
    const cell = str(out.cell_id) ?? str(input.cell_id) ?? 'new'
    const newSource = str(out.new_source) ?? str(input.new_source) ?? ''
    const before = mode === 'insert' ? null : str(out.old_source)
    return {
      key: `${path}#${cell}`,
      path,
      cell,
      before,
      after: mode === 'delete' ? '' : newSource,
    }
  }

  const path = str(out.filePath) ?? str(input.file_path)
  if (path === undefined) return null
  const patch = patchOf(out.structuredPatch)

  if (tool === 'Write') {
    const before =
      read.before !== undefined
        ? read.before
        : out.type === 'create'
          ? null
          : (str(out.originalFile) ?? undefined)
    const after = read.after ?? str(out.content) ?? str(input.content)
    return { key: path, path, before, after, patch }
  }

  if (tool === 'Edit') {
    const before = read.before !== undefined ? read.before : str(out.originalFile)
    const oldString = str(out.oldString) ?? str(input.old_string) ?? ''
    const newString = str(out.newString) ?? str(input.new_string) ?? ''
    const all = (out.replaceAll ?? input.replace_all) === true
    const after =
      read.after ??
      (typeof before === 'string' ? replaced(before, oldString, newString, all) : undefined)
    return { key: path, path, before, after, patch }
  }

  return null
}

export function displayName(path: string, cwd: string): string {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  return cwd !== '' && path.startsWith(root) ? path.slice(root.length) : path
}

// What a prompt the engine wrote reads as: a background task's notification
// by its summary, a slash command by its name and arguments, any other
// tagged prompt by its text without the tags.
function readable(prompt: string): string {
  const text = prompt.trim()
  if (!text.startsWith('<')) return text
  if (text.startsWith('<task-notification>')) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]
    return `Background task: ${summary?.trim() || 'finished'}`
  }
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]
  if (command !== undefined) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ''
    return `${command.trim()} ${args.trim()}`.trim()
  }
  return text.replace(/<[^>]*>/g, ' ')
}

export function titleOf(prompt: string): string {
  const text = readable(prompt)
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return '(no prompt)'
  let title = words.slice(0, TITLE_WORDS).join(' ')
  if (title.length > TITLE_CHARS) title = title.slice(0, TITLE_CHARS - 1).trimEnd()
  return title.length < words.join(' ').length ? `${title}…` : title
}

function keepUpTo(hunks: Hunks, budget: number): { hunks: string[]; dropped: number } {
  const kept: string[] = []
  let used = 0
  for (const hunk of hunks.hunks) {
    if (used + hunk.length > budget && kept.length > 0) break
    kept.push(hunk)
    used += hunk.length
  }
  return { hunks: kept, dropped: hunks.hunks.length - kept.length }
}

const isLarge = (text: string | null | undefined) =>
  typeof text === 'string' && text.length > MAX_TEXT_CHARS

// One file's steps of a turn, oldest first, as the file's diff: the text
// before its first step against the text after its last when both are known,
// else each step's own hunks in turn.
function fileOf(steps: Step[], cwd: string): FileDiff | null {
  const first = steps[0]!
  const last = steps[steps.length - 1]!
  const isNew = first.before === null
  const name =
    displayName(first.path, cwd) + (first.cell !== undefined ? ` · cell ${first.cell}` : '')
  const isKnown = steps.every(step => step.before !== undefined && step.after !== undefined)
  let note: string | undefined
  let hunks: Hunks

  if (steps.some(step => isLarge(step.before) || isLarge(step.after))) {
    hunks = { hunks: [], added: 0, removed: 0 }
    note = 'too large to diff'
  } else if (isKnown) {
    hunks = unifiedHunks(first.before ?? '', last.after ?? '')
  } else {
    hunks = { hunks: [], added: 0, removed: 0 }
    for (const step of steps) {
      const part =
        step.before !== undefined && step.after !== undefined
          ? unifiedHunks(step.before ?? '', step.after)
          : step.patch
      if (part === undefined) {
        note = 'some edits could not be diffed'
        continue
      }
      hunks = {
        hunks: [...hunks.hunks, ...part.hunks],
        added: hunks.added + part.added,
        removed: hunks.removed + part.removed,
      }
    }
    if (steps.length > 1 && note === undefined) note = 'each edit shown in turn'
  }

  if (hunks.hunks.length === 0 && note === undefined) {
    if (isNew) note = 'new empty file'
    else return null
  }
  const kept = keepUpTo(hunks, MAX_FILE_CHARS)
  if (kept.dropped > 0) note = `${kept.dropped} more hunks not kept`
  return {
    key: first.key,
    name,
    path: first.path,
    isNew,
    added: hunks.added,
    removed: hunks.removed,
    hunks: kept.hunks,
    ...(note !== undefined ? { note } : {}),
  }
}

export function turnOf(n: number, prompt: string, steps: readonly Step[], cwd: string): TurnDiff {
  const byKey = new Map<string, Step[]>()
  for (const step of steps) byKey.set(step.key, [...(byKey.get(step.key) ?? []), step])

  let budget = MAX_TURN_CHARS
  const files: FileDiff[] = []
  for (const group of byKey.values()) {
    const file = fileOf(group, cwd)
    if (file === null) continue
    const size = file.hunks.reduce((sum, hunk) => sum + hunk.length, 0)
    if (size > budget) {
      files.push({ ...file, hunks: [], note: 'not kept: the turn changed too much' })
    } else {
      budget -= size
      files.push(file)
    }
  }
  return {
    n,
    title: titleOf(prompt),
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  }
}

// A row that starts a turn: a user message with text and no tool results.
const isPromptRow = (message: SessionMessage) =>
  message.role === 'user' &&
  (message.toolResults === undefined || message.toolResults.length === 0) &&
  message.text !== ''

// The session's turns with edits, newest first, read back from the
// transcript, and how many turns it holds. Edits come from each Edit, Write
// and NotebookEdit call's stored result; errored calls are left out.
export function turnsFromMessages(
  messages: readonly SessionMessage[],
  cwd: string,
  keep: number,
): { turns: TurnDiff[]; count: number } {
  const starts = messages.flatMap((message, at) => (isPromptRow(message) ? [at] : []))
  const turns: TurnDiff[] = []

  for (let at = starts.length - 1; at >= 0 && turns.length < keep; at--) {
    const rows = messages.slice(starts[at], starts[at + 1])
    const steps = rows
      .flatMap(row => (row.role === 'assistant' ? row.toolUses : []))
      .filter(use => EDIT_TOOLS.has(use.tool) && use.isError !== true && use.result !== undefined)
      .map(use => stepOf(use.tool, use.input, use.result))
      .filter((step): step is Step => step !== null)
    if (steps.length === 0) continue
    const turn = turnOf(at + 1, rows[0]?.text ?? '', steps, cwd)
    if (turn.files.length > 0) turns.push(turn)
  }
  return { turns, count: starts.length }
}
