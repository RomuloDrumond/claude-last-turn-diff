// last-turn-diff: records the file edits Claude makes in each turn from its
// own Edit, Write and NotebookEdit calls (no git), and shows them per turn in
// a pane, with a one-line hint above the prompt after a turn that edited.
//
// The idea of recording edits at tool.call and replaying them in a pane comes
// from Anthropic's replay-theater sample mod (Apache-2.0); no code is copied.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResultOf } from 'claude-code'

import type { BandHint, DiffMode, TurnDiff } from '../types'
import { diffstat, diffstatAlt } from './icons'
import { plural } from './rows'
import { MODE_KEY, MONO_TEXT_SINCE, NEWEST, WRAP_KEY } from './state'
import { EDIT_TOOLS, MAX_TEXT_CHARS, stepOf, turnOf, turnsFromMessages } from './turns'
import type { Step } from './turns'
import { PANE, paneTree } from './view'
import type { PaneActions } from './view'

const TITLE = 'Last turn diff'
// How many turns with edits are kept.
const KEEP_TURNS = 30
// How many completed turns keep their edits in memory for agents of theirs
// that still run; an older one's agents count as agents nobody saw start.
const KEEP_LATE = 4

// The edits of one of the person's turns while they may still grow: the turn
// in flight, or one that completed with agents of its own still running.
type Recording = {
  turnId: string
  prompt: string
  // Oldest first.
  steps: Step[]
  // Its number, once it completed.
  n?: number
  // The agents that run for it and have not finished.
  agents: Set<string>
  // Whether its stored diff is being brought up to date, and whether an edit
  // landed meanwhile.
  isStoring?: boolean
  isStale?: boolean
}

// What the hooks remember of the turns as they run. Module memory: a reload
// loses it, and a turn in flight is then read back from the transcript when
// it completes.
type Memory = {
  // The turn in flight.
  current: Recording | undefined
  // The turn that completed last.
  last: Recording | undefined
  // The edits that landed with no turn to take them, which the next turn
  // takes: the main loop's between turns, and an agent's while this copy of
  // the module has seen no turn.
  loose: Step[]
  // The turn each agent seen to start works for until its run ends, by the
  // agent's id.
  owners: Map<string, Recording>
  // The completed turns whose agents still run, oldest first.
  late: Recording[]
  // The last of the hooks' own changes to the turns and the pane's place
  // among them, which run one after the other (`inOrder`).
  queue: Promise<unknown>
}

// Runs `work` once the changes queued before it are done: a turn's end and
// an agent's late edit both read the turns, write them and move the pane,
// and neither may do so between the other's steps.
function inOrder<T>(memory: Memory, work: () => Promise<T>): Promise<T> {
  const run = memory.queue.then(work, work)
  memory.queue = run.catch(() => undefined)
  return run
}

const isStale = (record: Recording) => record.isStale === true

const turns = atom({ plugin: 'last-turn-diff', key: 'turns' } as const, [])
const view = atom({ plugin: 'last-turn-diff', key: 'view' } as const, NEWEST)
const band = atom({ plugin: 'last-turn-diff', key: 'band' } as const, null)
const turnNo = atom({ plugin: 'last-turn-diff', key: 'turnNo' } as const, 0)

async function cwdOf($: EngineInterface): Promise<string> {
  try {
    return await $.session.cwd()
  } catch {
    return ''
  }
}

// Whether this engine's Text takes `mono`, from the release it is built
// from. An engine that cannot say, or says it in a way this cannot read,
// counts as one that does not.
async function hasMonoTextOn($: EngineInterface): Promise<boolean> {
  try {
    const { version, base } = await $.session.version()
    const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(base ?? version)
    if (parts === null) return false
    for (let k = 0; k < MONO_TEXT_SINCE.length; k++) {
      const part = Number(parts[k + 1])
      if (part !== MONO_TEXT_SINCE[k]) return part > MONO_TEXT_SINCE[k]!
    }
    return true
  } catch {
    return false
  }
}

async function readText($: EngineInterface, path: string): Promise<string | null | undefined> {
  try {
    if (!(await $.fs.exists(path))) return null
    const text = await $.fs.read(path)
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS + 1) : text
  } catch {
    return undefined
  }
}

// Back to the newest turn, keeping the person's display choices.
function toNewest($: EngineInterface) {
  return update($, view, was => ({
    ...NEWEST,
    ...(was.mode !== undefined ? { mode: was.mode } : {}),
    ...(was.wrap !== undefined ? { wrap: was.wrap } : {}),
  }))
}

async function openPane($: EngineInterface) {
  await toNewest($)
  return $.ui.open({ id: PANE, title: TITLE, focus: true })
}

// One of the session's agents' own conversation, which holds the edits it
// made; nothing when the session cannot read it back.
async function agentRows($: EngineInterface, agentId: string) {
  try {
    const rows = await $.session.messages({ agentId })
    return Array.isArray(rows) ? rows : undefined
  } catch {
    return undefined
  }
}

async function fromTranscript($: EngineInterface) {
  try {
    const messages = await $.session.messages()
    return await turnsFromMessages(messages, await cwdOf($), KEEP_TURNS, agentId => agentRows($, agentId))
  } catch {
    return undefined
  }
}

// Rebuilds the turns from the transcript: after a reload, /resume or a fork.
// Answers the turns it read, none when the transcript could not be read.
async function rebuild($: EngineInterface): Promise<TurnDiff[]> {
  const transcript = await fromTranscript($)
  if (transcript === undefined) return []
  const { turns: found, count } = transcript
  await update($, turns, () => found)
  await update($, turnNo, () => count)
  await toNewest($)
  const newest = found[0]
  await update($, band, () => (newest !== undefined && newest.n === count ? hintOf(newest) : null))
  return found
}

// A turn's number after a Refresh numbered turns anew, for one the
// transcript did not name: it moves as the nearest turn that was named did.
// `moved` holds each such turn's number before and after.
function renumbered(n: number, moved: readonly (readonly [number, number])[]): number {
  let near: readonly [number, number] | undefined
  for (const pair of moved) {
    if (near === undefined || Math.abs(pair[0] - n) < Math.abs(near[0] - n)) near = pair
  }
  return near === undefined ? n : n + near[1] - near[0]
}

// Whether a turn held live is the one the transcript stored: the same
// number or the same title (the two count turns and read prompts each their
// own way, so either may differ), and every file the transcript names.
function sameTurn(live: TurnDiff, stored: TurnDiff) {
  if (live.n !== stored.n && live.title !== stored.title) return false
  const held = new Set(live.files.map(file => file.key))
  return stored.files.every(file => held.has(file.key))
}

// The pane's Refresh: reads the transcript again and adds the turns it holds
// that were not recorded live (before the mod loaded, or lost to a reload).
// A turn recorded live is kept as recorded: it has each file as it was read
// around the edit, which the transcript lacks for an agent's edits. It takes
// the transcript's number, and the turns the transcript does not name, those
// still held in memory with no diff yet among them, move with their
// neighbours.
async function refresh($: EngineInterface, memory: Memory) {
  const transcript = await fromTranscript($)
  if (transcript === undefined) return
  const live = await read($, turns)
  // The turn the pane shows, followed to where the merge puts it.
  let shown = live[(await read($, view)).at]
  const matched = new Set<TurnDiff>()
  const moved: [number, number][] = []
  const found = transcript.turns.map(turn => {
    const free = live.filter(one => !matched.has(one) && sameTurn(one, turn))
    const hit = free.find(one => one.n === turn.n) ?? free[0]
    if (hit === undefined) return turn
    matched.add(hit)
    moved.push([hit.n, turn.n])
    const numbered = { ...hit, n: turn.n }
    if (hit === shown) shown = numbered
    return numbered
  })
  const onlyLive = live
    .filter(one => !matched.has(one))
    .map(one => {
      const numbered = { ...one, n: renumbered(one.n, moved) }
      if (one === shown) shown = numbered
      return numbered
    })
  const merged = [...found, ...onlyLive].sort((a, b) => b.n - a.n).slice(0, KEEP_TURNS)
  await update($, turns, () => merged)
  await update($, turnNo, count => Math.max(count, transcript.count))
  for (const record of new Set([memory.last, ...memory.late])) {
    if (record?.n === undefined) continue
    record.n = merged.find(one => one.id === record.turnId)?.n ?? renumbered(record.n, moved)
  }
  const at = shown === undefined ? 0 : Math.max(0, merged.indexOf(shown))
  await update($, view, was => ({ ...was, at }))
  try {
    $.ui.toast(`Refreshed: ${plural(merged.length, 'turn')} with edits`)
  } catch {
    // The redraw shows it.
  }
}

async function reset($: EngineInterface) {
  await update($, turns, () => [])
  await update($, turnNo, () => 0)
  await toNewest($)
  await update($, band, () => null)
}

// The person's unified or split and wrap choices, kept across sessions.
async function restoreChoices($: EngineInterface) {
  try {
    const kept = await $.store.get(MODE_KEY)
    if (kept === 'unified' || kept === 'split') {
      const mode: DiffMode = kept
      await update($, view, was => ({ ...was, mode }))
    }
    const wrap = await $.store.get(WRAP_KEY)
    if (typeof wrap === 'boolean') await update($, view, was => ({ ...was, wrap }))
  } catch {
    // No store here: the pane opens unified, lines wrapped.
  }
}

const hintOf = (turn: TurnDiff): BandHint => ({
  files: turn.files.length,
  added: turn.added,
  removed: turn.removed,
})

// Brings a completed turn's stored diff up to date with its edits: at its
// end (`isEnd`, which then shows it as the newest turn if it edited), and
// again for each edit an agent of its own lands after that. One run at a
// time: an edit that lands meanwhile has it go once more. The pane stays on
// the turn it shows, and the hint follows the last turn.
async function store($: EngineInterface, memory: Memory, record: Recording, isEnd = false) {
  if (record.isStoring === true) {
    record.isStale = true
    return
  }
  record.isStoring = true
  try {
    await inOrder(memory, async () => {
      do {
        record.isStale = false
        const cwd = await cwdOf($)
        const stood = (await read($, view)).at
        const shown = (await read($, turns))[stood]
        let stored: TurnDiff | undefined
        let kept: TurnDiff[] = []
        let n = record.n ?? 0
        await update($, turns, list => {
          // Refresh may have numbered the turn anew: its id still names it.
          const was = list.find(one => one.id === record.turnId)
          n = was?.n ?? record.n ?? 0
          const turn = { ...turnOf(n, record.prompt, record.steps, cwd), id: record.turnId }
          const rest = list.filter(one => one !== was)
          stored = turn.files.length > 0 ? turn : undefined
          kept = stored === undefined ? rest : [...rest, stored].sort((a, b) => b.n - a.n).slice(0, KEEP_TURNS)
          return kept
        })
        record.n = n
        const at = kept.findIndex(one => one.n === shown?.n && one.title === shown.title && one.id === shown.id)
        // A press that moved the pane meanwhile keeps it where it went.
        await update($, view, was => (was.at !== stood || at < 0 || at === was.at ? was : { ...was, at }))
        if (record === memory.last) await update($, band, () => (stored === undefined ? null : hintOf(stored)))
      } while (isStale(record))
      if (isEnd && record.steps.length > 0) await toNewest($)
    })
  } finally {
    record.isStoring = false
  }
}

// Keeps a completed turn's edits in memory for its agents that still run:
// the newest KEEP_LATE such turns.
function keepLate(memory: Memory, record: Recording) {
  if (memory.late.includes(record)) return
  memory.late.push(record)
  for (const old of memory.late.splice(0, Math.max(0, memory.late.length - KEEP_LATE))) {
    for (const agentId of old.agents) memory.owners.delete(agentId)
    old.agents.clear()
  }
}

// The turn an agent works for now: the one it was seen to start for, else
// its parent's when another agent started it, else the turn in flight, else
// the turn that completed last (a background agent works for a turn that is
// over, not for the next one). None before this copy of the module saw a
// turn: after a reload, until a turn completes.
async function turnFor($: EngineInterface, memory: Memory, agentId: string): Promise<Recording | undefined> {
  const known = memory.owners.get(agentId)
  if (known !== undefined) return known
  const current = memory.current
  let parent: string | undefined
  try {
    parent = (await $.agent.list()).find(agent => agent.id === agentId)?.parentId
  } catch {
    // No list here.
  }
  return memory.owners.get(agentId) ?? (parent !== undefined ? memory.owners.get(parent) : undefined) ?? current ?? memory.last
}

// An agent's run starts: every edit of the run goes to the turn it works
// for now, whichever turns start and end meanwhile.
async function adopt($: EngineInterface, memory: Memory, agentId: string) {
  const owner = await turnFor($, memory, agentId)
  if (owner === undefined || memory.owners.has(agentId)) return
  memory.owners.set(agentId, owner)
  owner.agents.add(agentId)
  if (owner.n !== undefined) keepLate(memory, owner)
}

// An agent's run ended: its turn keeps its edits in memory only while
// another agent of its own still runs.
function release(memory: Memory, agentId: string) {
  const owner = memory.owners.get(agentId)
  if (owner === undefined) return
  memory.owners.delete(agentId)
  owner.agents.delete(agentId)
  if (owner.agents.size === 0) memory.late = memory.late.filter(one => one !== owner)
}

export const register: Register = on => {
  const memory: Memory = {
    current: undefined,
    last: undefined,
    loose: [],
    owners: new Map(),
    late: [],
    queue: Promise.resolve(),
  }
  const forget = () => {
    memory.current = undefined
    memory.last = undefined
    memory.loose = []
    memory.owners.clear()
    memory.late = []
  }
  // Whether Text takes `mono` here, read once the pane first draws off the
  // terminal; the engine does not change while the module is loaded.
  let hasMonoText: boolean | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'lastturn',
      description: 'Show the file edits Claude made in the last turn, with earlier turns a step away',
      immediate: true,
    })
    await restoreChoices($)
    // A hot reload keeps $.state: only an empty session reads the transcript.
    if ((await read($, turns)).length === 0 && (await read($, turnNo)) === 0) await inOrder(memory, () => rebuild($))
    return started
  })

  // /clear starts over; /resume and a fork bring another transcript. Any
  // other start (a compaction, say) leaves the turns and their agents be.
  on('classic.SessionStart', async ($, e, next) => {
    const answered = await next(e)
    if (e.source === 'clear') {
      forget()
      await inOrder(memory, () => reset($))
    } else if (e.source === 'resume' || e.source === 'fork') {
      forget()
      await inOrder(memory, () => rebuild($))
    }
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
          : `T${newest.n}: ${plural(newest.files.length, 'file')} changed, +${newest.added} -${newest.removed}`,
    }
  })

  // A subagent's run starts a turn of its own: its edits are recorded with
  // those of the person's turn it works for, under that turn's prompt and
  // number, also those it lands after that turn completed.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await adopt($, memory, e.agentId)
      return next(e)
    }
    // A turn that never completed gives its edits to this one.
    memory.current ??= { turnId: e.turnId, prompt: e.text, steps: [], agents: new Set() }
    Object.assign(memory.current, { turnId: e.turnId, prompt: e.text })
    memory.current.steps.push(...memory.loose)
    memory.loose = []
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
    if (step === null) return ran
    // An agent nobody saw start has each edit go to the turn it works for
    // as the edit lands.
    const owner = e.agentId === undefined ? memory.current : await turnFor($, memory, e.agentId)
    if (owner === undefined) {
      memory.loose.push(step)
      return ran
    }
    owner.steps.push(step)
    // A turn that completed already: its stored diff takes the edit in.
    if (owner.n !== undefined) await store($, memory, owner)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      release(memory, e.agentId)
      return done
    }

    const record = memory.current
    if (record?.turnId !== e.turnId) {
      // This copy of the module did not see the turn start: read it back.
      // The edits that landed meanwhile in files the transcript does not
      // name (an agent's it cannot read back) stay for the next turn.
      const { loose } = memory
      forget()
      const found = await inOrder(memory, () => rebuild($))
      memory.loose.push(...loose.filter(step => !found.some(turn => turn.files.some(file => file.key === step.key))))
      return done
    }
    memory.current = undefined
    memory.last = record
    record.n = await read($, turnNo)
    if (record.agents.size > 0) keepLate(memory, record)
    await store($, memory, record, true)
    return done
  })

  // The hint above the prompt after a turn that edited files.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const hint = await read($, band)
    if (hint === null || e.props.hasSurvey) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const squares = diffstat(hint.added, hint.removed)
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text wrap="truncate-end">
          <Text dimColor>Last turn changed {plural(hint.files, 'file')}</Text>{'  '}
          <Text color="success">+{hint.added}</Text> <Text color="error">−{hint.removed}</Text>
        </Text>
        {Svg !== undefined && (
          <Svg
            alt={diffstatAlt(hint)}
            source={squares.source}
            width={squares.width}
            height={squares.height}
          />
        )}
        <Button
          key="open-last-turn-diff"
          label="View changes"
          {...(e.surface === 'terminal' ? { hotkey: 'd' } : {})}
          onPress={() => void openPane($)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const actions: PaneActions = {
      change: change => update($, view, change),
      remember: async (key, value) => {
        try {
          await $.store.set(key, value)
        } catch {
          // Remembering a choice is a convenience: the pane changed anyway.
        }
      },
      scrollTo: async key => {
        try {
          await $.ui.scroll({ to: { key }, in: PANE, block: 'start' })
        } catch {
          // The surface could not scroll: the file is open, further down.
        }
      },
      refresh: () => inOrder(memory, () => refresh($, memory)),
      copy: async (text, what, surface) => {
        try {
          const copied = await $.ui.copy({ text, surface })
          $.ui.toast(copied.isCopied ? `Copied ${what}` : `Could not copy ${what}`)
        } catch {
          // This surface has no clipboard to copy to.
        }
      },
    }
    const model = {
      list: await read($, turns),
      now: await read($, view),
      surface: e.surface,
      columns: e.props.bodyColumns,
      hasMonoText: e.surface !== 'terminal' && (hasMonoText ??= await hasMonoTextOn($)),
    }
    return paneTree($.ui.resolve(e), model, actions)
  })
}
