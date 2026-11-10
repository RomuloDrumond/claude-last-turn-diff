// What the hooks module and the drawing share: the view a pane starts from,
// the $.store keys and the engine the text drawing needs. The $.state atoms
// are the hooks module's alone, which hands the drawing what it reads from
// them.

import type { PaneView } from '../types'

export const NEWEST: PaneView = { at: 0, toggled: [], pages: {} }

// The $.store keys holding the person's unified or split choice and whether
// long lines wrap.
export const MODE_KEY = 'mode'
export const WRAP_KEY = 'wrap'

// The first engine whose Text takes `mono`, which a graphical surface draws
// the diff's lines with. 2.1.295 refuses the prop, and one refused prop
// replaces the whole pane with the engine's own.
export const MONO_TEXT_SINCE = [2, 1, 299] as const
