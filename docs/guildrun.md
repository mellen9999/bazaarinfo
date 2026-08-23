# guildrun dossier

researched 2026-08-23 (demo patch 0.5.5, build 24690909-era data). kripp started streaming it aug 16.
weekly patches — numbers here drift fast; in-game text is authority. UNCERTAIN tags mark unverified claims.

## what it is

- turn-based PvE autobattler roguelike on a hex grid, isometric 3D. steam app 3669200 ("coming soon"), free demo app 4425970 (out 2026-07-16, chapters 1–5). single-player only; 2-player co-op in development; no PvP ever (design pillar: "infinite build freedom without pvp constraints").
- dev: Leyline Creations GmbH, Munich. founders Raffael Köhler + Jonathan Hager, ~8 people, ex-Activision Blizzard/Riot/Konami/EA — lead designer credited on Hearthstone AND The Bazaar. debut game, partially german-fund financed.
- full release: premium, first half 2027 (gamediscover interview; older press said late 2026). demo progress carries over.
- traction: ~300k demo players in 10 days, peak 14k ccu, ~230k wishlists, ~89% positive (~1.9k reviews), 560k twitch hours/week at peak (#59 all-twitch). northernlion sponsored video; retromation/wanderbots praise; kotaku coverage.
- hubs: playguildrun.com · discord.gg/guildrun (the real hub) · r/Guildrun (official, size unknown) · X @PlayGuildrun. no official wiki; the "wikis" are an SEO farm (see data sources).

## core loop

- premise: rifts torn open worldwide; assemble a guild of heroes to seal them.
- run ≈ 20 min, 2 acts: chain of combat nodes / shops / events (campfires, trials with mutually-exclusive rewards). bosses close acts; act-end AUCTION (base bid 7 shards) sells stronger heroes/items/exclusive relics incl. team-size expanders. clear act 2 boss → endless unlocks.
- run start: pick heroes + a relic, with bonus tokens (run-start reroll tokens, start 0, max 4).
- board: hex grid, 4 rows (y=0 back … y=3 front). combat fully auto — no mid-fight input; heroes move, 6-neighbor adjacency. no timers anywhere, save mid-run.
- party vs reserve: field 3 of 6 owned at start, max 5 fielded (team-size upgrade 45 shards). benched heroes still act via Backup effects.
- emergency rewind ("shard stabilizer"): a lost normal combat is absorbed, retry the floor. start charge 10, +10 per win. hero death mid-fight is normal (grace can resurrect); red rift adds an explicit death limit. between-fight revival rules UNCERTAIN.

## combat

- targeting: nearest reachable enemy; class tie-break Tank > Vanguard > Warrior > Duelist > Assassin > Mage > Mystic. taunt overrides, stealth blocks (in-flight projectiles still land).
- damage pipeline, fixed order: immunity → crit → defense → shields → hp. omnivamp computed post-defense.
- mana: cast at full bar (whole bar spent). +5 mana per auto; +manaregen every 2s.
- **the storm** (anti-stall clock): from 50s, 5 dmg/s to EVERYONE, +5 escalation per tick, ×1.5 from ~65s — fights effectively end 65–75s. defense mitigates it.
- **riftbreaker** (legendary relic): at 90s, 33% max-hp TRUE dmg tick to enemies, then 5% per 0.25s. the stall-win button.

## stats (7 basic, one per class as primary)

- attack (warrior): hit = baseAtk × (1+atk/100)
- magic (mage): powers abilities only
- attack speed (duelist): atk/s = clamp(base × (1+as/100), 0.2, 5)
- mana regen (mystic): +mr per 2s
- defense: taken = dmg/(1+def/100); negative def amplifies; bypassed by true dmg + dots
- crit: min(crit,100)% chance, 2.0×; overflow past 100 = +1% crit dmg per point; abilities can crit
- max hp; ehp = hp × (1+def/100)
- stat math: value = (base + flats) × (1 + Σ%mods) — one additive % pool (two +100% = ×3), EXCEPT self-copy effects (hit hard/hit fast) which truly multiply.
- also: omnivamp (heals off everything, post-def), true damage (ignores def, shields still absorb), hp/s, damage amp (INERT in demo), bleed (in data, NOT active in demo).

## keywords / statuses (12)

- **poison**: 1/stack per 2s, never decays, ignores def, shields absorb. community: too slow vs burn (crossover ~52s ≈ past storm) without relics (deceleration corruptor, poison catalyst).
- **burn**: 1/stack per 1s, −1 stack per tick, ignores def, shields absorb.
- **frost**: −0.5 AS and −0.5 def per stack; −1 stack per 2s. widely called the strongest status; red rift act-2 boss can resist 50%.
- **stun**: 1.5s default; resistance stacks 15s, −25% each, immune at 4.
- **anti-heal**: healing ×0.5. heal-over-time window 6s, capped at max hp.
- **stealth** / **taunt**: untargetable / forced target.
- **shields**: temp hp, absorb normal+true+dot. durations: normal 10s, relic 99s, hero/rank 999s ("lasting"); shortest consumed first.
- **rush (N)**: live only first N seconds of combat. **stall (N)**: turns on at N seconds, once per battle. the central build axis — rush comps snowball early, stall comps outlast.
- **backup**: works from bench. **omnivamp**: above.
- legacy stacks: permanent uncapped counters (rush/stall triggers, shards earned) read fresh each fight — the endless scaling hook.

## ranks / specs / items

- ranks C→B→A→S, per-run. rank up = buy a duplicate (auto-merge) or campfire event. shard costs C 15 / B 25 / A 35 / S 45.
- C→B: pick 1 of 3 fixed **specializations** (25 heroes × 3 = the "75 spec paths"). some specs add a SECOND CLASS (aria harmony → +mystic, kai bold → +tank).
- B→A and A→S: pick 1 of 3 **rank modifiers** from the hero's class pool(s) (~15/class; dual-class draws both). "180 specializations" / "500+ leveling options" = marketing sum of specs+modifiers, exact math UNCERTAIN.
- rank S: +1 item slot. items: 3 base slots per hero, hard cap 6. respec exists mid-run; cost/location UNCERTAIN.
- **lovers**: specific hero pairs bond for shared bonuses (shared crit, stat transfer, kill chains). top endless archetype. not every pair valid.

## economy

- **shards** = the run currency (SEO wikis claiming a gold+shards dual currency are wrong — UNCERTAIN, lean shards-only). start 15; +2 per surviving hero per win; no passive income except shard maximizer relic (interest min(shards÷5, 20)).
- reroll: 1 shard, +1 per reroll within a visit, resets each shop. freeze holds offers to next shop.
- relic prices: common 10 / rare 20 / epic 30 / legendary 40. relics cannot be sold.

## difficulty

- 8 cumulative tiers: **base, C, B, A, S, SS, SSS, red rift** (each stacks all lower modifiers; per-rung table UNCERTAIN). unlock by winning.
- **red rift**: mandatory missions both acts (key fragments, challenge fights, death limit, win-streak rules); act-2 boss = elemental dragon (fire/poison/frost variants).
- **endless**: enemy stats scale super-linearly per cycle — stat × V^(0.43092n + 0.07815n²), cap 500,000,000/stat. score = floors + events + 2×difficulty index, no time component. global leaderboards.

## classes + heroes (25, demo 0.5)

classes (7, targeting order): Tank, Vanguard, Warrior, Duelist, Assassin, Mage, Mystic.

Aria (Mage) · Dragomir (Assassin) · Fiona (Mystic) · Funke (Mage) · Grace (Mystic) · Gustav (Mystic) · Hoyoung (Assassin) · Irini (Duelist) · Kai (Warrior) · Karsu (Duelist) · Logan (Warrior) · Ming (Vanguard) · Niklas (Vanguard) · Nyx (Duelist) · Pimenta (Tank) · Pollen (Mystic) · Ratna (Mage) · Reyna (Warrior) · Rip (Vanguard) · Rowan (Vanguard/Tank) · Sal (Mage) · Skorn (Tank) · Tilly (Warrior/Duelist) · Yuuna (Assassin) · Zuri (Tank/Assassin)

- guilds (factions): The Hunt (Kai, Ming), L'Héritage (Aria, Tilly), Frontline (Grace); rest UNCERTAIN. 6 guilds total in data.
- starters: Grace, Ming, Kai.
- community tier list (guildrun.app, jul 23, v0.5): S Aria/Irini/Gustav/Tilly · A Kai/Sal/Skorn/Pollen/Fiona · B Grace/Yuuna/Karsu/Niklas/Nyx/Logan/Reyna.
- notable kits: Aria requiem barrage (frost+burn beam), Irini limitless (+1 AS per auto, stall 15 bonus), Gustav blizzard (frost zone + shields), Tilly luxurious (atk↔AS cross-scaling + shards per 25 autos — the 5k-AD endless meme hero), Kai resolute strike (shield→nuke), Ming inner flame (burn per 600 maxhp), Grace salvation (shield+heal lowest, stall 20 resurrect).
- meta relics: shard maximizer (interest) · duelist's momentum engine (+40 AS global) · warrior's bloodshield engine · mage's cataclysm engine · assassin's ambush engine · defensive energy crystal (100% maxhp shield) · vanguard's titanic engine (hp→atk) · the riftbreaker.

## meta / discourse

- praised: build freedom (specs break class roles), pausable pve, generous demo; framed as StS × TFT × The Bazaar — explicitly positioned as the wholesome-pve answer to the bazaar's monetization/balance drama.
- complaints: weekly nerf cycle ("every patch nerfs the best options"), tooltip/ui density for new players.
- strong shapes: rush/stall snowball comps, shard-stacking payoffs, durable frontline + scaling carry, lovers pairs in endless.

## data sources (for grounding)

ranked, verified 2026-08-23:

1. **github leihcsky/guildrundb `content/*.json`** (source of guildrundb.gg) — raw dumps: heroes(25), heroSpecializations(75), passiveAbilities(88), activeAbilities(50), items(174), relics(408), enemies(644), rankModifiers(105), heroClasses(7), guilds(6), statMods, all.json 610KB. schema {id, kind, name, nameZh, slug, stats, loreKeys, images}. pushed 2026-08-22 (tracks 0.5.5). fetch `https://raw.githubusercontent.com/leihcsky/guildrundb/main/content/<file>.json`, pin a commit SHA. caveat: license null, single maintainer, no api contract.
2. **twitch-ext db on jsdelivr** — `cdn.jsdelivr.net/gh/KalaniEhuKai/GuildRunDataDisplayTwitchExtension@main/guildrundatabase.json`: 408 relics w/ raw templates + resolved values + rarity + icons, GPL-3.0, hot-reload design. cross-check/fallback. that repo is itself a guildrun twitch overlay ext (reads local game files) — prior art for a companion.
3. **steam patch-notes rss** — `store.steampowered.com/feeds/news/app/3669200/`: valid rss 2.0, full patch notes in body (0.5.5 aug 18, 0.5.4 aug 11). patch-day trigger.
4. fallback scrapes: guildruntools.com (ssr, exact scaling formulas in html), guildrunwiki.com (game-file extraction but pipeline private). guildrun.org/gguildrun.wiki/guildrun.net etc = SEO swarm, treat as untrusted.
5. no mediawiki/fandom wiki exists. no official api or dump — but the dev is discord-accessible and tiny; asking for an official dump is realistic.
6. live-state prior art: github gdoteof/guildrun-compendium (MIT) parses `Guildrun_Data/Logs` into runs/battles/shops — a Player.log-equivalent exists. game is unity/il2cpp; bepinex scene exists (bazaarinfo doctrine: in-process/modded reading is ruled out — log parsing is the sanctioned pattern).

## bot-relevant notes

- numbers drift weekly → any grounding needs the patch-rss trigger + delta guard, same shape as the bazaar patchday pipeline.
- counts drifted vs marketing already (408 relics live vs "300+", 174 items vs "100+", 27 hero slugs on one wiki vs 25) — never hardcode counts.
- twitch category "Guildrun" exists → stream-aware routing can key off the helix category like hearthstone does.
