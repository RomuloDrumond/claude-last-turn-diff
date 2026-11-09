// What the hooks module and the drawing share: the view a pane starts from
// and the $.store keys. The $.state atoms are the hooks module's alone, which
// hands the drawing what it reads from them.

import type { PaneView } from '../types'

export const NEWEST: PaneView = { at: 0, toggled: [], pages: {} }

// The $.store keys holding the person's unified or split choice and whether
// long lines wrap.
export const MODE_KEY = 'mode'
export const WRAP_KEY = 'wrap'
