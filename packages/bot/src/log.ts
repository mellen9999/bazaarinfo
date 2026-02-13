export function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args)
}
