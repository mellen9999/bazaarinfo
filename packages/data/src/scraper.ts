import type { BazaarCard } from '@bazaarinfo/shared'

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

export async function scrapeItems(onProgress?: (done: number, total: number) => void) {
  // page 0 to discover total count
  const url = `${BASE_URL}?c=items&page=0`
  const res = await fetch(url, { headers: RSC_HEADERS })
  const text = await res.text()

  const totalMatch = text.match(/"totalCards":(\d+)/)
  const total = totalMatch ? parseInt(totalMatch[1]) : 923
  const totalPages = Math.ceil(total / 10)

  const firstPage = extractPageCards(text)
  onProgress?.(1, totalPages)

  // fetch pages 1..n
  const rest = await fetchPages('items', 1, totalPages, (done, t) =>
    onProgress?.(done + 1, totalPages),
  )

  return { cards: [...firstPage, ...rest], total }
}
