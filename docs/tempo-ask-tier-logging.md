# Ask to Tempo Storm: log the card tier and template

Draft. Not sent — mellen's call on whether and where to send it.

The one thing that would fix tier accuracy for every log-reading tool at once.

---

## The message

**Subject: one-line logging request — card template + tier in Player.log**

Hi,

I build [BazaarInfo](https://github.com/mellen9999/bazaarinfo), a free Twitch
extension and chat bot for The Bazaar. The overlay lets viewers hover a card on
stream and see what it does; the bot answers card questions in chat. It's built on
bazaardb.gg's data and it reads the client's own `Player.log` — no memory reading, no
injection, nothing touching the game process.

There are two things I can't get from the log: **which card a spawned item is**, and
**its current tier.**

The first matters most. A card's template id is only logged when it's bought
(`[BoardManager] Card Purchased: InstanceId ... TemplateId ...`). Anything that
arrives another way — combat loot, a level-up bonus item, a level-up skill — is
spawned with only its instance id, so no tool can say what it is. On a real run
that's a meaningful share of the board, and viewers hovering it get nothing.

I went looking properly before writing to you, and I'm fairly confident it isn't
there to be found:

- `GetCardInfo()` writes the `Cards Spawned` block as
  `[id] [Owner] [Section] [Socket_N] [Size]` — no tier field.
- The one tier line that exists, `[BoardManager] Upgraded Card {id} Tier from: {old}
  to: {new}`, is skipped when `value.CanFuse()` or when
  `PedestalState.CanHandleCurrentUpgradeMessage` — so pedestal upgrades, a common
  path, emit nothing.
- Across a full real run: 6 pedestal visits, 110 spawn lines, **zero** tier lines and
  no occurrence of "tier" anywhere in the file.
- Enchantments are the same story — `OnCardEnchantedHandler` logs nothing usable.

So a log-reading tool has to fall back to the item's base tier from the static data,
which goes stale the moment the player upgrades anything. A Silver item shows Bronze
damage to the whole chat.

**The ask:** include the template id and tier (and ideally the enchantment) in the
card info the client already logs. Either would do it:

1. Add the fields to the existing tuple —
   `[id] [Owner] [Section] [Socket_N] [Size] [TemplateId] [Tier] [Enchantment]`, or
2. Emit the existing `Upgraded Card ... Tier from/to` line unconditionally, including
   the pedestal and fuse paths.

Option 1 is more robust for tools, since it doesn't depend on catching every
transition — and it's the only one that also names loot and skills (option 2 covers
tier alone).

**Why I think this is safe to add:** it's the player's own client logging the
player's own board — information already rendered on their own screen. It's not
opponent state, and it's nothing a player couldn't read by looking at their monitor.
The log already carries card identity, owner, section, socket and size — and the
template id for anything bought; template and tier are the attributes of the same
kind that are missing.

The alternative for tools that want live tier is to read it out of the running game,
which I won't do — I'm not asking streamers to run anything that touches the game
process on their main account. A log line keeps every tool on the safe side of that.

Happy to test a build, share the parser, or give you whatever's useful from what
we've already mapped out.

Thanks for reading,
mellen

---

## Notes for us

- Don't overstate. The decompile findings are from our own reading of the assemblies;
  say "I'm fairly confident", not "it is proven".
- Lead with the ask being one line. The easier it looks, the likelier it lands.
- Don't name any modding framework, ours or anyone's. The point stands without it,
  and naming one invites the reply "so you've been modding the game".
- If they say no: the tier ladder (`resolveTooltipParts`, shipped) is the answer, and
  it stays regardless — showing the whole upgrade curve is genuinely useful even when
  the live tier is known.
