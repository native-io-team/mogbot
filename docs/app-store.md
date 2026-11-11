# The phone app in the App Store

Everything needed to put the iPhone app (`mobile/`) in the App Store, and
what has been checked. Google Play is [play-store.md](play-store.md). Nothing here has been uploaded or submitted; every
step that reaches Apple is in the **Owner checklist** at the end, because it
needs the owner's Apple account and is published under their name.

**Publisher**: Galluzzo Conseil Inc. (organization, Canada), Apple
Developer team **N2VB8A88LB**, Julian Galluzzo as Account Holder. The store
build signs with that team (`STORE_PUBLISHER` in `mobile/app.config.ts`); the
older personal team H8NN6DM6G6 is for self-builds only and must not sign a
store build. Free Apps Agreement active; Paid Apps not signed (not needed for
a free app with no purchases); EU trader status not yet declared.

The app's name is **Mogbot** (it lives only in
`brand.json`). To rename a fork, change `brand.json` and run
`pnpm check:brand --write`; the store listing below uses `<Name>` where it
names the app.

## Building the store binary

The store build is `COMPANION_STORE_BUILD=1` (`mobile/app.config.ts`,
`storeBuild`). It is the only build that may reach the store, and it differs
from a self-build (the desktop's "Install on my phone") in exactly these ways,
each held by `mobile/__tests__/storeBuild.node.test.ts`:

| | Store build | Self-build |
| --- | --- | --- |
| Bundle id | `brand.json` `companion.bundleId` (`io.native.mogbot.companion`); any `COMPANION_BUNDLE_ID` that differs **throws** | `<bundleId>.<6 hex>` (iOS) / `.self` (Android) |
| `extra.official` | true: the Mac is told `build: official`, Settings offers push | false: "Push needs the app from the App Store" |
| Push entitlement | `aps-environment` (Xcode's App Store export makes it `production`) | none (a free team can't sign it) |
| App Transport Security | `NSAllowsArbitraryLoads: false`, no exceptions | Expo's dev default (the mock on `localhost`) |
| Apple team | `N2VB8A88LB` (`ios.appleTeamId`, unless `APPLE_TEAM_ID` is set) | the user's own (`APPLE_TEAM_ID`) |
| `NSHumanReadableCopyright` | `© 2026 Galluzzo Conseil Inc.` | none |

Both builds have: version **1.0.0** (`APP_VERSION`), build number from
`COMPANION_BUILD_NUMBER` (default 1), no Face ID string, the privacy
manifest, and light, dark and tinted icons.

**With EAS** (needs `EAS_PROJECT_ID`, see the checklist): the `production`
profile in `eas.json` sets `COMPANION_STORE_BUILD=1`, keeps the build number
on Expo's side (`appVersionSource: remote`, `autoIncrement`) and turns OTA
updates on for the `production` channel.

```bash
cd mobile
EAS_PROJECT_ID=<id> eas build -p ios --profile production
```

**Locally with Xcode**: `mobile/scripts/store-ios.sh` does the whole run
(prebuild → `pod install` → archive → export → checks) and never uploads.

```bash
cd mobile
scripts/store-ios.sh --build-number 1          # unsigned: proves the store config archives
scripts/store-ios.sh --sign --build-number 1   # signed with N2VB8A88LB, exported to an .ipa
# without an Xcode sign-in, with an App Store Connect API key (Users and Access → Integrations):
scripts/store-ios.sh --sign --build-number 1 \
  --api-key ~/keys/AuthKey_XXXXXXXXXX.p8 --api-key-id XXXXXXXXXX --api-issuer <issuer uuid>
```

- **Unsigned** (default): `CODE_SIGNING_ALLOWED=NO`, no `-allowProvisioningUpdates`,
  nothing reaches Apple, no export. Checks the archived app's bundle id,
  version and build, ATS, no Face ID string, the privacy manifest, and
  `aps-environment` in the project's entitlements.
- **`--sign`**: `DEVELOPMENT_TEAM=N2VB8A88LB CODE_SIGN_STYLE=Automatic
  -allowProvisioningUpdates` (only behind this flag: on the first run it
  registers the bundle id and creates the distribution certificate and
  profile in the team), then `xcodebuild -exportArchive` with
  [`mobile/store/ExportOptions.plist`](../mobile/store/ExportOptions.plist)
  (`method` `app-store-connect`, `destination` **`export`**, `teamID`
  `N2VB8A88LB`, `signingStyle` `automatic`; the script refuses to run if
  `destination` is changed). Then it unzips the `.ipa` and checks
  `aps-environment = production` and that the team is N2VB8A88LB.
- Archive, `.ipa` and derived data go in `mobile/store-build/` (ignored);
  `mobile/ios` is removed afterwards unless `--keep-native`.

It prints the next step (validate and upload with `altool`, Transporter or
Xcode's Organizer), which is the owner's.

The build number must go up with every upload of 1.0.0; the marketing
version changes only for a new release.

## What was checked, and how

Verified on this machine (Xcode, the iOS 27.2 SDK) with an **unsigned**
`xcodebuild archive` of the store build. See "Release build" below for the
results. Not verified: signing, the App Store export, `altool --validate-app`
and a device install, all of which need the owner's Apple account (signing
with `-allowProvisioningUpdates` registers the bundle id and creates
certificates and profiles in the team, which is the owner's to do).

### Release build

`COMPANION_STORE_BUILD=1 expo prebuild`, `pod install`, then `xcodebuild
archive -configuration Release` with signing off, on Xcode 27.2 / iOS SDK
27.2: **ARCHIVE SUCCEEDED** (52 MB app). What the archived app holds:

- `CFBundleIdentifier` `io.native.mogbot.companion`, version `1.0.0` (1),
  minimum iOS 16.4, `ITSAppUsesNonExemptEncryption` false,
  `NSAllowsArbitraryLoads` false with no exceptions.
- No `NSFaceIDUsageDescription`, `NSBonjourServices` or
  `NSLocalNetworkUsageDescription` (the dev launcher's build phase stripped
  them), no `UIBackgroundModes`.
- `PrivacyInfo.xcprivacy` as above, plus the Expo modules' own
  `*_privacy.bundle`s.
- `Expo.plist`: `EXUpdatesEnabled` false (no EAS project id), so it never
  fetches code.
- The dev launcher isn't compiled in (only the dev-menu interface protocol's
  name is in the binary); the JS bundle is the Hermes Release bundle, with
  "Try the demo" in it.
- Privacy-sensitive APIs referenced (what Apple's upload check matches
  against purpose strings): AVCaptureDevice, SFSpeechRecognizer and
  PHPhotoLibrary, each with its string; CMMotionManager (accelerometer only,
  expo-camera's orientation: no string needed); LAContext (expo-secure-store,
  only with `requireAuthentication`, which the app never sets);
  CTTelephonyNetworkInfo and NEHotspotNetwork (NetInfo; without the Wi-Fi
  entitlement it reads no SSID); UIPasteboard (paste a pairing link, copy).
  No location, contacts, calendars, Bluetooth, health, tracking, IDFA or
  StoreKit calls.
- Linked system frameworks are all public (Speech, AVFoundation, PhotosUI,
  UserNotifications, Security, LocalAuthentication, NetworkExtension,
  SafariServices, AuthenticationServices, WebKit, …).

The archive and its 3 GB of build products were deleted after checking.

Again on 10 November 2026 with `scripts/store-ios.sh --build-number 1`
(unsigned, Xcode 27.2): **ARCHIVE SUCCEEDED**, 56 MB app; bundle id
`io.native.mogbot.companion`, 1.0.0 (1), `NSHumanReadableCopyright` "© 2026
Galluzzo Conseil Inc.", ATS arbitrary loads false, non-exempt encryption
false, the privacy manifest present, no Face ID string, and `aps-environment`
in the project's entitlements (development there; the App Store export makes
it production). Archive and 3.2 GB of derived data deleted afterwards. Not
run: `--sign` (no Xcode account or API key on this Mac, and it would reach
Apple).

### Permissions (Info.plist)

Every string is shown by iOS when the app first asks, and each one is used:

| Key | Asked when | String |
| --- | --- | --- |
| `NSCameraUsageDescription` | Scanning the pairing code; taking a photo to send | Used to scan the pairing code on your Mac, and to take photos you send to your agents. |
| `NSMicrophoneUsageDescription` | Dictating a message | Used when you dictate a message to your agents. |
| `NSSpeechRecognitionUsageDescription` | Dictating a message | Turns what you dictate into text, on this phone when it can, for you to read before you send it. |
| `NSPhotoLibraryUsageDescription` | Attaching photos | Sends the photos you pick to your agent on your Mac. |
| Notifications (no key) | "Turn on alerts" after pairing, or Settings | iOS's own prompt, never at launch |

Removed: `NSFaceIDUsageDescription` (expo-secure-store's placeholder "Allow
$(PRODUCT_NAME) to access your Face ID biometric data"; the keychain items
aren't behind biometrics). `NSLocalNetworkUsageDescription` and
`NSBonjourServices` are the Expo dev launcher's, and its build phase strips
them from Release builds (checked in the archive). No background modes, no
associated domains, no location, contacts, calendars, health, Bluetooth or
tracking.

### Export compliance

`ITSAppUsesNonExemptEncryption = false`, so App Store Connect won't ask per
build. Why that's right: the app uses HTTPS through the system (URLSession /
TLS), SHA-256, and Ed25519 signatures (`@noble/curves`) only to check that
the Mac it reaches is the one it paired with. Encryption used only for
authentication, and the operating system's own TLS, are exempt from US export
rules (EAR Category 5 Part 2, Note 3 / the authentication exclusion), which
is Apple's "exempt" answer. The pairing also makes an X25519 key pair that
nothing uses yet (`Credentials.secretKey`, kept for a future relay). **If a
relay ever encrypts messages end to end with it, this answer changes**: set
the key to true and file the self-classification. The owner confirms this
answer in App Store Connect (checklist).

### Privacy

- **Privacy manifest** (`PrivacyInfo.xcprivacy`, from `PRIVACY_MANIFEST` in
  `app.config.ts`): no tracking, no tracking domains, no collected data, and
  the required-reason APIs of every native library linked in (they're static,
  so their own manifests don't reach the app's report): user defaults
  `CA92.1`; file timestamps `C617.1`, `0A2A.1`, `3B52.1`; system boot time
  `35F9.1`; disk space `E174.1`, `85F4.1`. The union of the manifests shipped
  by React Native (and Folly, glog, boost), expo-file-system,
  expo-application, expo-constants, expo-system-ui, expo-notifications and
  expo-device. Re-check when a native dependency is added.
- **App Privacy answers ("nutrition label")**: **Data Not Collected.** The
  app has no account, no analytics, no crash reporting, no ads and no
  server of ours: everything it shows and sends goes between the phone and
  the user's own Mac over the user's own Tailscale (`brand.json` telemetry is
  null, and the phone has no telemetry code). Crash notes stay on the phone
  (`lib/crash.ts`). Revisit when the push relay (`services/push-relay`) is
  deployed: it would see a device push token, which is "Device ID", linked to
  the user, used for app functionality, not tracking.
- **Account deletion (5.1.1(v))**: no accounts exist. "Forget this Mac"
  removes the pairing on both sides.

### Accessibility and polish

- VoiceOver: every icon-only control in the app carries a label
  (`IconButton`, `RoundButton` require one; a scan of every `Pressable` found
  none without a label or text inside). Replies, approvals and failures are
  announced (`lib/a11y.ts`).
- Dynamic Type: every Text scales, clamped per role (docs/mobile.md, "Feel
  and access"); `textSize.test.tsx` and the qa:web text-size shots hold it.
- No placeholder or lorem text; no "beta" or TestFlight wording in the app
  (the one self-build line that named TestFlight now says the App Store).
- iPad: `supportsTablet` is on (the list and a chat side by side), so the
  listing needs iPad screenshots too. The simulator showed the split's chat
  header drawn under the bar and iPadOS's tab bar; it's now padded by the
  header's height (`HeaderHeightContext`, as lib/navigation.ts said it should
  be). Landscape iPad and Stage Manager sizes weren't looked at.
- The demo was run on the iOS Simulator (iPhone 18 Pro Max and iPad Pro 13",
  Release build of the store config): every screen in the screenshots
  rendered as shown. Not tried on a real device.

## App Review

### The blocker, and the demo

Without a Mac running the desktop app and Tailscale on both devices, the app
can only show its welcome screen, which fails 2.1 (completeness): a reviewer
can't reach anything. So the welcome screen has **Try the demo**
(`mobile/src/lib/demo.ts`, `src/app/demo.tsx`):

- Five sample agents (a Chief of Staff, Inbox, Books, Website, Research) for
  a fictional café, with a morning brief, an approval card ("Send an email as
  you"), a result card, a table, and one agent working.
- No network at all: it's a `Transport` with no socket. Nothing is saved
  (no keychain entry, offline copy, drafts, outbox, badge or Home Screen
  quick actions), so relaunching returns to the welcome screen.
- It can't be mistaken for a Mac: the Mac is named "Demo Mac", the Agents
  and Projects lists open on "This is the demo" with **Pair your Mac**, every
  chat has a "Demo · sample agents" bar above the composer, anything sent
  gets "This is the demo, so I can't do real work…", allowing the card says
  "In the demo nothing is sent", and everything it doesn't offer answers
  "That isn't in the demo".
- It never replaces a real pairing: with a Mac paired, `startDemo` does
  nothing and the button isn't shown. Pairing a real Mac ends it.
- `<scheme>://demo` opens it too (handy for screenshots).

Tests: `mobile/__tests__/demo.node.test.ts`; screens:
`pnpm qa:web --phases demo`.

### Review notes (paste into App Store Connect → App Review Information → Notes)

> <Name> is the phone companion to <Name> for Mac, an open-source desktop app
> that runs the user's own team of AI agents (on Claude Code or OpenAI Codex)
> on their own Mac. The phone shows those agents' conversations and lets the
> user answer their requests while away from the desk. The phone connects
> directly to the user's Mac over the user's own Tailscale network; there is
> no server of ours, no account and no sign-in.
>
> Because a review device has no Mac to pair with, the app includes a demo:
> on the first screen, tap **Try the demo** (below "It's on — next"). It opens
> sample agents with made-up conversations. It works offline, sends nothing
> anywhere, and is labelled as the demo on every screen. In it you can open
> each agent's chat, answer the approval card in Inbox, look at the result
> card in Website, send a message to any agent (the reply explains it's the
> demo), search, and open Settings. "Pair your Mac" (or Settings → Leave the
> demo) returns to the first screen.
>
> To use it for real: install <Name> for Mac (<download URL>), turn on
> Settings → Phone, then scan the code it shows with this app. Both devices
> must be signed in to the same Tailscale account (the free plan works).
>
> Permissions: the camera scans the pairing code and takes photos to send;
> the microphone and speech recognition are for dictating a message;
> notifications are asked for only when the user turns on alerts.
>
> Encryption: HTTPS and signature checks for authentication only (exempt).

Attach a 30–60 second screen recording of a real pairing and an approval
answered from the phone if you have one; reviewers often ask for it with a
companion app.

### Guidelines most likely to bite

| Guideline | Status |
| --- | --- |
| 2.1 App completeness | The demo, and the notes above. Make sure the desktop download link in the notes works on review day. |
| 4.2.3(i) "work on its own without requiring installation of another app" | **The real risk.** Real use needs the desktop app and the Tailscale app. Mitigations: the demo works with neither; the notes frame Tailscale as the user's own network (like a VPN), not an app the phone app depends on for features. Companion apps for desktop software (remote desktop, SSH, home servers over Tailscale) routinely pass, but a rejection here is possible; answer it by pointing at the demo and the notes. |
| 4.2 Minimum functionality | The phone does a lot on its own once paired (chats, approvals, results, routines, dictation, search, projects); the demo shows most of it. |
| 5.1.1 Data collection / account deletion | No data collected, no account. |
| 5.1.2 Data use | Data goes only to the user's own Mac. |
| 2.5.1 Public APIs | Expo SDK 58 / React Native 0.88, public frameworks only (Speech, AVFoundation, PhotosUI, UserNotifications, Security). Nothing private found in the archive's linked frameworks (see Release build). |
| 2.5.4 Background modes | None declared. |
| Push | `aps-environment` is in the store build. The App ID needs the Push Notifications capability (automatic signing adds it). Push stays dormant until the relay is deployed: the app asks for notification permission only when the user turns on alerts, and the Mac reports push as unavailable. |
| Associated domains / universal links | None. Pairing uses the custom scheme `mogbot-companion://`. |
| 2.3.7 / 5.2 Trademarks | Keep "Claude", "Claude Code", "Codex", "OpenAI", "Anthropic" and "Tailscale" out of the name, subtitle and keywords; naming them as compatible software in the description is fine. |
| 4.0 Design | The icon is the mark on a Graphite key, full bleed and opaque (`mobile/assets/icon.png`, drawn by `pnpm icons:build`). |

## Store listing (drafts, not published)

**Name** (30): `Mogbot` (the record exists in App Store Connect).

**Subtitle** (30): `Your AI agents, on your phone` (29)

**Promotional text** (170): `Answer your agents from anywhere: approve what
they're about to do, read what they finished, and start new work, while they
keep running on your Mac.`

**Description**:

> Your agents keep working on your Mac. <Name> puts them in your pocket.
>
> Run a team of AI agents on your own Mac with <Name> for Mac, on Claude Code
> or Codex with your own accounts. This app is how you keep up with them
> away from the desk:
>
> • Every conversation, live: see what each agent is doing, step by step,
> and read its replies as they're written.
> • Answer what needs you: anything consequential, like sending an email or
> spending money, waits for your Allow. Answer it here in a tap.
> • Results you can check: finished work comes back as one card, with what
> the agent checked and what it didn't.
> • Start things: message any agent, dictate, attach photos and files, set
> routines like "every weekday at 9".
> • Projects: see the sessions running in your projects and answer their
> questions.
> • Private by design: the phone talks directly to your Mac over your own
> Tailscale network. No account, no server in the middle, no tracking.
>
> Requires <Name> for Mac and a free Tailscale account on both devices. No
> Mac yet? Tap "Try the demo" to look around with sample agents.

**Keywords** (100): `ai agents,assistant,automation,approvals,remote,mac,tasks,routines,chief of staff,productivity` (95)

**Category**: Productivity (primary), Business (secondary).

**Price**: Free (owner decides). No in-app purchases.

**Support URL / Marketing URL / Privacy Policy URL**: https://mogbot.app/support,
https://mogbot.app and https://mogbot.app/privacy (the marketing site,
`links.website` in `brand.json`). Listing contact: julian@native.agency. The short version of the policy:

> <Name> for iPhone collects no data. It has no account and no analytics,
> and sends nothing to us. It connects only to the Mac you pair it with,
> over your own Tailscale network, and what you see and send goes only
> between this phone and that Mac. Pairing keys are kept in this phone's
> keychain. Removing the app, or "Forget this Mac", removes them. Contact:
> julian@native.agency.

**Age rating** (Apple's questionnaire, as of 2026): everything "None" / "No"
except **Unrestricted Web Access: Yes** (the sign-in screen shows the Mac's
own browser page by page, and agents' links open), and **AI-generated
content**: the agents reply with text a model wrote, unfiltered by us. The
rating is **18+** (the owner's decision). No user-to-user
messaging, no gambling, no medical, no ads, no contests.

**Copyright**: `© 2026 Galluzzo Conseil Inc.` (also the build's
`NSHumanReadableCopyright`).

### Screenshots

Required: iPhone 6.9" (1320 × 2868 portrait), and iPad 13" (2064 × 2752)
because the app supports iPad. Smaller sizes are scaled from these. In
[`app-store/screenshots/`](app-store/screenshots/), taken from the demo on
the iOS 27.2 Simulator (iPhone 18 Pro Max, iPad Pro 13-inch (M5)), Release
build of the store config, light appearance, status bar 9:41:

| File | Shows |
| --- | --- |
| `iphone-6.9-1-agents.jpg`, `ipad-13-1-agents.jpg` | The agents: one waiting on you, one working (iPad: the list beside the Chief's chat) |
| `iphone-6.9-2-chief.jpg` | The Chief's morning brief, from a routine |
| `iphone-6.9-3-approval.jpg`, `ipad-13-3-approval.jpg` | "Send an email as you": Allow / Deny |
| `iphone-6.9-4-result.jpg`, `ipad-13-4-result.jpg` | A result card: what it checked and what it didn't |
| `iphone-6.9-5-research.jpg`, `ipad-13-5-research.jpg` | A reply with a table |

They show the demo's own labels ("This is the demo", "Demo · sample
agents"), which is honest but not pretty: for a cleaner set, take them from
a real paired Mac with fictional agents, or crop the bar.

To take them again: build the store config for the simulator with
`COMPANION_SCREENSHOTS=1` (only that build reads the launch argument;
`lib/screenshots.ts`), install it, then for each screen
`xcrun simctl launch <device> io.native.mogbot.companion -screenshotRoute /chat/inbox`
and `xcrun simctl io <device> screenshot`. A link (`simctl openurl
…://demo`) raises an "Open in …?" prompt the simulator can't tap, which is
why the launch argument exists. Never upload a `COMPANION_SCREENSHOTS=1`
build.

## Owner checklist

Only the owner can do these; each reaches Apple or speaks for the business.

1. **Account**: done. Galluzzo Conseil Inc., team N2VB8A88LB, Free Apps
   Agreement active. Paid Apps Agreement only if the app is ever sold.
   **EU trader status**: declare it (App Store Connect → Business) before
   the app can be offered in the EU; as an organization selling nothing, the
   trader contact details (address, phone, email) are shown on the EU
   listing. Or leave the EU out of availability until declared.
2. **Final name.** Confirm "Mogbot" or set the real one in `brand.json`
   (`pnpm check:brand --write`), and check it's available in App Store
   Connect.
3. **Bundle id.** Register `io.native.mogbot.companion` (or the final
   `companion.bundleId`) in team N2VB8A88LB, with the Push Notifications
   capability. Automatic signing does this on the first
   `scripts/store-ios.sh --sign`.
4. **Signing.** An Apple Distribution certificate for the team (none is in
   this Mac's keychain), and either Xcode signed in to an Apple ID in team
   N2VB8A88LB (Xcode → Settings → Accounts; none is signed in on this Mac),
   or an App Store Connect API key with the Admin or App Manager role
   (Users and Access → Integrations → App Store Connect API; download the
   `.p8` once, keep it out of the repo). Then `scripts/store-ios.sh --sign`
   (with `--api-key …` for the key), which makes the certificate and
   profile, exports, and checks `aps-environment = production`.
5. **App Store Connect record.** New app: platform iOS, the name, primary
   language English (U.S.), the bundle id, an SKU. Fill in `eas.json`'s
   `submit.production.ios` (`ascAppId`, API key id and issuer) if submitting
   with EAS.
6. **EAS project** (optional, for EAS builds and OTA updates):
   `eas init`, then set `EAS_PROJECT_ID` for production builds. Without it,
   OTA updates stay off and every fix is a new binary.
7. **Support and privacy policy URLs.** Deploy the marketing site with
   its new `/support` and `/privacy` pages (written, not deployed), and put
   the website in `brand.json` (`links.website`).
8. **The desktop download link** for the review notes and description:
   reviewers need somewhere real to point at. The owner has approved a
   public GitHub release page for the desktop app; publish it and use its
   URL for `<download URL>`.
9. **Export compliance.** Confirm the "exempt" answer above.
10. **App Privacy.** Answer "Data Not Collected" (above).
11. **Age rating, category, price, availability.** As above, or your call.
12. **Screenshots and the listing text.** Review the drafts above; upload.
13. **Upload and submit.** Upload the build (Xcode Organizer, `altool`,
    Transporter or `eas submit`), attach it to version 1.0.0, add the review
    notes, and submit. TestFlight first is a good idea: a real pairing on a
    real phone has not been done with a store-signed build.
14. **Push** (later): deploy `services/push-relay` with the team's APNs key
    (docs/push-relay.md), then revisit App Privacy (device ID).
15. **Icon** (optional): the real mark instead of the placeholder ring.
