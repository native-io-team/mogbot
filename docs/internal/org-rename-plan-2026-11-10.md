# Renaming the `ship-studio` GitHub org: what breaks, and a safe plan

2026-11-10. Read-only investigation. Nothing was renamed, created, pushed or changed. Evidence
comes from `gh api` GET calls as `julian-galluzzo` (an admin of both orgs), code search on this Mac,
and `curl` against public URLs.

**Short answer.** A rename itself breaks very little on day one, because GitHub redirects repo web,
git, API and release-download URLs. The real danger is afterwards. The old name `ship-studio`
becomes free the moment you rename, and every Ship Studio install out there keeps calling
`github.com/ship-studio/...` for updates, the plugin registry and its install script, forever. If
anyone else registers `ship-studio` and creates a repo called `releases` or `plugin-registry`,
those redirects stop and that person controls what installed Ship Studio apps download. So the
rename is safe only if you **register a placeholder org called `ship-studio` in the same sitting
and never create repos in it**.

Before any of that, check which org you mean. `thenativeagency` reads as the agency's name. The
agency's org is **`native-io-team`** (24 private client repos, Mogbot and `mogbot-releases`), not
`ship-studio` (Ship Studio the product: 37 public repos with users). See "Is this the rename you
want?" at the end.

---

## 1. What is in `ship-studio` (observed)

- Plan: Team. One member (you, admin). No teams. 2FA requirement **off**.
- 41 repos (37 public, 4 private). **None has GitHub Pages** (`has_pages: false` on every repo;
  `ship-studio.github.io` returns 404). None is archived or a fork.
  - Product: `ship-studio` (app source, homepage www.ship.studio), `releases` (public update feed
    and install scripts), `plugin-registry`, 18 `plugin-*` repos.
  - Starters cloned by both apps: `static-marketing-site-starter`, `nextjs-plain-css-starter`,
    `astro-static-marketing-site-starter`, `astro-html-starter`,
    `sveltekit-static-marketing-site-starter`, `html-starter`, `expo-starter`,
    `react-native-starter`, `flutter-starter`, `shopify-theme-starter`, `nuxt-…`, `eve-agent-starter`,
    plus templates (`saas-template-1`, `saul-goodman-lawyer-template`, `john-doe-portfolio`).
  - Private: `ship-studio-marketing` (ship.studio site), `ship-studio-agency`,
    `shipstudio-admin-agent` (bug-report bot), `studio-agent` (Fly).
- GitHub Apps installed on the org: **Vercel** (all repos), **CodeRabbit** (selected), **Slack**
  (selected).
- Repo Actions secrets on `ship-studio/ship-studio`: `APPLE_API_ISSUER`, `APPLE_API_KEY`,
  `APPLE_API_KEY_CONTENT`, `APPLE_API_KEY_PATH`, `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `BUG_REPORT_SECRET`, `CSTAR_IDENTITY_SECRET`, `RELEASES_PAT`,
  `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. `studio-agent`:
  `FLY_API_TOKEN`. None of these contains the org *name* by its nature (Apple, Tauri and Fly don't
  bind to a GitHub owner). `RELEASES_PAT` is bound to the org by ID if it is fine-grained, so it
  survives a rename.
- Repo webhooks and deploy keys on the key repos (`ship-studio`, `releases`, `plugin-registry` and
  the four private ones): none returned.
- Environments: `Preview`/`Production` on the private Vercel sites (Vercel's own).
- `thenativeagency` is free right now (`gh api users/thenativeagency` returns 404).

### What I could not read (the token lacks the scope)

- Org-level Actions secrets and variables, self-hosted runners (`admin:org`).
- Org webhooks (`admin:org_hook`).
- Packages: ghcr.io / npm under the org (`read:packages`). No code anywhere references
  `ghcr.io/ship-studio` or a published `@ship-studio/` npm package
  (`@ship-studio/agent-workspace` is a pnpm workspace name inside ship-studio-marketing, not
  published), so I expect none. Check at github.com/orgs/ship-studio/packages.
- OAuth apps the org has approved, and GitHub Apps *owned* by the org (Settings → Developer
  settings). Any OAuth/GitHub App callback URL or homepage under `github.com/ship-studio` should be
  checked by hand.
- Vercel / Netlify / CodeRabbit / Slack settings on their side.

To fill these in: `gh auth refresh -h github.com -s admin:org,admin:org_hook,read:packages` and
re-run the same GETs.

---

## 2. Every reference to the org, and what a rename does to it

"Redirects" = keeps working through GitHub's redirect **as long as nobody claims `ship-studio` and
recreates that repo name**.

### Ship Studio, already installed on users' Macs and Windows PCs (v1.6.5 here; feed is on 1.7.0)

These are compiled in. You cannot change them for old installs. This is why the placeholder org is
non-negotiable.

| What | Where (`~/Desktop/Projects/shipstudio`) | After rename |
|---|---|---|
| Updater feed `github.com/ship-studio/releases/releases/latest/download/latest{,-{{target}}}.json` and `latest-windows.json` | `src-tauri/tauri.conf.json:46-47`, `tauri.windows.conf.json:6` (also in the installed binary) | Redirects. Updates are signed (Tauri key), so a squatter could **stop** updates but not forge one |
| Asset URLs inside `latest.json` (`…/releases/download/v1.7.0/ShipStudio_darwin-universal.app.tar.gz`) | served file | Redirects |
| "Install a specific version" `…/releases/download/v{version}/ShipStudio_darwin-…app.tar.gz` | `src-tauri/src/commands/setup/auth.rs:204,288` | Redirects. Check whether this path verifies a signature; if not, a squatter's tarball would be installed |
| Plugin registry `raw.githubusercontent.com/ship-studio/plugin-registry/main/registry.json` | `src/lib/plugins.ts:120` | Should redirect (verify with curl right after). **Highest-risk squat target**: the registry names the repos the app clones and runs as plugins |
| Plugin repos `github.com/ship-studio/plugin-*` (from registry.json) | registry.json, `plugin.json` in each plugin | Clone redirects. If you later edit registry.json to the new owner, old clients compare the URL literally (`normalize_repo_url` / `repoUrlsMatch` keep the owner), so installed plugins stop matching their registry entry: "Install" shows again for plugins already installed. **Leave registry.json on the old URLs** until a client that compares owner-insensitively (or by repo id) is out |
| Starter repos for Remote Access `create_project` | `src-tauri/src/remote_access/tools.rs:1725-1750` | Clone redirects |
| Issue reporter: `gh api repos/ship-studio/ship-studio/issues` POST | `src-tauri/src/commands/issue_reports.rs:17` | GitHub answers non-GET API calls on a renamed repo with 307; `gh` should follow it. **But** `parse_created_issue` (`:273`) accepts the result only if `html_url` is exactly `https://github.com/ship-studio/ship-studio/issues/N`. After the rename GitHub returns `…/thenativeagency/ship-studio/issues/N`, so **every installed client will file the issue and then say it couldn't confirm** (and ask the user to check the list, where they may file it twice). Fix in Ship Studio and release **before** renaming: accept either owner |
| Links: issues list, security advisories, discussions | `issue_reports.rs:18`, `IssueReportModals.tsx:50-51`, `.github/ISSUE_TEMPLATE/config.yml` | Redirect |
| Error reports' issue URL from the admin agent | `src-tauri/src/error_reporting.rs:620` | Owner-agnostic check, fine |
| Ship Studio's template gallery | `commands/templates.rs:7` → `www.ship.studio/api/v1/templates` | Not on GitHub; unaffected (checked: entries carry no GitHub URLs) |

### Ship Studio's own CI and the ship.studio site (you can change these)

| What | Where | After rename |
|---|---|---|
| Release publishing `RELEASES_REPO="ship-studio/releases"`, `gh release list/create/upload --repo ship-studio/releases` | `shipstudio/.github/workflows/release.yml:261,310,320,371`, `release-windows.yml:209,257,267,321` | Probably works through redirects; uploads go to `uploads.github.com` and are the least tested path. Change to the new name before the next release |
| `curl https://ship.studio/install \| bash` → `raw.githubusercontent.com/ship-studio/releases/main/install.sh` (and `install.ps1`) | `~/ShipStudio/ship-studio-marketing/next.config.ts:53-74` | Should redirect. **Not signed**: whoever owns `ship-studio/releases` runs code on new users' machines. Point the redirect at the new name the same day |
| Download page reads `api.github.com/repos/ship-studio/releases/releases/latest` | `ship-studio-marketing/lib/releases.ts:17-21` | 301 redirect, `fetch` follows. Update anyway |
| Footer and link-monitor links `github.com/ship-studio` | `ship-studio-marketing/lib/constants.ts:50`, `lib/link-monitor.ts:149`, `SITE.md` | The **org profile page does not redirect**: `github.com/ship-studio` will show the placeholder org (or a 404). Update |
| Admin agent's `GITHUB_REPO` (env, "owner/repo") | `~/ShipStudio/shipstudio-admin-agent/agent/tools/*.ts`, Vercel env | Works via redirect; set it to `thenativeagency/ship-studio` on Vercel |
| `package.json`/`Cargo.toml` repository/homepage, README badges, docs | shipstudio repo | Redirect; cosmetic |
| Windows `scripts/install.ps1:17` | shipstudio repo | Redirects |
| Vercel projects linked to `ship-studio/*` (ship-studio, ship-studio-marketing, ship-studio-agency, shipstudio-admin-agent, static-marketing-site-starter, saas-template-1, saul-goodman-lawyer-template) | Vercel dashboard | Vercel tracks the repo by id; deploys usually continue. Check each project's Git settings after, and reconnect if it shows "repository not found" |
| CodeRabbit and Slack apps | their dashboards | Installations are by org id; Slack `/github subscribe ship-studio/...` subscriptions should follow. Verify one notification |

### Mogbot (this repo; `~/Desktop/Projects/dashbot` is the same tree pre-rename)

| What | Where | After rename |
|---|---|---|
| `links.starterRepoBase: "https://github.com/ship-studio"` | `brand.json:30` → `src-tauri/build.rs:90` (compile-time) → `useProjectCreation.ts:105`, `remote_access/tools.rs:2463` | Clones redirect. Shipped Mogbot 1.0.0 has it compiled in, so the placeholder protects Mogbot users too. Change to the new base in the next build |
| `.github/ISSUE_TEMPLATE/config.yml`, `SECURITY.md:17,44`, `docs/FORKING.md`, `README.md:199`, `docs/ship-studio-readme.md` | links to Ship Studio's repo | Redirect; these are being rewritten for open-sourcing anyway |
| Tests/fixtures (`src/test/brandFixture.ts`, `IssueReportModals.test.tsx`, `error_reporting.rs` tests, `installProgress.fixtures.test.ts`) | string literals | Nothing at runtime; leave |
| `prototypes/site-migration/trial.sh:22`, `docs/internal/release-checklist.md:65` | scripts/docs | Redirect |

Nothing in Mogbot points at `native-io-team` except its own identity (brand.json `repository`,
`releases`, `updates`, `macDownload`; `tauri.conf.json:77`; `Cargo.toml`; `package.json`;
`scripts/install.{sh,ps1}`; `packages/companion-protocol/src/brand.gen.ts`), which matters only if
you rename *that* org (section 5).

### Elsewhere on this Mac

- `~/Desktop/Projects/plugin-registry/registry.json` (12 plugin repo URLs), `PLUGIN_DEVELOPMENT.md`.
- `~/Desktop/Projects/shipstudio-plugins/*/plugin.json` and READMEs, and `plugin-starter/src/index.tsx:415`
  (`openUrl('https://github.com/ship-studio')`, the org page, which **won't** redirect).
- `~/Desktop/Projects/shipstudio-starter-projects/*/README.md`.
- Local clones whose `origin` is `github.com/ship-studio/...` keep working through the redirect;
  `git remote set-url origin https://github.com/thenativeagency/<repo>.git` when convenient.
- No Homebrew tap of yours is installed (`brew tap`: only shopify, stripe, supabase), and none is referenced.

---

## 3. How GitHub behaves on an org rename

Redirects (as long as the name stays unclaimed and no same-named repo appears under it):

- Repo web URLs, `git clone/fetch/push` over https and ssh.
- REST API `repos/ship-studio/<repo>/…`: **301 for GET, 307 for everything else**. Clients must
  follow redirects. `gh`, `fetch`, octokit and Tauri's updater do.
- Release download URLs (`/releases/latest/download/…`, `/releases/download/<tag>/…`).
- `raw.githubusercontent.com/ship-studio/<repo>/…`: expected to redirect like the repo. Verify
  with `curl -sI` right after, because the install script and plugin registry depend on it.
- Issues, PRs, wikis, stars and watchers move with the repos. GitHub App installations, Actions
  secrets/variables and fine-grained PATs are attached to the org's **id**, not its name, so they
  carry over.

Does **not** redirect, or breaks later:

- **The org profile** `github.com/ship-studio` and `github.com/orgs/ship-studio/...`. No redirect.
- **GitHub Pages** `ship-studio.github.io` (not used here, every repo has Pages off).
- **Packages**: `ghcr.io/ship-studio/<image>` pulls and npm `@ship-studio/*` scopes are tied to
  the namespace. None found in code; confirm the Packages tab is empty.
- **The org name written as text** anywhere: workflow YAML (`--repo ship-studio/releases`), env
  vars (`GITHUB_REPO`), code that compares owners (`issue_reports.rs`, plugin URL matching), OIDC
  trust policies keyed on `repo:ship-studio/*:ref:…` (AWS/GCP/Azure/Vercel OIDC; none found here,
  but check any cloud role you set up), branch protection or CODEOWNERS naming `@ship-studio/<team>`
  (the org has no teams).
- **`uses: ship-studio/<action>@v1`** in other people's workflows: resolved through the redirect.
  It works but is fragile, and GitHub can retire popular namespaces. None of your workflows use one.
- **Squatting.** The old name is claimable by anyone the moment you rename. If someone creates
  `ship-studio` and then a repo with the same name as one of yours (`releases`, `plugin-registry`,
  `ship-studio`), that repo **replaces the redirect**: their content is served at your old URLs.
  For an app with a compiled-in update feed, registry and install script, that is a supply-chain
  risk, not just broken links.
- Search engines, people's bookmarks to the org page, and badges pointing at the org profile.

---

## 4. Safe plan

### Before (days ahead)

1. **Decide which org** (section 5). Everything below is written for `ship-studio` → `thenativeagency`.
2. **Ship a Ship Studio release that copes with the new owner** and let it roll out:
   - `issue_reports.rs` `parse_created_issue`: accept `https://github.com/{ship-studio|thenativeagency}/ship-studio/issues/N`, and use the canonical constant for the endpoint.
   - Plugin URL matching (`normalize_repo_url`, `pluginRepoUrl.ts`): treat `ship-studio` and `thenativeagency` as one owner, so registry.json can move later.
   - Leave the updater endpoint on the old URL in *this* release, so the feed has one moving part at a time.
3. Fill in what this check couldn't read: org secrets/variables, org webhooks, Packages,
   OAuth/GitHub Apps owned by the org (callback URLs), any cloud OIDC trust policy naming `ship-studio`.
4. Turn on the 2FA requirement for the org while you're in its settings (it's off).
5. Pick a quiet hour with no Ship Studio release running. Have a second browser tab ready to
   create the placeholder org: **the gap between steps 6 and 7 is the risk window.**

### The rename (one sitting, minutes)

6. github.com/organizations/ship-studio/settings/profile → Rename organization → `thenativeagency`.
7. **Immediately** create a new free organization named `ship-studio`, owned by you. Leave it
   **empty**: never create a repo in it, especially not `releases`, `plugin-registry`,
   `ship-studio`, a starter or a plugin name, because that would replace the redirect. The one
   safe exception is a profile README: it lives in a repo called `.github`, and none of your repos
   has that name, so a one-line "moved to thenativeagency" note is fine.

### Verify (same hour)

8. `curl -sIL https://github.com/ship-studio/releases/releases/latest/download/latest.json` ends 200 on `thenativeagency`.
9. `curl -sIL https://raw.githubusercontent.com/ship-studio/plugin-registry/main/registry.json` and `…/releases/main/install.sh` end 200.
10. `curl -fsSL https://ship.studio/install | head -3` starts with `#!`.
11. `git ls-remote https://github.com/ship-studio/astro-html-starter` works (starter clones, Ship Studio and Mogbot).
12. `gh api repos/ship-studio/ship-studio --jq .full_name` prints `thenativeagency/ship-studio`.
13. Ship Studio app: Check for updates; open the plugin Library; create a project from a starter; file a test issue (expect the "couldn't confirm" result on old clients).
14. Vercel: each linked project still deploys on a push (or a redeploy) and its Git settings show the repo.
15. Slack and CodeRabbit: one notification or review on a test PR.

### After (that day and the next week)

16. Update what you own: `ship-studio-marketing` (`next.config.ts` install redirects, `lib/releases.ts`, `constants.ts`, `link-monitor.ts`), admin agent `GITHUB_REPO` on Vercel, Ship Studio release workflows (`--repo thenativeagency/releases`), package.json/Cargo.toml/README links, local `git remote set-url`.
17. Mogbot: `brand.json` `links.starterRepoBase` → `https://github.com/thenativeagency` in the next build.
18. Next Ship Studio release: updater endpoint → the new owner. Old installs keep using the redirect, which is why:
19. **Keep the placeholder `ship-studio` org for as long as any Ship Studio or Mogbot 1.0 install exists. In practice, forever.** Put it on a calendar so nobody deletes it as "unused".

### Rollback

- Within the first hour: delete (or rename away) the placeholder `ship-studio` org, then rename
  `thenativeagency` back to `ship-studio`. Redirects from `thenativeagency` then appear, which is
  harmless. Old URLs never stopped working, so users see nothing.
- The ordering matters: you can't rename back while the placeholder holds the name, and the
  moment between deleting it and renaming back is the same squat window as step 6→7. Do both in one go.

---

## 5. Is this the rename you want?

What the two orgs hold:

- `ship-studio`: Ship Studio the product. 37 public repos, real users, an update feed, a plugin
  ecosystem. Renaming it to an agency name puts "thenativeagency" on a public product's repos,
  and every Ship Studio link in the world starts pointing through it.
- `native-io-team` (free plan, you are admin): the agency. 24 private client and internal repos
  (native-os, client sites for Parasail, Workspan, Traffiq, Beachhead, Red Cell, …), **Mogbot**
  (private) and **`mogbot-releases`** (public; Mogbot 1.0.0's update feed and DMG, published today).
  Apps: Vercel (all repos), ChatGPT Codex connector.

If the goal is "the agency's GitHub should be called thenativeagency", the org to rename is
**`native-io-team`**, and `ship-studio` should stay as it is. The same rules apply there, with
these differences:

- Mogbot 1.0.0 has `github.com/native-io-team/mogbot-releases/releases/latest/download/latest.json`
  compiled in (`brand.json` `links.updates`, `tauri.conf.json:77`) and `scripts/install.sh` /
  `install.ps1` point at it. So the placeholder `native-io-team` org is just as necessary, and the
  next Mogbot build should move `brand.json`'s `repository`, `releases`, `updates`, `macDownload`
  (and regenerate `brand.gen.ts` with `pnpm check:brand --write`).
- The mogbot-site download page (`mogbot-site.vercel.app/start`) probably links to
  `native-io-team/mogbot-releases`. I couldn't find its repo on this Mac or under either org; check it.
- Client repos: each Vercel project and any client's own integration with those repos (deploy
  hooks, collaborators' remotes) follows the redirect. Tell collaborators to update remotes.
- It's on the free plan with 25 repos. A rename changes nothing about billing.

If the goal is open-sourcing **Mogbot** under a clean name, renaming either org is a heavier
tool than needed. Alternatives:

- **Transfer** `mogbot` and `mogbot-releases` to a new org (`thenativeagency`, or a product org
  such as `mogbot`). Repo transfers redirect the same way. Nothing else moves, and the agency's
  client repos stay private and out of the public org. Keep a same-named placeholder repo out of
  `native-io-team` forever (that's the transfer equivalent of the placeholder org).
- Keep `brand.json` `starterRepoBase` on `ship-studio`: that stays the shared-compat source for
  starters whatever happens to the agency org.

**Recommendation:** don't rename `ship-studio`. Ask whether he meant `native-io-team`. If he did,
rename it with the same plan (placeholder `native-io-team` straight away). If the aim is a public
home for Mogbot, transfer the two Mogbot repos to a new org instead. Do the open-sourcing first,
and keep the agency's client repos out of any org that's meant to be public.

### Side notes found along the way (not part of the rename)

- `ship-studio/releases`' "latest" release is `v1.7.0-win`, and the macOS `latest.json` is served
  from that Windows-tagged release. It works today, but a Windows-only release could change what
  Mac clients see.
- The ship-studio org's 2FA requirement is off.
