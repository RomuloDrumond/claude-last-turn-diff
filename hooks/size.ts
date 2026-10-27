// What a drawn tree costs against the bounds a pane is held to, counted as
// Claude Desktop counts them before it draws a pane: it refuses a tree of
// 2,000 nodes or more, or of 262,144 characters or more, and leaves the pane
// as it was; and the text the engine draws, which blanks whatever comes
// after a tree's first 100,000 characters. Measured on the elements
// themselves, so a count never drifts from what is drawn. Pure, so tests
// read it directly.

import type { RenderNode } from 'claude-code'

// Desktop counts the plugin's name on every element a press reaches.
const PLUGIN = 'last-turn-diff'

// `nodes`: every element, string and Select option. `chars`: Desktop's count
// of the props, labels, options, picture markup and strings. `text`: the
// engine's count of the strings, the labels of buttons, Selects and their
// options, and what pictures say.
export type Size = { nodes: number; chars: number; text: number }

export const NOTHING: Size = { nodes: 0, chars: 0, text: 0 }

export const plus = (a: Size, b: Size): Size => ({
  nodes: a.nodes + b.nodes,
  chars: a.chars + b.chars,
  text: a.text + b.text,
})

export const minus = (a: Size, b: Size): Size => ({
  nodes: a.nodes - b.nodes,
  chars: a.chars - b.chars,
  text: a.text - b.text,
})

// The larger of two sizes, measure by measure.
export const most = (a: Size, b: Size): Size => ({
  nodes: Math.max(a.nodes, b.nodes),
  chars: Math.max(a.chars, b.chars),
  text: Math.max(a.text, b.text),
})

export const fits = (size: Size, budget: Size) =>
  size.nodes <= budget.nodes && size.chars <= budget.chars && size.text <= budget.text

type Element = { type: string; props?: Record<string, unknown>; children?: readonly RenderNode[] }
type Option = { value: string; label?: string }

const length = (value: unknown) => (typeof value === 'string' ? value.length : 0)

// The characters Desktop counts for an element's own props: a pressable's
// address and label, a picture's markup and words, every other element's
// prop names and string values.
function ownChars({ type, props = {} }: Element): number {
  switch (type) {
    case 'Button':
      return length(props.key) + length(props.label) + length(props.hotkey) + length(props.action) + PLUGIN.length
    case 'Select':
      return (
        length(props.key) +
        length(props.label) +
        length(props.value) +
        PLUGIN.length +
        ((props.options ?? []) as Option[]).reduce((sum, option) => sum + length(option.value) + length(option.label), 0)
      )
    case 'Svg':
      return length(props.source) + length(props.alt)
    default:
      return Object.entries(props).reduce((sum, [key, value]) => sum + key.length + length(value), 0)
  }
}

// The text the engine counts in an element's own props: a button's label,
// a Select's and its options' labels, a picture's words.
function ownText({ type, props = {} }: Element): number {
  switch (type) {
    case 'Button':
      return length(props.label)
    case 'Select':
      return length(props.label) + ((props.options ?? []) as Option[]).reduce((sum, option) => sum + length(option.label), 0)
    case 'Svg':
      return length(props.alt)
    default:
      return 0
  }
}

export function sizeOf(node: RenderNode): Size {
  if (typeof node === 'string') return { nodes: 1, chars: node.length, text: node.length }
  const element = node as Element
  const options = element.type === 'Select' ? ((element.props?.options ?? []) as Option[]).length : 0
  return (element.children ?? []).reduce<Size>((size, child) => plus(size, sizeOf(child)), {
    nodes: 1 + options,
    chars: ownChars(element),
    text: ownText(element),
  })
}
