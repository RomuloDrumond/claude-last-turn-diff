// last-turn-diff: records the file edits Claude makes in each turn from its
// own Edit, Write and NotebookEdit calls (no git), and shows them per turn in
// a pane, with a one-line hint above the prompt after a turn that edited.
//
// The idea of recording edits at tool.call and replaying them in a pane comes
// from Anthropic's replay-theater sample mod (Apache-2.0); no code is copied.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput, ResultOf } from 'claude-code'

import type { BandHint, FileDiff, PaneView, TurnDiff } from '../types'
import { EDIT_TOOLS, MAX_TEXT_CHARS, stepOf, turnOf, turnsFromMessages } from './turns'
import type { Step } from './turns'

const PANE = 'last-turn-diff'
const TITLE = 'Last turn diff'
// How many turns with edits are kept.
const KEEP_TURNS = 30
// A tree draws its first 100,000 characters; the pane stays under this.
const TREE_BUDGET = 90_000
// A file shows its hunks a page at a time, a page at most this long.
const PAGE_CHARS = 24_000
// Files open by default until their first pages add up to this.
const OPEN_BY_DEFAULT_CHARS = 40_000
const MAX_LISTED_FILES = 150

const NEWEST: PaneView = { at: 0, toggled: [], pages: {} }

const turns = atom({ plugin: 'last-turn-diff', key: 'turns' } as const, [])
const view = atom({ plugin: 'last-turn-diff', key: 'view' } as const, NEWEST)
const band = atom({ plugin: 'last-turn-diff', key: 'band' } as const, null)
const turnNo = atom({ plugin: 'last-turn-diff', key: 'turnNo' } as const, 0)

type $ = EngineInterface

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function pagesOf(file: FileDiff): string[][] {
  const pages: string[][] = []
  let page: string[] = []
  let size = 0
  for (const hunk of file.hunks) {
    if (page.length > 0 && size + hunk.length > PAGE_CHARS) {
      pages.push(page)
      page = []
      size = 0
    }
    page.push(hunk)
    size += hunk.length + 1
  }
  if (page.length > 0) pages.push(page)
  return pages
}

function opensByDefault(files: readonly FileDiff[]): Set<string> {
  const open = new Set<string>()
  let size = 0
  for (const file of files) {
    const first = pagesOf(file)[0]
    if (first === undefined) continue
    const length = first.reduce((sum, hunk) => sum + hunk.length, 0)
    if (open.size > 0 && size + length > OPEN_BY_DEFAULT_CHARS) break
    open.add(file.key)
    size += length
  }
  return open
}

async function cwdOf($: $): Promise<string> {
  try {
    return await $.session.cwd()
  } catch {
    return ''
  }
}

async function readText($: $, path: string): Promise<string | null | undefined> {
  try {
    if (!(await $.fs.exists(path))) return null
    const text = await $.fs.read(path)
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS + 1) : text
  } catch {
    return undefined
  }
}

async function openPane($: $) {
  await update($, view, () => NEWEST)
  return $.ui.open({ id: PANE, title: TITLE, focus: true })
}

// Rebuilds the turns from the transcript: after a reload, /resume or a fork.
async function rebuild($: $) {
  let messages: Awaited<ReturnType<$['session']['messages']>> = []
  try {
    messages = await $.session.messages()
  } catch {
    return
  }
  const { turns: found, count } = turnsFromMessages(messages, await cwdOf($), KEEP_TURNS)
  await update($, turns, () => found)
  await update($, turnNo, () => count)
  await update($, view, () => NEWEST)
  const newest = found[0]
  await update($, band, () => (newest !== undefined && newest.n === count ? hintOf(newest) : null))
}

async function reset($: $) {
  await update($, turns, () => [])
  await update($, turnNo, () => 0)
  await update($, view, () => NEWEST)
  await update($, band, () => null)
}

const hintOf = (turn: TurnDiff): BandHint => ({
  n: turn.n,
  files: turn.files.length,
  added: turn.added,
  removed: turn.removed,
})

export const register: Register = on => {
  // The edits of the turn in flight, oldest first, and that turn's prompt.
  // Module memory: a reload mid-turn loses them, and the turn is then read
  // back from the transcript when it completes.
  let pending: Step[] = []
  let prompt = ''
  let turnId: string | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'lastturn',
      description: 'Show the file edits Claude made in the last turn, with earlier turns a step away',
      immediate: true,
    })
    // A hot reload keeps $.state: only an empty session reads the transcript.
    if ((await read($, turns)).length === 0 && (await read($, turnNo)) === 0) await rebuild($)
    return started
  })

  // /clear starts over; /resume and a fork bring another transcript.
  on('classic.SessionStart', async ($, e, next) => {
    const answered = await next(e)
    pending = []
    turnId = undefined
    if (e.source === 'clear') await reset($)
    else if (e.source === 'resume' || e.source === 'fork') await rebuild($)
    return answered
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'lastturn' }, async $ => {
    const list = await read($, turns)
    await openPane($)
    const newest = list[0]
    return {
      text:
        newest === undefined
          ? 'No file edits recorded in this session yet.'
          : `T${newest.n}: ${plural(newest.files.length, 'file')}, +${newest.added} -${newest.removed}`,
    }
  })

  on('turn.start', ($, e, next) => {
    prompt = e.text
    turnId = e.turnId
    void update($, turnNo, count => count + 1)
    return next(e)
  })

  // Records each edit that landed. The call always goes on unchanged.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!EDIT_TOOLS.has(tool)) return next(e)
    const input = e as unknown as Record<string, unknown>
    const path = typeof input.file_path === 'string' ? input.file_path : undefined
    const before = path !== undefined ? await readText($, path) : undefined

    const ran: ResultOf['tool.call'] = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const after = path !== undefined && before !== undefined ? await readText($, path) : undefined
    const step = stepOf(tool, input, ran.result, {
      ...(before !== undefined ? { before } : {}),
      ...(typeof after === 'string' ? { after } : {}),
    })
    if (step !== null) pending.push(step)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    if (turnId !== e.turnId) {
      // This copy of the module did not see the turn start: read it back.
      await rebuild($)
      pending = []
      return done
    }
    const steps = pending
    pending = []
    turnId = undefined
    const n = await read($, turnNo)
    const turn = turnOf(n, prompt, steps, await cwdOf($))
    if (turn.files.length === 0) {
      await update($, band, () => null)
      return done
    }
    await update($, turns, list => [turn, ...list].slice(0, KEEP_TURNS))
    await update($, view, () => NEWEST)
    await update($, band, () => hintOf(turn))
    return done
  })

  // The hint above the prompt after a turn that edited files.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hint = await read($, band)
    if (hint === null || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor wrap="truncate-end">
          Last turn: {plural(hint.files, 'file')}, <Text color="green">+{hint.added}</Text>{' '}
          <Text color="red">-{hint.removed}</Text>
        </Text>
        <Button key="open-last-turn-diff" label="View diff" hotkey="d" onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => paneOf($, e))
}

async function paneOf($: $, e: RenderInput<'Pane'>) {
  // Desktop, VS Code and mobile have no Raster or Image: this tree uses only
  // the elements every surface draws (Box, Text, Button, Code).
  const { Box, Text, Button, Code } = $.ui.resolve(e)
  const list = await read($, turns)
  const at = Math.min((await read($, view)).at, Math.max(0, list.length - 1))
  const { toggled, pages } = await read($, view)
  const turn = list[at]

  if (turn === undefined) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No file edits recorded in this session yet.</Text>
        <Text dimColor>Edits made through Edit, Write and NotebookEdit show here after each turn.</Text>
      </Box>
    )
  }

  const go = (to: number) =>
    update($, view, () => ({ at: Math.max(0, Math.min(to, list.length - 1)), toggled: [], pages: {} }))
  const toggle = (key: string) =>
    update($, view, now => ({
      ...now,
      toggled: now.toggled.includes(key) ? now.toggled.filter(one => one !== key) : [...now.toggled, key],
    }))
  const turnPage = (key: string, to: number) =>
    update($, view, now => ({ ...now, pages: { ...now.pages, [key]: to } }))

  const byDefault = opensByDefault(turn.files)
  const isOpen = (file: FileDiff) => byDefault.has(file.key) !== toggled.includes(file.key)
  let budget = TREE_BUDGET - 2_000
  const listed = turn.files.slice(0, MAX_LISTED_FILES)

  const rows = listed.map((file, index) => {
    const open = isOpen(file)
    const filePages = pagesOf(file)
    const page = Math.min(pages[file.key] ?? 0, Math.max(0, filePages.length - 1))
    const shown = filePages[page] ?? []
    const source = shown.join('\n')
    const fits = source.length <= budget
    if (open && fits) budget -= source.length
    const tags = [file.isNew ? 'new' : '', file.note ?? ''].filter(Boolean).join(', ')

    return (
      <Box key={`file-${index}`} flexDirection="column">
        <Button key={`toggle-${index}`} plain onPress={() => void toggle(file.key)}>
          {open ? '▾ ' : '▸ '}
          {file.name} <Text color="green">+{file.added}</Text> <Text color="red">-{file.removed}</Text>
          {tags !== '' ? <Text dimColor> ({tags})</Text> : ''}
        </Button>
        {open && shown.length > 0 && fits && (
          <Code key={`code-${index}`} format="diff" path={file.path} source={source} />
        )}
        {open && shown.length > 0 && !fits && (
          <Text dimColor>  Too much is open to draw this file: collapse another one.</Text>
        )}
        {open && filePages.length > 1 && (
          <Box flexDirection="row" gap={1}>
            <Button key={`earlier-${index}`} label="◀ Earlier hunks" onPress={() => void turnPage(file.key, page - 1)} />
            <Text dimColor>
              page {page + 1} of {filePages.length}
            </Text>
            <Button key={`later-${index}`} label="Later hunks ▶" onPress={() => void turnPage(file.key, page + 1)} />
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
        <Text dimColor>
          {plural(turn.files.length, 'file')}, <Text color="green">+{turn.added}</Text>{' '}
          <Text color="red">-{turn.removed}</Text> · turn {at + 1} of {list.length} with edits
        </Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Button key="prev" label="◀ Prev turn" hotkey="p" onPress={() => void go(at + 1)} />
        <Button key="next" label="Next turn ▶" hotkey="n" onPress={() => void go(at - 1)} />
        <Button
          key="all"
          label={listed.every(isOpen) ? 'Collapse all' : 'Expand all'}
          hotkey="a"
          onPress={() =>
            void update($, view, now => ({
              ...now,
              toggled: listed.every(isOpen)
                ? listed.filter(file => byDefault.has(file.key)).map(file => file.key)
                : listed.filter(file => !byDefault.has(file.key)).map(file => file.key),
            }))
          }
        />
      </Box>
      <Box flexDirection="column">{rows}</Box>
      {turn.files.length > listed.length && (
        <Text dimColor>{turn.files.length - listed.length} more files not listed.</Text>
      )}
    </Box>
  )
}
