# Ask to Tempo Storm: bring the board back to Player.log

Draft. Not sent — mellen's call on whether and where to send it.

Updated 2026-10-09: the current build (1.0.12650, public 2026-10-07) stopped logging
the board at all, which turns the old "please add tier" ask into "please don't take
the board away". That's the stronger, simpler request, so it leads now.

---

## The message

**Subject: Player.log stopped listing the board in 1.0.12650 — could it come back?**

Hi,

I build [BazaarInfo](https://github.com/mellen9999/bazaarinfo), a free Twitch
extension and chat bot for The Bazaar. Viewers hover a card on stream and see what
it does; the bot answers card questions in chat. It runs on bazaardb.gg's data and
reads the client's own `Player.log`: no memory reading, no injection, nothing
touching the game process.

On the current build the log no longer says what's on the board. In August a
board change looked like this:

```
[GameSimHandler] Cards Spawned: [itm_…] [Player] [Hand] [Socket_2] [Small] | …
[CardOperationUtility] Successfully moved card itm_… to Socket_4
```

On 1.0.12650 the same moment is only counts:

```
GameSim cards: id=…, dealt=1, spawned=2, disposed=0
```

Purchases, sells, upgrades, transforms and skill picks are still there, so a tool
can follow what the player *buys*. Everything else is invisible: starting items,
loot, level-up rewards, and any card the player drags to another slot. Live, that
means a streamer's overlay shows three of their eight items, some in the wrong place.

I'm fairly confident this was a cleanup of noisy logging rather than a decision about
tools, which is why I'm asking.

**The ask, smallest first:**

1. **Restore the `Cards Spawned` / `Cards Disposed` lines and the card-moved line**
   as they were. That alone puts every log-reading tool back where it was in August.
2. While it's open, **add the template id, tier and enchantment** to that same
   per-card tuple:
   `[id] [Owner] [Section] [Socket_N] [Size] [TemplateId] [Tier] [Enchantment]`.
   Today the template id is only logged on purchase, and tier only on some
   upgrades (`Upgraded Card … Tier from/to` is skipped on the fuse and pedestal
   paths), so loot can't be named and an upgraded item shows its base stats to the
   whole chat.

If a per-change line is too chatty, one line at the end of each `GameSim` message
listing the player's board would do just as well.

**Why I think it's safe:** it's the player's own client logging the player's own
board, information already drawn on their screen. No opponent state, nothing a
viewer couldn't read off the stream.

The other way for tools to get this is to read it out of the running game. I won't
do that, and I won't ask streamers to run anything that touches the game on their
main account. A log line keeps every tool on the safe side of that.

Happy to test a build, share the parser, or send exact before/after log excerpts.

Thanks for reading,
mellen

---

## Notes for us

- Evidence: the August lines are from our own `Player-prev.log` (2026-08-09). The
  1.0.12650 format strings and the list of what survived come from reading the
  current client: `GameSimHandler.LogCardOperations` now logs counts only, and the
  move/remove lines are gone. Still logged: `Card Purchased` (with TemplateId),
  `Sold Card`, `Upgraded Card`, `Transformed:`, `Selected skill`, `State changed`.
  See memory `project_log_board_removed`.
- Lead with "restore", not "add". Putting a removed line back is the cheapest ask
  they'll get this week.
- Don't overstate. Say "I'm fairly confident", not "proven".
- Don't name any modding framework, ours or anyone's, and don't mention rival tools.
  The point stands without it.
- If they say no: the overlay keeps working on purchases, and the tier ladder
  (`resolveTooltipParts`) stays. Showing the whole upgrade curve is useful even when
  the live tier is known.
