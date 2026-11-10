# Third-Party Notices

This app redistributes or depends on the following third-party software and
assets. Apache-2.0 and the SIL Open Font License require these notices to
accompany redistributed binaries: keep this file when packaging.

## scrcpy (vendored)

The Android mirror pushes **scrcpy-server** to the device for low-latency H.264
capture and input injection.

- Project: <https://github.com/Genymobile/scrcpy>
- Copyright © Genymobile / Romain Vimont and contributors
- License: Apache License 2.0 — <https://www.apache.org/licenses/LICENSE-2.0>
- Vendored artifact: `src-tauri/resources/scrcpy-server.jar` (**v4.0**, unmodified
  upstream release binary)

**Version pinning:** the jar's protocol version MUST match `SCRCPY_VERSION` in
`src-tauri/src/commands/mobile.rs` — the server validates the version argument
it is launched with. Update both together, and re-verify the control-message
wire format against the new server source (it has changed across major
versions).

## serve-sim (runtime dependency, not vendored)

The iOS mirror runs **serve-sim** via `npx` on the user's machine; the app
does not redistribute it.

- Project: <https://github.com/EvanBacon/serve-sim> (Evan Bacon / Expo)
- License: Apache License 2.0

## Fonts (bundled)

- **JetBrains Mono**, patched as **JetBrains Mono Nerd Font Mono**
  (`src/assets/fonts/`, `src-tauri/fonts/`, `public/fonts/`, the terminal font).
  JetBrains Mono: Copyright 2020 The JetBrains Mono Project Authors, SIL Open
  Font License 1.1 (<https://github.com/JetBrains/JetBrainsMono>). Nerd Fonts
  patcher and added glyphs: <https://github.com/ryanoasis/nerd-fonts>, MIT for
  the patcher, each glyph set under its own licence as listed in that
  project's `license-audit.md`.
- **Geist** and **Geist Mono** (`src/assets/fonts/`). Copyright Vercel, Inc.,
  SIL Open Font License 1.1 (<https://github.com/vercel/geist-font>).

The SIL Open Font License 1.1 text: <https://openfontlicense.org/open-font-license-official-text/>.

## Icons

- **Lucide** drawings used for agent keys
  (`packages/companion-protocol/src/agent-key-pack/`). ISC License, with the
  Feather-derived icons under MIT; the full text is in that folder's `LICENSE`.
