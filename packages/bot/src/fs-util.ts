import { chmod, rename } from 'fs/promises'

export async function writeAtomic(path: string, data: string, mode = 0o600) {
  const tmp = path + '.tmp'
  await Bun.write(tmp, data)
  await chmod(tmp, mode)
  await rename(tmp, path)
}
