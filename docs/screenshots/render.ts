// Draws a tree the pane or the hint drew as an HTML page styled like Claude
// Desktop's Code tab or like a terminal. On Desktop each element becomes the
// HTML Desktop's renderer makes of it (a transcription of its mapping:
// Box widths in columns and heights in lines, Text's monospaced face and
// its wrapping or cut, a Button's label alone, theme keys as Desktop's own
// light and dark colours); the icons are the mod's own SVGs. The frame and
// the fonts only imitate the app: its own faces are not ours to ship.
export type El = string | { type: string; props: Record<string, any>; children?: El[] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const uri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const attr = (s: string) => esc(s).replace(/"/g, '&quot;')

// The theme keys Desktop maps to its colours, as page variables.
const THEME_VARS: Record<string, string> = {
  text: 'text', inactive: 'secondary', subtle: 'muted', error: 'danger', success: 'success', warning: 'warning',
  claude: 'brand', permission: 'accent', suggestion: 'accent', remember: 'accent', ide: 'accent', autoAccept: 'pro',
  merged: 'merged', planMode: 'success',
}
const ANSI: Record<string, string> = {
  black: '#000000', red: '#e5484d', green: '#46a758', yellow: '#f5d90a', blue: '#3e63dd', magenta: '#d6409f',
  cyan: '#05a2c2', white: '#ffffff', gray: '#8b8d98', grey: '#8b8d98',
}
const colorOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  if (THEME_VARS[value]) return `var(--${THEME_VARS[value]})`
  if (ANSI[value.replace(/^ansi:/, '')]) return ANSI[value.replace(/^ansi:/, '')]
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) || /^(?:rgb|hsl)a?\([\d\s.,%/]+\)$/i.test(value) ? value : undefined
}
const mix = (color: string) => `color-mix(in srgb,${color} 60%,transparent)`
const one = (name: string, value: unknown) => (value === undefined ? [] : [`${name}:${value}`])
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
// A length across in columns, or down in half lines.
const across = (value: unknown) => (number(value) === undefined ? undefined : `${value}ch`)
const down = (value: unknown) => (number(value) === undefined ? undefined : `calc(${value} * .5lh)`)
const size = (value: unknown, unit: string) =>
  number(value) !== undefined ? `${value}${unit}` : typeof value === 'string' && /^\d+(?:\.\d+)?%$/.test(value) ? value : undefined

function boxStyle(p: Record<string, any>): string {
  const isBordered = typeof p.borderStyle === 'string' && p.borderStyle !== ''
  return [
    'display:flex',
    'box-sizing:border-box',
    `flex-direction:${p.flexDirection ?? 'row'}`,
    ...one('flex-grow', number(p.flexGrow)),
    ...one('flex-shrink', number(p.flexShrink)),
    ...one('flex-wrap', p.flexWrap),
    ...one('align-items', p.alignItems),
    ...one('align-self', p.alignSelf),
    ...one('justify-content', p.justifyContent),
    ...(p.gap === undefined ? [] : [`gap:${down(p.gap)} ${across(p.gap)}`]),
    ...one('width', size(p.width, 'ch')),
    ...one('height', size(p.height, 'lh')),
    ...one('min-width', size(p.minWidth, 'ch')),
    ...one('min-height', size(p.minHeight, 'lh')),
    ...(isBordered ? ['padding:8px 12px'] : []),
    ...(p.padding === undefined ? [] : [`padding:${down(p.padding)} ${across(p.padding)}`]),
    ...one('padding-top', down(p.paddingTop ?? p.paddingY)),
    ...one('padding-bottom', down(p.paddingBottom ?? p.paddingY)),
    ...one('padding-left', across(p.paddingLeft ?? p.paddingX)),
    ...one('padding-right', across(p.paddingRight ?? p.paddingX)),
    ...(isBordered
      ? ['border:1px solid var(--border)', 'border-radius:calc(6px + .25rem)', ...(p.borderDimColor ? [`border-color:${mix('var(--border)')}`] : [])]
      : []),
    ...one('background-color', colorOf(p.backgroundColor)),
    ...one('overflow', p.overflow),
    ...(p.display === 'none' ? ['display:none'] : []),
  ].join(';')
}

function textStyle(p: Record<string, any>, kids: El[]): string {
  const color = colorOf(p.color)
  const isWrapping = p.wrap === undefined || p.wrap === 'wrap'
  const strings = kids.every(kid => typeof kid === 'string') ? (kids as string[]).join('').trim() : undefined
  // How Desktop keeps a short word, or every word of a text, from breaking.
  const words =
    strings !== undefined && strings !== '' && strings.length <= 24 && !/\s/u.test(strings)
      ? ['overflow-wrap:break-word', 'white-space:pre']
      : kids.every(kid => typeof kid !== 'string' || kid.split(/[\s­-]+/u).every(word => word.length <= 24))
        ? ['overflow-wrap:break-word']
        : []
  return [
    ...one('color', p.dimColor ? (color === undefined ? 'var(--engine-dim-ink,var(--secondary))' : mix(color)) : color),
    ...(color === undefined ? [] : [`--engine-dim-ink:${mix(color)}`]),
    ...one('background-color', colorOf(p.backgroundColor)),
    ...(p.weight === 'semibold' || p.weight === 'bold' || p.bold ? ['font-weight:600'] : []),
    ...(p.mono ? ['font-family:var(--mono)'] : []),
    ...(p.italic ? ['font-style:italic'] : []),
    ...(isWrapping
      ? ['white-space:pre-wrap', 'overflow-wrap:anywhere', ...words]
      : ['display:inline-block', 'max-width:100%', 'white-space:pre', 'overflow:hidden', 'text-overflow:ellipsis', 'min-width:0']),
  ].join(';')
}

const CARET = `<svg data-select-caret viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

function desktop(e: El): string {
  if (typeof e === 'string') return esc(e)
  const p = e.props ?? {}
  const kids = e.children ?? []
  switch (e.type) {
    case 'Box': {
      // A row Box that names no alignment centres its text and buttons.
      const isRow = (p.flexDirection ?? 'row').startsWith('row') && p.alignItems === undefined
      return `<div${isRow ? ' data-engine-row' : ''} style="${boxStyle(p)}">${kids.map(desktop).join('')}</div>`
    }
    case 'Text':
      return `<span style="${textStyle(p, kids)}">${kids.map(desktop).join('')}</span>`
    case 'Button': {
      const cue = p.hotkey ? `<span data-press-cue>${esc(String(p.hotkey).toUpperCase())}</span>` : ''
      return `<button${p.plain ? ' data-press-plain' : ''}${p.dimColor ? ' data-press-dim' : ''}><span data-press-label>${esc(p.label ?? '')}</span>${cue}</button>`
    }
    case 'Select': {
      const shown = (p.options ?? []).find((o: any) => o.value === p.value) ?? p.options?.[0]
      const caption = p.label ? `<span data-engine-caption>${esc(p.label)}</span>` : ''
      return `<span data-engine-select-field>${caption}<button data-engine-select><span data-select-value>${esc(shown?.label ?? shown?.value ?? '')}</span>${CARET}</button></span>`
    }
    case 'Svg':
      return `<img alt="${attr(p.alt)}" src="${uri(p.source)}" style="display:block;max-width:100%;border:0;${p.width ? `width:${p.width}px` : 'width:100%'};height:${p.height}px">`
    default:
      return kids.map(desktop).join('')
  }
}

// The terminal: each element as text in a monospaced grid.
function terminal(e: El): string {
  if (typeof e === 'string') return esc(e)
  const p = e.props ?? {}
  const kids = (e.children ?? []).map(terminal).join('')
  const bg = (v?: string) => (v ? `background:var(--${v}, ${v})` : '')
  switch (e.type) {
    case 'Box': {
      const s: string[] = ['display:flex', `flex-direction:${p.flexDirection ?? 'row'}`]
      if (p.gap) s.push(p.flexDirection === 'column' ? `row-gap:${p.gap}lh` : `column-gap:${p.gap}ch`)
      if (p.alignItems) s.push(`align-items:${p.alignItems}`)
      if (p.justifyContent) s.push(`justify-content:${p.justifyContent}`)
      if (p.flexWrap) s.push(`flex-wrap:${p.flexWrap}`)
      if (p.flexShrink !== undefined) s.push(`flex-shrink:${p.flexShrink}`)
      if (p.width) s.push(`width:${p.width}`)
      if (p.flexGrow) s.push(`flex-grow:${p.flexGrow}`)
      if (p.backgroundColor) s.push(bg(p.backgroundColor))
      if (p.paddingX) s.push(`padding:0 ${p.paddingX}ch`)
      return `<div class="${p.borderStyle ? 'tcard' : ''}" style="${s.join(';')}">${kids}</div>`
    }
    case 'Text': {
      const c: string[] = []
      if (p.bold) c.push('b')
      if (p.dimColor) c.push('dim')
      if (p.color) c.push(p.color)
      if (p.wrap === 'truncate-end') c.push('trunc')
      return `<span class="${c.join(' ')}" style="${bg(p.backgroundColor)}">${kids}</span>`
    }
    case 'Button':
      return p.plain
        ? `<span>${kids || esc(p.label)}</span>`
        : `<span class="tbtn">[ ${esc(p.label)}${p.hotkey ? ` <span class="dim">${p.hotkey}</span>` : ''} ]</span>`
    case 'Select':
      return `<span class="tbtn">${p.label ? `${esc(p.label)} ` : ''}‹ ${esc((p.options ?? []).find((o: any) => o.value === p.value)?.label ?? '')} ›</span>`
    default:
      return kids
  }
}

// Desktop's own colours, light and dark, around the frame the page draws.
const THEMES = {
  dark: `--page:#1f1e1d;--pane:#151515;--text:#f0efec;--secondary:#c3c2b7;--muted:#898781;--border:rgb(255 255 255/.1);--danger:#ec7e7e;--success:#0ca30c;--warning:#db9300;--accent:#6da7ec;--pro:#a096eb;--brand:#c6613f;--merged:#b796ff;--fill:rgb(255 255 255/.1);--ring:transparent;--field:rgb(255 255 255/.05);--field-ring:rgb(255 255 255/.1);--shadow:0 24px 60px rgba(0,0,0,.45)`,
  light: `--page:#f5f4ed;--pane:#fcfcfb;--text:#0b0b0b;--secondary:#52514e;--muted:#898781;--border:rgb(11 11 11/.1);--danger:#8e2626;--success:#006300;--warning:#734500;--accent:#184f95;--pro:#4a3aa7;--brand:#c6613f;--merged:#8e6bd9;--fill:rgb(255 255 255/.1);--ring:rgb(11 11 11/.1);--field:rgb(255 255 255/.5);--field-ring:rgb(11 11 11/.1);--shadow:0 24px 60px rgba(60,50,30,.18)`,
}

// The faces Desktop asks for, its own first, then what this machine has.
const FACES = `--sans:"anthropic-sans",-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;--mono:"anthropic-mono","SF Mono",ui-monospace,Menlo,Consolas,monospace`

// Desktop's stylesheet for what it draws: body text, buttons, select fields.
const ENGINE_CSS = `
.engine{font:13px/19px var(--sans);color:var(--text);text-align:start}
.engine button{font:inherit;font-size:13px;line-height:19px;font-weight:400;appearance:none;display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;gap:.375rem;box-sizing:border-box;width:fit-content;max-width:100%;min-width:0;margin:0;border:0;padding:0;background:none;color:var(--text);text-align:center;white-space:nowrap;user-select:none}
.engine [data-press-label]{min-width:0;overflow:hidden;text-overflow:ellipsis}
.engine button:not([data-press-plain]):not([data-engine-select]){height:24px;padding:0 8px;border-radius:6px;background:var(--fill);box-shadow:inset 0 0 0 1px var(--ring),0 1px 2px 0 rgb(0 0 0/.05)}
.engine button[data-press-plain]{min-height:1lh;padding:0 4px;border-radius:4px}
.engine button[data-press-dim]{color:var(--engine-button-dim-ink,var(--engine-dim-ink,var(--secondary)))}
.engine [data-press-cue]{display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;box-sizing:border-box;width:calc(1em + 6px);height:calc(1em + 6px);border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:4px;font-size:11px;color:var(--secondary)}
.engine button:not([data-press-plain])>[data-press-cue]{margin-inline-end:calc((24px - 1em - 6px)/2 - 8px)}
.engine [data-engine-select-field]{position:relative;display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.engine [data-engine-caption]{color:var(--secondary);white-space:nowrap}
.engine button[data-engine-select]{justify-content:space-between;height:24px;padding:0 6px 0 8px;border-radius:6px;background:var(--field);box-shadow:inset 0 0 0 1px var(--field-ring);text-align:start}
.engine [data-select-value]{min-width:0;overflow:hidden;text-overflow:ellipsis}
.engine [data-select-caret]{flex-shrink:0;width:.875rem;height:.875rem;color:var(--secondary)}
.engine [data-engine-row]>span,.engine [data-engine-row]>button,.engine [data-engine-row]>img,.engine [data-engine-row]>[data-engine-select-field]{align-self:center}
`

const ICON = {
  expand: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5l-4.5 4.5M6.5 13.5h-4v-4M2.5 13.5l4.5-4.5"/></svg>`,
  close: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
}

// The pane at `columns` columns of Desktop's 13px code face, 7.8px each.
export function desktopPage(tree: El, theme: 'dark' | 'light', columns: number, maxHeight?: number) {
  const width = Math.round(columns * 7.8)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${THEMES[theme]};${FACES};color-scheme:${theme}}
*{box-sizing:border-box}
body{margin:0;background:transparent;font:13px/19px var(--sans);color:var(--text);-webkit-font-smoothing:antialiased}
.stage{padding:40px;display:inline-block}
.frame{width:${width + 24}px;background:var(--pane);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;position:relative}
.bar{display:flex;align-items:center;justify-content:space-between;padding:12px 16px 4px 12px;color:var(--secondary);font-size:14px}
.bar .icons{display:flex;gap:16px}
.body{padding:12px;${maxHeight ? `max-height:${maxHeight}px;overflow:hidden;` : ''}}
.fade{position:absolute;left:0;right:0;bottom:0;height:120px;background:linear-gradient(to bottom,transparent,var(--pane))}
${ENGINE_CSS}
</style></head><body><div class="stage"><div class="frame">
<div class="bar"><span>Last turn diff</span><span class="icons">${ICON.expand}${ICON.close}</span></div>
<div class="body engine">${desktop(tree)}</div>${maxHeight ? '<div class="fade"></div>' : ''}
</div></div></body></html>`
}

export function bandPage(tree: El, theme: 'dark' | 'light') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${THEMES[theme]};${FACES};color-scheme:${theme}}
*{box-sizing:border-box}
body{margin:0;background:transparent;font:13px/19px var(--sans);color:var(--text);-webkit-font-smoothing:antialiased}
.stage{padding:40px;display:inline-block}
.frame{width:560px;background:var(--pane);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}
.band{padding:12px 16px;border-bottom:1px solid var(--border)}
.band > div > button{margin-left:auto}
.prompt{padding:16px 18px;color:var(--secondary);display:flex;gap:14px;align-items:center;font-size:14px}
${ENGINE_CSS}
</style></head><body><div class="stage"><div class="frame">
<div class="band engine">${desktop(tree)}</div>
<div class="prompt"><span style="font-size:20px;line-height:1">+</span><span>Type / for commands</span></div>
</div></div></body></html>`
}

export function terminalPage(tree: El, columns: number, maxHeight?: number) {
  return `<!doctype html><html><head><style>
:root{--diffAdded:rgb(34,92,43);--diffRemoved:rgb(122,41,54);--diffAddedWord:rgb(56,166,96);--diffRemovedWord:rgb(179,89,107);--diffAddedDimmed:rgb(71,88,74);--diffRemovedDimmed:rgb(105,72,77)}
*{box-sizing:border-box}
body{margin:0;background:transparent;-webkit-font-smoothing:antialiased}
.stage{padding:40px;display:inline-block}
.frame{background:#1a1a1a;border:1px solid #333;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.45);overflow:hidden;position:relative}
.chrome{height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#2a2a2a;border-bottom:1px solid #111}
.chrome i{width:12px;height:12px;border-radius:50%;display:block}
.chrome span{flex:1;text-align:center;color:#999;font:13px -apple-system,system-ui;margin-right:52px}
.screen{padding:14px 16px;width:calc(${columns}ch + 32px);font:13px/1.4 "SF Mono",Menlo,monospace;color:#e6e6e6;white-space:pre;${maxHeight ? `max-height:${maxHeight}px;overflow:hidden;` : ''}}
.fade{position:absolute;left:0;right:0;bottom:0;height:100px;background:linear-gradient(to bottom,transparent,#1a1a1a)}
.b{font-weight:700}.dim{color:#8a8a8a}.success{color:rgb(78,186,101)}.error{color:rgb(255,107,128)}
.trunc{overflow:hidden;text-overflow:ellipsis}
.tcard{border:1px solid #555;border-radius:8px;padding:0 1ch}
.tbtn{color:#e6e6e6}
</style></head><body><div class="stage"><div class="frame">
<div class="chrome"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>claude — ~/work</span></div>
<div class="screen">${terminal(tree)}</div>${maxHeight ? '<div class="fade"></div>' : ''}
</div></div></body></html>`
}
