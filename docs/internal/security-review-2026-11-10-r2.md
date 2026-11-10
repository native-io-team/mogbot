# Security review, 2026-11-10 (round 2): today's day work

A second pass over what landed on `mogbot/foundation` during 2026-11-10 (up
to `7c5361678`), aimed where the risk is highest: the development-build
Keychain path, the Chrome native host's new copy, the late-grant expiry, the
paste-import removal and test splits, the phone store builds, the Mac release
script, and the public privacy and support pages against what the apps do.

Fixed in `6958483b2`, each with a test or a build-time check. What is left
is written down below and was not changed.

## Findings

| # | Severity | Surface | Finding | Status |
|---|---|---|---|---|
| 1 | **Medium** | Keychain (dev builds) | A secret over ~4 KB runs the rest of its value as a second `security` command | Fixed `6958483b2` |
| 2 | **Medium** | Privacy page | With `EAS_PROJECT_ID` set, the phone checks Expo's update server on every launch; the page says it talks only to your Mac | Owner decision |
| 3 | **Medium** | Privacy page / phone | On iOS the pairing keys stay in the Keychain after the app is deleted; the page says removing the app deletes them | Owner decision |
| 4 | Low | Approvals | A late Allow's one-hour grant was timed by uptime, which stops while the Mac sleeps | Fixed `6958483b2` |
| 5 | Low | Keychain (dev builds) | Non-ASCII or tab-containing secrets were stored, then failed the read-back as hex | Fixed `6958483b2` (refused first, plainly) |
| 6 | Low | Mac release | Nothing refused an entitlement that turns the hardened runtime off | Fixed `6958483b2` (script check) |
| 7 | Low | Android store build | Nothing refused a release manifest that allows plain HTTP | Fixed `6958483b2` (script check) |
| 8 | Low | Chrome host | The dev-build host copy and its stamp are trusted by path, size and mtime; a `.copying` temp could be swapped for a symlink | Documented |
| 9 | Low | Chrome host | The unpacked extension id is allowed in release builds, and its key is public | Documented (pre-existing) |
| 10 | Info | Phone backups | Outbox, drafts and preferences are in device backups | Documented (by design, `persist.ts`) |

### 1. A long secret ran a second Keychain command (dev builds)

`6805e1242` moved development builds' secret writes from `security
add-generic-password -w` (whose prompt keeps 128 characters) to `security
-i`, one quoted command line on stdin. The quoting is right: `\` and `"` are
escaped, and with throwaway items `a"b\c`, `x'y`, `$(id)`, `#comment`,
trailing `\` and leading or trailing spaces all stored exactly. But
`security -i` reads each line into a 4096-byte buffer. Measured: a 4097-byte
line (with its newline) is whole, a 4098-byte one is split, and **what is
past the cut runs as its own command**. With a value of padding followed by
`add-generic-password -a INJ -s <throwaway> -w pwned`, that second item was
created (reproduced, then deleted). The same value could carry
`delete-generic-password` for any item `security` may touch without a
prompt, or `add-generic-password -U` over one. The write itself then fails
its read-back, so the user sees an error, but the second command already ran.

Reach: development builds only (`Mode::Legacy`: debug, or not signed by an
Apple-issued certificate). The value is whatever is being stored: a secret
pasted into the masked card, or a token a provider returned in an OAuth
exchange, whose length the provider chooses.

Fix: `interactive_put_line` refuses a line over `INTERACTIVE_LINE_MAX`
(4000 bytes, under the measured 4096), any control character in the
service, account or value (`\n`, `\r`, NUL, tab, U+0085 …), and a value
that isn't printable ASCII. Tests: `a_line_security_would_split_is_refused`
(a spill-over value, 10 000 characters, exactly the limit accepted and one
more refused, escaped quotes counted), `a_line_break_is_refused`, and the
live `keychain_live_long_and_quoted_values_round_trip` now stores a value
at the limit through the real `security` (passed, items deleted).

Also checked: nothing reaches argv (`ps`) or a log; stdout and stderr are
discarded; a failed write is detected by the read-back (`Vault::write`).

### 2. Expo updates versus "talks only to your Mac" (owner)

`app.config.ts` turns OTA updates on whenever `EAS_PROJECT_ID` is set, with
`checkAutomatically: 'ON_LOAD'`, and docs/app-store.md's EAS route sets it
for the production build. Such a build asks `u.expo.dev` for an update on
every launch, which tells Expo the phone's IP, platform, runtime version,
channel and an install identifier (expo-updates' `EAS-Client-ID` header).
The privacy page says the phone connects "only to the Mac you pair it with
… and nowhere else", and the App Store privacy answers are drawn from it.
A local `store-ios.sh` / `store-android.sh` build has no project id, so its
updates are off and the page holds for it. Decide one of: keep OTA off in
store builds, or add Expo to the page and the store answers. Not changed:
it is a product choice and the site is read-only here.

### 3. Deleting the app on iOS doesn't delete the pairing keys (owner)

The pairing credentials are an `expo-secure-store` item
(`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so never in a backup). On iOS, Keychain
items generally survive deleting the app, and nothing in `pairing.ts`
clears them on a fresh install, so a reinstall on the same phone comes back
paired, and the page's "Removing the app … deletes them" is wrong for the
keys on iPhone. "Forget this Mac" does revoke on the Mac and wipe the phone,
and removing the phone on the Mac ends it. Fix to consider: a marker file in
the app's own folder (deleted with the app); with none and credentials
present, forget them. The hard part is an update from a version without the
marker, which must not unpair everyone: check for any of the app's own
files first. Left for a change that can be tried on a device.

### 4. A late Allow outlived a night's sleep

`720edd135` made a late Allow's one-time grant lapse after an hour, timed
with `Instant`. On macOS `Instant` is uptime and stops while the Mac sleeps,
so a grant given in the evening could still let the same call through the
next morning. Now `SystemTime`, and a clock set back before the grant ends
it (`late_grant_live`, `a_late_grant_lapses_by_the_wall_clock`).

### 5–7. Smaller fixes

- Secrets that aren't printable ASCII were stored, then `find-generic-password
  -w` printed them as hex and the save failed "didn't read back the same".
  Now refused up front with what a development build can store.
- `release-mac.sh` already refused `get-task-allow`. It now also refuses
  `cs.disable-library-validation`, `cs.allow-dyld-environment-variables`,
  `cs.allow-unsigned-executable-memory`,
  `cs.disable-executable-page-protection` and `cs.debugger`. Today's
  `Entitlements.plist` has none (Apple Events, audio input, Calendars,
  Contacts, each explained in the file).
- `store-android.sh` now fails a release manifest with
  `android:usesCleartextTraffic="true"`. The phone uses no `http://` URL
  outside development, and iOS store builds already set no ATS exceptions.

### 8–9. Chrome native host (left)

The dev-build host copy in `~/Library/Application Support/<app>/chrome-host/`
is written only by this user, and the same user can already change the
checkout under `~/Desktop` or the manifest itself, so no boundary is
crossed. Checked: a release `.app` is never copied (`in_app_bundle`), even
when run from `~/Downloads` or `~/Desktop`; the manifest still names only
`auth::origins()`; the host still checks the origin it is given; the
app ↔ host token proof is unchanged; extension staging skips symlinks and
dotfiles and fingerprints by content. Left: `refresh_copy` trusts a stamp
of path, size and mtime, and `remove_file` then `fs::copy` on the
`.copying` temp would follow a symlink planted between them (same user
only). The unpacked extension id (`DEV_EXTENSION_ID`) is in
`allowed_origins` in release builds too, and its key is in the repo, so
any unpacked extension could take that id. It would need the user's
Developer mode and Load unpacked, can't sit beside ours, and receives the
app's commands rather than giving them. Pre-existing; drop it from release
manifests once the Web Store id exists.

## Checked and fine

- **Paste-import removal** (`cbb08b615`): no command, protocol method, TS
  wrapper or fixture is left. `paste::parse_block` / `extract_blocks` stay,
  used only by `import_export` and `import_formats`. `agents::as_shown`
  runs the same five passes (`work`, `logins`, `step_in`, `admin`,
  `remember`) the desk and phone each ran before.
- **Store and router test splits** (`2993548a0`): the removed and added
  lines are the same once indentation is ignored (rustfmt reflow plus
  `#[path]` and `mod tests;`). No production line changed.
- **Phone store config**: no keystore, `.jks`, `.p8`, `.p12`,
  `google-services.json`, `credentials/` or gradle properties are tracked,
  and all are ignored. The upload key comes from `~/.gradle/gradle.properties`
  or the environment and is never echoed. `ExportOptions.plist` has
  `destination: export` (no upload). iOS store builds set
  `NSAllowsArbitraryLoads: false` with no exceptions. Android's merged
  permissions are checked against an allow-list by the script; biometric,
  storage, media, location, overlay, boot and install-referrer are blocked.
  The Java namespace change (`io.native_.mogbot.companion`) leaves the
  applicationId as brand.json's, which the script also checks.
- **Mac release script**: refuses the Memberstack identity and anything that
  isn't a Developer ID Application; checks the hardened runtime, the
  timestamp and that every Mach-O is signed by the identity; refuses any
  outside service turned on in brand.json; notarizes through a keychain
  profile, so no password reaches argv or the log; never uploads.
- **"The apps send nothing to us"**: brand.json has every link and
  telemetry key null, including `pushRelay`; the phone's push token goes
  only to the Mac; crash notes (`lib/crash.ts`) are written on the phone and
  never sent. Holds today, apart from 2 and 3.

## Not checked

- `security -i` behaviour on macOS versions other than this Mac's (Darwin
  25.6); the limit is kept 96 bytes under what was measured.
- A real store build of either phone app (the script checks were read and
  syntax-checked, not run).
- Whether OpenCode or the engines themselves contact anything beyond their
  model providers (outside "sends nothing to us", not re-checked).
