// one-shot script to fetch and describe all emotes for target channels
// usage: ANTHROPIC_API_KEY=... bun scripts/describe-emotes.ts

import { loadDescriptionCache, describeEmotes, getDescriptions } from '../packages/bot/src/emote-describe'

interface EmoteData { name: string, id: string, overlay: boolean }

function extractEmotes(emotes: any[]): EmoteData[] {
  return emotes.map((e: any) => ({
    name: e.name,
    id: e.data?.id ?? e.id,
    overlay: ((e.flags ?? 0) & 1) === 1,
  }))
}

async function fetchGlobal(): Promise<EmoteData[]> {
  const res = await fetch('https://7tv.io/v3/emote-sets/global')
  const data = await res.json()
  return extractEmotes(data.emotes ?? [])
}

async function fetchChannel(userId: string): Promise<EmoteData[]> {
  const res = await fetch(`https://7tv.io/v3/users/twitch/${userId}`)
  const data = await res.json()
  return extractEmotes(data.emote_set?.emotes ?? [])
}

const KRIPP_ID = '29795919'
const MELLEN_ID = '88731280'

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('set ANTHROPIC_API_KEY')
    process.exit(1)
  }

  await loadDescriptionCache()
  const before = Object.keys(getDescriptions()).length

  console.log('fetching 7TV emotes...')
  const [globals, kripp, mellen] = await Promise.all([
    fetchGlobal(),
    fetchChannel(KRIPP_ID),
    fetchChannel(MELLEN_ID),
  ])

  console.log(`7TV global: ${globals.length}, kripp: ${kripp.length}, mellen: ${mellen.length}`)

  // dedup by name
  const all = new Map<string, EmoteData>()
  for (const e of [...globals, ...kripp, ...mellen]) all.set(e.name, e)
  const emotes = [...all.values()]
  console.log(`${emotes.length} unique emotes total`)

  const described = await describeEmotes(emotes)
  const after = Object.keys(getDescriptions()).length

  console.log(`\ndone: ${described} new descriptions (${before} -> ${after} total)`)
}

main()
