import { describe, expect, it } from 'bun:test'
import { parseAtom } from './reddit-feed'

// trimmed from a real https://www.reddit.com/r/PlayTheBazaar/.rss response — including
// reddit's double-encoded content HTML, which is the part a naive parser gets wrong
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<category term="PlayTheBazaar" label="r/PlayTheBazaar"/>
<title>Play The Bazaar</title>
<entry>
  <author><name>/u/TempoStormReddit</name><uri>https://www.reddit.com/user/TempoStormReddit</uri></author>
  <category term="PlayTheBazaar" label="r/PlayTheBazaar"/>
  <content type="html">&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Hello, Bazaarians! We&amp;#39;re going BIG.&lt;/p&gt;&lt;/div&gt;</content>
  <id>t3_1vi3vb5</id>
  <updated>2026-08-06T15:00:00+00:00</updated>
  <title>Community Cup 19 - Fortune Favours the Huge</title>
</entry>
<entry>
  <author><name>/u/Vilefighter</name></author>
  <content type="html">&lt;p&gt;dragons &amp;amp; more dragons&lt;/p&gt;</content>
  <updated>2026-08-07T02:00:00+00:00</updated>
  <title>Tempo, I yearn for badass dragons</title>
</entry>
</feed>`

describe('parseAtom', () => {
  const entries = parseAtom(FEED)

  it('reads every entry and skips the feed-level title', () => {
    expect(entries.length).toBe(2)
    expect(entries[0].title).toBe('Community Cup 19 - Fortune Favours the Huge')
    expect(entries[1].title).toBe('Tempo, I yearn for badass dragons')
  })

  it('strips the /u/ prefix from authors', () => {
    expect(entries[0].author).toBe('TempoStormReddit')
  })

  // reddit double-encodes the HTML inside <content>, so one decode pass leaves &#39; behind
  it('fully decodes double-encoded entities and drops the markup', () => {
    expect(entries[0].body).toBe("Hello, Bazaarians! We're going BIG.")
    expect(entries[1].body).toBe('dragons & more dragons')
    expect(entries[0].body).not.toMatch(/&|<|>/)
  })

  it('keeps the feed order — position is the only ranking signal RSS gives', () => {
    expect(entries.map((e) => e.title[0])).toEqual(['C', 'T'])
  })

  // a feed shape change must degrade, never throw and take the refresh down with it
  it('returns empty for junk instead of throwing', () => {
    expect(parseAtom('')).toEqual([])
    expect(parseAtom('<html>not a feed</html>')).toEqual([])
    expect(parseAtom('<feed><entry><title></title></entry></feed>')).toEqual([])
  })
})
