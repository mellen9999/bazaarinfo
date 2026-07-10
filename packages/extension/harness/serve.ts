// Overlay dev harness — eyeball the real built overlay bundle in a browser without
// Twitch, the companion, or a live game.
//
//   bun run harness        (from packages/extension)   → http://127.0.0.1:8899
//
// It serves the real dist/ bundle, mocks the Twitch extension helper, stubs
// /api/cards, and broadcasts a full sample board (player + opponent + skills) on a
// heartbeat so the overlay renders exactly as a viewer sees it. Uses live card data
// from cache/items.json when available, else a small embedded fallback.
import { join } from 'path'

const DIST = join(import.meta.dir, '..', 'dist')
const CACHE = join(import.meta.dir, '..', '..', '..', 'cache', 'items.json')
const PORT = Number(process.env.HARNESS_PORT ?? 8899)

// ── pick a realistic board of cards (real data if present, else a fallback) ──
type Card = Record<string, unknown>
const FALLBACK: { items: Card[]; skills: Card[] } = {
  items: [
    { Title: 'Powder Keg', Type: 'Item', Size: 'Medium', Tiers: ['Gold', 'Diamond'], DisplayTags: ['Weapon'], ArtKey: '',
      Tooltips: [{ text: "Deal Damage equal to {aura.6}% of an enemy's Max Health and destroy this", type: 'Active' },
                 { text: 'When you Burn, Charge this {ability.1} second(s)', type: 'Passive' }],
      TooltipReplacements: { '{aura.6}': { Fixed: 40 }, '{ability.1}': { Fixed: 2 } } },
    { Title: 'Chocolate Bar', Type: 'Item', Size: 'Small', Tiers: ['Bronze', 'Silver', 'Gold', 'Diamond'], DisplayTags: ['Food'], ArtKey: '',
      Tooltips: [{ text: 'When you sell this, gain {ability.0} Max Health', type: 'Passive' }],
      TooltipReplacements: { '{ability.0}': { Bronze: 10, Silver: 20, Gold: 30, Diamond: 40 } } },
    { Title: 'Bar of Gold', Type: 'Item', Size: 'Small', Tiers: ['Bronze', 'Silver', 'Gold', 'Diamond'], DisplayTags: [], ArtKey: '',
      Tooltips: [{ text: 'Sells for Gold', type: 'Passive' }], TooltipReplacements: {} },
  ],
  skills: [
    { Title: 'Backroom Dealings', Type: 'Skill', Size: 'Small', Tiers: ['Gold'], DisplayTags: [], ArtKey: '',
      Tooltips: [{ text: 'Your items gain value', type: 'Passive' }], TooltipReplacements: {} },
  ],
}

function loadBoard(): { items: Card[]; skills: Card[] } {
  try {
    const cache = JSON.parse(require('fs').readFileSync(CACHE, 'utf8'))
    const want = ['Chocolate Bar', 'Powder Keg', 'Bar of Gold', 'Fang', 'Bandages', 'Cutlass', 'Barrel', 'Fire Claw']
    const byTitle = (t: string) => cache.items?.find((i: Card) => i.Title === t)
    const items = want.map(byTitle).filter(Boolean).slice(0, 8)
    const skills = (cache.skills ?? []).slice(0, 2)
    if (items.length >= 3) { console.log(`[harness] using ${items.length} real cards from cache`); return { items, skills } }
  } catch { /* fall through */ }
  console.log('[harness] cache/items.json not found — using embedded sample')
  return FALLBACK
}

const BOARD = loadBoard()

// ── the harness page: mock Twitch + stub fetch + broadcast a board on a heartbeat ──
function page(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>overlay harness</title>
<link rel="stylesheet" href="/video_overlay.css">
<style>
  html,body{margin:0;height:100%;width:100%;overflow:hidden;
    background:radial-gradient(120% 90% at 50% 40%, #1c2733 0%, #0d1014 70%);font-family:system-ui}
  .hint{position:fixed;top:6px;left:8px;color:#3a4654;font:11px monospace;z-index:0}
</style></head><body>
<div class="hint">overlay harness — hover a slot</div>
<div id="root"></div>
<script>
  const CARDS = ${JSON.stringify(BOARD)};
  window.Twitch = { ext: {
    onAuthorized(cb){ setTimeout(()=>cb({token:'harness',channelId:'0',userId:'0',clientId:'0'}),0); },
    listen(t,cb){ if(t==='broadcast') window.__bcast=cb; }, unlisten(){},
    onVisibilityChanged(cb){ window.__vis=cb; }, onContext(){},
  }};
  const _f = window.fetch.bind(window);
  window.fetch = (u,o) => String(u).includes('/api/cards')
    ? Promise.resolve(new Response(JSON.stringify(CARDS), {headers:{'content-type':'application/json'}}))
    : _f(u,o);
  function board(){
    const it=CARDS.items, sk=CARDS.skills||[], D=[];
    const w=s=>s==='Small'?0.058:s==='Large'?0.14:0.092;
    let x=0.075; it.forEach((c,i)=>{const cw=w(c.Size);
      D.push({title:c.Title,tier:(c.Tiers||['Gold']).slice(-1)[0],x,y:0.60,w:cw,h:0.23,owner:'player',type:c.Type,enchantment:i===1?'Fiery':i===4?'Golden':undefined}); x+=cw+0.012;});
    let ox=0.10; it.slice(0,4).forEach(c=>{const cw=w(c.Size);
      D.push({title:c.Title,tier:(c.Tiers||['Gold']).slice(-1)[0],x:ox,y:0.135,w:cw,h:0.20,owner:'opponent',type:c.Type}); ox+=cw+0.012;});
    let sx=0.06; sk.forEach(c=>{D.push({title:c.Title,tier:(c.Tiers||['Gold']).slice(-1)[0],x:sx,y:0.865,w:0.033,h:0.058,owner:'player',type:'Skill'}); sx+=0.043;});
    return D;
  }
  const fire = () => window.__bcast && window.__bcast('broadcast','application/json',JSON.stringify({v:1,cards:board()}));
  // heartbeat < the overlay's 75s stale-TTL so the board never self-wipes while you look
  const hb = setInterval(fire, 10000);
  const t = setInterval(()=>{ if(window.__bcast){ fire(); clearInterval(t);} }, 300);
</script>
<script src="/video_overlay.js"></script>
</body></html>`
}

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/' || path === '/index.html') {
      return new Response(page(), { headers: { 'content-type': 'text/html' } })
    }
    const file = Bun.file(join(DIST, path))
    if (await file.exists()) return new Response(file)
    return new Response('not found', { status: 404 })
  },
})

console.log(`[harness] overlay running → http://127.0.0.1:${PORT}`)
console.log('[harness] hover any slot to see the tooltip. ctrl-c to stop.')
