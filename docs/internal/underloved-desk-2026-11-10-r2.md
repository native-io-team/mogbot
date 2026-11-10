# Underloved desk surfaces, round 2, 2026-11-10

The surfaces the overnight passes didn't reach (chat, Settings, ⌘K, usage, notifications, rooms,
import, Remote Access, Projects, onboarding and result cards were already loved; see the other
`docs/internal/*-2026-11-10*.md`).

**How it was looked at.** `pnpm harness` on port 1445 with its own `TMPDIR`, then
`node scripts/harness-capture.mjs --all --theme light`: every scenario and every palette command
(777 captures; 2 failed to settle before any change here, `mode-toggle-workspace` and
`settings-agents-quiet-off`, and `window.new` has no fixture). The shots were read as 2×2 contact
sheets plus full-size crops. Light theme on purpose: it is the one the night looked at least.

**Not checked:** WKWebView, the phone, a real merge conflict on a file with context lines or one
over the preview limit (the `conflicts` scenario has neither, so "The lines around them" and
"The whole of both" were checked only in code), and the non-text-file conflict view.

## What was weakest, and what changed

1. **Routine past runs cut off the reason.** (`agents-schedule-history`) Each run was one
   ellipsised line, so "Didn't run · Claude Code is signed out · Gmail ne…" lost exactly the part
   worth reading, and the times didn't line up. Now a two-column grid (subgrid): the time, then the
   outcome in its colour, then why, in full and muted underneath. On the Routines page,
   "last: ran" (read as a typo) is "last run: ran".

2. **The preview pane with no site said Open in workspace twice.** (`agents-preview-stopped-workspace`)
   The header's Open in workspace and a greyed-out Test it sat above a body that offered Open in
   workspace again. With no site (stopped, needs installing, no preview), the body alone says why
   and offers the way on; a test that can't run isn't shown. A failed start keeps the header's
   link, since its body has no action.

3. **Edit agent was a 440px column holding a whole briefing.** (`agents-edit-usage`,
   `agents-reach-editor`, `agents-heavy-editor`) Usage, what it can do, independence, admin,
   permissions, rules, what it can reach and skills under one hairline, in tables whose values
   wrapped onto three lines. An existing agent's dialog is now 580px (New agent stays 440 and
   calm). And the dialog mixed two save models without saying so: the top is a draft with Save,
   everything from independence down saves the moment it changes. One muted line where they
   meet now says "These apply as you change them, without Save."

4. **Admins listed "Not an admin" six times.** (`settings-agents-admins`) The switch already says
   off. Only an admin's row carries a line now ("Manages and approves local work for the others"),
   so the one that is stands out. `Row`'s description became optional rather than rendering an
   empty span. The empty activity says what goes there.

5. **The merge conflict dialog was Ship Studio's, untouched.** (`conflicts`, `branch.resolveConflicts`)
   Title Case everywhere (Keep Yours, Copy Prompt, Send to Agent, Abort Merge), shouted
   YOUR VERSION / THEIR VERSION, a warning triangle for something that isn't danger, a blue info
   box, Copy Prompt beside Send to Agent (two ways to the same place), "More information" that
   repeated both versions in full right under the panels, raw `px` throughout, and in the light
   theme the Keep buttons' words turned **white on light grey** on hover (`--text-white`). Now:
   sentence case and plain words ("Both branches changed the same lines", "Cancel the merge"),
   the merge icon, one plain line "Need parts of both? Your agent can combine them." with Send to
   agent, or Copy a prompt only when there's no session to send to; the fold holds only what the
   panels don't (the lines around them, and the rest of a version the panel cut short) and is
   absent when there's nothing; the Button family for everything but the yours/theirs pair; every
   value a token. The footer says what was silent before: closing the dialog cancels the merge too.

6. **The workspace's git surfaces shouted.** (`branches-many`, `gitlab-branches-tab`, `prs-open`,
   `modal.help`) Capitals for SYNC / BRANCHES / PULL REQUESTS / OPEN, Title Case section
   headings (Current Branch, Team Branches, Recently Merged), "Submit for Review", "Create Pull
   Request", "Help & Commands", and a red danger Close on every PR row beside Merge (closing a PR
   loses nothing and asks first; the confirm stays danger). All sentence case on the label type
   role now; the row's Close is a quiet ghost button.

7. **No engine said the three engine names twice above three buttons that say them again.**
   (`agents-no-engine-at-all`) The title names them once; the body says what it takes and that
   projects work without one.

## Left, on purpose

- **"Chrome, through Your Chrome"** in What it can reach reads oddly, but "Your Chrome" is the
  feature's name and that area changed this morning in another branch; not touched here.
- **Settings → Advanced → Spotify controls.** An inherited Ship Studio extra in an agents app.
  It may not earn its place, but removing a feature is the owner's call.
- **Deleting an agent is for good**, while an admin's delete goes to Recently deleted for 30
  days. The user's own delete could go there too (one restore path for both); a product decision.

## What I'd do next

- The rest of the workspace inherited from Ship Studio: `DevServerStatus`'s error copy ("The
  dev-server process is no longer running… often an AI agent in the terminal…"), the main-branch
  banner spanning the pane, raw `px` in `branches/main.css`'s Branch Indicator block and
  `pr-list.css`, Title Case in `GitErrorHandler` (Copy Prompt, Send to Agent).
- A conflict scenario with context lines and a long version, and one for a non-text file, so the
  dialog's other states are seen, not just read.
- The key picker's "All" icons open on text-alignment glyphs (align-left, columns), which no one
  would pick for an agent; lead with Featured.
- Closing the conflict dialog by Escape or a click outside cancels the merge. It now says so; it
  might be better to keep the merge and close only on the explicit button.
