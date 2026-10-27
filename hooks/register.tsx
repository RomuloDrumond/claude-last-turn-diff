// last-turn-diff: records the file edits Claude makes in each turn from its
// own Edit, Write and NotebookEdit calls (no git), and shows them per turn in
// a pane, with a one-line hint above the prompt after a turn that edited.
//
// The idea of recording edits at tool.call and replaying them in a pane comes
// from Anthropic's replay-theater sample mod (Apache-2.0); no code is copied.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResultOf } from 'claude-code'

import type { BandHint, DiffMode, TurnDiff } from '../types'
import { diffstat } from './icons'
import { plural } from './rows'
import { MODE_KEY, NEWEST, WRAP_KEY } from './state'
import { EDIT_TOOLS, MAX_TEXT_CHARS, stepOf, turnOf, turnsFromMessages } from './turns'
import type { Step } from './turns'
import { PANE, paneTree } from './view'
import type { PaneActions } from './view'

const TITLE = 'Last turn diff'
// How many turns with edits are kept.
const KEEP_TURNS = 30
// The first engine whose Text takes `mono`. Claude Desktop draws the diff as
// its own text from there; 2.1.295 refuses the prop, and one refused prop
// replaces the whole pane with the engine's own.
const MONO_TEXT_SINCE = [2, 1, 299] as const

type $ = EngineInterface

const turns = atom({ plugin: 'last-turn-diff', key: 'turns' } as const, [])
const view = atom({ plugin: 'last-turn-diff', key: 'view' } as const, NEWEST)
const band = atom({ plugin: 'last-turn-diff', key: 'band' } as const, null)
const turnNo = atom({ plugin: 'last-turn-diff', key: 'turnNo' } as const, 0)

async function cwdOf($: $): Promise<string> {
  try {
    return await $.session.cwd()
  } catch {
    return ''
  }
}

// Whether this engine's Text takes `mono`, from the release it is built
// from. An engine that cannot say, or says it in a way this cannot read,
// draws the diff as pictures.
async function hasMonoTextOn($: $): Promise<boolean> {
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

async function readText($: $, path: string): Promise<string | null | undefined> {
  try {
    if (!(await $.fs.exists(path))) return null
    const text = await $.fs.read(path)
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS + 1) : text
  } catch {
    return undefined
  }
}

// Back to the newest turn, keeping the person's display choices.
const toNewest = ($: $) =>
  update($, view, was => ({
    ...NEWEST,
    ...(was.mode !== undefined ? { mode: was.mode } : {}),
    ...(was.wrap !== undefined ? { wrap: was.wrap } : {}),
  }))

async function openPane($: $) {
  await toNewest($)
  return $.ui.open({ id: PANE, title: TITLE, focus: true })
}

async function fromTranscript($: $) {
  try {
    return turnsFromMessages(await $.session.messages(), await cwdOf($), KEEP_TURNS)
  } catch {
    return undefined
  }
}

// Rebuilds the turns from the transcript: after a reload, /resume or a fork.
async function rebuild($: $) {
  const transcript = await fromTranscript($)
  if (transcript === undefined) return
  const { turns: found, count } = transcript
  await update($, turns, () => found)
  await update($, turnNo, () => count)
  await toNewest($)
  const newest = found[0]
  await update($, band, () => (newest !== undefined && newest.n === count ? hintOf(newest) : null))
}

// The same turn read twice: the same files, and the same number or title
// (a title from an older version of the mod may read differently).
const sameTurn = (a: TurnDiff, b: TurnDiff) =>
  (a.n === b.n || a.title === b.title) &&
  a.files.map(file => file.key).join('\n') === b.files.map(file => file.key).join('\n')

// The pane's Refresh: reads the transcript again and adds the turns it holds
// that were not recorded live (before the mod loaded, or lost to a reload).
// A turn recorded live is kept as recorded: it has its subagents' edits too.
async function refresh($: $) {
  const transcript = await fromTranscript($)
  if (transcript === undefined) return
  const live = await read($, turns)
  const shown = live[(await read($, view)).at]
  const matched = new Set<TurnDiff>()
  const found = transcript.turns.map(turn => {
    const free = live.filter(one => !matched.has(one) && sameTurn(one, turn))
    const hit = free.find(one => one.n === turn.n) ?? free[0]
    if (hit === undefined) return turn
    matched.add(hit)
    return { ...hit, n: turn.n }
  })
  const onlyLive = live.filter(one => !matched.has(one))
  const merged = [...found, ...onlyLive].sort((a, b) => b.n - a.n).slice(0, KEEP_TURNS)
  await update($, turns, () => merged)
  await update($, turnNo, count => Math.max(count, transcript.count))
  const at = shown === undefined ? 0 : Math.max(0, merged.findIndex(turn => turn.n === shown.n && turn.title === shown.title))
  await update($, view, was => ({ ...was, at }))
  try {
    $.ui.toast(`Refreshed: ${plural(merged.length, 'turn')} with edits`)
  } catch {
    // The redraw shows it.
  }
}

async function reset($: $) {
  await update($, turns, () => [])
  await update($, turnNo, () => 0)
  await toNewest($)
  await update($, band, () => null)
}

// The person's unified or split and wrap choices, kept across sessions.
async function restoreChoices($: $) {
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
  // Whether Desktop's Text takes `mono` here, read once the pane first draws
  // on Desktop; the engine does not change while the module is loaded.
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
          : `T${newest.n}: ${plural(newest.files.length, 'file')} changed, +${newest.added} -${newest.removed}`,
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
    await toNewest($)
    await update($, band, () => hintOf(turn))
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
            alt={`${hint.added} added, ${hint.removed} removed`}
            source={squares.source}
            width={squares.width}
            height={squares.height}
          />
        )}
        <Button key="open-last-turn-diff" label="View changes" hotkey="d" onPress={() => void openPane($)} />
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
      refresh: () => refresh($),
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
      hasMonoText: e.surface === 'desktop' && (hasMonoText ??= await hasMonoTextOn($)),
    }
    return paneTree($.ui.resolve(e), model, actions)
  })
}
