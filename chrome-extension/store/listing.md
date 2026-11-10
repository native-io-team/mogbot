# Chrome Web Store listing (draft, not submitted)

Package: `pnpm package:extension` → `chrome-extension/dist/<slug>-chrome-<version>.zip`
(the manifest's dev `key` is removed; the store assigns the listing's own id,
which then goes into `brand.json` as `chromeExtension.webStoreId`).

Icon: `icons/icon-128.png` (from `store/icon.svg`). Screenshot
`store/assets/screenshot-1280x800.png` and small promo tile
`store/assets/promo-440x280.png`, rendered from the `.html` beside them with
headless Chrome (`--window-size` to the image's size). Privacy policy:
https://mogbot.app/privacy/chrome-extension (`privacy.md`'s two sections).

## Name

Mogbot for Chrome

## Summary (132 characters max)

Let your Mogbot agents use this Chrome, in tabs of their own, through the Mogbot app on your Mac. Sends and payments ask you first.

## Category

Productivity / Tools

## Description

Mogbot runs a team of AI agents on your own Mac. This extension lets them
use the sites you're already signed in to in Chrome, instead of asking you to
log in somewhere else.

- Agents open their own tabs, in a tab group with their name, and only ever
  see and act in those. Your other tabs are never read.
- Anything that would send, post, publish, pay, delete or share stops and
  asks you in the Mogbot app first, with what it would do and as whom.
- Agents never type passwords or one-time codes.
- It talks only to the Mogbot app on this Mac, through Chrome's native
  messaging. Nothing goes to any server of ours; there isn't one.
- While an agent drives a tab, Chrome shows its own "started debugging this
  browser" bar. Press Cancel on it at any time and agents stop.

Requires the Mogbot app for macOS, with Settings → Agents → Your Chrome
turned on.

## Single purpose

Lets the user's Mogbot agents, running in the Mogbot app on the same
computer, open and use web pages in this Chrome on the user's behalf.
