// The values last-turn-diff keeps in $.state for the session.

// One file (or one notebook cell) as a turn's edits left it.
export type FileDiff = {
  // What groups the edits: the absolute path, plus `#<cell>` for a notebook cell.
  key: string
  // The path as drawn, relative to the session's directory when inside it.
  name: string
  // The path the Code element infers a language from.
  path: string
  isNew: boolean
  added: number
  removed: number
  // Unified-diff hunks, each its `@@` header and body.
  hunks: string[]
  // Something the list says beside the counts ("too large to diff").
  note?: string
}

// The file edits of one turn.
export type TurnDiff = {
  // The turn's number in the session, from 1 (drawn T<n>).
  n: number
  // The prompt's first words.
  title: string
  files: FileDiff[]
  added: number
  removed: number
}

// Where the pane stands.
export type PaneView = {
  // Which turn, as an index into `turns` (0 the newest).
  at: number
  // Collapsed files, by key (every file starts open).
  toggled: string[]
  // Each file's page of rows, by key; 0 when absent.
  pages: Record<string, number>
  // Lines interleaved (unified) or old beside new (split); unified when absent.
  mode?: DiffMode
  // Whether long lines wrap; they do when absent.
  wrap?: boolean
  // The file shown or last jumped to, as an index into the turn's files.
  file?: number
}

export type DiffMode = 'unified' | 'split'

// The one-line hint above the prompt.
export type BandHint = { n: number; files: number; added: number; removed: number }

declare module 'claude-code' {
  interface PluginState {
    'last-turn-diff': {
      // Newest first.
      turns: TurnDiff[]
      view: PaneView
      // Null when the last turn edited nothing.
      band: BandHint | null
      // How many turns the session has had.
      turnNo: number
    }
  }
}
