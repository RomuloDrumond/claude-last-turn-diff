import type { On, SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import { unifiedHunks } from '../hooks/diff'
import { diffstat, fileIcon, squaresOf } from '../hooks/icons'
import { rowsOf, splitRowsOf, wordSpans } from '../hooks/rows'
import { diffPictures } from '../hooks/svg'
import { languageOf, tokensOf } from '../hooks/syntax'
import { titleOf } from '../hooks/turns'

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

  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.messages', () => ({ value: options.messages ?? [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
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

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

// Everything the drawing shows, no-break spaces read as spaces.
async function shown(ui: Pick<Mounted, 'findAll'>): Promise<string> {
  const all = await ui.findAll({})
  return all.map(one => one.text).join('\n').replace(/ /g, ' ')
}

// The text of an SVG picture's lines, one <text> a line, entities read.
const linesOf = (source: string) =>
  source
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<text[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

// The diff pictures a graphical surface drew, as their markup.
async function pictures(ui: Pick<Mounted, 'findAll'>): Promise<string[]> {
  return (await ui.findAll({ type: 'Svg' }))
    .filter(one => String(one.props.alt).startsWith('Diff of'))
    .map(one => String(one.props.source))
}

// The small pictures beside the text and buttons, by what they say.
async function icons(ui: Pick<Mounted, 'findAll'>): Promise<string[]> {
  return (await ui.findAll({ type: 'Svg' }))
    .map(one => String(one.props.alt))
    .filter(alt => !alt.startsWith('Diff of'))
}

// Everything the pane shows: its elements' text and its pictures' lines.
async function content(ui: Pick<Mounted, 'findAll'>): Promise<string> {
  return [await shown(ui), ...(await pictures(ui)).map(linesOf)].join('\n')
}

// The Text elements drawn on a background, by theme key.
async function marked(ui: Pick<Mounted, 'findAll'>, background: string): Promise<string[]> {
  const texts = await ui.findAll({ type: 'Text' })
  return texts.filter(one => one.props.backgroundColor === background).map(one => one.text)
}

describe('last-turn-diff', () => {
  test('the terminal shows an edit as numbered, tinted rows', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'make the answer forty-two please', () => editAnswer($))

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const text = await shown(ui)
    expect(text).toContain('T1 · make the answer forty-two please')
    expect(text).toContain('1 file changed')
    expect(text).toMatch(/ 1  1   export function answer\(\) \{/)
    expect(text).toMatch(/ 2 {4}− {3}return 1/)
    expect(text).toMatch(/ {4}2 \+ {3}return 42/)
    expect((await ui.find({ type: 'Box', key: 'card-0' }))?.text.replace(/ /g, ' ')).toMatch(/src\/answer\.ts\s*\+1 −1/)
    expect(await marked(ui, 'diffRemovedWord')).toEqual(['1'])
    expect(await marked(ui, 'diffAddedWord')).toEqual(['42'])
    expect((await ui.findAll({ type: 'Box' })).some(box => box.props.backgroundColor === 'diffAdded')).toBe(true)
    expect(await pictures(ui)).toEqual([])
  })

  test('the desktop draws an edit as a GitHub-style picture', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'make the answer forty-two please', () => editAnswer($))

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await shown(ui)).toContain('T1 · make the answer forty-two please')
    const [picture, ...rest] = await pictures(ui)
    expect(rest).toEqual([])
    expect(picture).toContain('class="rd"')
    expect(picture).toContain('class="ra"')
    expect(picture).toContain('class="wd"')
    expect(picture).toContain('class="wa"')
    expect(picture).toContain('<tspan x="')
    expect(linesOf(picture!)).toContain('  return 42')
    expect(linesOf(picture!)).toContain('export function answer() {')
    // Icons beside the title, the counts and the file, and a chevron button.
    expect(await icons(ui)).toEqual(['Prompt', '1 line added, 1 removed', 'Changed file', '1 line added, 1 removed'])
    expect((await ui.find({ type: 'Button', key: 'chevron-0' }))?.props.label).toBe('⏷')
    expect((await ui.find({ type: 'Button', key: 'refresh' }))?.props.label).toBe('↻ Refresh')
    // No hotkey badges crowd the desktop's buttons.
    expect((await ui.findAll({ type: 'Button' })).every(button => button.props.hotkey === undefined)).toBe(true)
  })

  test('the band sums the last turn and opens the pane', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'edit and create', async () => {
      await editAnswer($)
      await $.tool.call({ tool: 'Write', file_path: '/work/src/new.ts', content: 'a\nb\n' })
    })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await shown(ui)).toMatch(/Last turn changed 2 files[\s\S]*\+3[\s\S]*−1/)
      expect(await icons(ui)).toEqual(surface === 'desktop' ? ['3 added, 1 removed'] : [])
      await ui.press({ key: 'open-last-turn-diff' })
      await ui.unmount()
    }
  })

  test('a new file is marked New and numbered on one side', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'notes', () =>
      $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: '# Notes\nfirst\n' }),
    )

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Box', key: 'card-0' }))?.text.replace(/ /g, ' ')).toMatch(/notes\.md\s*\+2 −0/)
    expect(await icons(ui)).toContain('New file')
    expect(await icons(ui)).toContain('New')
    expect(linesOf((await pictures(ui))[0]!)).toContain('# Notes')
    await ui.unmount()

    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await terminal.find({ type: 'Box', key: 'card-0' }))?.text.replace(/ /g, ' ')).toMatch(/notes\.md\s*New\s*\+2 −0/)
  })

  test('a refused edit is left out', async ($, on) => {
    world(on, { deny: '/work/src/answer.ts' })
    await start($)
    await turn($, 1, 'try an edit', () => editAnswer($))

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await shown(ui)).toContain('No file edits recorded')
    expect(await icons(ui)).toEqual(['No edits yet'])
  })

  test('Older and Newer step through the turns, newest first', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'first edit', () => editAnswer($))
    await turn($, 2, 'nothing to edit', async () => {})
    await turn($, 3, 'second file', () =>
      $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: '# Notes\n' }),
    )

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await content(ui)).toContain('T3 · second file')
      expect(await content(ui)).toContain('# Notes')
      await ui.press({ key: 'prev' })
      expect(await content(ui)).toContain('T1 · first edit')
      expect(await content(ui)).toContain('  return 42')
      await ui.press({ key: 'next' })
      expect(await content(ui)).toContain('T3 · second file')
      await ui.unmount()
    }
  })

  test('the turn picker jumps to a turn', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'first edit', () => editAnswer($))
    await turn($, 2, 'second file', () =>
      $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: '# Notes\n' }),
    )

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const picker = await ui.find({ type: 'Select', key: 'turn' })
    expect(picker?.props.options).toEqual([
      { value: '0', label: 'T2 · second file · 1 file' },
      { value: '1', label: 'T1 · first edit · 1 file' },
    ])
    await ui.select({ key: 'turn', value: '1' })
    expect(await shown(ui)).toContain('T1 · first edit')
  })

  test('split view puts the old lines beside the new ones', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))

    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await terminal.press({ key: 'mode' })
    expect((await terminal.find({ type: 'Button', key: 'mode' }))?.props.label).toBe('Unified view')
    const halves = (await terminal.findAll({ type: 'Box' })).filter(box => box.props.width === '50%')
    expect(halves.length).toBe(6)
    expect(halves.map(box => box.props.backgroundColor ?? '')).toContain('diffRemoved')
    expect(halves.map(box => box.props.backgroundColor ?? '')).toContain('diffAdded')
    await terminal.unmount()

    // The choice is kept: the desktop opens split too.
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await desktop.find({ type: 'Button', key: 'mode' }))?.props.label).toBe('▤ Unified view')
    expect((await pictures(desktop))[0]).toContain('<svg x="50%" width="50%"')
  })

  test('a narrow pane draws unified and leaves out the split button', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 40 } })
    expect(await ui.find({ type: 'Button', key: 'mode' })).toBeUndefined()
    expect((await pictures(ui))[0]).not.toContain('width="50%"')
    // The card leaves its squares out; the turn's stay.
    expect(await icons(ui)).toEqual(['Prompt', '1 line added, 1 removed', 'Changed file'])
    await ui.unmount()

    // Desktop's pictures wrap each half, so a pane the terminal finds too
    // narrow still offers split view there.
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 70 } })
    expect((await desktop.find({ type: 'Button', key: 'mode' }))?.props.label).toBe('◫ Split view')
    await desktop.unmount()
    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 70 } })
    expect(await terminal.find({ type: 'Button', key: 'mode' })).toBeUndefined()
  })

  test('a file collapses and expands from its card', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await content(ui)).toContain('return 42')
    await ui.press({ key: 'toggle-0' })
    expect(await content(ui)).not.toContain('return 42')
    await ui.press({ key: 'toggle-0' })
    expect(await content(ui)).toContain('return 42')
  })

  test('Collapse all and Expand all fold every card', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'two files', async () => {
      await editAnswer($)
      await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: '# Notes\n' })
    })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Button', key: 'all' }))?.props.label).toBe('⊟ Collapse all')
    expect((await pictures(ui)).length).toBe(2)
    await ui.press({ key: 'all' })
    expect(await pictures(ui)).toEqual([])
    expect((await ui.find({ type: 'Button', key: 'all' }))?.props.label).toBe('⊞ Expand all')
    expect((await ui.find({ type: 'Button', key: 'chevron-0' }))?.props.label).toBe('⏵')
    await ui.press({ key: 'all' })
    expect(await content(ui)).toContain('return 42')
    expect(await content(ui)).toContain('# Notes')
  })

  test('Unwrap lines cuts long lines instead of wrapping them', async ($, on) => {
    world(on)
    await start($)
    const long = `export const note = '${'word '.repeat(60)}'\n`
    await turn($, 1, 'edit', () => $.tool.call({ tool: 'Write', file_path: '/work/long.ts', content: long }))

    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const codeWraps = async () =>
      (await terminal.findAll({ type: 'Text', text: /note/ }))
        .filter(one => one.props.wrap !== undefined)
        .map(one => one.props.wrap)
    expect(await codeWraps()).toEqual(['wrap'])
    await terminal.press({ key: 'wrap' })
    expect(await codeWraps()).toEqual(['truncate-end'])
    expect((await terminal.find({ type: 'Button', key: 'wrap' }))?.props.label).toBe('Wrap lines')
    await terminal.unmount()

    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(linesOf((await pictures(desktop))[0]!)).toContain('…')
    await desktop.press({ key: 'wrap' })
    expect(linesOf((await pictures(desktop))[0]!)).not.toContain('…')
  })

  // The kit has no $.ui.scroll, so the scroll to the card is checked in a session.
  test('Jump to file opens the file', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'two files', async () => {
      await editAnswer($)
      await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: '# Notes\n' })
    })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'toggle-1' })
    expect(await content(ui)).not.toContain('# Notes')
    await ui.select({ key: 'jump', value: '1' })
    expect(await content(ui)).toContain('# Notes')
  })

  test('a turn too large to draw at once shows one file at a time', async ($, on) => {
    world(on)
    await start($)
    const big = (tag: string) => Array.from({ length: 200 }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n'
    await turn($, 1, 'generate five files', async () => {
      for (const tag of ['a', 'b', 'c', 'd', 'e']) {
        await $.tool.call({ tool: 'Write', file_path: `/work/${tag}.txt`, content: big(tag) })
      }
    })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await shown(ui)).toContain("This turn's diff is too large to show at once, so it shows one file at a time")
      expect(await shown(ui)).toContain('File 1 of 5')
      expect(await ui.find({ key: 'toggle-0' })).toBeDefined()
      expect(await ui.find({ key: 'toggle-1' })).toBeUndefined()
      expect(await ui.find({ key: 'all' })).toBeUndefined()
      await ui.press({ key: 'next-file' })
      expect(await shown(ui)).toContain('File 2 of 5')
      expect(await content(ui)).toContain('b line 1')
      expect(await ui.find({ key: 'toggle-0' })).toBeUndefined()
      await ui.select({ key: 'jump', value: '4' })
      expect(await shown(ui)).toContain('File 5 of 5')
      expect(await content(ui)).toContain('e line 1')
      await ui.press({ key: 'later-4' })
      expect(await content(ui)).toContain('e line 200')
      expect(await shown(ui)).toContain('151–200 of 200 lines')
      await ui.press({ key: 'prev-file' })
      expect(await shown(ui)).toContain('File 4 of 5')
      await ui.select({ key: 'jump', value: '0' })
      await ui.unmount()
    }
  })

  test('Refresh adds the turns the transcript holds that were not recorded live', async ($, on) => {
    const messages: SessionMessage[] = []
    world(on, { messages })
    await start($)
    await turn($, 1, 'first edit', () => editAnswer($))
    messages.push(
      { role: 'user', text: 'old prompt', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'use-0',
            tool: 'Write',
            input: { file_path: '/work/old.md', content: 'old\n' },
            result: { type: 'create', filePath: '/work/old.md', content: 'old\n', structuredPatch: [] },
            text: 'ok',
          },
        ],
      },
      { role: 'user', text: 'first edit', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'use-1',
            tool: 'Edit',
            input: { file_path: '/work/src/answer.ts', old_string: '  return 1', new_string: '  return 42' },
            result: { filePath: '/work/src/answer.ts', originalFile: SOURCE, oldString: '  return 1', newString: '  return 42' },
            text: 'ok',
          },
        ],
      },
    )

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Select', key: 'turn' })).toBeUndefined()
    await ui.press({ key: 'refresh' })
    expect((await ui.find({ type: 'Select', key: 'turn' }))?.props.options).toEqual([
      { value: '0', label: 'T2 · first edit · 1 file' },
      { value: '1', label: 'T1 · old prompt · 1 file' },
    ])
    expect(await shown(ui)).toContain('T2 · first edit')
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
    await start($)

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await shown(ui)).toContain('T1 · old prompt')
    expect(await content(ui)).toContain('  return 7')
  })

  test('/clear empties the record', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))
    await $.classic.SessionStart({ source: 'clear' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await shown(ui)).toContain('No file edits recorded')
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

describe('rows', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const after = before.replace('line 10\n', 'line ten\n').replace('line 19\n', '')

  test('unchanged runs between hunks become gap rows', () => {
    const rows = rowsOf(unifiedHunks(before, after).hunks)
    expect(rows[0]).toEqual({ kind: 'gap', count: 6, from: 1 })
    expect(rows.filter(row => row.kind === 'gap')).toEqual([
      { kind: 'gap', count: 6, from: 1 },
      { kind: 'gap', count: 2, from: 14 },
    ])
    const removed = rows.find(row => row.kind === 'removed')
    expect(removed).toMatchObject({ old: 10, spans: [{ text: 'line ', isChanged: false }, { text: '10', isChanged: true }] })
  })

  test('split rows pair each removed line with its replacement', () => {
    const pairs = splitRowsOf(rowsOf(unifiedHunks(before, after).hunks)).filter(row => row.kind === 'pair')
    const changed = pairs.filter(row => row.kind === 'pair' && row.left !== row.right)
    expect(changed).toMatchObject([
      { left: { kind: 'removed', old: 10 }, right: { kind: 'added', new: 10 } },
      { left: { kind: 'removed', old: 19 } },
    ])
  })

  test('lines that share little are not marked word by word', () => {
    expect(wordSpans('const a = 1', 'const a = 2')).not.toBeNull()
    expect(wordSpans('totally different', 'nothing alike here at all')).toBeNull()
  })
})

describe('diffPictures', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const after = before.replace('line 10\n', 'line ten\n')
  const rows = rowsOf(unifiedHunks(before, after).hunks)
  const options = { width: 600, wrap: true, path: 'a.txt', digits: 2, isSplit: false, isNew: false }

  test('draws each row with its numbers, sign and tint, and a row for each gap', () => {
    const [picture, ...rest] = diffPictures(rows, options)
    expect(rest).toEqual([])
    expect(picture!.height).toBe(20 * rows.length)
    const lines = linesOf(picture!.source)
    expect(lines).toContain('⋯ 6 unchanged lines (lines 1–6)')
    expect(lines).toMatch(/\n10\n−\nline 10/)
    expect(lines).toMatch(/\n10\n\+\nline ten/)
    expect(picture!.source).toContain('width="100%"')
  })

  test('wraps a long line after a space, or cuts it with an ellipsis', () => {
    const long = rowsOf(unifiedHunks('a\n', `${'word '.repeat(80)}\n`).hunks)
    const wrapped = diffPictures(long, { ...options, width: 300 })[0]!
    const rowsDrawn = (source: string) => (source.match(/<text y=/g) ?? []).length
    expect(rowsDrawn(wrapped.source)).toBeGreaterThan(3)
    expect(linesOf(wrapped.source)).not.toMatch(/wor\nd/)
    const cut = diffPictures(long, { ...options, width: 300, wrap: false })[0]!
    expect(rowsDrawn(cut.source)).toBe(2)
    expect(linesOf(cut.source)).toContain('…')
  })

  test('split puts each side in a viewport of its own', () => {
    const source = diffPictures(splitRowsOf(rows), { ...options, isSplit: true })[0]!.source
    expect(source).toContain('<svg width="50%"')
    expect(source).toContain('<svg x="50%" width="50%"')
    expect(source).toContain('class="sep"')
  })

  test('escapes markup and replaces characters XML refuses', () => {
    const odd = rowsOf(unifiedHunks('a\n', 'if (a < b && c > d) {}\u0001\ud800\n').hunks)
    const source = diffPictures(odd, options)[0]!.source
    expect(source).toContain('&lt;')
    expect(source).toContain('&amp;&amp;')
    expect(source).not.toContain('\u0001')
    expect(source).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  test('a very long page is drawn as several pictures, each under the element limit', () => {
    const text = Array.from({ length: 1500 }, (_, i) => `const value${i} = "${'x'.repeat(60)}"`).join('\n') + '\n'
    const many = diffPictures(rowsOf(unifiedHunks('', text).hunks), { ...options, isNew: true, digits: 4 })
    expect(many.length).toBeGreaterThan(1)
    expect(many.every(one => one.source.length < 131_072)).toBe(true)
  })
})

describe('tokensOf', () => {
  const kinds = (text: string, path: string) =>
    tokensOf(text, languageOf(path)).map(token => [text.slice(token.from, token.to), token.kind])

  test('marks keywords, names, strings, numbers and comments', () => {
    expect(kinds('export function add(a: number) { return "x" + 1 } // sum', 'a.ts')).toEqual([
      ['export', 'keyword'],
      ['function', 'keyword'],
      ['add', 'function'],
      ['return', 'keyword'],
      ['"x"', 'string'],
      ['1', 'constant'],
      ['// sum', 'comment'],
    ])
    expect(kinds('class Point:  # a point', 'a.py')).toEqual([
      ['class', 'keyword'],
      ['Point', 'type'],
      ['# a point', 'comment'],
    ])
  })

  test('leaves files of no known language plain', () => {
    expect(kinds('return 1', 'notes.txt')).toEqual([])
  })
})

describe('titleOf', () => {
  test('reads a background task notification by its summary', () => {
    expect(
      titleOf('<task-notification>\n<task-id>w1</task-id>\n<status>completed</status>\n<summary>Workflow "step3a" completed</summary>\n</task-notification>'),
    ).toBe('Background task: Workflow "step3a" completed')
  })

  test('reads a slash command by its name and arguments', () => {
    expect(titleOf('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>42</command-args>')).toBe(
      '/review 42',
    )
  })
})

describe('icons', () => {
  test('the squares split five as GitHub rounds them', () => {
    expect(squaresOf(58, 4)).toEqual({ added: 5, removed: 0, none: 0 })
    expect(squaresOf(7, 3)).toEqual({ added: 4, removed: 1, none: 0 })
    expect(squaresOf(1, 1)).toEqual({ added: 1, removed: 1, none: 3 })
    expect(squaresOf(0, 0)).toEqual({ added: 0, removed: 0, none: 5 })
  })

  test('the squares and the file icon are sized SVG with light and dark colours', () => {
    const squares = diffstat(7, 3)
    expect(squares.width).toBe(48)
    expect(squares.source.match(/class="a"/g)?.length).toBe(4)
    expect(squares.source.match(/class="d"/g)?.length).toBe(1)
    expect(squares.source).toContain('prefers-color-scheme:light')
    expect(fileIcon(true).source).toContain('class="i as"')
    expect(fileIcon(false).source).toContain('class="ms"')
  })
})
