import type { BazaarCard, Monster } from '@bazaarinfo/shared'

const BASE_URL = 'https://bazaardb.gg/search'
const RSC_HEADERS = {
  RSC: '1',
  'Next-Router-State-Tree':
    '%5B%22%22%2C%7B%22children%22%3A%5B%22search%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D',
}

const BATCH_SIZE = 5
const DELAY_MS = 200

function extractPageCards(rscText: string): BazaarCard[] {
  // pageCards is embedded in the RSC payload as a JSON array
  const marker = '"pageCards":'
  const idx = rscText.indexOf(marker)
  if (idx === -1) return []

  const arrStart = rscText.indexOf('[', idx + marker.length)
  if (arrStart === -1) return []

  // bracket-count to find the matching ]
  let depth = 0
  for (let i = arrStart; i < rscText.length; i++) {
    if (rscText[i] === '[') depth++
    else if (rscText[i] === ']') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(rscText.substring(arrStart, i + 1))
        } catch {
          return []
        }
      }
    }
  }
  return []
}

async function fetchPage(category: string, page: number): Promise<BazaarCard[]> {
  const url = `${BASE_URL}?c=${category}&page=${page}`
  const res = await fetch(url, { headers: RSC_HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const text = await res.text()
  return extractPageCards(text)
}

export interface ScrapeOptions {
  category: string
  totalPages: number
  onProgress?: (done: number, total: number) => void
}

async function fetchPages(
  category: string,
  startPage: number,
  endPage: number,
  onProgress?: (done: number, total: number) => void,
): Promise<BazaarCard[]> {
  const total = endPage - startPage
  const allCards: BazaarCard[] = []
  let done = 0

  for (let batch = startPage; batch < endPage; batch += BATCH_SIZE) {
    const pages = Array.from(
      { length: Math.min(BATCH_SIZE, endPage - batch) },
      (_, i) => batch + i,
    )

    const results = await Promise.all(pages.map((p) => fetchPage(category, p)))
    for (const cards of results) allCards.push(...cards)

    done += pages.length
    onProgress?.(done, total)

    if (batch + BATCH_SIZE < endPage) {
      await new Promise((r) => setTimeout(r, DELAY_MS))
    }
  }

  return allCards
}

async function scrapeCategory(
  category: string,
  onProgress?: (done: number, total: number) => void,
) {
  const url = `${BASE_URL}?c=${category}&page=0`
  const res = await fetch(url, { headers: RSC_HEADERS })
  const text = await res.text()

  const totalMatch = text.match(/"totalCards":(\d+)/)
  if (!totalMatch) console.warn(`warn: could not parse totalCards for ${category}, paginating until empty`)
  const total = totalMatch ? parseInt(totalMatch[1]) : 0
  const totalPages = total ? Math.ceil(total / 10) : 0

  const firstPage = extractPageCards(text)
  if (firstPage.length === 0) return { cards: [], total: 0 }

  onProgress?.(1, totalPages || 1)

  if (totalPages > 1) {
    const rest = await fetchPages(category, 1, totalPages, (done, t) =>
      onProgress?.(done + 1, totalPages),
    )
    return { cards: [...firstPage, ...rest], total }
  }

  // no totalCards — paginate until empty
  const allCards = [...firstPage]
  let page = 1
  while (true) {
    const cards = await fetchPage(category, page)
    if (cards.length === 0) break
    allCards.push(...cards)
    page++
    onProgress?.(page, page)
    if (page > 1) await new Promise((r) => setTimeout(r, DELAY_MS))
  }
  return { cards: allCards, total: allCards.length }
}

export async function scrapeItems(onProgress?: (done: number, total: number) => void) {
  return scrapeCategory('items', onProgress)
}

export async function scrapeSkills(onProgress?: (done: number, total: number) => void) {
  return scrapeCategory('skills', onProgress)
}

function extractMonsters(rscText: string): Monster[] {
  const monsters: Monster[] = []
  const marker = '"Type":"CombatEncounter"'
  let searchFrom = 0
  while (true) {
    const typeIdx = rscText.indexOf(marker, searchFrom)
    if (typeIdx === -1) break

    let start = typeIdx
    while (start > 0 && rscText[start] !== '{') start--

    let depth = 0
    let found = false
    for (let i = start; i < rscText.length; i++) {
      if (rscText[i] === '{') depth++
      else if (rscText[i] === '}') {
        depth--
        if (depth === 0) {
          try {
            monsters.push(JSON.parse(rscText.substring(start, i + 1)))
          } catch {}
          searchFrom = i + 1
          found = true
          break
        }
      }
    }
    if (!found) break
  }
  return monsters
}

export async function scrapeMonsters() {
  const url = `${BASE_URL}?c=monsters&page=0`
  const res = await fetch(url, { headers: RSC_HEADERS })
  if (!res.ok) throw new Error(`HTTP ${res.status} for monsters`)
  const text = await res.text()
  const monsters = extractMonsters(text)
  return { monsters, total: monsters.length }
}
