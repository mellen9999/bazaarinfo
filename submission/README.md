# Twitch Extension Submission Pack

Pre-flight checklist for submitting BazaarInfo Overlay to the Twitch extension store.

## Required assets

Drop the following PNGs into `packages/extension/assets/` (referenced by `manifest.json`):

| Asset | Path | Size | Notes |
|---|---|---|---|
| Discovery icon | `icon_24.png` | 24x24 | Square, transparent background, simple silhouette |
| Search-result icon | `icon_300.png` | 300x300 | Square, on-brand orange `#ff8700` accent |
| Hero icon | `icon_1080.png` | 1080x1080 | Square, used on the extension detail page |
| Overlay screenshot | `screenshot_overlay.png` | 1280x720 | Live stream with overlay tooltips visible |
| Panel screenshot | `screenshot_panel.png` | 1280x720 | Card search panel open |
| Setup screenshot | `screenshot_setup.png` | 1280x720 | Broadcaster config view + companion running |

## Capture protocol

1. Run dev server: `bun run --watch packages/ebs/src/index.ts`
2. Open <https://localhost.rig.twitch.tv:8080> via the [Developer Rig](https://dev.twitch.tv/docs/extensions/rig/)
3. For each screenshot, set viewport to 1280x720 (DevTools → Toggle device toolbar → custom 1280x720, scale 100%)
4. Capture with the system screenshot tool (`flameshot`, `gnome-screenshot`, etc.)
5. Save into `packages/extension/assets/` with the exact filenames above

## Store listing copy

| Field | Value |
|---|---|
| Name | BazaarInfo Overlay |
| Summary (max 80 chars) | Live card tooltips for The Bazaar — hover the stream to see stats. |
| Description | Hover any card on stream to see tier, stats, and the full tooltip. Card detections come from a lightweight companion app the broadcaster runs locally — no game files, screenshots, or account data are sent. Powered by [bazaardb.gg](https://bazaardb.gg). |
| Category | Overlays |
| Support email | mellen@heatsync.org |
| Privacy policy URL | <https://github.com/mellen9999/bazaarinfo/blob/master/PRIVACY.md> |
| Terms URL | <https://github.com/mellen9999/bazaarinfo/blob/master/TERMS.md> |

## CSP gates (already satisfied)

- No inline `<script>` tags in any HTML in `packages/extension/`
- No string-source code execution APIs
- All `style="..."` attributes use CSS custom properties bound at JSX (no dynamic CSS string injection)
- All network calls go to `https://ebs.bazaarinfo.com` (declared in `connect_src`)

## Build for upload

```
cd packages/extension
bun run zip           # build + zip, in one step
```

The zip must be **flat** — `video_overlay.html` at the root, matching the viewer
paths in Asset Hosting. Zipping the `dist/` folder itself nests every file one level
down and Twitch then serves 404s for all of them, so use the `zip` script rather than
rolling your own. `manifest.json` and `assets/` do **not** go in: hosted extensions
take their config and images from the console, not from the archive.

Upload via Developer Console → the version → **Files**. The version must be in Local
Test to accept an upload; a version in Hosted Test, Pending Action or In Review is
read-only, so move it back first. After uploading, check the MD5 shown on that page
against `md5sum packages/extension/bazaarinfo-extension.zip`.

## Submitting

Full path from an editable version: Local Test → Hosted Test → Submit For Review.
Each move opens a confirm dialog with its own button; the page does nothing until you
answer it.

The review form's **Walkthrough Guide and Change Log** box is empty on every
submission — Twitch keeps nothing from the previous one. The text last submitted is
kept in `review-notes-1.0.2.md`; update it rather than rewriting from scratch.

Because the overlay needs the companion running against a live game, the review team
has to be scheduled — say so in that box.

## Final pre-submission checklist

- [ ] All 6 PNG assets present in `packages/extension/assets/`
- [ ] `manifest.json` `version` matches the git tag you're submitting
- [ ] `ebs_url` matches the production tunnel (`ebs.bazaarinfo.com`)
- [ ] `support_email` is monitored
- [ ] `PRIVACY.md` and `TERMS.md` are publicly reachable on GitHub
- [ ] Test in Developer Rig with the production EBS URL
- [ ] Bundle size < 256 KB (Twitch extension limit)
- [ ] Screenshot 1280x720, no Twitch chrome, no personal info visible
