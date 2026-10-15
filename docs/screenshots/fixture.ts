// The README's images are drawn from this test: make.ts copies it into a
// copy of the mod as a test, and it prints the trees the pane and the hint
// draw for a small made-up project, one `@@TREE <name> <json>` line each.
// It isn't named *.test.ts, so `claude plugin test .` leaves it out.
import type { On } from 'claude-code'
import { describe, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PLUGIN = 'last-turn-diff'
const pane = (columns: number) =>
  ({
    plugin: PLUGIN,
    component: 'Pane',
    requestId: 'last-turn-diff',
    props: { title: 'Last turn diff', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  }) as const
const band = (columns: number) =>
  ({
    plugin: PLUGIN,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: columns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }) as const

const print = (name: string, tree: unknown) => console.log(`@@TREE ${name} ${JSON.stringify(tree)}`)

const TASK_BEFORE = `export interface Task {
  id: number
  title: string
  done: boolean
}
`
const STORE_BEFORE = `import { Task } from './task'

export class TaskStore {
  private tasks: Task[] = []
  private nextId = 1

  add(title: string): Task {
    const task = { id: this.nextId++, title, done: false }
    this.tasks.push(task)
    return task
  }

  complete(id: number) {
    const task = this.tasks.find(t => t.id === id)
    if (task) task.done = true
  }

  pending(): Task[] {
    return this.tasks.filter(t => !t.done)
  }
}
`
const STORE_AFTER = `import { Task } from './task'
import { normalizeTags } from './tags'

export class TaskStore {
  private tasks: Task[] = []
  private nextId = 1

  add(title: string, tags: string[] = []): Task {
    const task = { id: this.nextId++, title, done: false, tags: normalizeTags(tags) }
    this.tasks.push(task)
    return task
  }

  complete(id: number) {
    const task = this.tasks.find(t => t.id === id)
    if (task) task.done = true
  }

  pending(): Task[] {
    return this.tasks.filter(t => !t.done)
  }
}
`
const TAGS = `// Tags are stored trimmed, lowercase and without duplicates.
export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  for (const tag of tags) {
    const clean = tag.trim().toLowerCase()
    if (clean) seen.add(clean)
  }
  return [...seen].sort()
}
`

function world(on: On) {
  const files = new Map<string, string>([
    ['/work/src/task.ts', TASK_BEFORE],
    ['/work/src/store.ts', STORE_BEFORE],
    ['/work/README.md', '# Tasks\n\nA tiny task list.\n'],
  ])
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.messages', () => ({ value: [] }))
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
    if (e.tool === 'Edit') {
      const before = files.get(path) ?? ''
      files.set(path, before.replace(input.old_string ?? '', input.new_string ?? ''))
      return { result: { filePath: path, originalFile: before, structuredPatch: [] } }
    }
    if (e.tool === 'Write') {
      const type = files.has(path) ? 'update' : 'create'
      const before = files.get(path)
      files.set(path, input.content ?? '')
      return { result: { type, filePath: path, content: input.content, originalFile: before, structuredPatch: [] } }
    }
    return { result: 'done' }
  })
}

async function turn($: Engine, n: number, text: string, calls: () => Promise<unknown>) {
  await $.turn.start({ text, turnId: `turn-${n}` })
  await calls()
  await $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: `turn-${n}`, reason: 'answer' })
}

describe('README images', () => {
  test('draws the pane and the hint', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
    await turn($, 1, 'Mention the store in the README', () =>
      $.tool.call({ tool: 'Edit', file_path: '/work/README.md', old_string: 'A tiny task list.', new_string: 'A tiny task list with a store.' }),
    )
    await turn($, 2, 'Add tags to tasks and let the store filter by tag', async () => {
      await $.tool.call({ tool: 'Write', file_path: '/work/src/store.ts', content: STORE_AFTER })
      await $.tool.call({ tool: 'Edit', file_path: '/work/src/task.ts', old_string: '  done: boolean\n', new_string: '  done: boolean\n  tags: string[]\n' })
      await $.tool.call({ tool: 'Write', file_path: '/work/src/tags.ts', content: TAGS })
    })

    const unified = await $.ui.mount({ ...pane(100), surface: 'desktop' })
    print('pane', await unified.drawn())
    await unified.unmount()

    // Split view with the two other files folded; the terminal then opens
    // with the same choices, as a person who made them would see it.
    const split = await $.ui.mount({ ...pane(130), surface: 'desktop' })
    await split.press({ key: 'mode' })
    await split.press({ key: 'toggle-1' })
    await split.press({ key: 'toggle-2' })
    print('split', await split.drawn())
    await split.press({ key: 'mode' })
    await split.unmount()

    const terminal = await $.ui.mount({ ...pane(100), surface: 'terminal' })
    print('terminal', await terminal.drawn())
    await terminal.unmount()

    const hint = await $.ui.mount({ ...band(80), surface: 'desktop' })
    print('band', await hint.drawn())
  })
})
