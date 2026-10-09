# Review notes — 1.0.4

Submitted 2026-10-09 (1.0.3 withdrawn). Pasted into the **Walkthrough Guide and Change Log** box for
review. Channel field: `mellen`.

---

CHANGE LOG - 1.0.4 (previous released version: 1.0.2)

Version 1.0.3 was submitted on 2026-10-08 and withdrawn from review before a decision. 1.0.4 supersedes it and contains everything that was in 1.0.3 plus the changes below, so this log covers everything since 1.0.2.

Overlay:
- Each board frame is held until the viewer's own video shows it, using the stream latency Twitch reports for the viewer (hlsLatencyBroadcaster, from onContext) and a timestamp our backend adds when the board changes. Tooltips line up with the picture instead of running ahead of it. The broadcaster can add an extra stream delay in the config view if they delay the stream in OBS.
- Card text shows keywords with a coloured glyph and a bold word, and the tooltip stat line shows the owning hero.
- Card search for viewers, with filter chips (hero, type, size, tier). A square search button appears in the bottom right only while Twitch's player controls are visible (ctx.arePlayerControlsVisible); the / key opens it too. The button and the open search box are the only parts of the overlay that take mouse input.
- Card text follows the viewer's Twitch language (ctx.language) for German, Spanish, French, Italian, Korean, Portuguese, Thai, Turkish and Chinese. Other languages stay English.
- Hover areas never extend over a part of the board where a card may sit but was not reported (fixes a wrong tooltip).
- If a card arrives that the overlay has no data for (e.g. after a game patch), it reloads the card list once, at most every 10 minutes.
- Clearer error state if the Twitch Extension Helper fails to load; recovers when the tab is hidden and shown again.

Panel:
- Same search and filter chips as the overlay, same keyword glyphs and language support.
- Retries card data with backoff instead of failing on the first network error.

Config (broadcaster view):
- Extra stream delay field (seconds), saved with the crop in the broadcaster configuration segment.
- The companion now signs in with Twitch (device code), so the quick-start text changed. The companion secret is masked until revealed and can be rotated (the old one stops working immediately).
- A screenshot can be pasted or dropped onto the alignment tool.

No new permissions and no new hosts: all network calls still go only to https://ebs.bazaarinfo.com. The language strings come from https://ebs.bazaarinfo.com/api/i18n/<lang>, the same host as the card data, authenticated with the same Twitch JWT.

WALKTHROUGH

Purpose: viewers hover a card on the broadcaster's stream, or search the card list, and see that card's stats and tooltip text for the game The Bazaar.

Panel (needs no live stream and no broadcaster setup - see REVIEW ENVIRONMENT):
1. Open the extension panel on the channel page.
2. Type a card name. Use the filter chips (hero, type, size, tier) to narrow the list; click a chip to pick a value.
3. Select a result to see full card detail. Keyboard: arrows move the selection, Enter selects, Escape clears, left/right step through tiers.
4. Language: set the Twitch account language (Settings > Preferences > Language, e.g. Francais) and reload. Card names, tooltip text and filter labels change to that language.

Video overlay:
1. It draws only while the broadcaster's companion app is sending card positions. Hovering a card shows a tooltip with name, tier, size, cooldown, owning hero and effect text, with keyword glyphs.
2. Search: move the mouse over the player so the player controls appear; a small square search button shows bottom right. Click it (or press /), type a card name, use the filter chips, pick a result, Escape closes. The button disappears when the controls hide.
3. With no companion data the overlay renders nothing except that button (when controls are visible) and takes no mouse input anywhere else, so the player behaves normally.

Config (broadcaster view):
1. Shows the channel ID and the companion secret (masked until revealed, rotate button), and the quick-start steps (the companion signs in with Twitch).
2. Optional alignment box for windowed or cropped streams, and an optional extra stream delay in seconds.

Data, permissions and privacy:
- The only permission requested is "broadcast".
- Configuration: this version turns on the Extension Configuration Service (broadcaster segment only, no required version strings). The config view stores the broadcaster's optional game-area alignment and stream delay there; earlier versions had it set to "No configuration", so those settings could not persist.
- All network calls go to https://ebs.bazaarinfo.com, declared in the CSP. No other external hosts.
- No analytics, no third-party trackers, no personal data collected. The viewer's language setting is only used to choose which text file to load. Card data is from bazaardb.gg.

REVIEW ENVIRONMENT

Channel: mellen

Panel: fully testable on the channel above, no live stream or companion needed. Twitch allows only one active slot per channel at a time; tell me when you begin and I will activate the panel slot right away.

Video overlay: it only draws while a broadcaster is live with the companion running beside the game, and I am not able to go live for the review. In its place:
- A recording of this exact 1.0.4 build (the uploaded video_overlay.html/js, served locally with a sample board): hover tooltips with keyword glyphs, the search button appearing with the player controls, search with a filter chip, and the same card in French: https://github.com/mellen9999/bazaarinfo/blob/master/submission/overlay-demo-1.0.4.gif
- The released 1.0.2 overlay runs live most days on twitch.tv/nl_kripp; 1.0.4 builds on it as listed above.
- The full source is public: https://github.com/mellen9999/bazaarinfo/tree/master/packages/extension
