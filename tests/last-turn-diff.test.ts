import type { On, SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'

import type { Elements } from 'claude-code'

import { unifiedHunks } from '../hooks/diff'
import { diffstat, fileIcon, squaresOf } from '../hooks/icons'
import { blocksOf, rowsIn, rowsOf, splitRowsOf, wordSpans } from '../hooks/rows'
import { sizeOf } from '../hooks/size'
import { diffPictures } from '../hooks/svg'
import { languageOf, tokensOf } from '../hooks/syntax'
import { titleOf, turnOf } from '../hooks/turns'
import { paneTree } from '../hooks/view'
import { desktopSize, desktopVerdict } from './desktop-limits'

// The test runtime's console, which the hooks' types leave out.
declare const console: { log: (...parts: unknown[]) => void }

const PLUGIN = 'last-turn-diff'
const SURFACES = ['terminal', 'desktop'] as const
// The engine the tests' sessions say they run on: Desktop draws its own text
// from 2.1.299, pictures before.
const TEXT_ENGINE = '2.1.299'
const PICTURE_ENGINE = '2.1.295'
const DESKTOP_ENGINES = [TEXT_ENGINE, PICTURE_ENGINE] as const
type DesktopEngine = (typeof DESKTOP_ENGINES)[number]
const versionOf = (engine: string) => ({ version: engine, base: engine })
const drawingOn = (engine: DesktopEngine) => (engine === TEXT_ENGINE ? 'text' : 'pictures')
// The text a pane allows itself (view.tsx), under the 100,000 characters
// the engine draws: a tree past it had its end blanked by the engine.
const MAX_TEXT = 90_000
// The figure space the gutter buttons pad their numbers with, written `_`.
const figures = (label: string) => label.replace(/_/g, '\u2007')
// What a line's code may take before it loses its colours (text.tsx).
const MAX_CODE_NODES = 24

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

type World = {
  messages?: SessionMessage[]
  deny?: string
  // What `$.session.version()` answers; null, no answer at all.
  version?: { version: string; base?: string } | null
}

// A session beneath the plugin: files in memory, and Edit and Write calls
// that change them as the tools do (or are refused when `deny` names one).
// It keeps what was copied and toasted.
function world(on: On, options: World = {}) {
  const files = new Map<string, string>([['/work/src/answer.ts', SOURCE]])
  const copied: string[] = []
  const toasts: string[] = []
  const version = options.version === undefined ? { version: TEXT_ENGINE, base: TEXT_ENGINE } : options.version

  mock.store(on)
  if (version !== null) on('session.version', () => ({ value: version }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.messages', () => ({ value: options.messages ?? [] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
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
  return { copied, toasts }
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

const write = ($: Engine, path: string, content: string) => $.tool.call({ tool: 'Write', file_path: path, content })

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

type Target = Parameters<Engine['ui']['mount']>[0]
type Drawn = Mounted<'terminal' | 'desktop'>
type Node = string | { type: string; props?: Record<string, unknown>; children?: Node[] }

// Every element of a drawn tree, depth first.
function elementsOf(tree: unknown): Exclude<Node, string>[] {
  const out: Exclude<Node, string>[] = []
  const walk = (node: Node) => {
    if (typeof node === 'string') return
    out.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree as Node)
  return out
}

// What the engine counts against the 100,000 characters of text it draws,
// blanking the rest: the strings, the labels of buttons, Selects and their
// options, and what pictures say.
function engineText(node: Node): number {
  if (typeof node === 'string') return node.length
  const props = node.props ?? {}
  const label = (value: unknown) => (typeof value === 'string' ? value.length : 0)
  const own =
    node.type === 'Button'
      ? label(props.label)
      : node.type === 'Select'
        ? ((props.options ?? []) as { label?: string }[]).reduce((sum, option) => sum + label(option.label), label(props.label))
        : node.type === 'Svg'
          ? label(props.alt)
          : 0
  return (node.children ?? []).reduce((sum, child) => sum + engineText(child), own)
}

// Mounts a drawing. On the desktop every tree it draws, after each press and
// pick too, must pass Desktop's own checks and keep its text within what the
// engine draws, with no two buttons on one key.
async function mount($: Engine, target: Target): Promise<Drawn> {
  const ui = (await $.ui.mount(target)) as Drawn
  if (target.surface !== 'desktop') return ui
  const check = async () => {
    const tree = await ui.drawn()
    expect(desktopVerdict(tree)).toMatchObject({ isAccepted: true })
    expect(engineText(tree as Node)).toBeLessThanOrEqual(MAX_TEXT)
    const keys = elementsOf(tree)
      .filter(one => one.type === 'Button')
      .map(one => String(one.props?.key))
    expect(new Set(keys).size).toBe(keys.length)
  }
  await check()
  return {
    ...ui,
    press: async pressed => {
      const answer = await ui.press(pressed)
      await check()
      return answer
    },
    select: async picked => {
      const answer = await ui.select(picked)
      await check()
      return answer
    },
  }
}

// Engine 2.1.295 refuses Text's `mono` and draws its own pane in place of
// one that holds it, so Desktop's text cannot be drawn there. The first
// refusal is noted once; the tests of the text drawing stop at their mount
// on that engine, and the tests of the pictures it draws instead still run.
let isMonoRefused = false
async function mountText($: Engine, target: Target): Promise<Drawn | undefined> {
  if (isMonoRefused) return undefined
  try {
    return await mount($, target)
  } catch (error) {
    if (!String(error).includes('"mono" is not allowed')) throw error
    isMonoRefused = true
    console.log('NOTE: this engine refuses Text `mono` (Claude Desktop 2.1.295): the desktop text tests are skipped here.')
    return undefined
  }
}

// Mounts on a surface of a session on `engine`: on the desktop, its text or
// its pictures (undefined where the text cannot be drawn, as mountText).
const mountOn = (
  $: Engine,
  surface: (typeof SURFACES)[number],
  target: Omit<Target, 'surface'> = PANE,
  engine: DesktopEngine = TEXT_ENGINE,
) =>
  surface === 'desktop' && engine === TEXT_ENGINE
    ? mountText($, { ...target, surface } as Target)
    : mount($, { ...target, surface } as Target)

// The surfaces a test of `engine` draws on: the terminal, which reads no
// version, with the first engine only.
const surfacesOn = (engine: DesktopEngine) => (engine === TEXT_ENGINE ? SURFACES : (['desktop'] as const))

// Everything the drawing shows, no-break spaces read as spaces.
async function shown(ui: Pick<Mounted, 'findAll'>): Promise<string> {
  const all = await ui.findAll({})
  return all.map(one => one.text).join('\n').replace(/\u00a0/g, ' ')
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

// The code Desktop drew as its own text, one string a line.
async function codeLines(ui: Pick<Mounted, 'findAll'>): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).filter(one => one.props.mono === true).map(one => one.text)
}

// Everything the pane shows: its elements' text and its pictures' lines.
async function content(ui: Pick<Mounted, 'findAll'>): Promise<string> {
  return [await shown(ui), ...(await pictures(ui)).map(linesOf)].join('\n')
}

// The Text elements drawn on a background, by theme key or colour.
async function marked(ui: Pick<Mounted, 'findAll'>, background: string): Promise<string[]> {
  const texts = await ui.findAll({ type: 'Text' })
  return texts.filter(one => one.props.backgroundColor === background).map(one => one.text)
}

// Where a card's page stands, from its pager: first line, last, of how many.
async function pageOf(ui: Pick<Mounted, 'findAll'>): Promise<[number, number, number] | undefined> {
  const match = /(\d+)–(\d+) of (\d+) lines/.exec(await shown(ui))
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

// Presses a card's Later lines up to its last page: the lines each page
// shows, and how many the file has.
async function pageThrough(ui: Drawn, index: number): Promise<{ counts: number[]; total: number }> {
  const counts: number[] = []
  for (let page = 0; page < 40; page++) {
    const [first, last, total] = (await pageOf(ui))!
    counts.push(last - first + 1)
    if (last === total) return { counts, total }
    await ui.press({ key: `later-${index}` })
  }
  throw new Error('more than 40 pages')
}

const sum = (counts: number[]) => counts.reduce((total, count) => total + count, 0)

// A table of numbers where an edit changes every value: each changed number
// is a coloured, marked run of its own.
function numberTable(perLine: number, lines = 300) {
  const before =
    Array.from(
      { length: lines },
      (_, r) => '  ' + Array.from({ length: perLine }, (_, c) => String(100 + 2 * ((r * perLine + c) % 400))).join(', ') + ',',
    ).join('\n') + '\n'
  return { before, after: before.replace(/\d+/g, d => String(Number(d) + 1)) }
}

describe('last-turn-diff', () => {
  test('the terminal shows an edit as numbered, tinted rows', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'make the answer forty-two please', () => editAnswer($))

    const ui = await mount($, { ...PANE, surface: 'terminal' })
    const text = await shown(ui)
    expect(text).toContain('T1 · make the answer forty-two please')
    expect(text).toContain('1 file changed')
    expect(text).toMatch(/ 1  1   export function answer\(\) \{/)
    expect(text).toMatch(/ 2 {4}− {3}return 1/)
    expect(text).toMatch(/ {4}2 \+ {3}return 42/)
    expect((await ui.find({ type: 'Box', key: 'card-0' }))?.text.replace(/\u00a0/g, ' ')).toMatch(/src\/answer\.ts\s*\+1 −1/)
    expect(await marked(ui, 'diffRemovedWord')).toEqual(['1'])
    expect(await marked(ui, 'diffAddedWord')).toEqual(['42'])
    expect((await ui.findAll({ type: 'Box' })).some(box => box.props.backgroundColor === 'diffAdded')).toBe(true)
    expect(await pictures(ui)).toEqual([])
    // The terminal's own selection copies from it: it has no copy buttons.
    expect(await ui.find({ type: 'Button', key: 'copy-0' })).toBeUndefined()
  })

  test('Desktop draws the lines as its own text, the numbers on buttons', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'make the answer forty-two please', () => editAnswer($))

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    expect(await shown(ui)).toContain('T1 · make the answer forty-two please')
    expect(await pictures(ui)).toEqual([])
    // The code alone, in the monospaced face.
    expect(await codeLines(ui)).toEqual(['export function answer() {', '  return 1', '  return 42', '}'])
    // Both numbers and the sign on a plain button: dim beside an unchanged
    // line, on the number tint beside a changed one.
    const gutter = async (key: string) => (await ui.find({ type: 'Button', key }))?.props
    expect(await gutter('ln-0-0')).toMatchObject({ plain: true, dimColor: true, label: figures('_1__1__') })
    expect(await gutter('ln-0-1')).toMatchObject({ plain: true, dimColor: false, label: figures('_2____−') })
    expect(await gutter('ln-0-2')).toMatchObject({ plain: true, dimColor: false, label: figures('____2_+') })
    const tints = (await ui.findAll({ type: 'Box' })).map(box => box.props.backgroundColor)
    expect(tints).toContain('#f8514926')
    expect(tints).toContain('#f851494d')
    expect(tints).toContain('#2ea04326')
    expect(tints).toContain('#3fb9504d')
    // The changed words marked in the text's own colour, which reads on the
    // mark in a dark theme, and the rest of the syntax in theme colours.
    expect(await marked(ui, '#f8514966')).toEqual(['1'])
    expect(await marked(ui, '#2ea04366')).toEqual(['42'])
    const marks = (await ui.findAll({ type: 'Text' })).filter(one => one.props.backgroundColor !== undefined)
    expect(marks.every(one => one.props.color === undefined)).toBe(true)
    const red = (await ui.findAll({ type: 'Text' })).filter(one => one.props.color === 'error').map(one => one.text)
    expect(red.filter(text => /^[a-z]+$/.test(text))).toEqual(['export', 'function', 'return', 'return'])
    // Icons beside the title, the counts and the file, and a chevron button.
    expect(await icons(ui)).toEqual(['Prompt', '1 line added, 1 removed', 'Changed file', '1 line added, 1 removed'])
    expect((await ui.find({ type: 'Button', key: 'chevron-0' }))?.props.label).toBe('⏷')
    expect((await ui.find({ type: 'Button', key: 'refresh' }))?.props.label).toBe('↻ Refresh')
    // A file of one hunk has a Copy diff button and no Copy hunk.
    expect((await ui.find({ type: 'Button', key: 'copy-0' }))?.props).toMatchObject({ plain: true, label: 'Copy diff' })
    const keys = elementsOf(await ui.drawn()).map(one => String(one.props?.key))
    expect(keys.filter(key => key.startsWith('hunk-'))).toEqual([])
    // No hotkey badges crowd the desktop's buttons.
    expect((await ui.findAll({ type: 'Button' })).every(button => button.props.hotkey === undefined)).toBe(true)
    // size.ts counts a drawn tree as the port of Desktop's check does.
    const tree = await ui.drawn()
    expect(sizeOf(tree)).toMatchObject({ nodes: desktopSize(tree).nodes, chars: desktopSize(tree).chars })
  })

  // The pane measures its elements before the engine sees them; the engine
  // adds what a press needs and, from 2.1.304, a `weight` to bold text.
  for (const isSplit of [false, true]) {
    test(`what the pane measures is what Desktop counts once drawn${isSplit ? ', split' : ''}`, async ($, on) => {
      world(on)
      await start($)
      const { before, after } = numberTable(19, 40)
      const path = '/work/src/table.ts'
      await turn($, 1, 'add the table', () => write($, path, before))
      await turn($, 2, 'bump the table', () => write($, path, after))

      const ui = await mountText($, { ...PANE, surface: 'desktop' })
      if (ui === undefined) return
      if (isSplit) await ui.press({ key: 'mode' })
      const drawn = await ui.drawn()
      const list = [
        turnOf(2, 'bump the table', [{ key: path, path, before, after }], '/work'),
        turnOf(1, 'add the table', [{ key: path, path, before: null, after: before }], '/work'),
      ]
      const elements = { Box: 'Box', Text: 'Text', Button: 'Button', Select: 'Select', Svg: 'Svg' } as unknown as Elements['desktop']
      const built = paneTree(
        elements,
        {
          list,
          now: { at: 0, toggled: [], pages: {}, ...(isSplit ? { mode: 'split' as const } : {}) },
          surface: 'desktop',
          columns: PANE.props.bodyColumns,
          hasMonoText: true,
        },
        { change: async () => undefined, remember: async () => {}, scrollTo: async () => {}, refresh: async () => {}, copy: async () => {} },
      )
      const added = elementsOf(drawn)
        .filter(one => one.type === 'Text' && 'weight' in (one.props ?? {}))
        .reduce((sum, one) => sum + 'weight'.length + String(one.props!.weight).length, 0)
      expect(sizeOf(built).nodes).toBe(desktopSize(drawn as never).nodes)
      expect(sizeOf(built).chars + added).toBe(desktopSize(drawn as never).chars)
      expect(sizeOf(built).text).toBe(engineText(drawn as Node))
    })
  }

  test('pressing a line number copies that line', async ($, on) => {
    const { copied, toasts } = world(on)
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    await ui.press({ key: 'ln-0-2' })
    expect(copied).toEqual(['  return 42'])
    expect(toasts).toEqual(['Copied line 2'])
    await ui.press({ key: 'ln-0-1' })
    expect(copied[1]).toBe('  return 1')
    expect(toasts[1]).toBe('Copied line 2')
    // Split, each side's button copies its own line.
    await ui.press({ key: 'mode' })
    await ui.press({ key: 'ln-0-1-old' })
    await ui.press({ key: 'ln-0-1-new' })
    expect(copied.slice(2)).toEqual(['  return 1', '  return 42'])
  })

  test('a line number copies the line as the file has it, characters drawn as U+FFFD too', async ($, on) => {
    const { copied } = world(on)
    await start($)
    await turn($, 1, 'add', () => write($, '/work/odd.txt', 'x = 1\n\f\ny = "a\u001b[0mb"\n'))

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    expect(await codeLines(ui)).toEqual(['x = 1', '\uFFFD', 'y = "a\uFFFD[0mb"'])
    await ui.press({ key: 'ln-0-1' })
    await ui.press({ key: 'ln-0-2' })
    expect(copied).toEqual(['\f', 'y = "a\u001b[0mb"'])
  })

  test('a line kept cut copies what was kept, and says so', async ($, on) => {
    const { copied, toasts } = world(on)
    await start($)
    await turn($, 1, 'add', () => write($, '/work/long.txt', `${'x'.repeat(600)}\n`))

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    await ui.press({ key: 'ln-0-0' })
    expect(copied).toEqual(['x'.repeat(400)])
    expect(toasts).toEqual(['Copied the first 400 characters of line 1'])
    await ui.press({ key: 'copy-0' })
    expect(toasts[1]).toBe('Copied the diff of long.txt, its long lines cut to their first 400 characters')
  })

  for (const engine of DESKTOP_ENGINES) {
    test(`a card's Copy diff copies its file as a unified diff (${drawingOn(engine)})`, async ($, on) => {
      const { copied, toasts } = world(on, { version: versionOf(engine) })
      await start($)
      await turn($, 1, 'edit', async () => {
        await editAnswer($)
        await write($, '/work/notes.md', '# Notes\n')
      })

      const ui = await mountOn($, 'desktop', PANE, engine)
      if (ui === undefined) return
      await ui.press({ key: 'copy-0' })
      await ui.press({ key: 'copy-1' })
      expect(copied).toEqual([
        ['--- a/src/answer.ts', '+++ b/src/answer.ts', '@@ -1,3 +1,3 @@', ' export function answer() {', '-  return 1', '+  return 42', ' }', ''].join('\n'),
        ['--- /dev/null', '+++ b/notes.md', '@@ -0,0 +1,1 @@', '+# Notes', ''].join('\n'),
      ])
      expect(toasts).toEqual(['Copied the diff of src/answer.ts', 'Copied the diff of notes.md'])
    })
  }

  test('Copy hunk copies one hunk of a file of several, unified and split', async ($, on) => {
    const { copied, toasts } = world(on)
    await start($)
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const after = before.replace('line 2\n', 'line two\n').replace('line 15\n', 'line fifteen\n')
    await turn($, 1, 'add', () => write($, '/work/list.txt', before))
    await turn($, 2, 'rename', () => write($, '/work/list.txt', after))
    const first = ['@@ -1,5 +1,5 @@', ' line 1', '-line 2', '+line two', ' line 3', ' line 4', ' line 5', ''].join('\n')
    const second = ['@@ -12,7 +12,7 @@', ' line 12', ' line 13', ' line 14', '-line 15', '+line fifteen', ' line 16', ' line 17', ' line 18', '']
      .join('\n')

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    // The first hunk starts at line 1: a row of its own leads it. The gap
    // row leads the second.
    const hunkKeys = async () =>
      elementsOf(await ui.drawn())
        .map(one => String(one.props?.key))
        .filter(key => key.startsWith('hunk-'))
    expect(await hunkKeys()).toEqual(['hunk-0-0', 'hunk-0-6'])
    expect((await ui.find({ type: 'Button', key: 'hunk-0-0' }))?.props).toMatchObject({ plain: true, label: 'Copy hunk' })
    expect((await ui.find({ type: 'Button', key: 'gap-0-6' }))?.props.label).toBe('⋯ 6 unchanged lines (lines 6–11)')
    expect((await codeLines(ui)).length).toBe(14)
    await ui.press({ key: 'hunk-0-0' })
    await ui.press({ key: 'hunk-0-6' })
    expect(copied).toEqual([first, second])
    expect(toasts).toEqual(['Copied hunk 1 of 2', 'Copied hunk 2 of 2'])

    // Split, the buttons sit on the new side, and both sides keep their rows
    // in line.
    await ui.press({ key: 'mode' })
    expect(await hunkKeys()).toEqual(['hunk-0-0', 'hunk-0-5'])
    const sides = elementsOf(await ui.drawn()).filter(one => one.type === 'Box' && one.props?.width === '50%')
    const keysIn = (side: Exclude<Node, string>) => elementsOf(side).map(one => String(one.props?.key))
    expect(keysIn(sides[0]!).filter(key => key.startsWith('hunk-'))).toEqual([])
    expect(keysIn(sides[1]!).filter(key => key.startsWith('hunk-'))).toEqual(['hunk-0-0', 'hunk-0-5'])
    // A row one line high, or a hunk's row over its first line's.
    const heights = (side: Exclude<Node, string>) =>
      (side.children as Exclude<Node, string>[]).map(row => row.props?.height ?? (row.children ?? []).length)
    expect(heights(sides[0]!)).toEqual(heights(sides[1]!))
    await ui.press({ key: 'hunk-0-5' })
    expect(copied[2]).toBe(second)
  })

  test('an emoji changed inside a line stays whole', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'add', () => write($, '/work/face.ts', "const face = '😀'\n"))
    await turn($, 2, 'smile', () => write($, '/work/face.ts', "const face = '😁'\n"))

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    expect(await codeLines(ui)).toEqual(["const face = '😀'", "const face = '😁'"])
    expect(await marked(ui, '#f8514966')).toEqual(['😀'])
    expect(await marked(ui, '#2ea04366')).toEqual(['😁'])
  })

  for (const [why, version] of [
    ['before engine 2.1.299', { version: PICTURE_ENGINE, base: PICTURE_ENGINE }],
    ['when the engine gives no version', null],
    ['when its version cannot be read', { version: 'nightly' }],
  ] as const) {
    test(`Desktop draws GitHub-style pictures ${why}`, async ($, on) => {
      world(on, { version })
      await start($)
      await turn($, 1, 'make the answer forty-two please', () => editAnswer($))

      const ui = await mount($, { ...PANE, surface: 'desktop' })
      expect(await shown(ui)).toContain('T1 · make the answer forty-two please')
      expect(await codeLines(ui)).toEqual([])
      const [picture, ...rest] = await pictures(ui)
      expect(rest).toEqual([])
      expect(picture).toContain('class="rd"')
      expect(picture).toContain('class="ra"')
      expect(picture).toContain('class="wd"')
      expect(picture).toContain('class="wa"')
      expect(picture).toContain('<tspan x="')
      expect(linesOf(picture!)).toContain('  return 42')
      expect(linesOf(picture!)).toContain('export function answer() {')
      expect(await icons(ui)).toEqual(['Prompt', '1 line added, 1 removed', 'Changed file', '1 line added, 1 removed'])
      expect((await ui.find({ type: 'Button', key: 'refresh' }))?.props.label).toBe('↻ Refresh')
    })
  }

  test("a development build's release counts as that release", async ($, on) => {
    world(on, { version: { version: '2.1.299-dev.20261001.t101500.sha1a2b3c4', base: '2.1.299-dev' } })
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    expect(await codeLines(ui)).toContain('  return 42')
  })

  test('only the text drawing names a face, size, weight or digits of its own', async ($, on) => {
    world(on, { version: { version: PICTURE_ENGINE, base: PICTURE_ENGINE } })
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))

    // The engine spells `bold` as a semibold weight; any other weight is the mod's.
    const isStyled = ({ props = {} }: Exclude<Node, string>) =>
      ['mono', 'size', 'tabular'].some(prop => prop in props) || ('weight' in props && props.bold !== true)
    for (const surface of SURFACES) {
      const ui = await mount($, { ...PANE, surface })
      expect(elementsOf(await ui.drawn()).filter(isStyled)).toEqual([])
      await ui.press({ key: 'mode' })
      expect(elementsOf(await ui.drawn()).filter(isStyled)).toEqual([])
      await ui.press({ key: 'mode' })
      await ui.unmount()
    }
  })

  test('the band sums the last turn and opens the pane', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'edit and create', async () => {
      await editAnswer($)
      await write($, '/work/src/new.ts', 'a\nb\n')
    })

    for (const surface of SURFACES) {
      const ui = await mount($, { ...BAND, surface })
      expect(await shown(ui)).toMatch(/Last turn changed 2 files[\s\S]*\+3[\s\S]*−1/)
      expect(await icons(ui)).toEqual(surface === 'desktop' ? ['3 added, 1 removed'] : [])
      await ui.press({ key: 'open-last-turn-diff' })
      await ui.unmount()
    }
  })

  test('a new file is marked New and numbered on one side', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'notes', () => write($, '/work/notes.md', '# Notes\nfirst\n'))

    const terminal = await mount($, { ...PANE, surface: 'terminal' })
    expect((await terminal.find({ type: 'Box', key: 'card-0' }))?.text.replace(/\u00a0/g, ' ')).toMatch(/notes\.md\s*New\s*\+2 −0/)
    await terminal.unmount()

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    expect((await ui.find({ type: 'Box', key: 'card-0' }))?.text.replace(/\u00a0/g, ' ')).toMatch(/notes\.md\s*\+2 −0/)
    expect(await icons(ui)).toContain('New file')
    expect(await icons(ui)).toContain('New')
    expect(await codeLines(ui)).toEqual(['# Notes', 'first'])
    expect((await ui.find({ type: 'Button', key: 'ln-0-0' }))?.props.label).toBe(figures('_1_+'))
  })

  test('a refused edit is left out', async ($, on) => {
    world(on, { deny: '/work/src/answer.ts' })
    await start($)
    await turn($, 1, 'try an edit', () => editAnswer($))

    const ui = await mount($, { ...PANE, surface: 'desktop' })
    expect(await shown(ui)).toContain('No file edits recorded')
    expect(await icons(ui)).toEqual(['No edits yet'])
  })

  test('split view puts the old lines beside the new ones', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))

    const terminal = await mount($, { ...PANE, surface: 'terminal' })
    await terminal.press({ key: 'mode' })
    expect((await terminal.find({ type: 'Button', key: 'mode' }))?.props.label).toBe('Unified view')
    const halves = (await terminal.findAll({ type: 'Box' })).filter(box => box.props.width === '50%')
    expect(halves.length).toBe(6)
    expect(halves.map(box => box.props.backgroundColor ?? '')).toContain('diffRemoved')
    expect(halves.map(box => box.props.backgroundColor ?? '')).toContain('diffAdded')
    await terminal.unmount()

    // The choice is kept: the desktop opens split too, each side a column of
    // rows one line high, each its number then its code, cut at the side's
    // edge.
    const desktop = await mountText($, { ...PANE, surface: 'desktop' })
    if (desktop === undefined) return
    expect((await desktop.find({ type: 'Button', key: 'mode' }))?.props.label).toBe('▤ Unified view')
    const sides = elementsOf(await desktop.drawn()).filter(one => one.type === 'Box' && one.props?.width === '50%')
    expect(sides.map(side => [side.props?.flexDirection, side.props?.overflow])).toEqual([
      ['column', 'hidden'],
      ['column', 'hidden'],
    ])
    const rowsIn = (side: Exclude<Node, string>) => side.children as Exclude<Node, string>[]
    expect(sides.every(side => rowsIn(side).every(row => row.props?.height === 1))).toBe(true)
    const removed = rowsIn(sides[0]!)[1]!
    expect(rowsIn(removed).map(child => child.type)).toEqual(['Box', 'Text'])
    expect(elementsOf(removed).find(one => one.type === 'Button')?.props?.key).toBe('ln-0-1-old')
    expect(await codeLines(desktop)).toEqual([
      'export function answer() {',
      '  return 1',
      '}',
      'export function answer() {',
      '  return 42',
      '}',
    ])
    const texts = (await desktop.findAll({ type: 'Text' })).filter(one => one.props.mono === true)
    expect(texts.every(one => one.props.wrap === 'truncate-end')).toBe(true)
    // Split never wraps there, so it has no Wrap button.
    expect(await desktop.find({ type: 'Button', key: 'wrap' })).toBeUndefined()
    await desktop.press({ key: 'mode' })
    expect(await desktop.find({ type: 'Button', key: 'wrap' })).toBeDefined()
  })

  test('before 2.1.299 split view puts the old picture beside the new one', async ($, on) => {
    world(on, { version: { version: PICTURE_ENGINE, base: PICTURE_ENGINE } })
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))

    const desktop = await mount($, { ...PANE, surface: 'desktop' })
    await desktop.press({ key: 'mode' })
    expect((await desktop.find({ type: 'Button', key: 'mode' }))?.props.label).toBe('▤ Unified view')
    expect((await pictures(desktop))[0]).toContain('<svg x="50%" width="50%"')
    // The pictures wrap each half, so their Wrap button stays.
    expect((await desktop.find({ type: 'Button', key: 'wrap' }))?.props.label).toBe('⇥ Unwrap lines')
  })

  test('a narrow pane draws unified and leaves out the split button', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))

    const narrow = await mountText($, { ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 40 } })
    if (narrow !== undefined) {
      expect(await narrow.find({ type: 'Button', key: 'mode' })).toBeUndefined()
      // The card leaves its squares out; the turn's stay.
      expect(await icons(narrow)).toEqual(['Prompt', '1 line added, 1 removed', 'Changed file'])
      await narrow.unmount()
      // Desktop's text cuts each side at its edge, so it needs as much room
      // as the terminal does.
      const text = await mount($, { ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 80 } })
      expect(await text.find({ type: 'Button', key: 'mode' })).toBeUndefined()
      await text.unmount()
      const wide = await mount($, { ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 90 } })
      expect((await wide.find({ type: 'Button', key: 'mode' }))?.props.label).toBe('◫ Split view')
      await wide.unmount()
    }
    const terminal = await mount($, { ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 70 } })
    expect(await terminal.find({ type: 'Button', key: 'mode' })).toBeUndefined()
  })

  test("before 2.1.299 Desktop's pictures offer split view from 64 columns", async ($, on) => {
    world(on, { version: { version: PICTURE_ENGINE, base: PICTURE_ENGINE } })
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))

    const narrow = await mount($, { ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 40 } })
    expect(await narrow.find({ type: 'Button', key: 'mode' })).toBeUndefined()
    expect((await pictures(narrow))[0]).not.toContain('width="50%"')
    await narrow.unmount()
    const desktop = await mount($, { ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 70 } })
    expect((await desktop.find({ type: 'Button', key: 'mode' }))?.props.label).toBe('◫ Split view')
  })

  test('Unwrap lines cuts long lines instead of wrapping them', async ($, on) => {
    world(on)
    await start($)
    const long = `export const note = '${'word '.repeat(60)}'\n`
    await turn($, 1, 'edit', () => write($, '/work/long.ts', long))

    const terminal = await mount($, { ...PANE, surface: 'terminal' })
    const codeWraps = async () =>
      (await terminal.findAll({ type: 'Text', text: /note/ }))
        .filter(one => one.props.wrap !== undefined)
        .map(one => one.props.wrap)
    expect(await codeWraps()).toEqual(['wrap'])
    await terminal.press({ key: 'wrap' })
    expect(await codeWraps()).toEqual(['truncate-end'])
    expect((await terminal.find({ type: 'Button', key: 'wrap' }))?.props.label).toBe('Wrap lines')
    await terminal.press({ key: 'wrap' })
    await terminal.unmount()

    const desktop = await mountText($, { ...PANE, surface: 'desktop' })
    if (desktop === undefined) return
    const line = async () => (await desktop.findAll({ type: 'Text', text: /note/ })).find(one => one.props.mono === true)
    // Wrapping is the Text's own way; cut, its row stays one line high.
    expect((await line())?.props.wrap).toBeUndefined()
    await desktop.press({ key: 'wrap' })
    expect((await line())?.props.wrap).toBe('truncate-end')
    expect((await desktop.find({ type: 'Button', key: 'wrap' }))?.props.label).toBe('↵ Wrap lines')
    const rows = (await desktop.findAll({ type: 'Box' })).filter(box => box.props.alignItems === 'stretch')
    expect(rows.every(row => row.props.height === 1 && row.props.overflow === 'hidden')).toBe(true)
    // The whole line is still there to copy.
    expect((await line())?.text).toBe(long.slice(0, -1))
  })

  test('before 2.1.299 Unwrap lines cuts the pictured lines with an ellipsis', async ($, on) => {
    world(on, { version: { version: PICTURE_ENGINE, base: PICTURE_ENGINE } })
    await start($)
    await turn($, 1, 'edit', () => write($, '/work/long.ts', `export const note = '${'word '.repeat(60)}'\n`))

    const desktop = await mount($, { ...PANE, surface: 'desktop' })
    expect(linesOf((await pictures(desktop))[0]!)).not.toContain('…')
    await desktop.press({ key: 'wrap' })
    expect(linesOf((await pictures(desktop))[0]!)).toContain('…')
  })

  test('blank lines stay lines and tabs stay tabs', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'add', () => write($, '/work/a.go', 'func a() {\n\tif x {\n\n\t\treturn 1\n\t}\n}\n'))

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    expect(await codeLines(ui)).toEqual(['func a() {', '\tif x {', '\n', '\t\treturn 1', '\t}', '}'])
    // A blank line holds a newline and wraps however the rest are drawn, so
    // a copy keeps it as an empty line.
    for (const press of [[], ['wrap']]) {
      for (const key of press) await ui.press({ key })
      const blank = (await ui.findAll({ type: 'Text' })).find(one => one.props.mono === true && one.text === '\n')
      expect(blank?.props.wrap).toBeUndefined()
    }
  })

  test('a line of control characters is drawn, not refused', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'add', () => write($, '/work/odd.txt', 'bell\u0007 escape\u001b[0m form\u000c del\u007f\n'))

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    expect(await codeLines(ui)).toEqual(['bell\uFFFD escape\uFFFD[0m form\uFFFD del\uFFFD'])
  })

  test('/clear empties the record', async ($, on) => {
    world(on)
    await start($)
    await turn($, 1, 'edit', () => editAnswer($))
    await $.classic.SessionStart({ source: 'clear' })

    const ui = await mount($, { ...PANE, surface: 'terminal' })
    expect(await shown(ui)).toContain('No file edits recorded')
  })
})

// The pane's controls, in both of Desktop's drawings (on the terminal too,
// once): Desktop's own text, which an engine that refuses `mono` cannot
// draw, and the pictures before 2.1.299.
for (const engine of DESKTOP_ENGINES) {
  describe(`the pane's controls (${drawingOn(engine)})`, () => {
    test('Older and Newer step through the turns, newest first', async ($, on) => {
      world(on, { version: versionOf(engine) })
      await start($)
      await turn($, 1, 'first edit', () => editAnswer($))
      await turn($, 2, 'nothing to edit', async () => {})
      await turn($, 3, 'second file', () => write($, '/work/notes.md', '# Notes\n'))

      for (const surface of surfacesOn(engine)) {
        const ui = await mountOn($, surface, PANE, engine)
        if (ui === undefined) continue
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
      world(on, { version: versionOf(engine) })
      await start($)
      await turn($, 1, 'first edit', () => editAnswer($))
      await turn($, 2, 'second file', () => write($, '/work/notes.md', '# Notes\n'))

      const ui = await mountOn($, 'desktop', PANE, engine)
      if (ui === undefined) return
      const picker = await ui.find({ type: 'Select', key: 'turn' })
      expect(picker?.props.options).toEqual([
        { value: '0', label: 'T2 · second file · 1 file' },
        { value: '1', label: 'T1 · first edit · 1 file' },
      ])
      await ui.select({ key: 'turn', value: '1' })
      expect(await shown(ui)).toContain('T1 · first edit')
      expect(await content(ui)).toContain('  return 42')
    })

    test('a file collapses and expands from its card', async ($, on) => {
      world(on, { version: versionOf(engine) })
      await start($)
      await turn($, 1, 'edit', () => editAnswer($))

      const ui = await mountOn($, 'desktop', PANE, engine)
      if (ui === undefined) return
      expect(await content(ui)).toContain('return 42')
      await ui.press({ key: 'toggle-0' })
      expect(await content(ui)).not.toContain('return 42')
      await ui.press({ key: 'toggle-0' })
      expect(await content(ui)).toContain('return 42')
    })

    test('Collapse all and Expand all fold every card', async ($, on) => {
      world(on, { version: versionOf(engine) })
      await start($)
      await turn($, 1, 'two files', async () => {
        await editAnswer($)
        await write($, '/work/notes.md', '# Notes\n')
      })

      const ui = await mountOn($, 'desktop', PANE, engine)
      if (ui === undefined) return
      expect((await ui.find({ type: 'Button', key: 'all' }))?.props.label).toBe('⊟ Collapse all')
      expect(await content(ui)).toContain('# Notes')
      await ui.press({ key: 'all' })
      expect(await content(ui)).not.toContain('# Notes')
      expect(await content(ui)).not.toContain('return 42')
      expect((await ui.find({ type: 'Button', key: 'all' }))?.props.label).toBe('⊞ Expand all')
      expect((await ui.find({ type: 'Button', key: 'chevron-0' }))?.props.label).toBe('⏵')
      await ui.press({ key: 'all' })
      expect(await content(ui)).toContain('return 42')
      expect(await content(ui)).toContain('# Notes')
    })

    // The kit has no $.ui.scroll, so the scroll to the card is checked in a session.
    test('Jump to file opens the file', async ($, on) => {
      world(on, { version: versionOf(engine) })
      await start($)
      await turn($, 1, 'two files', async () => {
        await editAnswer($)
        await write($, '/work/notes.md', '# Notes\n')
      })

      const ui = await mountOn($, 'desktop', PANE, engine)
      if (ui === undefined) return
      await ui.press({ key: 'toggle-1' })
      expect(await content(ui)).not.toContain('# Notes')
      await ui.select({ key: 'jump', value: '1' })
      expect(await content(ui)).toContain('# Notes')
    })

    test('a turn too large to draw at once shows one file at a time', async ($, on) => {
      world(on, { version: versionOf(engine) })
      await start($)
      const big = (tag: string) => Array.from({ length: 200 }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n'
      await turn($, 1, 'generate five files', async () => {
        for (const tag of ['a', 'b', 'c', 'd', 'e']) await write($, `/work/${tag}.txt`, big(tag))
      })

      for (const surface of surfacesOn(engine)) {
        const ui = await mountOn($, surface, PANE, engine)
        if (ui === undefined) continue
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
      world(on, { messages, version: versionOf(engine) })
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

      const ui = await mountOn($, 'desktop', PANE, engine)
      if (ui === undefined) return
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
      world(on, { messages, version: versionOf(engine) })
      await start($)

      const ui = await mountOn($, 'desktop', PANE, engine)
      if (ui === undefined) return
      expect(await shown(ui)).toContain('T1 · old prompt')
      expect(await content(ui)).toContain('  return 7')
    })
  })
}

describe("Desktop's bounds", () => {
  // Every tree these draw passes Desktop's checks (`mount`), page by page.
  for (const perLine of [19, 60]) {
    test(`a table of ${perLine} numbers a line, every one changed, pages within the bounds`, async ($, on) => {
      world(on)
      await start($)
      const { before, after } = numberTable(perLine)
      await turn($, 1, 'add', () => write($, '/work/src/table.ts', before))
      await turn($, 2, 'bump', () => write($, '/work/src/table.ts', after))

      const ui = await mountText($, { ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 130 } })
      if (ui === undefined) return
      // Past the cap a line drops its colours, then marks its changes as one.
      const codes = elementsOf(await ui.drawn()).filter(one => one.props?.mono === true)
      expect(codes.length).toBeGreaterThan(0)
      expect(codes.every(one => desktopSize(one as never).nodes <= MAX_CODE_NODES)).toBe(true)
      const unified = await pageThrough(ui, 0)
      expect(sum(unified.counts)).toBe(unified.total)
      expect(Math.min(...unified.counts.slice(0, -1))).toBeGreaterThanOrEqual(100)
      await ui.press({ key: 'mode' })
      const split = await pageThrough(ui, 0)
      expect(sum(split.counts)).toBe(split.total)
      expect(Math.min(...split.counts.slice(0, -1))).toBeGreaterThanOrEqual(50)
    })
  }

  test('a lone dense file still draws, a page at a time', async ($, on) => {
    world(on)
    await start($)
    const { before, after } = numberTable(60)
    await turn($, 1, 'add', () => write($, '/work/src/table.ts', before))
    await turn($, 2, 'bump', () => write($, '/work/src/table.ts', after))

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    expect(await shown(ui)).not.toContain('too large to draw here')
    expect(await shown(ui)).not.toContain('collapse another file')
    expect((await codeLines(ui)).length).toBeGreaterThan(50)
  })

  test('a 300-line file, unified and split, a page at a time', async ($, on) => {
    world(on)
    await start($)
    // Every third line renamed: the rows are pairs of changed lines between
    // unchanged ones.
    const lines = (isRenamed: (k: number) => boolean) =>
      Array.from(
        { length: 300 },
        (_, k) => `  const value${k} = ${isRenamed(k) ? 'computeFast' : 'compute'}(${k}, "item-${k}") // note ${k}`,
      ).join('\n') + '\n'
    await turn($, 1, 'add', () => write($, '/work/src/values.ts', lines(() => false)))
    await turn($, 2, 'rename', () => write($, '/work/src/values.ts', lines(k => k % 3 === 0)))

    const ui = await mountText($, { ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 130 } })
    if (ui === undefined) return
    // A line this plain keeps its colours and marks under the cap.
    expect(await marked(ui, '#2ea04366')).toContain('computeFast')
    expect((await ui.findAll({ type: 'Text' })).some(one => one.props.color === 'inactive')).toBe(true)
    const unified = await pageThrough(ui, 0)
    expect(sum(unified.counts)).toBe(unified.total)
    expect(unified.counts.length).toBeGreaterThan(2)
    await ui.press({ key: 'mode' })
    const split = await pageThrough(ui, 0)
    expect(sum(split.counts)).toBe(split.total)
    expect(split.counts.length).toBeGreaterThan(unified.counts.length)
    await ui.press({ key: 'earlier-0' })
    expect((await pageOf(ui))![1]).toBeLessThan(split.total)
  })

  test('a minified line is drawn whole, cut or wrapped', async ($, on) => {
    world(on)
    await start($)
    const minified = `var a={${Array.from({ length: 500 }, (_, k) => `k${k}:${k}`).join(',')}};\n`
    await turn($, 1, 'add', () => write($, '/work/app.min.js', minified.repeat(3)))

    const ui = await mountText($, { ...PANE, surface: 'desktop' })
    if (ui === undefined) return
    const lines = await codeLines(ui)
    expect(lines.length).toBe(3)
    expect(lines.every(line => line.length >= 400 && minified.startsWith(line.slice(0, 400)))).toBe(true)
    await ui.press({ key: 'wrap' })
    expect((await codeLines(ui)).length).toBe(3)
  })

  for (const engine of DESKTOP_ENGINES) {
    test(`a turn of 70 files lists at most 64 of them to jump to (${drawingOn(engine)})`, async ($, on) => {
      world(on, { version: versionOf(engine) })
      await start($)
      await turn($, 1, 'scaffold', async () => {
        for (let k = 0; k < 70; k++) await write($, `/work/files/f${k}.txt`, `file ${k}\n`)
      })

      for (const surface of surfacesOn(engine)) {
        const ui = await mountOn($, surface, PANE, engine)
        if (ui === undefined) continue
        const options = async () =>
          ((await ui.find({ type: 'Select', key: 'jump' }))?.props.options as { value: string }[]).map(one => Number(one.value))
        expect(await shown(ui)).toContain('File 1 of 70')
        expect(await options()).toEqual(Array.from({ length: 64 }, (_, k) => k))
        await ui.select({ key: 'jump', value: '40' })
        expect(await shown(ui)).toContain('File 41 of 70')
        expect(await options()).toEqual(Array.from({ length: 64 }, (_, k) => k + 6))
        expect((await ui.find({ type: 'Select', key: 'jump' }))?.props.value).toBe('40')
        await ui.press({ key: 'next-file' })
        expect(await content(ui)).toContain('file 41')
        await ui.select({ key: 'jump', value: '9' })
        await ui.select({ key: 'jump', value: '0' })
        await ui.unmount()
      }
    })

    // The jump list's labels, the turn picker and the card's path count
    // against the text the engine draws, before the lines: past it, the
    // engine would blank the page's last lines and its pager.
    test(`long paths in a 70-file turn leave a page room to draw (${drawingOn(engine)})`, async ($, on) => {
      world(on, { version: versionOf(engine) })
      await start($)
      const folder = `/work/${'a-rather-long-folder-name/'.repeat(30)}`
      const { before, after } = numberTable(80, 150)
      await turn($, 1, 'add the data', () => write($, `${folder}data.ts`, before))
      await turn($, 2, 'bump the data and scaffold', async () => {
        await write($, `${folder}data.ts`, after)
        for (let k = 1; k < 70; k++) await write($, `${folder}f${k}.txt`, `file ${k}\n`)
      })

      const ui = await mountOn($, 'desktop', { ...PANE, props: { ...PANE.props, bodyColumns: 130 } }, engine)
      if (ui === undefined) return
      const labels = ((await ui.find({ type: 'Select', key: 'jump' }))?.props.options as { label: string }[]).map(one => one.label)
      expect(labels.every(label => label.startsWith('…') && label.length < 100)).toBe(true)
      for (const press of [[], ['mode']]) {
        for (const key of press) await ui.press({ key })
        expect(await shown(ui)).not.toContain('too large to draw here')
        const { counts, total } = await pageThrough(ui, 0)
        expect(sum(counts)).toBe(total)
        expect((await ui.findAll({ type: 'Button' })).every(one => one.props.label !== '')).toBe(true)
      }
    })
  }

  test('before 2.1.299 two dense files show one at a time, each a page at a time', async ($, on) => {
    world(on, { version: versionOf(PICTURE_ENGINE) })
    await start($)
    const tables = ['a', 'b'].map(name => ({ path: `/work/src/${name}.ts`, ...numberTable(60, 100) }))
    await turn($, 1, 'add', async () => {
      for (const { path, before } of tables) await write($, path, before)
    })
    await turn($, 2, 'bump', async () => {
      for (const { path, after } of tables) await write($, path, after)
    })

    const ui = await mount($, { ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 130 } })
    expect(await shown(ui)).toContain("This turn's diff is too large to show at once, so it shows one file at a time")
    for (const index of [0, 1]) {
      expect(await shown(ui)).toContain(`File ${index + 1} of 2`)
      const { counts, total } = await pageThrough(ui, index)
      expect(sum(counts)).toBe(total)
      expect(counts.length).toBeGreaterThan(1)
      await ui.press({ key: 'next-file' })
    }
  })

  test('before 2.1.299 a page of pictures stays within the bounds', async ($, on) => {
    world(on, { version: { version: PICTURE_ENGINE, base: PICTURE_ENGINE } })
    await start($)
    const { before, after } = numberTable(60)
    await turn($, 1, 'add', () => write($, '/work/src/table.ts', before))
    await turn($, 2, 'bump', () => write($, '/work/src/table.ts', after))

    const ui = await mount($, { ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 130 } })
    expect((await pictures(ui)).every(source => source.length < 131_072)).toBe(true)
    expect((await ui.findAll({ type: 'Svg' })).every(one => Number(one.props.height ?? 0) <= 4096)).toBe(true)
    expect(await shown(ui)).not.toContain('too large to draw here')
    const unified = await pageThrough(ui, 0)
    expect(sum(unified.counts)).toBe(unified.total)
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

  test('a long hunk stored in parts is one block, its lines still paired', () => {
    const many = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`)
    const { hunks } = unifiedHunks(many.join('\n') + '\n', many.map(line => `${line}!`).join('\n') + '\n')
    expect(hunks.length).toBe(3)
    const blocks = blocksOf(hunks)
    expect(blocks.length).toBe(1)
    expect(blocks[0]!.text).toBe(hunks.join('\n'))
    const added = rowsIn(blocks).filter(row => row.kind === 'added')
    expect(added.length).toBe(300)
    for (const row of added) {
      expect(row.kind === 'added' && row.spans).toEqual([
        { text: `line ${row.kind === 'added' ? row.new : 0}`, isChanged: false },
        { text: '!', isChanged: true },
      ])
    }
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

  test('escapes markup and replaces characters XML or the engine refuses', () => {
    const odd = rowsOf(unifiedHunks('a\n', 'if (a < b && c > d) {}\u0001\u0085\ud800\n').hunks)
    const source = diffPictures(odd, options)[0]!.source
    expect(source).toContain('&lt;')
    expect(source).toContain('&amp;&amp;')
    expect(source).not.toContain('\u0001')
    expect(source).not.toContain('\u0085')
    expect(source).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  test('a very long page is drawn as several pictures, each under the element limits', () => {
    const text = Array.from({ length: 1500 }, (_, i) => `const value${i} = "${'x'.repeat(60)}"`).join('\n') + '\n'
    const many = diffPictures(rowsOf(unifiedHunks('', text).hunks), { ...options, isNew: true, digits: 4 })
    expect(many.length).toBeGreaterThan(1)
    expect(many.every(one => one.source.length < 131_072 && one.height <= 4096)).toBe(true)
  })

  test('a page of wrapped lines starts a new picture before 4,096 pixels', () => {
    const text = Array.from({ length: 150 }, (_, i) => `${i} ${'word '.repeat(40)}`).join('\n') + '\n'
    const tall = diffPictures(rowsOf(unifiedHunks('', text).hunks), { ...options, width: 300, isNew: true, digits: 3 })
    expect(tall.length).toBeGreaterThan(1)
    expect(tall.every(one => one.height <= 4096)).toBe(true)
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
