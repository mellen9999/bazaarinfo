import { Component } from 'preact'
import type { ComponentChildren } from 'preact'

interface Props {
  children: ComponentChildren
}

interface State {
  failed: boolean
}

// A render throw anywhere in the tooltip takes the whole preact tree with it, which
// means one malformed card kills every hover zone for the rest of the stream. The
// card data is third-party and its shape does drift without warning — `ArtKey`
// simply disappeared from bazaardb's dump at one point — so the blast radius is
// worth bounding.
//
// Scoped to the tooltip alone: a card we cannot render loses its tooltip, and the
// board stays live. Reset by keying this on the hovered card, so the next hover
// starts clean rather than inheriting the last failure.
export class TooltipBoundary extends Component<Props, State> {
  state: State = { failed: false }

  componentDidCatch() {
    this.setState({ failed: true })
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
