import type { ComponentChildren } from 'preact'

interface Props {
  // 'span' by default; the key caps in the panel hint are real <kbd>
  as?: 'span' | 'kbd'
  class?: string
  style?: Record<string, string>
  children: ComponentChildren
}

// A box with its ink centred inside it, both axes, whatever font the viewer's OS
// picked (see glyph-center.ts). The outer element is the box and never moves; only
// the inner `.gi` takes the measured offset, so borders and backgrounds stay put.
export function Glyph({ as: Tag = 'span', class: cls, style, children }: Props) {
  return (
    <Tag class={`glyph${cls ? ` ${cls}` : ''}`} style={style} aria-hidden="true">
      <span class="gi">{children}</span>
    </Tag>
  )
}
