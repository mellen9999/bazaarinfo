declare module '*.css' {
  const content: string
  export default content
}

declare global {
  interface Window {
    Twitch?: {
      ext: {
        onAuthorized: (cb: (auth: { token: string; channelId: string; clientId: string }) => void) => void
        listen: (target: string, cb: (target: string, contentType: string, message: string) => void) => void
        unlisten: (target: string, cb: (target: string, contentType: string, message: string) => void) => void
        onContext?: (cb: (ctx: { theme?: string; language?: string; mode?: string }) => void) => void
        onVisibilityChanged?: (cb: (isVisible: boolean, context: unknown) => void) => void
      }
    }
  }
}

export {}
