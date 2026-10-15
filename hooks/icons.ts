// The pane's small pictures on a graphical surface, as SVG markup for its
// Svg element: a file's icon, the five diffstat squares, the New pill, a
// warning sign and the empty pane's drawing, in GitHub's colours. Each is an
// image of its own, so each carries its colours and switches them with
// `prefers-color-scheme`. A Button holds only text, so these sit beside
// the buttons, never inside one. Pure, so tests read it directly.

export type Icon = { source: string; width: number; height: number }

// Squares in a diffstat, as GitHub draws five.
export const SQUARES = 5
const SQUARE_PX = 8
const SQUARE_GAP_PX = 2

const STYLE =
  '<style>' +
  '.i{fill:none;stroke:#8b949e;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}' +
  '.a{fill:#3fb950}.d{fill:#f85149}.z{fill:#6e768166}.w{fill:#d29922}' +
  '.as{stroke:#3fb950}.ws{stroke:#d29922}.ms{fill:#d29922}' +
  '.pill{fill:#2ea04326;stroke:#3fb95099}' +
  '.label{font:600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;fill:#3fb950}' +
  '@media (prefers-color-scheme:light){.i{stroke:#59636e}.a{fill:#1a7f37}.d{fill:#d1242f}.z{fill:#d1d9e0}' +
  '.w{fill:#9a6700}.as{stroke:#1a7f37}.ws{stroke:#9a6700}.ms{fill:#9a6700}' +
  '.pill{fill:#dafbe1;stroke:#1a7f3766}.label{fill:#1a7f37}}' +
  '</style>'

const svg = (width: number, height: number, body: string): Icon => ({
  source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${STYLE}${body}</svg>`,
  width,
  height,
})

// A sheet with its corner folded, as an outline.
const SHEET =
  '<path class="i" d="M4 1.75h5.25L12.75 5.25v8.5a.5.5 0 0 1-.5.5h-8.25a.5.5 0 0 1-.5-.5v-11.5a.5.5 0 0 1 .5-.5z"/>' +
  '<path class="i" d="M9.25 1.75v3.5h3.5"/>'

// A file's icon: a sheet, with a green plus when the turn made it and an
// amber dot when it changed one.
export function fileIcon(isNew: boolean): Icon {
  const mark = isNew ? '<path class="i as" d="M8 7.75v4M6 9.75h4"/>' : '<circle class="ms" cx="8" cy="9.75" r="1.75"/>'
  return svg(16, 16, SHEET + mark)
}

// How many of the five squares are added, removed and neither, as GitHub
// rounds them: a change of fewer than five lines leaves some empty.
export function squaresOf(added: number, removed: number): { added: number; removed: number; none: number } {
  const total = added + removed
  const filled = Math.min(SQUARES, total)
  const green = total === 0 ? 0 : Math.round((filled * added) / total)
  return { added: green, removed: filled - green, none: SQUARES - filled }
}

// The five squares, green for added, red for removed, grey for the rest.
export function diffstat(added: number, removed: number): Icon {
  const counts = squaresOf(added, removed)
  const classes = [
    ...Array<string>(counts.added).fill('a'),
    ...Array<string>(counts.removed).fill('d'),
    ...Array<string>(counts.none).fill('z'),
  ]
  const body = classes
    .map(
      (name, index) =>
        `<rect class="${name}" x="${index * (SQUARE_PX + SQUARE_GAP_PX)}" y="0" width="${SQUARE_PX}" height="${SQUARE_PX}" rx="2"/>`,
    )
    .join('')
  return svg(SQUARES * SQUARE_PX + (SQUARES - 1) * SQUARE_GAP_PX, SQUARE_PX, body)
}

// A green pill that reads "New".
export function newPill(): Icon {
  return svg(
    36,
    18,
    '<rect class="pill" x=".5" y=".5" width="35" height="17" rx="8.5"/>' +
      '<text class="label" x="18" y="12.75" text-anchor="middle">New</text>',
  )
}

// A triangle with an exclamation mark, in amber.
export function warningIcon(): Icon {
  return svg(
    16,
    16,
    '<path class="i ws" d="M8 2.25 14.5 13.5h-13z"/><path class="i ws" d="M8 6.5v3.25"/><circle class="w" cx="8" cy="11.6" r=".9"/>',
  )
}

// The prompt that began a turn: a speech bubble.
export function turnIcon(): Icon {
  return svg(
    16,
    16,
    '<path class="i" d="M2.75 3.75a1 1 0 0 1 1-1h8.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.75 13.25v-2.5h-1a1 1 0 0 1-1-1z"/>',
  )
}

// The empty pane: a sheet with a removed line and two added ones.
export function emptyPicture(): Icon {
  return svg(
    48,
    48,
    '<path class="i" d="M12 4.75h16.5L37.25 13.5v29a1.25 1.25 0 0 1-1.25 1.25H12a1.25 1.25 0 0 1-1.25-1.25v-36.5A1.25 1.25 0 0 1 12 4.75z"/>' +
      '<path class="i" d="M28.5 4.75v8.75h8.75"/>' +
      '<rect class="d" x="15" y="19" width="14" height="3" rx="1.5"/>' +
      '<rect class="a" x="15" y="26" width="18" height="3" rx="1.5"/>' +
      '<rect class="a" x="15" y="33" width="11" height="3" rx="1.5"/>',
  )
}
