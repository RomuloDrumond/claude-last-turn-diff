// A port of the checks Claude Desktop runs on a pane's tree before it draws
// it (its renderer's `ze`, `O` and `Ve`): a tree of 2,000 nodes or more, 32
// levels or more, or 262,144 characters or more is refused, and the pane
// keeps what it drew before. Nodes are the elements, the strings and a
// Select's options; characters are a Button's address, label and plugin, a
// Select's and its options' words, a picture's markup and words, and every
// other element's prop names and string values. The tests run every tree
// they draw on the desktop through it. Not named *.test.ts: a helper.

type Node = string | { type: string; props?: Record<string, unknown>; children?: Node[]; press?: { plugin?: string }; hover?: Record<string, unknown> }

export type DesktopSize = { nodes: number; depth: number; chars: number }

export const MAX_NODES = 2000
export const MAX_DEPTH = 32
export const MAX_CHARS = 262144

const length = (...values: unknown[]) => values.reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0)

// Prop names and string values, as `M` counts them.
const propChars = (props: Record<string, unknown> | undefined) =>
  Object.entries(props ?? {}).reduce((sum, [key, value]) => sum + key.length + length(value), 0)

type Option = { value?: string; label?: string }

function ownChars(node: Exclude<Node, string>): number {
  const props = node.props ?? {}
  const plugin = node.press?.plugin
  switch (node.type) {
    case 'Button':
      return length(props.key, props.label, props.hotkey, props.action, plugin) + propChars(node.hover)
    case 'Select':
      return (
        length(props.key, props.label, props.value, plugin) +
        ((props.options ?? []) as Option[]).reduce((sum, option) => sum + length(option.value, option.label), 0)
      )
    case 'Svg':
      return length(props.source, props.alt)
    default:
      return propChars(props) + propChars(node.hover)
  }
}

// `ze`: what a tree adds up to, a string one node of its length.
export function desktopSize(node: Node): DesktopSize {
  if (typeof node === 'string') return { nodes: 1, depth: 1, chars: node.length }
  const options = node.type === 'Select' ? ((node.props?.options ?? []) as Option[]).length : 0
  return (node.children ?? []).map(desktopSize).reduce(
    (sum, child) => ({ nodes: sum.nodes + child.nodes, depth: Math.max(sum.depth, child.depth + 1), chars: sum.chars + child.chars }),
    { nodes: 1 + options, depth: 1, chars: ownChars(node) },
  )
}

// `Ve`: no more than 2,000 values visited, none deeper than 32.
function isWalkable(tree: Node): boolean {
  const stack: { value: Node; depth: number }[] = [{ value: tree, depth: 1 }]
  let visited = 0
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    visited += 1
    if (visited > MAX_NODES || next.depth > MAX_DEPTH) return false
    if (typeof next.value === 'string') continue
    for (const child of next.value.children ?? []) stack.push({ value: child, depth: next.depth + 1 })
  }
  return true
}

// Whether Desktop draws the tree, and what it counted.
export function desktopVerdict(tree: unknown): DesktopSize & { isAccepted: boolean } {
  const size = desktopSize(tree as Node)
  const isAccepted = isWalkable(tree as Node) && size.nodes < MAX_NODES && size.depth < MAX_DEPTH && size.chars < MAX_CHARS
  return { ...size, isAccepted }
}
