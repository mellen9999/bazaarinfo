declare module '*.css' {
  const content: string
  export default content
}

interface TwitchConfigSegment {
  segment: string
  version: string
  content: string
}

declare global {
  interface Window {
    Twitch?: {
      ext: {
        onAuthorized: (cb: (auth: { token: string; channelId: string; clientId: string }) => void) => void
        listen: (target: string, cb: (target: string, contentType: string, message: string) => void) => void
        unlisten: (target: string, cb: (target: string, contentType: string, message: string) => void) => void
        onContext?: (cb: (ctx: { theme?: string; language?: string; mode?: string; videoResolution?: string; displayResolution?: string }) => void) => void
        onVisibilityChanged?: (cb: (isVisible: boolean, context: unknown) => void) => void
        // Configuration Service — Twitch-hosted per-channel store. The config view
        // writes the broadcaster segment via set(); every view (incl. the viewer
        // overlay) reads it from `broadcaster` on load and on onChanged().
        configuration?: {
          broadcaster?: TwitchConfigSegment
          onChanged?: (cb: () => void) => void
          set?: (segment: 'broadcaster', version: string, content: string) => void
        }
        // Present in viewer-facing views; role gates broadcaster-only affordances.
        viewer?: { role?: string }
      }
    }
  }
}

export {}
