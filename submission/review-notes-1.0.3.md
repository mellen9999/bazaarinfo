# Review notes — 1.0.3

Pasted into the **Walkthrough Guide and Change Log** box when submitting 1.0.3 for
review. Channel field: `mellen`.

Kept because the box starts empty on every resubmission — Twitch does not carry the
previous text over.

---

CHANGE LOG - 1.0.3 (previous released version: 1.0.2)

Overlay:
- Hover areas never extend over a part of the board where a card may sit but was not reported. Previously a neighbouring card's area could stretch over it and show the wrong card's tooltip.
- If the overlay receives a card it has no data for (for example after a game patch while the viewer has the stream open), it quietly reloads the card list once (at most once every 10 minutes).
- Clearer error state if the Twitch Extension Helper fails to load; recovers correctly when the tab is hidden and shown again.

Panel:
- Retries card data with backoff instead of failing on the first network error.

Config (broadcaster view):
- The companion secret is masked until revealed, and can be rotated (the old secret stops working immediately).
- A screenshot can be pasted or dropped onto the alignment tool.

No new permissions and no new hosts: all network calls still go only to https://ebs.bazaarinfo.com.

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
1. Shows the broadcaster's channel ID and a generated secret (masked until revealed), used to authenticate the companion app they run locally. A rotate button issues a new secret and invalidates the old one.
2. Optional alignment box for windowed or cropped streams; a screenshot can be pasted or dropped onto it to calibrate.

Data, permissions and privacy:
- The only permission requested is "broadcast".
- All network calls go to https://ebs.bazaarinfo.com, which is declared in the CSP. There are no other external hosts.
- No analytics, no third-party trackers, and no personal data is collected. Card data is from bazaardb.gg.

REVIEW ENVIRONMENT

Channel: mellen

Twitch allows this extension only one active slot on a channel at a time, so the panel and the video overlay cannot both be live at once. When you begin the review, tell me which you want to see and I will activate that slot on the channel right away - the panel needs no live stream and no companion app, the video overlay needs both (see below).

The video overlay requires the broadcaster's companion app to be running alongside the game, so it can only be shown on a live stream. This channel is not live continuously, so please reach out and I will schedule a time to go live with the companion running so the overlay can be reviewed.
