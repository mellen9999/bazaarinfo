import { chmod, rename, open } from 'fs/promises'
import { dirname } from 'path'

export async function writeAtomic(path: string, data: string, mode = 0o600) {
  const tmp = path + '.tmp'
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await chmod(tmp, mode)
  await rename(tmp, path)
  // fsync the parent directory so the rename is durable
  try {
    const dir = await open(dirname(path), 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } catch (e: any) {
    // some platforms (Windows, certain mounts) reject dir fsync — ignore safely
    if (!['EISDIR', 'EINVAL', 'EPERM'].includes(e?.code)) throw e
  }
}
