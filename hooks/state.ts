// What the hooks and the drawing share besides their $.state values (whose
// atoms each file declares where it reads them, as the validator requires).

import type { PaneView } from '../types'

export const NEWEST: PaneView = { at: 0, toggled: [], pages: {} }

// The $.store keys holding the person's unified or split choice and whether
// long lines wrap.
export const MODE_KEY = 'mode'
export const WRAP_KEY = 'wrap'
