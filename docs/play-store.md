# The phone app on Google Play

Everything needed to put the Android app (`mobile/`) on Google Play, and
what has been checked. The iPhone side is [app-store.md](app-store.md); the
app, the demo and most review answers are the same, so this page says only
what differs. Nothing here has been uploaded or submitted; every step that
reaches Google is in the **Owner checklist** at the end.

**Publisher**: Galluzzo Conseil Inc. (Canada), as an **organization**
Play Console account (to be created; the owner has a D-U-N-S number). The
app's name is **Mogbot**, a working name that lives only in `brand.json`.

## Building the store bundle

Play takes an **Android App Bundle** (`.aab`), signed with an **upload key**;
Google re-signs what it delivers with the app signing key it holds (**Play
App Signing**, required for new apps). The store build is the same
`COMPANION_STORE_BUILD=1` as on iOS (`mobile/app.config.ts`), held by
`mobile/__tests__/storeBuild.node.test.ts`:

| | Google Play build | Self-build |
| --- | --- | --- |
| Package | `brand.json` `companion.bundleId`: **`io.native.mogbot.companion`** (permanent once uploaded) | `<bundleId>.self` |
| Gradle namespace | `io.native_.mogbot.companion`: `native` is a Java keyword, so the Java package of R, BuildConfig and MainActivity gets an underscore (`androidNamespace`, `withJavaSafeNamespace`). Users and Play never see it; the package above is unchanged. AGP refused to build without it | same rule |
| `versionName` | `1.0.0` (`APP_VERSION`) | same |
| `versionCode` | `COMPANION_BUILD_NUMBER` (default 1), a whole number that goes up with every upload; the same number as the iOS build number. EAS keeps it remotely (`appVersionSource: remote`, `autoIncrement`) | 1 |
| `extra.official` | true | false |
| Push (FCM) | only with `GOOGLE_SERVICES_JSON=<path>` (the owner's Firebase project); without it the app never asks for a token and Settings says only what arrives while the app is open (`canReceivePush`, `src/lib/push.ts`) | none: Settings says it needs the Google Play app |
| Release signing | the upload key from Gradle properties or the environment; the debug key otherwise (Play refuses it) | debug key |

SDK levels come from Expo SDK 58 / React Native 0.88's version catalog:
**minSdk 24** (Android 7.0), **targetSdk 36** (Android 16), compileSdk 37,
NDK 27.1, AGP 9.2, Gradle 9.4. Play has required new apps and updates to
target **API 35** since 31 August 2025, and announces one level higher each
year (API 36 from 31 August 2026 is the expected rule; check Play Console's
"Target API level" notice). 36 meets both.

```bash
cd mobile
scripts/store-android.sh --build-number 1                       # local check, debug-signed
scripts/store-android.sh --build-number 1 --require-upload-key  # the bundle for Play
```

`store-android.sh` checks Java (17+) and the SDK, runs `expo prebuild -p
android --clean`, `./gradlew bundleRelease`, then checks the merged release
manifest: package = brand.json's, `versionCode` = the build number,
targetSdk ≥ 35, not debuggable, and **no permission outside the allowed
list** (it fails on a new one, so a dependency can't add one silently). It
prints who signed the bundle, copies it to `mobile/store-build/android/`
(ignored), removes `mobile/android` unless `--keep-native`, and prints the
next step. It never uploads.

**With EAS** (needs `EAS_PROJECT_ID`): `eas build -p android --profile
production` (`android.buildType: app-bundle`), `eas submit -p android`
(`submit.production.android` in `eas.json`: a Play service-account key at
`mobile/credentials/play-service-account.json`, ignored, to the **internal**
track as a **draft**). Play's API can't create the app, so the first bundle
must be uploaded by hand in Play Console either way.

### What to install to build

On this Mac: JDK 17 (Temurin 17.0.21, at `~/.local/jdk/jdk-17.0.21+9`), and
the Android SDK at `~/Library/Android/sdk` (build-tools 34–36, platforms
34–36, NDK 26–28, emulator, platform-tools, an API 35 arm64 system image).
Gradle downloads itself (the wrapper) and the SDK platform 37 that
compileSdk needs on first run. Elsewhere: Node 20+, pnpm, a JDK 17 (Temurin
or Zulu; set `JAVA_HOME`), Android Studio or the command-line tools with
`platforms;android-37`, `build-tools;36.0.0` and `ndk;27.1.12297006`
(`sdkmanager`), `ANDROID_HOME` set, and the licences accepted
(`sdkmanager --licenses`).

### Signing

Make the upload key once, keep it and its passwords out of the repo (the
`.gitignore` ignores `*.keystore`, `*.jks` and `credentials/`), and back it
up: if it's lost, Play can reset it, but only after the owner asks.

The key on this Mac (made 10 November 2026): `~/.android-keys/mogbot-upload.jks`
(the folder 700, the file 600), a PKCS12 store, alias `upload`, RSA 4096,
valid 30 years, its one password (store and key) only in the login Keychain
as `mogbot-android-upload` / `upload`. Made like this, the password passed
to `keytool` through the environment (`-storepass:env`) and to the Keychain
on `security -i`'s stdin, never on a command line:

```bash
keytool -genkeypair -storetype PKCS12 -keyalg RSA -keysize 4096 -validity 10950 \
  -alias upload -keystore ~/.android-keys/mogbot-upload.jks \
  -dname "CN=Galluzzo Conseil Inc., O=Galluzzo Conseil Inc., L=<your city>, ST=<your region>, C=<country>" \
  -storepass:env KS_PW -keypass:env KS_PW
```

Then in `~/.gradle/gradle.properties` (never the project's), or the same
names as environment variables, either the passwords themselves or, as on
this Mac, the Keychain item that holds them:

```properties
COMPANION_UPLOAD_STORE_FILE=/Users/<you>/.android-keys/mogbot-upload.jks
COMPANION_UPLOAD_KEY_ALIAS=upload
COMPANION_UPLOAD_KEYCHAIN_SERVICE=mogbot-android-upload
# COMPANION_UPLOAD_KEYCHAIN_ACCOUNT defaults to the key alias
# or, without the Keychain: COMPANION_UPLOAD_STORE_PASSWORD / COMPANION_UPLOAD_KEY_PASSWORD
```

`store-android.sh` reads the Keychain item at build time (`security
find-generic-password -w`) and exports it as the two password variables for
Gradle's environment only: never written to a file, printed or on argv.

`app.config.ts`'s `withUploadSigning` gives the release build type
`signingConfigs.upload` when `COMPANION_UPLOAD_STORE_FILE` is set and the
debug key otherwise; the file it writes names only the properties, never a
path or a password. On the first upload choose **Use Google-generated key**
(Play App Signing). Push later needs the **app signing key's** SHA-256 from
Play Console (Setup → App signing) in Firebase, not the upload key's.

## Android, feature by feature

What the iPhone app does and what the Android build does instead. Checked
in code, prebuild and the build; not on an Android phone (see "What was
checked").

| Feature | Android |
| --- | --- |
| Siri, Shortcuts, Action button | Not on Android. `expo-app-intents` is Apple-only (not autolinked); its JS reads the native module as optional, so `isAvailable()` is false and `SiriBridge` renders nothing. The Swift in `app-intents/` is skipped: Android inline modules compile only `.kt` |
| Live Activity | Not on Android: `liveActivity` checks the OS, and expo-widgets and @expo/ui are excluded from Android autolinking (`package.json`) |
| Share extension ("Send to agent…") | Only with `SHIPSTUDIO_SHARE_EXTENSION=1`, as on iOS; then Android gets intent filters for `text/*`, `image/*`, `*/*`. Off in the store build |
| Lock Screen approvals | Notification actions on the "Needs you" channel. Android actions can't require unlocking, so **Allow opens the app** (which unlocks it) and answers there; **Deny** works locked (docs/mobile.md, "Answering from the Lock Screen") |
| Notifications | Channels "Needs you" (high) and "Replies"; `POST_NOTIFICATIONS` asked only when alerts are turned on (Android 13+) |
| Push while closed | Only with Firebase (see the table above); otherwise not asked for and not claimed |
| Dictation, Talk, Listen | `expo-speech-recognition` (on-device when Android 13+ allows, else the system recogniser, named as "Recognised off this phone"), `expo-speech` for the voice. No silent switch on Android; plays at media volume |
| Glass, SF Symbols, context menus | iOS only; Android gets plain surfaces, Material Symbols (`expo-symbols`' font, no native module), ripples and its own menu sheet |
| Home Screen quick actions | `expo-quick-actions` has an Android module (launcher shortcuts) |
| Haptics | `expo-haptics` (VIBRATE) |
| Pairing | The camera scans the code; "Is Tailscale installed?" returns unknown on Android 11+ (package visibility), so it isn't claimed; the store link goes to Tailscale's Play page |
| Back gesture | Predictive back on (`predictiveBackGestureEnabled`, `enableOnBackInvokedCallback`) |
| Icon | Adaptive (foreground on the app's dark surface) plus a **monochrome** layer for Android 13+ themed icons (`assets/adaptive-monochrome.png`, from `scripts/build-icons.mjs`) |
| The demo | Pure JS, no network: the same on Android. `mogbot-companion://demo` opens it (`adb shell am start -d mogbot-companion://demo`) |

### Permissions

Declared (`ANDROID_PERMISSIONS` in `app.config.ts`), each used:

| Permission | Why | Asked |
| --- | --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | Reach the paired Mac; know when the phone is offline (NetInfo) | No (install-time) |
| `CAMERA` | Scan the pairing code; take a photo to send | When scanning or taking a photo |
| `RECORD_AUDIO` | Dictation and Talk | When dictating |
| `POST_NOTIFICATIONS` | Alerts (Android 13+) | When alerts are turned on |
| `VIBRATE` | Haptics | No |

Also merged from libraries, none asked for at run time (all normal or
vendor permissions): `ACCESS_WIFI_STATE` (NetInfo); `WAKE_LOCK` and
`com.google.android.c2dm.permission.RECEIVE` (Firebase messaging, which
expo-notifications always links, used only for push); the app's own
`…DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`; and the vendor launchers' badge
permissions (`com.sec.android.provider.badge…`, `com.huawei.android.launcher…`,
`com.htc.launcher…`, `com.sonyericsson.home…`, `me.everything.badger…`,
`android.permission.READ_APP_BADGE` and the like: ShortcutBadger, so the
icon badge works on Samsung, Huawei, Sony and other launchers). The build
script allows exactly these and fails on anything new. Play lists them on
the listing's "About this app → App permissions"; none needs a declaration.

Blocked (`ANDROID_BLOCKED_PERMISSIONS`, `tools:node="remove"`):
`READ/WRITE_EXTERNAL_STORAGE`, `READ_MEDIA_IMAGES/VIDEO/AUDIO`,
`READ_MEDIA_VISUAL_USER_SELECTED` (photos come from the system photo picker
and files from the document picker, which need none; Play's photo and video
permissions policy refuses media access for occasional picking),
`SYSTEM_ALERT_WINDOW` (the development menu's), `RECEIVE_BOOT_COMPLETED`
(re-arms scheduled notifications; the app schedules none),
`ACCESS_FINE/COARSE_LOCATION`, `USE_BIOMETRIC` / `USE_FINGERPRINT`
(expo-secure-store's, for keys behind biometrics, which the app's aren't) and
the Play install referrer (`BIND_GET_INSTALL_REFERRER_SERVICE`,
expo-application's; never read). No foreground service, exact alarm, all-files,
SMS, call log, contacts, location or accessibility permission, so Play
Console has no permission declaration form to fill in.

## What was checked, and how

See "Release build" below for the run. The release APK of the same
config ran on the API 35 emulator: the pairing screen, the demo, every
agent's chat, the approval card, the result card and the table rendered
(the screenshots above), with no crash in logcat. That run found and fixed
one Android bug: the tab screens' transparent large-title bar (iOS's) let
the first card draw under the title and the status bar, because Android
has no adjusted insets; the bar is opaque there now (`HEADER_OVERLAYS`,
`src/lib/navigation.ts`). Not checked: a Play-signed install, a real Android
phone, the camera scan, dictation, notifications and their Allow / Deny
actions, push through FCM, tablets, dark appearance, Play's pre-launch
report.

### Release build

`scripts/store-android.sh --build-number 1` on this Mac (Temurin 17.0.21,
the SDK above), 10 November 2026: **BUILD SUCCESSFUL** (bundleRelease, about
6 minutes from a cold Gradle cache), all checks passed:

- Package `io.native.mogbot.companion`, version `1.0.0` (1), min SDK 24,
  target SDK 36, not debuggable, the namespace `io.native_.mogbot.companion`.
- Permissions exactly as listed above (the first run failed the check on
  the biometric, install-referrer and badge permissions, which is how they
  were found and settled).
- An 84 MB `.aab` with all four ABIs (Play delivers one per device, so a
  phone downloads a fraction of that), signed with the **debug** key because
  no upload key exists yet: not uploadable, as the script says.
- The first ever Android build failed before this: AGP refuses
  `io.native.mogbot.companion` as a namespace (`native` is a Java keyword),
  so `withJavaSafeNamespace` was added. A self-build over adb
  (`<id>.self`) had the same problem and gets the same fix.

The bundle and `mobile/android` were deleted afterwards; the Gradle caches
in `~/.gradle` were kept (shared, and they make the next build fast).

## Store listing (drafts, not published)

**App name** (30): `Mogbot: AI agents on the go` (27). No "Claude",
"ChatGPT", "Codex", "OpenAI", "Anthropic" or "Tailscale" in the name, icon
or short description (Play's metadata and impersonation policies). If
"Mogbot" changes, change `brand.json` first.

**Short description** (80): `Answer your AI agents from your phone while they keep working on your Mac.` (74)

**Full description** (4000):

> Your agents keep working on your Mac. Mogbot puts them in your pocket.
>
> Run a team of AI agents on your own Mac with Mogbot for Mac, on the AI
> accounts you already have. This app is how you keep up with them away from
> the desk:
>
> • Every conversation, live: see what each agent is doing, step by step,
> and read its replies as they're written.
> • Answer what needs you: anything consequential, like sending an email or
> spending money, waits for your Allow. Answer it here in a tap, even from
> a notification.
> • Results you can check: finished work comes back as one card, with what
> the agent checked and what it didn't.
> • Start things: message any agent, dictate, attach photos and files, set
> routines like "every weekday at 9".
> • Talk: a hands-free voice conversation with an agent.
> • Projects: see the sessions running in your projects and answer their
> questions.
> • Private by design: the phone talks directly to your Mac over your own
> Tailscale network. No account, no server in the middle, no tracking, no
> ads.
>
> Requires Mogbot for Mac (free and open source) and a free Tailscale
> account on both devices. No Mac yet? Tap "Try the demo" to look around
> with sample agents.
>
> Mogbot works with Claude Code, Codex and OpenCode on your Mac. It is not
> affiliated with or endorsed by Anthropic, OpenAI or Tailscale.

(1,358 characters. Naming the compatible software in the description, with
the not-affiliated line, is allowed; keep it out of the title.)

**Category**: Productivity. **Tags**: Productivity, Business tools.
**Contact details**: email juliangalluzzois@gmail.com (shown on the
listing; required), website = the marketing site once deployed. Phone
optional. **Privacy policy URL**: `<site>/privacy` (written in
`~/ShipStudio/mogbot-site/src/pages/privacy.astro`, not deployed).
**Price**: Free. No in-app products, no ads (answer "No, my app does not
contain ads").

### Graphics

In [`play-store/`](play-store/):

| Asset | Spec | File |
| --- | --- | --- |
| App icon | 512 × 512 PNG, ≤ 1 MB, full square (Play rounds it) | `icon-512.png` (from `mobile/assets/icon.png`) |
| Feature graphic | 1024 × 500 JPG or 24-bit PNG, no alpha | `feature-graphic.png`, drawn from `feature-graphic.html` (the app's dark surface, its icon, Geist) |
| Phone screenshots | 2–8, PNG or JPG, 16:9 or 9:16, each side 320–3840 px and the long side ≤ 2× the short; **at least 4 at 1080 px or more** to be eligible for recommendations | `phone-1-agents.jpg` … `phone-5-research.jpg`, 1080 × 1920 (below) |
| 7" and 10" tablet screenshots | Optional (needed for tablet featuring), same rules, ≥ 1080 px | not made |

To render the feature graphic again, Chrome headless at 1024 × 500 on the
HTML (the fonts need `--allow-file-access-from-files`, or inline them).

The phone screenshots are from Android: a release APK of the store config
(`./gradlew assembleRelease` after `store-android.sh --keep-native`) on the
API 35 emulator (Google APIs, arm64, an AVD set to 1080 × 1920 at 420 dpi,
since Play wants the long side at most twice the short and a Pixel's 2400
isn't), light appearance, the system UI demo mode (9:41, full battery and
Wi-Fi, no notification icons), opened with `adb shell am start -a
android.intent.action.VIEW -d mogbot-companion://demo`, then
`…://chat/chief`, `chat/inbox`, `chat/site`, `chat/research`, each taken
with `adb exec-out screencap -p`:

| File | Shows |
| --- | --- |
| `phone-1-agents.jpg` | The agents, one waiting on you, one working, under "This is the demo" |
| `phone-2-chief.jpg` | The Chief's morning brief |
| `phone-3-approval.jpg` | "Send an email as you": Deny / Allow |
| `phone-4-result.jpg` | A result card: what it checked and what it didn't |
| `phone-5-research.jpg` | A reply with a table |

Like the iPhone set they show the demo's labels. No tablet set yet.

## Policy answers (App content)

Play Console → Policy and programs → App content. Each is the owner's to
submit.

**Privacy policy**: the URL above.

**App access**: "All or some functionality is restricted", with these
instructions (Play's reviewers get no Mac):

> Mogbot is the phone companion to Mogbot for Mac, an open-source desktop
> app that runs the user's own team of AI agents on their own computer. The
> phone connects directly to the user's Mac over the user's own Tailscale
> network. There is no account, no sign-in and no server of ours.
>
> No credentials are needed to review it. On the first screen tap **Try the
> demo**. It opens sample agents with made-up conversations; it works
> offline, sends nothing and is labelled as the demo on every screen. Open
> any agent's chat, answer the approval card in Inbox, look at the result
> card in Website, send a message (the reply explains it's the demo),
> search, and open Settings. "Pair your Mac" returns to the first screen.
>
> Real use: install Mogbot for Mac (<download URL>), turn on Settings →
> Phone, and scan the code it shows. Both devices must be on the same
> Tailscale account.

**Ads**: No ads.

**Content rating** (the IARC questionnaire): category **"All Other App
Types"** (a utility/productivity app; not a game, not a social or
communication app with other people). Answers: violence, fear, sexuality,
nudity, profanity or crude humour, drugs, alcohol, tobacco, gambling,
simulated gambling, discriminatory content: **No**. "Does the app allow
users to interact or exchange content with other users?": **No** (the user
talks only to their own agents on their own Mac). "Does the app share the
user's current physical location with other users?": **No**. "Does the app
allow users to purchase digital goods?": **No**. "Does the app contain
unrestricted internet access, such as a web browser?": **No** (links open in
the system browser, outside the app); the owner may answer Yes for the
Mac's sign-in page view, which only makes the rating stricter. "Is this a
news or educational product?": No. Expected result: Everyone / PEGI 3 / USK
0, possibly higher where AI-generated text is asked about. Confirm in the
questionnaire.

**Target audience and content**: **18 and over** only. Not designed for
children, so the Families policies don't apply; answer "No" to appealing to
children.

**Data safety**. Play counts data as *collected* when the app transmits it
off the device, and as *shared* when it goes to a third party. What leaves
the phone goes to one place: the user's own Mac, over the user's own
Tailscale network (WireGuard) and HTTPS, which the user paired on purpose.
The developer never receives it, and there is no server of ours.

- **Recommended answer**: "Does your app collect or share any of the
  required user data types?" **No.** Reason: the only recipient is the
  user's own device, chosen by the user; nothing reaches the developer or
  any third party, so it is the user moving their own data between their
  own devices (like a remote-desktop or SSH client). No analytics, crash
  reporting, ads or SDKs that send data.
- **If the owner (or Play's review) reads "off the device" strictly**,
  declare, all **not shared**, **encrypted in transit: Yes**, **users can
  request deletion: Yes** ("Forget this Mac" and deleting on the Mac), all
  for **App functionality**, none optional except where marked:
  Messages → *Other in-app messages* (what you send your agents); Photos and
  videos → *Photos* (optional: only photos you attach); Files and docs
  (optional: only files you attach); Audio → *Voice or sound recordings*
  (optional: only with Settings → Voice → Attach the recording on).
  Dictated speech is turned into text by Android's own recogniser, which is
  the system's, not ours.
- **When push is deployed** (FCM through `services/push-relay`): add
  Device or other IDs (the push token), collected, shared with Google
  (Firebase Cloud Messaging) as a service provider, for App functionality.
- Data deletion URL: not required (no account). Security section: "Data is
  encrypted in transit" Yes.

Needs verification: Play's Data safety help page on the current definitions
(it is updated periodically) before submitting.

**Government apps, financial features, health, news, COVID-19**: No / none.

**AI-generated content** (Play's policy for apps with generative AI): the
agents' replies are written by the models the user runs on their own Mac and
accounts, and shown in the app. The policy asks generative-AI apps for a way
to **report or flag offensive output** from inside the app. The app has no
such button today. Options: (a) add a "Report this reply" action that
emails the support address with the reply attached, only on the user's tap
(nothing automatic); (b) answer that the app doesn't generate content (it
displays the user's own agents' output from the user's own computer).
**The owner's call; (a) is the safer route for review.** Not built.

## Play's rules for a new developer account

From what is documented here, to be verified in Play Console when signing up
(the rules change):

- **Organization account** (what the owner is making): needs the D-U-N-S
  number, the organization's legal name and address matching it, a website,
  and a contact email and phone verified by Google; a one-time US$25 fee.
  Organization accounts are **exempt from the closed-testing requirement**
  below. The developer name shown on the listing is the organization's.
- **Personal accounts created after 13 November 2023** must run a **closed
  test with at least 12 testers opted in for 14 consecutive days** before
  they can apply for production access (it was 20 until December 2024).
  Not the path here, but if Play ever asks for it, that is what it means.
- **Developer verification**: Google now requires identity verification for
  every developer, and has announced that apps on certified Android devices
  must come from verified developers (rolling out by region from 2026). The
  Play Console account's verification covers it.
- A new app should go **internal testing → closed testing → production**:
  internal testing is instant and reaches up to 100 testers by email, and
  shows the pre-launch report (Firebase Test Lab on real devices), the best
  look at Android hardware this app will get before review.

## Owner checklist

Only the owner can do these; each reaches Google or speaks for the business.

1. **Play Console organization account** for Galluzzo Conseil Inc. (D-U-N-S,
   website, verified email and phone, US$25). Wait for verification.
2. **Final name** and the **package**: `io.native.mogbot.companion` is
   permanent on Play once uploaded. Change `brand.json` first if either
   should be different.
3. **Upload key**: make it (Signing, above), back it up, put its four
   properties in `~/.gradle/gradle.properties`.
4. **Build**: `mobile/scripts/store-android.sh --build-number 1
   --require-upload-key`.
5. **Create the app** in Play Console: name, default language English
   (United States), App, Free. Accept the declarations.
6. **App content** answers above: privacy policy URL, app access (the demo
   instructions, with the real download link), ads, content rating, target
   audience 18+, data safety, and decide the **AI-generated content** report
   option.
7. **Store listing**: name, short and full description, icon, feature
   graphic, at least 4 phone screenshots from Android, category, contact
   email, website.
8. **Internal testing** release: upload the `.aab`, choose **Play App
   Signing (Google-generated key)**, add testers, install from the Play link
   on a real Android phone, pair with a real Mac, and answer an approval.
   Read the pre-launch report.
9. **Production**: countries (Canada at least). For the EU, Play asks for
   the developer's trader status (EU Digital Services Act): declare it. Then send for review. The
   first review of a new account can take several days.
10. **Push** (later): a Firebase project, `google-services.json` (pass it as
    `GOOGLE_SERVICES_JSON`, never commit it), the app signing key's SHA-256
    in Firebase, the FCM key in `services/push-relay`, then update Data
    safety.
11. **Support and privacy pages**: deploy the marketing site with `/support`
    and `/privacy`.
