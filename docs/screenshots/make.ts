// Rebuilds the README's images in docs/images from the mod's real output.
// It copies the mod with fixture.ts as its only test, runs it to get the
// trees the pane and the hint draw, draws them as pages (render.ts) and
// photographs them with a headless Chrome.
//
//   cd docs/screenshots && bun install && bun make.ts
//
// It uses the installed Google Chrome; set CHROME_PATH to use another
// Chromium, and CLAUDE_BIN to run the tests with another claude. That claude
// must be 2.1.299 or later: older engines refuse the text the fixture draws.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { bandPage, desktopPage, terminalPage } from './render'

const repo = resolve(import.meta.dir, '../..')
const images = join(repo, 'docs/images')
const work = mkdtempSync(join(tmpdir(), 'last-turn-diff-images-'))

try {
  // The mod as it is in the working tree, uncommitted changes included,
  // without its own tests.
  const files = (await Bun.$`git -C ${repo} ls-files -co --exclude-standard`.text())
    .split('\n')
    .filter(file => file && !file.startsWith('tests/') && !file.startsWith('docs/'))
  for (const file of files) await Bun.write(join(work, file), Bun.file(join(repo, file)))
  await Bun.write(join(work, 'tests/fixture.test.ts'), Bun.file(join(import.meta.dir, 'fixture.ts')))

  const run = await Bun.$`${process.env.CLAUDE_BIN ?? 'claude'} plugin test ${work}`.nothrow().quiet()
  const output = run.stdout.toString() + run.stderr.toString()
  if (run.exitCode !== 0) throw new Error(`the fixture failed:\n${output}`)
  const trees = new Map<string, any>()
  for (const line of output.split('\n')) {
    const match = /@@TREE (\S+) (.*)$/.exec(line)
    if (match) trees.set(match[1]!, JSON.parse(match[2]!))
  }
  const tree = (name: string) => {
    if (!trees.has(name)) throw new Error(`the fixture printed no ${name} tree`)
    return trees.get(name)
  }

  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' })
  const shoot = async (html: string, name: string, theme: 'dark' | 'light') => {
    const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: theme, viewport: { width: 1600, height: 1000 } })
    await page.setContent(html)
    await page.locator('.stage').screenshot({ path: join(images, `${name}.png`), omitBackground: true })
    await page.close()
    console.log(`docs/images/${name}.png`)
  }
  for (const theme of ['dark', 'light'] as const) {
    await shoot(desktopPage(tree('pane'), theme, 100), `pane-${theme}`, theme)
    await shoot(desktopPage(tree('split'), theme, 130), `split-${theme}`, theme)
    await shoot(bandPage(tree('band'), theme), `band-${theme}`, theme)
  }
  await shoot(terminalPage(tree('terminal'), 100), 'terminal', 'dark')
  await browser.close()
} finally {
  rmSync(work, { recursive: true, force: true })
}
