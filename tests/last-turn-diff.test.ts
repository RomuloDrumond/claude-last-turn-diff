import type { On, SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { unifiedHunks } from '../hooks/diff'

const PLUGIN = 'last-turn-diff'
const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'last-turn-diff',
  props: {
    title: 'Last turn diff',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const SOURCE = ['export function answer() {', '  return 1', '}', ''].join('\n')

// A session beneath the plugin: files in memory, and Edit and Write calls
// that change them as the tools do (or are refused when `deny` names one).
function world(on: On, options: { messages?: SessionMessage[]; deny?: string } = {}) {
  const files = new Map<string, string>([['/work/src/answer.ts', SOURCE]])

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.messages', () => ({ value: options.messages ?? [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, string>
    const path = input.file_path ?? ''
    if (options.deny === path) return { deny: 'not allowed' }
    if (e.tool === 'Edit') {
      const before = files.get(path) ?? ''
      files.set(path, before.replace(input.old_string ?? '', input.new_string ?? ''))
      return { result: { filePath: path, originalFile: before, structuredPatch: [] } }
    }
    if (e.tool === 'Write') {
      const type = files.has(path) ? 'update' : 'create'
      files.set(path, input.content ?? '')
      return { result: { type, filePath: path, content: input.content, structuredPatch: [] } }
    }
    return { result: 'done' }
  })
  return files
}

async function turn($: Engine, n: number, text: string, calls: () => Promise<unknown>) {
  await $.turn.start({ text, turnId: `turn-${n}` })
  await calls()
  await $.turn.complete({
    answer: 'Done.',
    durationMs: 10,
    isAborted: false,
    turnId: `turn-${n}`,
    reason: 'answer',
  })
}

const editAnswer = ($: Engine) =>
  $.tool.call({
    tool: 'Edit',
    file_path: '/work/src/answer.ts',
    old_string: '  return 1',
    new_string: '  return 42',
  })

describe('last-turn-diff', () => {
  test('an Edit then turn.complete puts its diff in the pane', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await turn($, 1, 'make the answer forty-two please', () => editAnswer($))

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const code = await ui.find({ type: 'Code' })
      expect(code?.text).toContain('@@ -1,3 +1,3 @@')
      expect(code?.text).toContain('-  return 1')
      expect(code?.text).toContain('+  return 42')
      expect(await ui.find({ text: 'T1 · make the answer forty-two please' })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /src\/answer\.ts/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the band sums the last turn and opens the pane', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await turn($, 1, 'edit and create', async () => {
      await editAnswer($)
      await $.tool.call({ tool: 'Write', file_path: '/work/src/new.ts', content: 'a\nb\n' })
    })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /Last turn: 2 files, \+3 -1/ })).toBeDefined()
      await ui.press({ key: 'open-last-turn-diff' })
      await ui.unmount()
    }
  })

  test('a refused edit is left out', async ($, on) => {
    world(on, { deny: '/work/src/answer.ts' })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await turn($, 1, 'try an edit', () => editAnswer($))

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ text: /No file edits recorded/ })).toBeDefined()
  })

  test('Prev and Next step through the turns, newest first', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await turn($, 1, 'first edit', () => editAnswer($))
    await turn($, 2, 'nothing to edit', async () => {})
    await turn($, 3, 'second file', () =>
      $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: '# Notes\n' }),
    )

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ text: 'T3 · second file' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.text).toContain('+# Notes')
    await ui.press({ key: 'prev' })
    expect(await ui.find({ text: 'T1 · first edit' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.text).toContain('+  return 42')
    await ui.press({ key: 'next' })
    expect(await ui.find({ text: 'T3 · second file' })).toBeDefined()
  })

  test('a file collapses and expands from its row', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await turn($, 1, 'edit', () => editAnswer($))

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
    await ui.press({ key: 'toggle-0' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.press({ key: 'toggle-0' })
    expect(await ui.find({ type: 'Code' })).toBeDefined()
  })

  test('the turns are read back from the transcript at start', async ($, on) => {
    const messages: SessionMessage[] = [
      { role: 'user', text: 'old prompt', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'use-1',
            tool: 'Edit',
            input: { file_path: '/work/src/answer.ts', old_string: '  return 1', new_string: '  return 7' },
            result: {
              filePath: '/work/src/answer.ts',
              oldString: '  return 1',
              newString: '  return 7',
              originalFile: SOURCE,
              structuredPatch: [],
              replaceAll: false,
            },
            text: 'ok',
          },
        ],
      },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'use-1', text: 'ok', isError: false }] },
      { role: 'user', text: 'a later question', toolUses: [] },
      { role: 'assistant', text: 'An answer.', toolUses: [] },
    ]
    world(on, { messages })
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ text: 'T1 · old prompt' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.text).toContain('+  return 7')
  })

  test('/clear empties the record', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await turn($, 1, 'edit', () => editAnswer($))
    await $.classic.SessionStart({ source: 'clear' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ text: /No file edits recorded/ })).toBeDefined()
  })
})

describe('unifiedHunks', () => {
  test('keeps three lines of context and numbers both sides', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const after = before.replace('line 10\n', 'line ten\n').replace('line 19\n', '')
    const { hunks, added, removed } = unifiedHunks(before, after)
    expect(added).toBe(1)
    expect(removed).toBe(2)
    expect(hunks).toEqual([
      ['@@ -7,7 +7,7 @@', ' line 7', ' line 8', ' line 9', '-line 10', '+line ten', ' line 11', ' line 12', ' line 13'].join('\n'),
      ['@@ -16,5 +16,4 @@', ' line 16', ' line 17', ' line 18', '-line 19', ' line 20'].join('\n'),
    ])
  })

  test('a new file is one all-added hunk', () => {
    expect(unifiedHunks('', 'a\nb\n').hunks).toEqual(['@@ -0,0 +1,2 @@\n+a\n+b'])
  })
})
