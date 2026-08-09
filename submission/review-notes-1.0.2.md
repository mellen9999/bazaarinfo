# Review notes — 1.0.2

Pasted into the **Walkthrough Guide and Change Log** box when submitting 1.0.2 for
review. Channel field: `mellen`.

Kept because the box starts empty on every resubmission — Twitch does not carry the
previous text over.

---

CHANGE LOG - 1.0.2 (previous released version: 1.0.1)

Addresses the 2.9 rejection from the last review:
- The Twitch Extension Helper (twitch-ext.min.js) is now the first element in <head> after <meta charset> in all three HTML files (video_overlay.html, panel.html, config.html), and is loaded synchronously. It previously carried a "defer" attribute, so it was not guaranteed to execute before our own scripts. No script now precedes it; our own bundles remain deferred.

Also new since 1.0.1:
- Panel view added (1.0.1 was video overlay only).
- Card tooltips now show the value for every tier, e.g. "Deal 10/20/30/40 Damage", with each number coloured to its tier, rather than one tier's numbers. Our data source cannot report a card's current in-game tier, so showing the full progression is accurate where showing a single number was not.
- Broadcaster alignment tool in the config view, for broadcasters who play windowed or crop the game in OBS.

WALKTHROUGH

Purpose: viewers hover a card on the broadcaster's stream and see that card's stats and tooltip text for the game The Bazaar.

Panel (needs no live stream and no broadcaster setup - see REVIEW ENVIRONMENT below for slot details):
1. Open the extension panel on the channel page.
2. Type any card name to search the game's card list.
3. Select a result to see full card detail. Keyboard navigable: arrow keys move the selection, Enter selects, Escape clears, left/right arrows step through tiers.

Video overlay:
1. The overlay draws only while the broadcaster's companion app is sending card positions. Hovering a card on the video shows a tooltip with the card's name, tier, size, cooldown and effect text.
2. With no data present the overlay renders nothing and does not intercept mouse input.

Config (broadcaster view):
1. Shows the broadcaster's channel ID and a generated secret, used to authenticate the companion app they run locally.
2. Optional alignment box for windowed or cropped streams.

Data, permissions and privacy:
- The only permission requested is "broadcast".
- All network calls go to https://ebs.bazaarinfo.com, which is declared in the CSP. There are no other external hosts.
- No analytics, no third-party trackers, and no personal data is collected. Card data is from bazaardb.gg.

REVIEW ENVIRONMENT

Channel: mellen

Twitch allows this extension only one active slot on a channel at a time, so the panel and the video overlay cannot both be live at once. It is currently activated in the video-overlay slot. The panel needs no live stream and no companion app - ask and I will move it to a panel slot right away.

The video overlay requires the broadcaster's companion app to be running alongside the game, so it can only be shown on a live stream. This channel is not live continuously, so please reach out and I will schedule a time to go live with the companion running so the overlay can be reviewed.
