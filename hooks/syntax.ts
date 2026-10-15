// A small line-at-a-time highlighter for the diff picture: keywords,
// strings, comments, numbers and constants, function and type names. It
// knows a handful of language families by file extension and reads each
// line on its own, so a string or comment spanning lines is only guessed.

export type TokenClass = 'keyword' | 'string' | 'comment' | 'constant' | 'function' | 'type'

export type Token = { from: number; to: number; kind: TokenClass }

type Language = {
  keywords: ReadonlySet<string>
  constants: ReadonlySet<string>
  lineComments: readonly string[]
  blockComment?: readonly [string, string]
  quotes: string
  isCaseBlind?: boolean
}

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean))

// A keyword that names what the next word declares.
const NAMES_TYPE = words('class interface type struct enum trait impl union module namespace')
const NAMES_FUNCTION = words('function def func fn fun')

const C_LIKE: Language = {
  keywords: words(`abstract as async await break case catch chan char class const continue
    debugger declare default defer delete do double else enum export extends extern final finally
    float fn for from func function go goto if impl implements import in instanceof int interface is
    keyof let long loop map match mod move mut namespace new of override package private protected
    pub public range readonly return satisfies select short signed sizeof static struct super switch
    this throw throws trait try type typedef typeof union unsafe unsigned use using var virtual void
    volatile when where while with yield val fun object sealed data open lateinit`),
  constants: words('true false null nil undefined NaN Infinity None Some Ok Err self Self iota'),
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: `'"\``,
}

const PYTHON: Language = {
  keywords: words(`and as assert async await break class continue def del elif else except
    finally for from global if import in is lambda nonlocal not or pass raise return try while with
    yield match case print`),
  constants: words('True False None self cls'),
  lineComments: ['#'],
  quotes: `'"`,
}

const SHELL: Language = {
  keywords: words(`if then else elif fi for while until do done case esac function in return local
    export readonly declare source echo exit set unset shift`),
  constants: words('true false'),
  lineComments: ['#'],
  quotes: `'"\``,
}

const RUBY: Language = {
  keywords: words(`def end if elsif else unless while until for in do return class module begin
    rescue ensure require require_relative yield then case when attr_reader attr_accessor private`),
  constants: words('nil true false self'),
  lineComments: ['#'],
  quotes: `'"`,
}

const DATA: Language = {
  keywords: words(''),
  constants: words('true false null yes no on off'),
  lineComments: ['#'],
  quotes: `'"`,
}

const JSON_LIKE: Language = { ...DATA, lineComments: [] }

const CSS: Language = {
  keywords: words('import media supports keyframes font-face from to important'),
  constants: words(''),
  lineComments: [],
  blockComment: ['/*', '*/'],
  quotes: `'"`,
}

const SQL: Language = {
  keywords: words(`select from where join left right inner outer on and or not insert into values
    update set delete create table alter drop index primary key foreign references as group by
    order having limit offset distinct union all case when then else end begin commit rollback
    with returning if exists`),
  constants: words('null true false'),
  lineComments: ['--'],
  blockComment: ['/*', '*/'],
  quotes: `'"`,
  isCaseBlind: true,
}

const BY_EXTENSION: Record<string, Language> = {
  ts: C_LIKE, tsx: C_LIKE, mts: C_LIKE, cts: C_LIKE, js: C_LIKE, jsx: C_LIKE, mjs: C_LIKE, cjs: C_LIKE,
  go: C_LIKE, rs: C_LIKE, java: C_LIKE, kt: C_LIKE, kts: C_LIKE, scala: C_LIKE, swift: C_LIKE,
  c: C_LIKE, h: C_LIKE, cc: C_LIKE, cpp: C_LIKE, hpp: C_LIKE, cs: C_LIKE, dart: C_LIKE, php: C_LIKE,
  py: PYTHON, pyi: PYTHON,
  sh: SHELL, bash: SHELL, zsh: SHELL, fish: SHELL,
  rb: RUBY, rake: RUBY,
  yml: DATA, yaml: DATA, toml: DATA, ini: DATA, cfg: DATA, conf: DATA, env: DATA,
  json: JSON_LIKE, jsonc: C_LIKE, json5: C_LIKE,
  css: CSS, scss: { ...CSS, lineComments: ['//'] }, less: { ...CSS, lineComments: ['//'] },
  sql: SQL,
}

const BY_NAME: Record<string, Language> = {
  Dockerfile: SHELL, Makefile: SHELL, Gemfile: RUBY, Rakefile: RUBY, '.bashrc': SHELL, '.zshrc': SHELL,
}

export function languageOf(path: string): Language | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/#.*$/, '')
  const byName = BY_NAME[name]
  if (byName !== undefined) return byName
  const dot = name.lastIndexOf('.')
  return dot < 0 ? undefined : BY_EXTENSION[name.slice(dot + 1).toLowerCase()]
}

const isWordStart = (ch: string) => /[A-Za-z_$]/.test(ch)
const isWord = (ch: string) => /[\w$]/.test(ch)

// The tokens of one line, in order, none overlapping.
export function tokensOf(text: string, language: Language | undefined): Token[] {
  if (language === undefined) return []
  const tokens: Token[] = []
  const trimmed = text.trimStart()
  // A line inside a block comment, as most code writes one.
  if (language.blockComment !== undefined && /^(\*|\/\*|\*\/)/.test(trimmed)) {
    return [{ from: text.length - trimmed.length, to: text.length, kind: 'comment' }]
  }
  let names: TokenClass | undefined
  let at = 0
  while (at < text.length) {
    const ch = text[at]!
    const block = language.blockComment
    if (block !== undefined && text.startsWith(block[0], at)) {
      const end = text.indexOf(block[1], at + block[0].length)
      const to = end < 0 ? text.length : end + block[1].length
      tokens.push({ from: at, to, kind: 'comment' })
      at = to
      continue
    }
    if (language.lineComments.some(mark => text.startsWith(mark, at) && (mark !== '#' || at === 0 || /\s/.test(text[at - 1]!)))) {
      tokens.push({ from: at, to: text.length, kind: 'comment' })
      break
    }
    if (language.quotes.includes(ch)) {
      let to = at + 1
      while (to < text.length && text[to] !== ch) to += text[to] === '\\' ? 2 : 1
      to = Math.min(text.length, to + 1)
      tokens.push({ from: at, to, kind: 'string' })
      at = to
      continue
    }
    if (/\d/.test(ch) && (at === 0 || !isWord(text[at - 1]!))) {
      const match = /^(0[xX][\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(text.slice(at))
      const to = at + (match?.[0].length ?? 1)
      tokens.push({ from: at, to, kind: 'constant' })
      at = to
      continue
    }
    if (isWordStart(ch)) {
      let to = at + 1
      while (to < text.length && isWord(text[to]!)) to++
      const word = text.slice(at, to)
      const key = language.isCaseBlind ? word.toLowerCase() : word
      let next = to
      while (next < text.length && text[next] === ' ') next++
      if (language.keywords.has(key)) {
        tokens.push({ from: at, to, kind: 'keyword' })
        names = NAMES_TYPE.has(key) ? 'type' : NAMES_FUNCTION.has(key) ? 'function' : undefined
      } else if (language.constants.has(key)) {
        tokens.push({ from: at, to, kind: 'constant' })
        names = undefined
      } else if (names !== undefined) {
        tokens.push({ from: at, to, kind: names })
        names = undefined
      } else if (text[next] === '(') {
        tokens.push({ from: at, to, kind: 'function' })
      }
      at = to
      continue
    }
    at++
  }
  return tokens
}
