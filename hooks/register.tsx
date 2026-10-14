// last-turn-diff: records the file edits Claude makes in each turn from its
// own Edit, Write and NotebookEdit calls (no git), and shows them per turn in
// a pane, with a one-line hint above the prompt after a turn that edited.
//
// The idea of recording edits at tool.call and replaying them in a pane comes
// from Anthropic's replay-theater sample mod (Apache-2.0); no code is copied.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResultOf } from 'claude-code'

import type { BandHint, DiffMode, TurnDiff } from '../types'
import { MODE_KEY, NEWEST } from './state'
import { EDIT_TOOLS, MAX_TEXT_CHARS, stepOf, turnOf, turnsFromMessages } from './turns'
import type { Step } from './turns'
import { paneOf, plural } from './view'

const PANE = 'last-turn-diff'
const TITLE = 'Last turn diff'
// How many turns with edits are kept.
const KEEP_TURNS = 30

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

async function readText($: $, path: string): Promise<string | null | undefined> {
  try {
    if (!(await $.fs.exists(path))) return null
    const text = await $.fs.read(path)
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS + 1) : text
  } catch {
    return undefined
  }
}

// Back to the newest turn, keeping the unified or split choice.
const toNewest = ($: $) => update($, view, was => ({ ...NEWEST, ...(was.mode ? { mode: was.mode } : {}) }))

async function openPane($: $) {
  await toNewest($)
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
  await toNewest($)
  const newest = found[0]
  await update($, band, () => (newest !== undefined && newest.n === count ? hintOf(newest) : null))
}

async function reset($: $) {
  await update($, turns, () => [])
  await update($, turnNo, () => 0)
  await toNewest($)
  await update($, band, () => null)
}

async function restoreMode($: $) {
  try {
    const kept = await $.store.get(MODE_KEY)
    if (kept === 'unified' || kept === 'split') {
      const mode: DiffMode = kept
      await update($, view, was => ({ ...was, mode }))
    }
  } catch {
    // No store here: the pane opens unified.
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

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'lastturn',
      description: 'Show the file edits Claude made in the last turn, with earlier turns a step away',
      immediate: true,
    })
    await restoreMode($)
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
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        <Text wrap="truncate-end">
          <Text dimColor>Last turn changed {plural(hint.files, 'file')}</Text>{'  '}
          <Text color="success">+{hint.added}</Text> <Text color="error">−{hint.removed}</Text>
        </Text>
        <Button key="open-last-turn-diff" label="View changes" hotkey="d" onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => paneOf($, e))
}
