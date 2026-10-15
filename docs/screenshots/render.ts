// Draws a tree the pane or the hint drew as an HTML page styled like Claude
// Desktop's Code tab or like a terminal. The diffs and icons are the mod's
// own SVGs; the frame, fonts and buttons only imitate the app.
export type El = string | { type: string; props: Record<string, any>; children?: El[] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const uri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

function desktop(e: El, unit = 8): string {
  if (typeof e === 'string') return esc(e)
  const p = e.props ?? {}
  const kids = (e.children ?? []).map(c => desktop(c, unit)).join('')
  switch (e.type) {
    case 'Box': {
      const s: string[] = ['display:flex', `flex-direction:${p.flexDirection ?? 'row'}`]
      if (p.gap) s.push(`gap:${p.gap * unit}px`)
      if (p.alignItems) s.push(`align-items:${p.alignItems === 'center' ? 'center' : p.alignItems}`)
      if (p.justifyContent) s.push(`justify-content:${p.justifyContent}`)
      if (p.flexWrap) s.push(`flex-wrap:${p.flexWrap}`)
      if (p.flexShrink !== undefined) s.push(`flex-shrink:${p.flexShrink}`, 'min-width:0')
      if (p.paddingX) s.push(`padding:6px ${p.paddingX * unit}px`)
      if (p.backgroundColor) s.push(`background:${p.backgroundColor}`)
      const cls = p.borderStyle ? 'card' : ''
      return `<div class="${cls}" style="${s.join(';')}">${kids}</div>`
    }
    case 'Text': {
      const c: string[] = []
      if (p.bold) c.push('b')
      if (p.dimColor) c.push('dim')
      if (p.color) c.push(p.color)
      if (p.wrap === 'truncate-end') c.push('trunc')
      return `<span class="${c.join(' ')}">${kids}</span>`
    }
    case 'Button':
      return `<button class="${p.plain ? 'plain' : ''}">${kids || esc(p.label)}</button>`
    case 'Select': {
      const opt = (p.options ?? []).find((o: any) => o.value === p.value)
      const sel = `<span class="select">${esc(opt?.label ?? '')}<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`
      return p.label ? `<span class="field"><span class="dim">${esc(p.label)}</span>${sel}</span>` : sel
    }
    case 'Svg':
      return `<img alt="${esc(p.alt)}" src="${uri(p.source)}" ${p.width ? `width="${p.width}"` : 'style="width:100%"'} height="${p.height}">`
    default:
      return kids
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

const THEMES = {
  dark: `--page:#1f1e1d;--pane:#262624;--fg:#f0eee6;--dim:#9b998f;--line:rgba(222,220,209,.14);--btn:rgba(222,220,209,.09);--success:#6cc56f;--error:#f07a72;--shadow:0 24px 60px rgba(0,0,0,.45)`,
  light: `--page:#f5f4ed;--pane:#ffffff;--fg:#141413;--dim:#73726c;--line:rgba(31,30,29,.13);--btn:#f0eee6;--success:#2b8a3e;--error:#cf3a32;--shadow:0 24px 60px rgba(60,50,30,.18)`,
}

const ICON = {
  expand: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5l-4.5 4.5M6.5 13.5h-4v-4M2.5 13.5l4.5-4.5"/></svg>`,
  close: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
}

export function desktopPage(tree: El, theme: 'dark' | 'light', columns: number, maxHeight?: number) {
  const width = columns * 8
  return `<!doctype html><html><head><style>
:root{${THEMES[theme]};color-scheme:${theme}}
*{box-sizing:border-box}
body{margin:0;background:transparent;font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased}
.stage{padding:40px;display:inline-block}
.frame{width:${width + 40}px;background:var(--pane);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;position:relative}
.bar{display:flex;align-items:center;justify-content:space-between;padding:12px 16px 8px 20px;color:var(--dim);font-size:15px}
.bar .icons{display:flex;gap:16px}
.body{padding:8px 20px 20px;${maxHeight ? `max-height:${maxHeight}px;overflow:hidden;` : ''}}
.fade{position:absolute;left:0;right:0;bottom:0;height:120px;background:linear-gradient(to bottom,transparent,var(--pane))}
.b{font-weight:600}.dim{color:var(--dim)}.success{color:var(--success)}.error{color:var(--error)}
.trunc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{font:inherit;color:var(--fg);background:var(--btn);border:0;border-radius:8px;padding:4px 11px;white-space:nowrap}
button.plain{background:none;padding:0 4px 0 0}
.select{display:inline-flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:8px;padding:4px 10px;white-space:nowrap;max-width:420px;overflow:hidden}
.field{display:inline-flex;align-items:center;gap:10px}
.card{border:1px solid var(--line);border-radius:8px;overflow:hidden}
.card>div:first-child{min-height:38px}
img{display:block}
.card img[width="16"]{margin:0 6px 0 2px}
</style></head><body><div class="stage"><div class="frame">
<div class="bar"><span>Last turn diff</span><span class="icons">${ICON.expand}${ICON.close}</span></div>
<div class="body">${desktop(tree)}</div>${maxHeight ? '<div class="fade"></div>' : ''}
</div></div></body></html>`
}

export function bandPage(tree: El, theme: 'dark' | 'light') {
  return `<!doctype html><html><head><style>
:root{${THEMES[theme]};color-scheme:${theme}}
*{box-sizing:border-box}
body{margin:0;background:transparent;font:15px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased}
.stage{padding:40px;display:inline-block}
.frame{width:560px;background:var(--pane);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}
.band{padding:12px 16px;border-bottom:1px solid var(--line)}
.band > div > button{margin-left:auto}
.prompt{padding:16px 18px;color:var(--dim);display:flex;gap:14px;align-items:center}
.b{font-weight:600}.dim{color:var(--dim)}.success{color:var(--success)}.error{color:var(--error)}
.trunc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{font:inherit;font-size:14px;color:var(--fg);background:var(--pane);border:1px solid var(--line);border-radius:7px;padding:2px 6px 2px 10px;display:inline-flex;gap:8px;align-items:center}
kbd{font:12px -apple-system,system-ui;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 5px}
img{display:block}
</style></head><body><div class="stage"><div class="frame">
<div class="band">${desktop(tree).replace(/(View changes)<\/button>/, '$1 <kbd>D</kbd></button>')}</div>
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
