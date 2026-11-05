# Agents

Persistent, named agents you chat with, the way Grok Bot works on desktop, but
every agent is a Claude Code session on your own Mac. One of them, the **Chief
of Staff**, manages the rest: it creates agents, briefs them, delegates to them,
keeps track of what they're doing, and deletes them when you say so. You can
talk only to the Chief and let it run everything else.

Agents is a mode, not a page. The **Agents | Projects** toggle at the top of
the sidebar (⌘⇧A, or ⌘K → Switch to Agents) turns the whole window into the
chat app: agent list on the left, one conversation on the right. Switching
back returns to wherever you were on the Projects side (the dashboard,
Workflows, the Inbox, or the open project); switching in returns to the last
conversation. While Projects is showing, an amber badge on the
Agents segment says an agent needs your OK or has news, and its tooltip says
which. New agent is ⌘N, the row at the foot of the agent list, or ⌘K. In the
collapsed rail the toggle is two stacked icons; below the compact breakpoint
it is an icon pair at the top bar's leading edge.

Agents is the primary view: the app opens on it (a project window opens its
workspace instead), and onboarding ends there. A new Chief's chat opens on its
greeting, `prompts::CHIEF_GREETING`, appended by `ensure_main` when it creates
the Chief: what it can do (create agents, delegate, approvals, projects, the
phone) and a question. It is stored, not generated, so nothing runs on the
user's plan until they reply, and `CHIEF_INSTRUCTIONS` tells the Chief it said
it. Three starters sit under it until the user's first message (see "A
first real result", below); while the greeting is all there is, it and the
starters sit in the middle of the page as an empty state (`data-greeting` on
the message column), not at the foot of an empty screen.

In Agents mode the sidebar's top row is the toggle (Home, Workflows and the
Inbox belong to the Projects side). **What's in flight** — the one name for
the cross-agent overview — is reached from a **"Needs you · N"** row at the
top of the agent list, shown only while an agent waits on you (a request, or a
turn that didn't finish; the same set ⌘J visits), and from ⌘K. A usage limit
is not waiting on you — it resets by itself — so it isn't counted: What's in
flight lists it under **Paused**, and in a chat it is a quiet centred line
with "Retry at 4:45 AM" (and a quiet "Try anyway", since the limit may have
lifted early), not a tinted box. There is no
icon for it: an unlabeled one was three names for one place. Its foot has the Phone row (the companion
app: pair, or which phone is connected); remote access, for driving the app
from another assistant, appears there only while it is on and is otherwise
reached from the Phone panel's last line or ⌘K. In a project's workspace
sidebar, agents bound to that project are listed above its terminal
Sessions; clicking one opens its chat.

## A first real result, and ready-made agents (`agents/templates.rs`)

The people this is for already run an assistant; what they can't get there is
work that keeps going without them. So the Chief's greeting starts on
pipelines, not one-offs: something starts it (a time, a file, an email, a
GitHub issue), agents hand the work between them, and it ends on a card the
user answers, on the desk or the phone. Three starters and **More ideas…**,
from one catalogue (`lib/chiefIdeas.ts`). Each types a whole, specific brief
with one blank at its end; none sends by itself.

- **Ship fixes while I sleep…**: every night a fixer bound to the repo's
  project takes the top open GitHub issue and fixes it in its own copy, a
  reviewer checks it (`message_agent`), and the morning brings one change
  card with Keep / Review / Discard. Pushing waits for the user.
- **Run my launch as a team…**: a strategist, a writer and a builder, the
  Chief keeping the plan in a file, and a 9am weekday standup it collects
  and summarises. The Chief puts the three and itself in a room
  (`create_room`, see "Rooms"), so the user talks to the whole team at once.
- **Turn client briefs into sites…**: `watch_for` `new_file` on a folder;
  each brief becomes a project (`blank` needs nothing installed) whose
  session drafts the site, handed back with `share_result` naming the
  project.
- **More ideas…** opens the gallery (`ChiefIdeasModal`, also ⌘K → "Ideas for
  your team…"), grouped On a schedule / When something happens / Agents
  together: watch competitors weekly (researcher + analyst, one brief), babysit
  errors hourly (reproduce, fix in a copy, a card to keep; one line when
  nothing broke, since a routine always leaves its line), an inbox triage
  crew (sorter + drafter through the user's email app; sending is always an
  Allow card), and two agents arguing it out. Its foot links Ready-made
  agents and the Phone panel.

**Setup is step one, never a dead end.** An idea may need what this Mac
doesn't have (GitHub signed in, the repo as a project, an email app, a
folder, a paired phone). The gallery line says so ("Your Chief helps you
connect GitHub first"), and `CHIEF_INSTRUCTIONS` has the Chief walk the user
through it in the chat, naming the real places (⌘K → Connect GitHub account,
Projects → Import from GitHub, ⌘K → Connect an app for agents…, ⌘K → Pair a
phone), checking each step before the next. Then the team, then the trigger
(said to run only while the app is open and the Mac awake), then **the first
run now**, while the user is there to choose Always allow for what it will
repeat unattended (a 1am run can't wait for an Allow). Always allow is never
suggested for sending, spending, pushing or anything reaching a client.

**A site comes back on a card, not by moving the window.** `share_result`
takes an optional `project` (a name from `project_list`, resolved against the
real list and refused if unknown), stored on the card as its path; the card
offers **Preview**, which opens the project only when pressed. A revision
keeps the project. The Chief is told not to call `project_open` (which takes
over the window) unless asked. When the turn also left a change card (a
project with git), the result rides on it and that card's own Preview is the
one shown.

The set is fixed, not rotated: two people comparing notes, and a screenshot
and the app, should see the same first screen.

**Existing Chiefs get the new instructions** (`agents::upgrade_chief`, on
every look-up of the Chief, one read when there's nothing to do). Every
earlier default is kept word for word in `prompts::PAST_CHIEF_INSTRUCTIONS`
(add the old text there whenever `CHIEF_INSTRUCTIONS` changes). If one is
found intact in the Chief's `## Instructions`, only it is swapped for the
current text: what the user added around it (or a `### From Ship Studio`
merge) stays, and `write_instructions` keeps the role, heading and `##
Memory`. Instructions the user rewrote (no old default left intact) are
theirs and are never touched or appended to: new guidance tacked onto rules
someone chose could contradict them. The Ship Studio Chief merge also skips
any past default, so stale guidance isn't merged in as the user's.

Research runs on the engine's own tools and account. On
Claude Code every web search and every page opened is a tool call the
approval broker asks about, so a first research turn can raise several
Allow cards. The Chief and the Research assistant are told to say so
before they start ("I'll ask before searching the web"), and a search's
card offers **Always allow web searches** (a `Tool` rule on `WebSearch`,
`permissions::suggest`); a page's card offers its one host, so each new
site still asks once. On Codex, web search is Codex's own built-in tool
(seen as `webSearch` items): it doesn't come through the broker, so it
runs without a card. There is no WebFetch on Codex; a command that
reaches the network is sandboxed and asks to escalate, with a card.
Whether a user's Codex has web search turned on (and live or cached) is
Codex's own setting, which the app doesn't read, so Research there may
find it can't search and says so, per its briefing. The briefings tell a
Codex agent not to promise cards it won't raise. Not verified: a live
Codex research turn.

A prompts.rs test holds each line of `CHIEF_INSTRUCTIONS` the ideas lean on.
Not verified: any of the pipelines on a live engine end to end (a night's
fix, a reviewer hand-off, a triggered site), and whether a routine turn at
1am stalls on an Allow the first run didn't cover.

**Ready-made agents** (role templates) are one catalogue,
`src-tauri/src/agents/templates.json`: Research assistant, Inbox triage and
Weekly review, each a name, role, colour, briefing and its own starters. The
backend reads it (`templates.rs`) and the desktop imports the same file
(`lib/agentTemplates.ts`), so what the dialog shows is what the agent gets.

- **The Chief** sees a "Ready-made agents" section in its prompt
  (`templates::chief_section`) and creates one with `create_agent`'s
  `template`: the template brings the role, briefing and colour; `role` and
  `color` override, and `instructions` is *added* under "About the user",
  never instead of the briefing. Only `name` is required.
- **New agent** starts with "Start from" (Blank and each template, a
  `SegmentedControl`). Picking one fills in the name, role and briefing, all
  editable; switching replaces only fields still showing the last template's
  words. ⌘K has one "New agent: <title>…" per template
  (`agents.template.<id>`).
- **The agent** records `template` (registry field, omitted when none). Its
  first open shows the template's starters instead of the generic ones, also
  when the Chief made it and its chat holds only "Created by" notes.
- **Inline connect, only where honest.** Only Inbox needs anything (`needs:
  "mail"`): it reads email through an app the user connects. The dialog and
  the agent's first open say so in one line ("It reads your email through an
  app you connect, such as Gmail.") with **Connect an app…** opening Apps
  (Claude Code agents; on Codex the line says to connect it in Codex). Nothing
  claims an app is or isn't connected: the engine lists its apps only once a
  turn starts. The briefing tells the agent to check, say so in one line and
  stop if it has none, and never invent a message.
- **Phone**: `agents.templates` (read-only; a Mac that serves it accepts
  `template` on `agents.create`) lists them without briefings; New agent shows
  "Start from" chips and the Mac fills in the briefing. The phone's Chief chat
  has no starters, and apps are connected on the Mac.

Not verified: a real turn on each template (briefing quality is untested
against live models; `scripts/agents-e2e.sh behaviour` doesn't cover it yet),
and Inbox against a live Gmail connector.

## What an agent is

| Piece | Where | Notes |
| --- | --- | --- |
| Identity | `<projects root>/.shipstudio/agents/agents.json` | name, role, avatar (shape + colour key), pinned/hidden, unread, Claude session id |
| Home | `<projects root>/.shipstudio/agents/<id>/` | the agent's working directory |
| Instructions + memory | `<home>/CLAUDE.md` | Claude Code loads it every turn. Instructions on top, `## Memory` below, which the agent maintains itself. Editing instructions never touches memory. |
| Conversation | `<home>/messages.jsonl` | what *you* were shown: your messages, its replies, agent-to-agent lines, approval cards, errors. Append-only |
| Card answers | `<home>/approvals.jsonl` | one line per answered approval card, applied over the card on read (answering never rewrites the log) |
| In flight | `<home>/turn.json`, `<home>/inbox.json` | the turn running now, and what is queued behind it; both survive a quit |

The chat log is ours, not Claude Code's transcript. The UI never reconstructs a
conversation from tool output it doesn't own (see "Never Assume Data").

## How a turn runs (`src-tauri/src/agents/runner.rs`)

Each agent has an inbox. A message from you or from another agent is queued; if
the agent is idle a worker drains the inbox, so everything that arrived while it
was busy becomes **one** next turn. A turn is one process:

```
claude --print --output-format stream-json --verbose --include-partial-messages
       --session-id <uuid> | --resume <uuid>
       --permission-mode acceptEdits
       --permission-prompt-tool mcp__shipstudio_agents__approve
       --mcp-config <app support>/agent-bridge/mcp-<random>.json   (0600; see below)
       --allowedTools mcp__shipstudio_agents
       --append-system-prompt <voice + role + team rules>
       --add-dir <projects root> --add-dir <each external project>
       --disallowedTools 'Edit(**/.git/**)' 'Edit(**/.shipstudio/**)'
                         'Edit(/<each added dir>/**/.git/**)' …
                         'Bash(git config core.hooksPath:*)' …
cwd = the agent's home, prompt on stdin, MCP_TOOL_TIMEOUT raised (see below)
```

**What a turn may write.** Its cwd and every `--add-dir` (the whole projects
root and every external project — not only a bound agent's own project;
narrowing that to the bound project is a product decision still open), minus
any `.git` or `.shipstudio` folder anywhere in them. Claude Code gets that as
deny rules: relative ones for its cwd and absolute `//` ones per added folder,
because a relative rule doesn't reach an `--add-dir` (verified on 2.1.318: a
Write into each is refused "denied by your permission settings", including in
an added folder whose path has a space and a comma). The rules cover the file
tools. For the shell there are also `Bash` deny rules for persisting the git
settings that make a later `git` run execute a program (`core.hooksPath`,
`core.fsmonitor`, `core.sshCommand`, in every `git config` scope); a deny wins
over any allow in the user's own settings. Those are prefix rules, so other
ways of writing into `.git` from a shell (`echo … > .git/hooks/x`, `cp`, an
interpreter, `git -C dir config …`) aren't matched; they aren't silent either,
since in `acceptEdits` every shell command asks through `approve` unless the
user's settings allow it. Treat all of this as defence in depth, not a
sandbox. Codex gets the same as a permissions profile (below). The copy-per-task commit is made by the app at the end of the
turn, never by the agent (`task`).

There is no long-lived process per agent, so twenty idle agents cost nothing.
The user's own Claude Code MCP servers and settings still load, which is how an
agent reaches Gmail, Calendar, Slack or anything else you've connected.

From the stream:

- every **top-level text block** streams: its text deltas (`stream_event`)
  build a draft sent as `agents://draft {agentId, id, text-so-far}` at most
  every 40ms, and the complete block is recorded under the draft's id, so the
  finished message takes over the same bubble (`agents/stream.rs`, tested on a
  captured real stream). Sub-agent text, streamed or not, is internal and is
  dropped. Stop mid-reply keeps what streamed, as a message marked `stopped`;
- while words are arriving the typing dots are hidden; they and the activity
  line come back between text blocks, while tools run;
- every **tool call** only updates the line under the agent's name ("Editing
  PricingTable.tsx", "Messaging Finance"); it never becomes a message;
- `system/init` confirms the session id, which is stored for the next `--resume`,
  and is checked against what we assume (`agents/broker.rs`, see Approvals):
  the permission mode it really runs in and whether our own MCP server started;
- an `is_error` result, or any exit without a `result` event (a crash, or
  output that wasn't stream-json, even with exit code 0), becomes an error
  line; a crash keeps what had streamed, marked `stopped`. `agents/failure.rs` words the two states people actually hit in
  Agents' own terms and tags the line (`failure`): "Claude Code's usage limit
  is reached. It resets at 3:00 PM." (`usage_limit`, with `resetsAt` only when
  Claude Code printed an epoch, or a clock time in this Mac's zone; a time in
  another zone is quoted, never converted) and "Claude Code is signed out."
  (`signed_out`). Anything else is shown as it came. The agent's registry entry
  carries the tag while the error is the newest line (`Agent.failure`, cleared
  by anything said after it), so the sidebar shows "<reason> · didn't finish"
  (the reason first, over up to two lines) with a red dot, or "Usage limit ·
  resets 3:00 PM" quietly with no dot at all (amber means needs you, only), and
  What's in flight lists it under Needs you with its remedy.

A vanished session (`--resume` → "No conversation found") is replaced once with
a fresh one. **Stop** ends the turn and drops the queue; it leaves a quiet
"Stopped" note (your doing, not a failure). A turn is capped at 3 hours.

**Start fresh, keep memory.** The agent menu, ⌘K and the phone's agent sheet
offer "Start fresh" (`agents_start_fresh` / `agents.startFresh`): the next
message begins a new conversation on the same engine, through the same path an
engine switch takes. Instructions and `## Memory` carry over; the session
doesn't, and nothing is recapped into the new one. The chat stays, with a
"Started fresh · memory kept" note (`fresh: true`) drawn as a divider. It's
refused while the agent is working, while a card in its chat waits on an
answer, while another agent still owes it the answer to something it delegated
(that answer would land in a conversation that never asked), and when its next
message already starts a new conversation. The check and the reset happen under
the inbox lock, so a message sent at the same moment either starts first (and
the fresh start is refused) or starts in the new conversation; two at once
record one divider. Any later recap (an engine switch, a vanished session) only
carries what came after the last divider. The prompts tell agents this can
happen, so anything they'll need later belongs in memory.

**Context meter.** `agents/context.rs` stores one reading per agent
(`Agent.context`: `used`, `window`, the engine's `model` id) from the engine's
own numbers: Claude Code's last `assistant` `message.usage` against the
`result` event's `modelUsage[*].contextWindow`, and Codex app-server's
`thread/tokenUsage/updated` (`last` against `modelContextWindow`, less
`reasoningOutputTokens`, which the next request doesn't carry — as Codex's own
`tokens_in_context_window` counts it; Codex's "% left" also sets aside a fixed
allowance, so it can read a point or two lower). `codex exec`
reports no window, so it gives no reading, and the UI shows nothing; nothing is
ever estimated. The editor shows "72% full · 144k of 200k tokens"; from 85% the
chat suggests starting fresh. A turn on the agent's own model replaces the
reading, or clears it when it gives none (stopped, timed out, an old Claude Code
without `modelUsage`, a `codex exec` fallback, a vanished-session retry); a
routine on another model (check-ins default to Haiku) leaves it alone, since
that model's window isn't the conversation's. A fresh start, an engine switch
or a model change clears it.

**Process trees.** Each turn's `claude` leads its own process group
(`agents::procs`). Stop, interrupt, the timeout and quitting walk its process
tree first (a backgrounded child that called `setsid` has left the group but
is still a descendant), then signal the group and every descendant: SIGTERM,
then SIGKILL after 1.5s. A dev server or watcher its Bash tool started dies
with it. Once `claude` closes its output, its exit and stderr are waited on
for at most 10s; once its result is in, for a few seconds, then whatever it
left running in the background is stopped too.

**Slots.** One turn per 2 GB of RAM may run at once, never fewer than 3 or
more than 16 (`agents/capacity.rs`; 16 on a 32 GB Mac, 4 on an 8 GB one). An
agent past that shows "Waiting for a free slot (N agents already working)"
with the real N, can be stopped while it waits, and picks up whatever else
arrived meanwhile when its slot frees. On a machine with 12 GB or less, a
turn also waits while the kernel's free-memory figure is under 1 GB and
another turn is running ("Waiting for free memory (1 agent already
working)"); a lone turn always runs.

**Quitting mid-turn.** A turn writes `<home>/turn.json` (pid, session, and
for a bound agent the project snapshot taken before it) while it runs. On
quit, `RunEvent::Exit` calls `runner::shutdown_sync`, which stops every
turn's process tree and leaves the marks in place. A crash or force quit runs
no cleanup at all, so at launch `runner::recover_after_restart` also stops a
leftover process (if its command line still names the session), removes the
mark, records the turn's change card if it changed the project, and ends on
an error line (tagged `failure: other`) saying the turn didn't finish. The
messages queued behind it (`inbox.json`) are then sent once, after a note
naming them; the interrupted turn itself is not re-run. What the last run
left is noted synchronously at launch (`runner::prepare_recovery`, before
anything can start a turn): those messages go back on the queue (and stay on
disk), and those agents' turns wait until recovery has dealt with them, so a
turn started in this run is never mistaken for a leftover and nothing is
sent twice. The mark is written *before* a batch leaves the queue, so there
is no moment a quit leaves neither. An update's restart waits for working
agents ("After agents finish"; click again to restart now).

**Nothing goes silent.** A worker that panics mid-turn resets the agent
(idle, slot freed, an error line saying the turn didn't finish) instead of
leaving it "working" forever. The panic is caught (`catch_unwind`) and
handled as a failed turn; a guard that fires while unwinding only resets
in-memory state, so a second panic in that handling ends one task, never the
app. Word to delegators keeps the dead turn's hop (and the 6-hop cap), and a
worker that died before taking anything tells the agents whose requests it
dropped. Recovery at launch can't hold turns forever either: each agent is
bounded (45 s), the whole pass too (150 s), a panic in one is caught, and the
gate opens however recovery ends; the worktree sweep runs after the agents.
A turn the app closed on before it took its messages (its mark names them,
and they were still in the inbox) is reported as sent again, never also as
"didn't finish · Retry"; and the "sent again" note names only what is still
queued, not messages a Stop dropped meanwhile. Stop, and the 3-hour limit, tell any agent
that delegated the turn "{name} couldn't finish: …", and a Stop tells each
agent whose request was still queued that it was stopped before it started.
A scheduled run is settled by its ticket id (it rides on the queued wake and
carries over an interrupt); stopped, or dropped by a Stop, it is recorded as
failed ("Stopped"), never as a success or left "Running". The status says
"Needs your OK" until every open card of the turn is answered (a count per
agent, per turn). Deleting an agent stops it, closes its queue (anything sent to it
meanwhile is refused and its sender told), and waits up to 3 s for its
turn to end; a write for an agent no longer registered is refused, so its
folder never comes back.

**Damaged files and newer builds.** `agents.json` is written atomically and
again as `agents.json.bak`. It is read and written losslessly: fields this
build doesn't know (on an agent, a check-in, a rule), unknown top-level keys,
and whole entries it can't read (a newer build's) are kept and written back
untouched, so running an older build never deletes what a newer one saved.
Only a file that isn't JSON counts as damage: the backup is loaded and written
back, and the damaged file is kept as `agents.json.corrupt-<ms>`; with no
readable backup it is an error, never an empty list that would be saved over
it. A chat line of a kind this build doesn't know is skipped on read and stays
on disk, since the log is append-only. A torn last line in
`messages.jsonl` is skipped on read, and the next append starts a new line
instead of fusing into it. Opening a chat and paging back through it
(`agents_messages` with `before`/`through`) read the log from its end, only as
far back as the page needs, and apply `approvals.jsonl` to the page read. A log that can't be written: the user's own send
fails with the reason; a reply mid-turn is still shown, with one error line
(at most a minute) saying it won't survive a restart.

### What it did (`src-tauri/src/agents/work.rs`)

Under the last thing a turn says (its reply, its error, or "Stopped"; never
a note someone else wrote into the chat, and never a "started fresh"
divider), one quiet line: "Worked 6 min · 23 steps · edited 2 files". It
opens into the steps in order, each with its time into the turn and any
screenshot it produced. Every step is something observed: a tool call in the
engine's own output (Claude Code's `tool_use`, a Codex item; a call reported
twice is one step), an approval card, a preview screenshot. A turn with no
steps has no line.

- **Outcomes are observed**: a call is a request, so each step is matched to
  what came back by id (Claude Code's `tool_result` by `tool_use_id`, with
  `is_error` and the permission decision beside it; a Codex item's
  completion and its `status`). Declined reads "Asked to run rm — you
  declined", failed reads "Tried to edit App.tsx", and both are drawn
  quieter (`outcome` on the step). An approval step says the answer: "You
  allowed: Run a command" / "You declined: …". "Edited n files" counts only
  edits that came back successful.
- **Words, safe by construction**: `work::describe_tool` is the one table.
  A command is only its program and subcommand ("Ran npm test", "Ran git
  push", "Ran curl": never arguments, URLs or environment), a web page only
  its host ("Browsed acme.com"), a file only its name, someone else's MCP
  tool a verb and the service ("Searched Google Drive", "Sent from Gmail",
  "Worked in Chrome"), our own tools past-tense words ("Shared a file").
  The engine's bookkeeping (ToolSearch, Skill, BashOutput, plan-mode
  switches) is no step at all; an unknown built-in is "Used a tool". The
  working line uses the present tense ("Running npm test").
- **Then scrubbed, then clipped**: Keychain redaction, then `work::scrub`
  (blanks secret-named variables, flags and headers, `-p…`/`-a`, query and
  JSON fields such as `sig=` and `"password":`, bearer values, URL user
  info, key- and base64-shaped strings), and only then the 100-character
  limit, so a cut never leaves part of a token.
- **Screenshots** attach to the screenshot call that took them: the oldest
  one still running for that project. A screenshot no call explains (it
  came with a session's reply) is a step of its own.
- **Live**: while the turn runs, the status carries `work` (the newest 12
  steps and the counts; no file names) plus `doing`, the running call's
  working-line words. The desktop's working line gets a "5 steps" toggle
  that opens the steps so far above it; the newest is left out only while
  the working line is saying it (`doing` equals the activity), never when
  the line is blank. A bound agent's list offers **Open project** (its
  workspace), and every agent's offers **Take over** (below), as does the
  working line itself. Taking over a browser tab the agent drives is not
  built.
- **Stored** beside the log, never in it: `turns/<message-id>.json`, sent
  again on `agents://message` when the turn ends, and applied only to the
  paged chat reads (desktop and phone), after the log's lock is released,
  with one listing of `turns/` per page. Search, summaries and the shared
  files list never read them. `messages.jsonl` stays append-only; older
  builds show no timeline.
- **Pruned**: an agent keeps the newest 500 timelines, and past its newest
  100 none older than 90 days; the replies stay, only what they did is
  forgotten. Deleting an agent removes its home and so its timelines;
  starting fresh keeps them, since the history above the divider is still
  shown.
- **Bounded**: at most 60 steps per turn (the newest; `stepCount` says how
  many there were), 30 file names.
- **Phone**: the message's `work` shows as the folded line and list under it
  (`mobile/src/components/work.tsx`). While it works, "Working · 8 steps"
  sits folded under the working row and opens into the steps so far. Live
  steps go only to an app that says it shows them (`hello.features:
  ["work.live"]`); others get the status without `work`, and the overview
  never carries it (it goes out on every registry change).

## Tools agents get (`src-tauri/src/agents/mcp.rs`)

Served by the existing loopback agent bridge at `/mcp/agent`. The path names
no one: the caller is the `Authorization: Bearer` secret it sends, 256 random
bits issued for that agent and that turn (`broker::grant`) and revoked the
moment the turn ends; an unknown, missing or ended secret gets a bare 404.
The secret never touches a command line, where `ps` shows it to every local
account (`agents/reach.rs`): Claude Code reads it from a 0600 `--mcp-config`
file in a 0700 folder of ours, removed when the turn ends (verified on
2.1.318: the header is sent on every request); Codex from an environment
variable named by `bearer_token_env_var` (verified on 0.166's app-server),
which Codex's default shell-environment policy keeps out of the commands it
runs because its name contains `TOKEN`. (Until 2026-11 the URL was
`/mcp/<bridge token>/agents/<id>?turn=<n>`, inline on the command line, so
any local account could read it and call in as any agent; the preview token
those turns exposed is replaced once at the next launch.)

| Tool | Who | What |
| --- | --- | --- |
| `list_agents` | all | names, roles, busy / waiting |
| `message_agent` | all | async: records "Messaged X" here and "Message from Y" there, queues a turn for X |
| `project_*`, `session_*`, `preview_screenshot`, `git_status`, `push`, `deploy_status` | all | working on projects, below |
| `share_file` | all | hands the user a file it made: copied into its `attachments/`, posted as its own message with a file card |
| `share_result` | all | ends a piece of work on one result card: files, links, what it checked and did not verify; revisions become v2 (below, "Result cards") |
| `request_secret` | all | a secure input card for a password, key, token or login; the agent gets `$VAR` and a reference, never the value (below) |
| `create_agent` | Chief | name, role, instructions, optional `template`, `project` and `first_task` |
| `update_agent` | Chief | name / role / instructions / project (memory kept) |
| `delete_agent` | Chief | puts an Allow / Deny card in the Chief's chat first |
| `create_room` | Chief | name, 2–6 members, optional lead, a one-line purpose (`agents/room_tools.rs`, below, "Rooms") |
| `add_to_room`, `remove_from_room` | Chief | change who's in a room (it keeps 2–6); a joiner gets the room's files |
| `approve` | CLI only | the permission prompt tool (below) |

**Answers come back on their own.** A `message_agent` request is a debt: the
turn that handles it owes the sender an answer. When that turn ends, whatever
it said (or "couldn't finish: …" if it failed) is delivered back to the
sender as its answer (`runner::return_results`), so delegated work always
reports back and the delegate never spends a tool call doing it. Messaging
the sender during the turn settles the debt instead (`runner::settle`). An
answer is framed differently from a request ("Billing's answer to your
request … tell the user the outcome; don't reply"), and handling it owes
nobody anything, so answers can't ping-pong. Stop drops the debt; an
interrupted turn passes it to the turn that replaces it.

**Loops.** Agents messaging agents can ping-pong. A user message starts a chain
at hop 0; each `message_agent` from a turn at hop *n* delivers at *n+1*, and
`message_agent` refuses past hop 6. The prompts also tell agents not to send
acknowledgements to each other.

## Working on projects (`src-tauri/src/agents/sessions.rs`)

Agents work on projects the way Remote Access does: in the
project's real agent tabs (backend PTY sessions), so the user can open the
project and carry on the same conversation. It is Remote Access's toolset,
run by the same handlers in `remote_access/tools.rs`, under names that can't
be confused with agent-to-agent `message_agent`:

| Agents | Remote handler |
| --- | --- |
| `project_list` / `project_create` / `project_open` | `list_projects` / `create_project` / `open_project` |
| `session_message` (the default) / `session_start` | `message_agent` / `start_agent` |
| `session_wait` / `session_read` / `session_key` / `session_close` / `session_progress` | `wait_for_agent` / `read_agent` / `press_key` / `close_agent` / `show_progress` |
| `preview_screenshot`, `git_status`, `deploy_status` | same |
| `push` | own: a card instead of the PIN |

- **Scope:** every project in the app (agents already run as the user with
  every project as an `--add-dir`), not the remote's opt-in list.
  `project_create` doesn't share the project for remote access and doesn't
  switch the window.
- **Answers:** the shared STATUS / reply / NEXT shape, with remote tool names
  rewritten to the agent's (`sessions::rename`, whole identifiers only).
- **Chat:** each call runs inside `AGENTS_CALL` (a task-local in
  `tools.rs`), which collects what it started, the replies it saw and its
  screenshots. They become `session` lines: "Started a session in
  acme-marketing", "Sent to acme-marketing · Claude Code 1", the reply (once
  per distinct reply), and screenshots inline. "Open session" opens the
  project with that tab selected (`openAgentSession` →
  `useRemoteAgentControl`). Screenshots are written to the agent's
  attachments and never stored behind the remote's public image links.
- **Window: it never moves because of an agent.**
  - *Sessions* start in the background. `start_agent` emits
    `remote-start-agent`; `lib/backgroundSessions.ts` spawns the PTY with the
    same builder a mounted tab uses (`lib/agentSpawn.ts`: PATH, `--session-id`,
    auto-accept, `--add-dir` libraries, the prompt as argv), then the
    project's tabs adopt it: its in-memory list if this window has opened the
    project (the active tab is left alone), otherwise its saved list in
    `.shipstudio/project.json`, which opening the project restores from. The
    Terminal that mounts then finds the PTY alive (open is idempotent) and
    replays its scrollback, so the conversation is all there. Messages,
    reads, waits and key presses were always backend-only (`pty_session`).
  - *Screenshots* are taken off-screen: headless Chromium (the preview's own
    Playwright capture) against the project's running dev server, found
    through its preview proxy (`proxy::dev_server_port_for`) — so not even
    the page or width of a preview the user is looking at changes. With no
    dev server running, the answer says the preview isn't running and the user
    can open the project; starting one would mean opening the project.
  - *Closing* a session is the tab's × done in the background, the same way.
  - `project_open` is the one tool that switches the window, because the user
    asked to see the project. "Open session" on a session line does too: the
    user clicked it.
- **Safety:** unchanged shared rules. Text only to agent tabs, never shells;
  a leading `!`, a `/` command outside the allowlist and control characters
  are refused; an opening prompt can't start with `-`.
- **Push:** no PIN. `push` puts a card in the agent's chat ("Push
  acme-marketing") with the branch, origin (credentials stripped), the
  commits and what gets committed first. It has no tool call behind it, so
  no "Always allow" is offered and no rule can skip it. Allow pushes exactly
  the tree the card described (`frozen_tree` / `push_frozen`); a change in
  between pushes nothing. An unanswered card expires after 240s.
- **Questions a session asks** (`agents/decisions.rs`): when a session stops
  on something it can't answer itself (Claude Code's folder-trust dialog, a
  permission prompt in the tab, any menu or y/n `agent_state.rs` recognises),
  the app raises a card with the prompt's own text and options, and the
  agent's tool call waits on it like `approve` (240s; then the card stays live
  and an answer wakes the agent with "call session_wait"). The card goes in
  the owner's chat **and** where the work came from: up the delegation chain
  (`runner::turn_origin`) to the agent the user asked, plus the chat a window
  is showing. One request id in every chat; answering in any resolves all
  (`decisions::resolve_all`), the others turning into the quiet "Allowed ·
  Yes, I trust this folder" line. It is announced once (`record_quietly` for
  the copies) and counts as "Needs your OK" in each row, ⌘J and the badge.
  Allow / Deny (or the session's other options) send that option's keys
  (its number; for the trust dialog's unnumbered menu, arrows then Enter),
  after checking the session is still asking the same thing. Agents can't
  answer: `session_key` refuses while a question is up, and the prompts tell
  them to say "Allow it on the card above". A message refused because the
  session was asking is sent once the card is answered.
- **Folder trust:** one card per project ("Let Claude Code work in
  demo-site?"). Allow writes `projects["<real path>"].hasTrustDialogAccepted
  = true` into `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), keeping
  everything else, then answers the dialog in every session of that project
  showing it. Observed with Claude Code 2.1.318 in a throwaway HOME: that is
  exactly what accepting the dialog writes, keyed by the canonical path, and
  an entry with only that key (on the folder or a parent) skips the dialog.
  Nothing is trusted without the card.
- **Change cards:** a message that changed the project leaves a `changes`
  card ("Changed 1 file in demo-site", View diff), once per message.
- **Audit:** the remote's `remote_audit.jsonl`, same rules (reads skipped,
  previews only), with `actor` set to the agent's name. The Remote access
  modal's activity list leaves those out.
- **Bound agents** are still an option; sessions are the default.

## What an agent can do (`src-tauri/src/agents/capabilities.rs`)

Turns run with `--chrome`. Each turn's `system/init` lists the session's
tools and MCP servers with their status; the runner keeps the last one on
the agent and builds one line per kind of capability (projects, the team,
Chrome, computer use, on this Mac, connectors, needs sign-in). The lines go
into the next turn's prompt ("What you can do here") and into the editor
("What <agent> can do"). Nothing is listed before the first turn.

Verified on Claude Code 2.1.318 in `--print`: Claude in Chrome loads with
`--chrome` and a tool call answered (extension connected); the user's MCP
servers load with their status; there is no computer-use server in a
headless turn, so it isn't claimed. Not verified: Chrome with the extension
disconnected (the line then says "Not connected" if Claude Code reports it
so), and a Chrome call going through an approval card in the running app.
`cargo test --lib agents::capabilities -- --ignored` repeats the headless
check.

## Lines, cards and bars (`components/agents/AgentCard.tsx`)

Everything in a conversation that isn't something someone said is one of
three surfaces, so a chat with a request, a copy to keep and an import going
at once still reads as one product:

- **Line** — one quiet centred sentence, no surface, that wraps (never cut
  with an ellipsis: the cut half is usually the reassuring part). Something
  that happened: notes, the fresh nudge, "Started fresh · memory kept", a
  usage limit, a take-over that closed by itself. At most one text action.
- **Card** (`AgentCard`) — something that wants a decision or holds a
  result: approvals, a session's question, secret requests, import consent
  and review, the change card, the result card (`share_result`; a project
  copy's change card sits inside it, without a second surface), a real
  failure. Icon (semantic — a shield,
  a lock, a folder, a download; the warning triangle only for real danger),
  title, a muted source line ("Acme Site · in demo-site"), the body, a muted
  note, then the actions **right-aligned with the single affirmative last**.
  The affirmative (Allow, Save, Keep changes, Import) is the neutral
  `strong` button, never the accent (docs/design-system.md, "Answers are
  neutral"). `danger` only for what destroys work (Discard, Delete).
  Answered, a card becomes its outcome line.
- **Bar** (`ConversationBar`, stacked by `ConversationBars`) — the state of
  this conversation until it ends, in the reading column directly above the
  composer, in a fixed order: take-over, import, other agents' requests, what the engine can't do, a
  key in the draft, dictation blocked. At most two show; the rest fold into
  "N more". A key in the draft never folds: it guards something the user is
  about to do and can't take back, so it always shows and the others fold
  around it. A bar says the state, never repeats the card's question, and
  never points at "the card". Nothing spans the pane under the header.

The **header is identity only** (badge, name, role, project chip). What an
agent is doing is said once in its sidebar row and once in the conversation
(a bar or the working line) — never a third time up there.

Another agent's request shows in a chat one way: the requests bar above the
composer ("Lead Gen needs your OK", "16 agents need your OK"), whose Review
panel opens the same cards in place. A session's question reaches every chat
its work touched; in a chat that isn't its owner's it is left out of the
conversation and offered by that bar instead.

Vocabulary, one word per idea: a **request** (answered with **Allow /
Deny**; "Needs your OK" wherever something waits on you — sidebar row, What's
in flight, the phone); **copy** only for a project copy; **conversation**,
never "session", in what people read; **Take over / Hand back** (no noun
"take-over" in copy); **Start fresh**, **Review changes**, **Preview**,
**Open in <project>**; **logins** for what an agent needs signed in; "Mac"
where the copy means this computer. No branch names, exit codes, tab
numbers, "via connector" or "(import)" in anything a person reads.

## Approvals

`acceptEdits` lets an agent edit files inside its home and every project
without asking. Anything else Claude Code would prompt for (a shell command
that isn't read-only, a web fetch, an MCP tool like sending email, a file
outside those folders) goes to `approve`, which puts a card in that agent's
chat showing the exact command, file, URL or tool input, and waits for
**Allow** or **Deny**. While it waits, the agent's row says "Needs your OK".

**What the broker trusts** (`agents/broker.rs`). Each turn gets an id, named
by its secret, open until `run_turn` returns. An `approve` call with no
turn, from a turn that has ended or been replaced, or repeating a
`tool_use_id` already asked, is denied at once with no card: those could
only ever be zombie cards. A timeout is never recorded as the user's answer:
a permission card stays live (below), a confirmation is marked expired, and
the agent is told the request expired, not that the user said no. Every turn's
`system/init` is read for its real `permissionMode` (verified on 2.1.318:
`"acceptEdits"`): `bypassPermissions` would mean nothing ever asks, so the
turn is stopped before it acts; a stricter mode (`default`, `plan`,
`dontAsk`) or one we don't know is noted once in the chat and carried on. If
our own server shows `failed` there, its approval tool doesn't exist and the
turn is stopped too.

Codex turns get the same: the turn's secret is what Codex presents to our
server, and Codex's own approval requests go through
`broker::admit` before a card (`codex_app::answer`, request ids named
`codex-<turn>-<jsonrpc id>` because JSON-RPC ids restart with each
app-server). The init check is Claude Code's only: Codex is started with the
approval policy we set, not one it reports back.

**Misclicks.** Allow, Always allow and a session question's options are inert
for 400 ms after a card appears, and a click the keyboard produced counts only
if the key went down on that button, so typing in the composer can never
answer a card (`useCardGuard`). Deny is never held back.

Verified against Claude Code 2.1.318: the tool receives
`{tool_name, input, tool_use_id}` and must answer
`{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`.

Two timeouts shape the design, both observed:

- **~60s**: Claude Code's default MCP call timeout. A timed-out approval came
  back to the agent as "Bash is hanging". Turns set `MCP_TOOL_TIMEOUT` well
  past our wait.
- **300s**: Claude Code abandons a *permission prompt* at five minutes
  regardless of `MCP_TOOL_TIMEOUT` (two unanswered cards were both given up at
  exactly 300s, while their buttons still looked live).

So approvals are asynchronous. `approve` waits 240s. If you haven't answered,
it tells the agent "the user may be away: stop, say what you need, you'll be
woken if they allow it", and **the card stays live**. A late **Allow** grants
that exact tool call once (same tool, same input) and queues a turn telling the
agent to carry on; its retry goes through without a second card. **Deny** is
one click and just records the answer. **Deny with a note…**, in the card's
… menu (as on the phone), declines and hands the
agent what you typed: as the deny message while it waits on the card, or as a
queued turn when it doesn't; the card keeps it ("Declined · “…”").
Live cards survive restarts, because the
tool and input are stored on the card. The app's own confirmations (delete
an agent) do expire, since they only mean something while asked. The sidebar
shows "Needs your OK" while any card is open (`pendingApprovals`).

**Answered where you are** (`AgentRequests.tsx`, counts in
`lib/agentRequests.ts`). Other agents' open cards are offered in the chat
you're in by one bar above the composer, in the Chief's chat for every
agent, elsewhere for the agents that chat has worked with: "Lead Gen needs
your OK" (one or two agents are named), "16 agents need your OK" past that,
with what they are ("41 logins to add", "3 requests", "2 requests, 1 of them
a login": a login is a secure input card) and **Review**. The bar has one
height and one place, so the conversation never moves for it; it replaced a
chip per agent at the foot of the chat, which after an import stacked sixteen
deep under every message. Review opens one panel rising from the bar across
the reading column: "Needs your OK · 16 agents · 41 logins", the agents in
name order (so the list holds still as you answer it), each a row with its
line ("4 logins: Slack bot token, Slack user token…", or the one request's
title) that opens to its cards, answerable in place, and **Open chat**. With
one or two agents every row starts open; past that, all start folded, so
the whole list is in view before you pick. ↑ ↓ Home End
move between agents, Esc or Done closes and returns focus to Review, a click
elsewhere closes it where you clicked. An answered card stays, resolved, until
the panel closes, and focus moves to the next Allow. Counts come only from the
cards in each agent's loaded lines plus the registry's `pendingApprovals` for
older ones ("2 more are further back in its chat"); nothing is estimated, and
cards that were waiting before the bar existed show as they are. Answering it
there answers it everywhere (one request id). A card already in the chat (a
session's question) isn't offered twice. The phone has no such stack: its
Chief chat shows only the Chief's own cards, and the agent list's "Needs you"
section is where other agents' requests are. A run of the same request from one
agent with nothing of yours between says "2 of 3 similar requests" on each
card, counted from the cards that have arrived, never from how many might
follow (`approvalSeries`).

**Always allow** (`agents/permissions.rs`). A permission card can offer a
quiet "Always allow …" beside Deny / Allow, scoped when the card is made and
stored on it, so the UI can only accept that scope, never widen it: a Bash
command's leading words (`npm test`, `git push`, `npm run build`), or the exact
command for wrappers and risky programs (`sudo`, `rm`, `bash`, `curl`…) and for
anything whose second word is a flag; one exact host for WebFetch; one
connector tool; web search. Never Bash, Write or Edit as a whole, and never on
The app's own confirmations (delete an agent has no tool call, so no
scope). A command only matches if it is one plain command: `;`, `&`, `|`,
redirects, `$`, backticks, parentheses, backslashes and line breaks all ask
again, so `npm test && rm -rf ~` never matches `npm test`. Rules are stored per
agent (`Agent.permissions`); each auto-allowed call leaves a muted `note` line
("Allowed automatically: npm test · Always allowed"); the agent editor lists
them under Permissions with Revoke. A card answered this way reads "Always
allowed · npm test" (`Approval.alwaysAllowed`, with `always` set to the rule).
Adding a rule also answers every other open card from the same agent that it
covers (`mcp::covered_by`), through the same path as Allow: a live waiter is
woken, and a card nobody waits on any more gets a late Allow that wakes the
agent.

## Secrets (`src-tauri/src/agents/secrets.rs`)

`request_secret {name, purpose, kind, fields?}` puts a secure input card in
the agent's chat: what it wants, why, a masked field per part, Save / Deny.
It's an approval card (`Approval.secret`), so it counts as "Needs your OK",
notifies, and shows in What's in flight; nothing waits on it, so it survives
restarts and can be answered whenever. Save (`agents_save_secret`) sends the
value from the webview to the macOS Keychain, service
`ship-studio-agent-<agent id>`, one item per variable, and wakes the agent
with the variable's name and the reference (`secret:finance/stripe_key`).
Deny wakes it with a plain refusal (or the user's note). The registry keeps
names, purpose, reference, created and last-used only.

**Use: environment variables.** Each turn is a fresh `claude` process, so
that agent's turns (and no other's) start with its secrets as variables
(`$STRIPE_KEY`; a login's fields as `$BANK_USERNAME`, `$BANK_PASSWORD`), and
the turn's prompt lists which it has. Chosen over a `use_secret`
substitution tool because it needs no command runner of our own, works for
scripts and SDKs that read the environment, and an approval card shows the
command with `$STRIPE_KEY` unexpanded. Variables that change the shell,
Claude Code, the linker or git (`PATH`, `CLAUDE*`, `DYLD_*`, `GIT_*`…) are
refused as names. "Last used" is the last turn started with it; whether the
agent read it isn't known.

**Redaction** (defence in depth): every known value (loaded at launch, and on
save or injection; 6+ characters) becomes `[secret:…]` in every line the
store appends (chat log, card answers), the queue, recorded and emitted
messages (a session's question card included: its question, options and
the answer picked, in every chat that holds it), drafts, the activity line,
the prompt piped to the next turn, and the remote/agents audit log. Not covered: a turn that prints the variable
sends it to Claude as tool output and into Claude Code's own transcript; the
prompt forbids printing one.

Every agent is told to ask with `request_secret` and never to ask for a
credential in chat. If the composer holds something key-shaped (Stripe,
GitHub, OpenAI, Anthropic, AWS, Slack, Google, JWT, `password=…`), a quiet
line offers "Store it securely" (`agents_add_secret`), which replaces it in
the draft with its variable; it never blocks sending. Edit agent → Secrets
lists them with Revoke, which deletes the Keychain items; deleting an agent
deletes its items too. macOS only, like workspace credentials.

## Steering a working agent

Sending mid-turn queues the message for the next turn (default). The newest
queued bubble says "Queued, sends when <agent> finishes" with **Interrupt and
send now**, and the working indicator sits above the run of queued messages
at the end (what it's doing now, then what's waiting); ⌘↵ in the composer sends and interrupts at once. A message is
queued when it was sent after the turn in progress began (`isQueued`: its `ts`
is after `status.since`). `agents_interrupt` cancels the turn without dropping
the queue (Stop drops it); the cut-off reply is kept as `stopped`, a note
"Interrupted to read your new message" is recorded, and the next turn's prompt
opens with `prompts::interrupted`: what it was working on, its last step, and
that the work already done stands. A card the interrupted turn was waiting on
stays live, with the usual late-Allow behaviour.

Esc in an empty composer stops a working agent only when pressed twice within
1.5s: the first shows "Esc again to stop <agent>" where the hint goes, so a
reflexive Esc never drops a turn. ⌘K also lists "Stop <agent>" for every agent
that isn't idle (with a confirm), Allow / Deny for the oldest card waiting on
you, "Next agent that needs you" (⌘J: a card, or a turn that didn't finish;
the Needs you row's tooltip says ⌘J too), and the open agent's own actions,
everything in its … menu by name: Edit, Pin / Unpin, Mute / Unmute, Hide /
Show, Mark as unread, Start fresh, Open <agent>'s project (when it works in
one) and Delete (with the same confirm). The stop control is a square glyph,
"Stop (Esc twice)".

**Activity, in words** (`plainActivity`). The engine's activity line
("Editing PricingTable.tsx", "$ npm test", "Reading …/src/App.tsx") is shown
as a person would say it — "Working on the pricing table", "Running a
command", "Reading the app" — in the header, the sidebar, the working
indicator, delegation lines and What's in flight. A line that's already plain
("Drafting the reminders") is left alone; only file names, paths, commands
and URLs are put into words.

## Take over (`src-tauri/src/agents/takeover.rs`)

Step into the agent's own session and drive it by hand, then hand it back.
From the agent menu ("Take over" / "Hand back"), the ⋯ beside the working
line, and ⌘K ("Take over <agent>" for the agent you're looking at only;
"Hand <agent> back" for any agent you're driving). Offered once
the agent has a conversation on its engine (`sessionId`, not `newEngine`).

- **Paused.** `runner::claim_for_takeover` sets `driven` on the agent's
  runtime under the inbox lock, and only while no turn is running or waiting
  for a slot. While driven no turn starts: messages from you, the phone,
  other agents and one-time check-ins wait in the queue (and in `inbox.json`);
  a routine coming due is skipped, moved to its next time, recorded as a
  `skipped` run, with a note ("Skipped “Morning brief” · you were driving
  Finance"). `list_agents` tells other agents their messages wait. Start
  fresh, and a change of engine or project, are refused until hand-back —
  for the editor and the Chief's `update_agent` alike, through one helper
  (`runner::update_settings`) that checks under the same lock the claim is
  made under. Deleting (`takeover::delete_agent`, used by both the command
  and the Chief's `delete_agent`) stops the turn first, then ends the
  take-over dropping its queue, so nothing starts a turn on the way out;
  only then is the agent's copy cleaned up (`task::abandon`: pending work
  committed on its branch first, the copy kept if anything couldn't be), so
  the terminal is gone from the copy before the copy is. An update must pass
  both guards: no engine/project/work-directly change while driven, and no
  rebind while a copy is open (`task::refuse_rebind`). Keep and Discard are
  refused while driven, since the terminal is working in the copy.
- **Mid-turn** the session is in use, so take-over is refused and the UI asks:
  **Stop and take over** (Stop, as ever dropping the queue; then waits for the
  turn to end, ≤15s) or **Wait**.
- **The process** is spawned in Rust (`pty_session::open_session`), so the
  bridge token and the agent's secrets never enter the webview: the engine's
  interactive CLI resumed on the agent's session, in the turn's working dir
  (`project::layout`: home, its project, or its open copy of the project —
  exactly where a turn would run), with the turn's environment (PATH, secrets,
  `MCP_TOOL_TIMEOUT`, the nested-session variables removed, no workspace
  account variables) and the turn's own command line minus what only a
  headless turn needs:
  - Claude Code: `claude::interactive_args` = a turn's args without
    `--print`, `--output-format`, `--verbose`, `--include-partial-messages`,
    `--permission-prompt-tool` (it asks in the terminal, to you): `--chrome
    --resume <session> --permission-mode acceptEdits --mcp-config …
    --allowedTools mcp__shipstudio_agents --append-system-prompt … --add-dir …`.
    Its secret is granted with no turn (and revoked at hand-back), so anything
    that reaches `approve` is refused; the agent's other tools (message an
    agent, share a file) work.
  - Codex: `codex resume -c sandbox_mode="workspace-write" -c
    approval_policy="on-request" -c developer_instructions=… <every turn's
    -c> [-m model] -C <cwd> <thread>`. `developer_instructions` is the
    agent's identity plus its secrets section, as a `codex exec` turn passes
    it. Built from `codex resume --help` on 0.166; not run against a real
    thread (no signed-in account on the build machine).
  The PTY has no project in its metadata, so remote access and other agents'
  `session_*` tools can't see or type into it, and the phone is never sent
  its id. Its id starts `takeover-`: a tab's `pty_session_open` may attach to
  it while it runs but never respawns it, and the take-over's watcher also
  checks the pid, so a respawn can't pass for the take-over.
- **Edits are auto-accepted while you drive**, as they are for the agent
  (Claude Code's `acceptEdits`, Codex's `workspace-write`), in its projects
  too. Bash still asks. The bar's tooltip says so once; Shift-Tab changes
  it in Claude Code.
- **Trust.** If Claude Code hasn't recorded the folder as trusted
  (`hasTrustDialogAccepted` on it or a folder above, in `.claude.json` under
  `CLAUDE_CONFIG_DIR` or home — read, never written), the bar adds:
  "Claude Code will ask whether to trust this folder — choose “Yes,
  proceed”. Choosing No hands it back." Codex's trust prompt isn't
  checked.
- **Where.** A bound agent's session becomes a tab in its project's workspace
  (`adoptTakeover` + focus, through `useRemoteAgentControl`), which opens. The
  tab is never saved: `set_terminal_state` drops `takeover-` tabs, and
  `get_terminal_state` drops any on disk and adds the ones running now, so
  a quit, crash or hand-back leaves no ghost tab to respawn.
  Any other agent's shows in its chat in place of the conversation
  (`AttachedTerminal`, attach-only), with "Show chat" to see the conversation
  and composer. Either way a bar above the composer (with the other bars;
  under the terminal when it fills the column) says "You're driving
  Finance in a terminal · Hand back"; the sidebar row reads "You're driving
  Finance" unless a request outranks it; the header stays identity only.
  A message you send waits ("Waiting, sends when you hand Finance back").
  Keep changes and Discard on its copy are disabled until it's handed back
  (the backend refuses them too), and the fresh nudge doesn't show.
- **Hand back** (the button, ⌘K, or the process exiting, noticed within
  0.5s). If the terminal printed in the last 2s it is likely mid-response,
  so the button asks first ("Hand back anyway?"); anything typed but not sent
  is dropped. Ctrl-C three times, 300ms apart (Claude Code's first clears the
  prompt, its second arms "press again"), then up to 5s for it to exit; only
  a process still alive with the session on its command line is killed
  (pids get reused). Only then is `driven` released, so a turn and the
  terminal never share the session. A note says "You handed Finance back after 6 min";
  if the session's transcript grew, the next turn starts with
  `prompts::handed_back`. Start fresh and an engine switch clear that
  preamble. A bound agent's tab is closed (`remote-close-agent`). Deleting
  the agent ends a take-over without a note.
- **Closed by itself early** (within 10s, or with a non-zero exit — the
  trust question answered No, a rejected flag, a crash): a quiet note
  (`kind: note`, `takeover: true`), not an error — it isn't the agent
  failing — says so plainly with the terminal's last lines in a mono block
  (`remote_access::screen::render_tail`), no preamble, and no Retry. Being a
  note, it sets no failure, alerts nobody, and peers and the phone never
  call it "didn't finish". Older builds wrote it as an error; those still
  render with the block and no Retry.
- **Phone:** the overview carries `takeover` (without the PTY id); the phone
  says "Being driven on your Mac" on the row, the chat header, the composer
  and a queued message, the only phrasing it uses for this, offers no Stop,
  and queued messages wait. It can't take over.
- **One mark on disk.** `<home>/takeover.json` (pid, session) from open to
  hand-back. At the next launch a leftover mark means the app quit or crashed
  mid-take-over: the CLI is stopped if it outlived the app (only while it is
  still that CLI), and the chat says the take-over ended. What waited is sent
  like any interrupted queue.

Verified for Claude Code 2.1.318 with a throwaway folder on Haiku (about two
cents): `--print --session-id`, then interactive `--resume` in a PTY (a new
message, Ctrl-C twice exits), then `--print --resume` recalled both turns
under the same session id. In a folder Claude Code hasn't been told to trust,
the interactive CLI first shows its own trust dialog (default "No, exit"),
which the person at the keyboard answers; nothing is trusted for them.

## Notifications (`src-tauri/src/agents/notify.rs`)

The backend decides, since it knows when a message is recorded and when a turn ends.

- **On screen** = a *focused* window is showing that agent (`agents_focus` reports which agent each window shows; focus is asked of the window at that moment). Messages on screen neither notify nor count as unread.
- A reply or error off screen notifies with the agent's name and the first line. Inside a turn they are held and posted once when it ends, with the latest text. An approval posts at once, with a sound.
- Bursts across agents are capped (3 per 20s); the rest stay silent but still count.
- **Mute** (row context menu) stops OS notifications for that agent; a bell-off mark shows in its row. Unread and the badge still count it.
- **Dock badge** = unread + pending approvals across non-hidden agents. The mode toggle's badge is on whenever any non-hidden agent is waiting or unread. Approval cards don't add to unread; they count as pending until answered.
- Clicking a notification focuses a window and emits `agents://open`; the app switches to Agents and opens that agent. Focusing a window clears the unread of the agent it shows.
- Uses `tauri-plugin-notification` (2.8, click reporting on macOS). Not verified in a real build yet: the dev binary posts under another app's identity, so click-through should be checked in a signed build.

## Memory you can see (`src-tauri/src/agents/memory.rs`)

The agent editor has two tabs, Agent and Memory. Memory lists the `## Memory`
section of the agent's CLAUDE.md as entries (each top-level list item or
paragraph; a `### Imported from …` heading groups what came with an import),
with add, edit and delete applied at once and Undo in a toast. Nothing is
re-rendered: a change splices only that entry's lines, so the instructions,
the agent's own formatting, code fences, CRLF and the rest stay byte for
byte. An edit or delete names the entry by position and its text as shown;
if the agent rewrote it meanwhile, the change is refused and the list reloads.
Deleting returns the exact lines removed, which Undo puts back.

**Remember this** (hover a message): Claude Code on Haiku turns the message
into one line (`--tools "" --strict-mcp-config --no-session-persistence`,
45 s at most; the message's opening if that can't run), shown in a small
dialog to edit before it's added. Cmd+K → "Edit what <agent> remembers…" opens
the tab.

## Import from Grok Bot (or any connected assistant)

The goal of an import is that each agent arrives understanding everything it
is supposed to do, so working with it here feels like carrying on in the
other assistant: its role and full instructions, every routine and schedule,
everything it watches for, the apps it uses, the user's preferences and its
standing context. Past conversations are a bonus, capped (below).

Only the other assistant knows its own agents, instructions and memory, so the
import runs from its side, over Remote Access. Nothing it sends becomes an
agent by itself: before anything is created the Chief **plays the plan back**
to the user and asks what's missing, then every connector import ends on one
review card in the Chief's chat, and the user imports what they keep
(`agents/harvest.rs`, `agents/review.rs`).

**Import agents** lists **From another assistant** first, and opens there;
**From Ship Studio** is the second segment, opened when asked for (⌘K
"Import agents from Ship Studio…"), since few people have agents there. ⌘K
"Import agents from another assistant…" opens the first.

The **Import agents** button leads with a conversation (`agents/connector.rs`,
the full threat model in docs/remote-access.md):

1. The user presses **Start** (one import, until it ends or the app quits),
   then sends their other assistant one message (`import::import_prompt`).
2. Its first `import_conversation` call puts an Allow / Deny card in the
   Chief's chat ("Grok wants to bring its agents over"). Nothing is shared or
   delivered until Allow.
3. It then talks to a **sealed interview** (`agents/interview.rs`): a
   throwaway Claude Code session that speaks as the Chief but has no built-in
   tools, no settings or CLAUDE.md, no folders, not the Chief's session or
   rules, and only `propose_agent` / `update_proposal` / `finish`, which
   stage a draft. The user watches it in the Chief's chat: the other
   assistant's lines are `from_agent` lines with a `connector:<source>` peer
   ("From Grok"), the interview's replies `sent_to_agent`
   lines to the same peer, indented as "To Grok · from the sealed
   conversation". Neither ever reaches the
   Chief's own session (`runner::recap_lines` skips them), and the other
   assistant only hears what the interview wrote. A bar above the composer
   says where it is, that what you type stays between you and the Chief, and
   has a plain **Stop** (stopping loses nothing); the Chief's own Stop
   (desktop or phone, where its row reads "Bringing in agents from Grok")
   stops it too.
4. **The interview asks for everything.** Per agent: its instructions word
   for word, every routine (when, what), everything it watches for (when X
   happens, what it does), the apps and connectors it uses and what for, the
   user's preferences, its standing context, what it remembers, and its
   logins by name, then "anything else it does?". `propose_agent` /
   `update_proposal` carry `watches`, `apps`, `preferences` and `context`
   beside the old fields; all of them go through the same cleaning and the
   same credential refusal.
5. **Playback** (`harvest::playback`, a `CardKind::Playback` card). `finish`
   doesn't go straight to review: it posts "Here's what your 2 agents will do
   for you", each agent's plan in the first person and plain words ("Every
   weekday at 09:00: check for new invoices (arrives paused: you switch it
   on)", "When an invoice email arrives: file it…", "I'll keep in mind: …",
   "I'll ask you for bank_login on a secure card…", "I'll have 37 past
   conversations from Grok to look back on"), and what it **doesn't** know
   yet as quieter gap lines ("Nothing on a schedule, and nothing I watch
   for. If I did something regularly, tell me"; an unreadable routine time).
   The lines are built from the staged fields, never written by a model, so
   they say exactly what Import would bring. Then "Is there anything I'm
   missing?" with a field: **Add this** hands the user's words to the sealed
   interview in a `<from_user>` envelope (credentials refused, 4,000
   characters), which folds them in with `update_proposal` / `propose_agent`
   (asking the other assistant one question if it needs to) and calls
   `finish` again, so the plan is played back again; **That's everything**
   puts up the review card. After five playbacks `finish` goes straight to
   review. On the phone the same card is answerable: That's everything is
   its Allow, Add something sends the words as the card's note
   (`connector::answer_card`); Deny with no note stops the import. While the
   plan is with the user the other assistant is told `STATUS: with_user`.
   The playback card expires on a restart (the interview is in memory).
6. `finish` (once the user says that's everything) posts the review card: each agent ticked, with its role and the
   first lines of its instructions in view (**Show all** for the rest), its
   memory, routines (paused) and the logins it asks for a click away; a
   name already taken (or a lookalike of one) comes in as "<Name> (from
   Grok)" unless the user picks **Replace**, which lists what it does to
   that agent: new instructions (the diff), a fresh conversation (memory
   kept), its running routines paused, its project unbound, its
   Always-allow rules removed, and its saved logins removed unless "Keep its
   saved logins" is ticked (off by default). The managing agent's notes are
   an optional "Add to <Chief>'s notes", off by default. **Import** creates
   what's ticked; **Don't import** creates nothing. The phone's card
   imports too, as new agents only (`agents.import.review`): Replace and the
   Chief's notes stay on the Mac's card (an older Mac's phone card says
   "Review on your Mac"). Logins arrive as secure
   cards in each agent's chat that don't wake it
   (`secrets::Request::quiet`): an imported agent first runs when the user
   messages it. The card also lists what each agent watches for, its
   preferences and context, the apps it used, and how many past
   conversations arrived (and how many credentials were masked in them).
   Its preferences, context, watches and apps land in its `## Memory`
   under "### Imported from Grok" (`harvest::memory_block`): what it watched
   for there isn't set up here by itself (mapping "an invoice email arrives"
   onto a connector check would be a guess); the memory tells the agent to
   offer to set each up as a "When…" routine. Routines arrive paused, as
   before.

**Where you are now** (`agents/arrival.rs`). An imported agent's
instructions were written for the other assistant's sandbox ("research lives
at /workspace/canada-west-move/", "use confirm_push"). Taken at their word
here, a turn runs `ls /workspace/…`, which doesn't exist on a Mac, and every
try raises an Allow card. So:

- Every agent imported from another assistant (the review card, `import_agents`
  and Paste) gets a `## Where you are now` section in its CLAUDE.md, written by
  the app, above `## Instructions`: its home folder, that paths from the other
  assistant don't exist here (naming the ones its own text mentions) and to use
  the same name in its home instead, whether anything came over into
  `imported/<source>/`, that projects are reached with `project_list` and their
  sessions, that logins are `request_secret` cards or a connection (never a
  password in chat), that it runs on Claude Code or Codex on this Mac, and the
  nearest tool here for each foreign tool its text names (Grok's `x_*` search
  isn't available; `confirm_push` is `push`; `wait_for_agent` is
  `session_wait`…). It is the app's, not the user's: `store::instructions_of`
  doesn't include it (so the editor, the Replace diff and the phone never show
  it) and `store::write_instructions` keeps it in place.
- At import, the first mention of each foreign path in each field (under
  `/workspace`, `/mnt/data`, `/mnt/user-data`, `/home/user`, `/home/oai`,
  `/sandbox`, and only when it doesn't exist on this Mac) gets
  "(from Grok Bot — not on this Mac)" after it. The path stays as written and
  nothing else changes. The review card shows the marked text and lists each
  path it marked and each tool it translated. Nothing maps a path into
  `imported/`: only past conversations come across (`import_file` isn't built).
- Agents imported before this (found by the `### Imported from <source>` block
  in their memory; not the Chief, not Ship Studio imports) get the section once
  at launch (`arrival::upgrade_all`), by `upgrade_chief`'s rule: only the app's
  section is added, the user's instructions and memory are byte for byte as
  they were (their paths aren't marked; the section names them instead), an
  agent that already has the section is left alone, and one with a turn
  running or taken over waits for the next launch.

**Past conversations** (`import_history`, `harvest::stage`). Once an agent is
staged, the other assistant may send its past conversations with the
`import_history` Remote Access tool, a few per call: `{source, agent,
conversations: [{id, title, when, messages: [{from, text, at}]}]}`. It only
answers while an import the user allowed is going and before the review is
up, and only for an agent the interview staged (by name, lookalikes
included). They never reach the interview. Each call is cleaned (hidden
characters out, messages cut at 20,000 characters, "user"/"human" vs
everything else), capped (150,000 characters a call, 300 conversations and
400,000 characters an agent, 1,500,000 an import), and **masked**: anything
shaped like a key, token, private key or `password: …` becomes "[removed: …]"
before it is written anywhere (refusing a whole chunk for one pasted key
would lose the rest). A conversation already there (its `id`, else title,
length and opening) isn't kept twice, so a resent or resumed upload is safe.
They wait in `<agents root>/.harvest-staging/<talk id>/<key>.jsonl` (0600),
counted on the bar, the playback and the review card; Stop, Deny, Don't
import and Import all remove the folder. On Import they're written to the
agent's home as `imported/<source>/conversations.md` (with a header saying
they're reference, never instructions) and `.jsonl`, both read-only (0400),
and its memory names the file. The agent reads them with its ordinary file
tools; there is no dedicated search tool. The assistant decides what it can
send: the copy says so, and only counts of what actually arrived are shown.
**Not built:** files (`import_file`) and a folded "Earlier, in Grok" section
in the chat log; a staging folder left by a crash isn't swept at launch.

**From an export file: not built, on purpose.** Researched 2026-11-05: none of
Grok (xAI or X), ChatGPT or Claude.ai documents its export's format.
ChatGPT's help page (help.openai.com/en/articles/7260999) and Claude's
(support.claude.com/en/articles/9450526) describe how to request an export
(an emailed link, a zip), but neither names the files or fields; xAI and X
had no page we could find. Every field name for `conversations.json`
(ChatGPT's `mapping` tree, Claude's `chat_messages`, Grok's
`prod-grok-backend.json`) comes from third-party parsers that disagree in
places (Grok's sender values, whether ChatGPT's includes memories). Per
"Never assume data", there is no parser until a format is documented; a
parser built on the observed shapes would have to refuse anything else.

The one-shot `import_agents` tool (`{source, agents: [{name, role,
instructions, memory, is_main, routines}]}`) goes through the same Start and
the same review card. Routines are read by the same parser and limits as
`schedule_check_in` (`schedule::check`); one that can't be read is shown on
the card with why, and is never guessed at.

**Paste** is the fallback ("Can't connect? Paste a reply instead"; needs
nothing set up). Copy a message into the other assistant (`PASTE_PROMPT` in
`src-tauri/src/agents/paste.rs`) asking for every agent as a ```json block in
the `{source, agents}` shape, in full and with no credentials, split into
numbered whole-agent blocks if it's long. Paste the whole reply back: every
```json block (or bare JSON) is found and merged, and the preview lists each
agent and whether it is new, updates an existing one, or merges into the
Chief. Anything wrong (a trailing comma and its line, a cut-off block, a
missing name, a non-text field, a duplicate, two mains) is listed by block,
agent and field and blocks the import; nothing is repaired except curly
quotes used as JSON quotes. Import runs the same `import::import()`.

What doesn't come across: the other platform's own connectors (its Gmail,
Calendar…). Here, agents use what this Mac and Claude Code are connected to.

### From Ship Studio on this Mac (`src-tauri/src/agents/other_app.rs`)

When the app this one grew out of has agents on this Mac, **Import agents**
gains a second segment, "From another assistant" | "From Ship Studio" (and
⌘K gains "Import agents from Ship Studio…", gated by the cheap
`agents_other_app_exists`, which reads only its registry). The name is
`OTHER_APP_NAME` in `other_app.rs`; the modal reads it from the preview's
`appName`, and the TS copy is used only for the palette title. Its agents are found
under its projects folder (`<its projects root>/.shipstudio/agents`, the root
read from its own `app_state.json`), else `~/ShipStudio/.shipstudio/agents`.

Both apps use the same layout, so it's a copy, not a translation. The tab
previews every agent (new, merges into the Chief, already here, or stays
behind and why), with its instructions, memory, message and file counts,
routines and project, then **Import** copies:

| Comes across | How |
| --- | --- |
| Registry entry | same id (so agent-to-agent lines still point at the right agent), name, role, avatar, engine, model, routine model, pinned/hidden/muted, usage, unknown fields. "Always allow" rules only if the user ticks "Keep their rules" (listed per agent in the preview; off by default, since they pre-approve tool calls) |
| Home | whole folder: CLAUDE.md (instructions + memory), `messages.jsonl`, `approvals.jsonl`, `attachments/`, anything else it kept there. Symlinks are never followed or copied |
| Project binding | kept when the folder still exists; otherwise dropped and said in its chat |
| Routines | kept, **paused**, so nothing runs in both apps while both are open |
| Chief of Staff | merged by `import.rs`'s rules: ours keeps its name, role, avatar, engine and session; theirs adds its instructions under `### From Ship Studio` (unless they're the stock Chief's), its memory section under `### Imported from Ship Studio`, its conversation as **one block before ours** under a "From Ship Studio" divider note (`store::prepend_log_block`, never interleaved), its files (an existing name here wins, reported), its routines (paused) and, if kept, its rules, without doubling any. Since our Chief keeps its own session, a recap of the other Chief's last 24 messages is written to `history-from-ship-studio.md` in its home and named in its memory; the chat note says "Merged in", not "Brought over" |

Not copied, on purpose: **saved secrets** (values in its Keychain items,
`ship-studio-agent-<id>`; reading them would raise Keychain prompts owned by
the other app and copy credentials without the user choosing to: the tab and
the agent's chat name which secrets stayed behind, and the agent asks again
with `request_secret`); **sessions** (tied to the folder they ran in; the
agent starts fresh and is handed the recent conversation, `new_engine`);
**a turn in flight** (`turn.json`, `inbox.json`). Waiting approval cards are
expired, except secure input cards, which still work here.

It's read-only: nothing under the other app's folder is written, moved or
deleted (the Rust test hashes the whole source tree before and after; an
agent home that is itself a symlink is skipped, not followed). It's
idempotent and safe to retry: `agents/imports.json` records each source id it
brought over, so importing again skips them ("Already here"; a bare id
collision says so instead); the Chief's merge skips lines by id, memory by
block, files by name and routines/rules by value, so a merge that failed part
way is simply run again; a folder left between moving a home in and
registering it, or an `.import-*` staging folder, is ours and is cleared. One
import runs at a time (a static mutex). One agent failing is reported by name
and the rest carry on; the registry event fires however it ended, and the
modal reloads the Chief's chat. The preview counts conversation only (not
cards or notes), sizes each agent, and says when a bound agent shares its
project folder with its Ship Studio twin and that paused routines' twins keep
running there. Across volumes (APFS clones within one) the copy checks free
space first, refuses with both sizes if it won't fit, and reports progress
(`agents://import-progress`). An agent whose name is taken here
stays behind until one is renamed; a newer build's entry this one can't read
is listed, not guessed at.

## Check-ins and routines (`src-tauri/src/agents/schedule.rs`)

An agent that says "I'll check back tomorrow" can: `schedule_check_in {when,
note}` (with `list_check_ins` and `cancel_check_in`) takes a plain-language
time in the user's zone, once ("tomorrow 9am") or repeating ("every weekday
9am", "every 2 hours"). A phrase it can't read is refused, never guessed. The
Chief of Staff can schedule for another agent. They are stored on the agent's
registry entry.

The user sees them in a popover on the chat header ("N scheduled", or a clock
when there are none; Cmd+K → "Schedule a check-in for <agent>…"). Each row
can be paused (routines) or cancelled. The composer takes one line, `when:
what`, split at the first colon followed by a space, and reads the time back
as the backend resolved it before Return adds it.

**Run now** (`agents_schedule_run_now`) fires a row immediately as an ordinary
wake: the same `check_in` line (marked `manual`, shown "· run now") and the
same prompt, which tells the agent it was asked for ahead of time. Its
`nextAt` doesn't move, and a one-time check-in stays scheduled: it's a
rehearsal, not a skip. **Edit** (`agents_schedule_update`) puts the row's own
words back in the composer (`scheduleWhenPhrase`, which the grammar reads back
as the same schedule; a Rust test holds `describe` to that) and Return saves
it in place: same id, paused stays paused, `when` re-read from now. It can't be
edited into a copy of another row. Esc leaves the edit, not the popover.

**When a run fails** (`agents/runs.rs`). A firing leaves a ticket with the
exact prompt it queued; the turn that carried that prompt settles it by how it
ended (its newest line an error, or not). A temporary failure (the usage
limit, Anthropic overloaded or a 5xx, the network: `failure::is_temporary`)
is tried again after 2, 5, 10, 20, 40 and 60 minutes, the last pulled in to 3
hours after the first failure; a usage limit with a known reset (up to 6 hours
off) is tried a minute after the reset instead. A routine's retry never runs
into its own next run. A sign-in, or anything we can't name, isn't retried.
The user is notified on the first failure ("… didn't run: … Trying again at
3:01 PM."), not for retries failing in between, and at the end only if it
ended in failure; a retry that works notifies like any reply. Connectors
Claude Code's init listed as `needs-auth` are named on the run and in the
notice ("Gmail needs signing in again"). The row says "retrying today 3:01
PM"; "Past runs (N)" lists its last 10 runs: when, and what came of each. A run
cut off by quitting is recorded as such at launch, and a routine's retry that
came due while the app was closed is dropped, not run late. Run now is
recorded too, but never retried or announced.

A one-minute tick fires them, with the workflow scheduler's rules: nothing
fires while the app is closed, at most one firing per tick, and a routine never
catches up a backlog. A one-time check-in missed while closed fires once, marked
late; an agent that missed several is woken once with all of their notes. A
firing records a `check_in` line in the chat, then wakes the agent with the
note.

That line goes through `runner::record` as a `MessageKind::wants_user()` kind,
the same predicate as replies, and is recorded after the wake starts, so it
falls inside the turn. Notifications use the same predicate, so a check-in
and its answer post one notification per turn.

### "When…" routines (`src-tauri/src/agents/watch.rs`)

A routine can start when something happens instead of at a time: "When
someone mentions me on GitHub, triage it." There are no webhooks (nothing of
ours is reachable from the internet); each one is a cheap check from this Mac
every few minutes:

| Source | How it's checked | Cost |
|---|---|---|
| Someone mentions me on GitHub | `gh api notifications` (all, participating), reason `mention`/`team_mention`; one firing per new mention (thread id + latest comment, or `updated_at`) | free |
| An issue or PR is assigned to me | `gh api search/issues -f q="assignee:@me is:open"`, 100 a page, up to 300 | free |
| A new file appears in a folder | the folder's listing (not hidden, not `.crdownload`/`.part`/…, not modified in the last 5 s; symlinks skipped); folders of at most 2,000 entries | free |
| A Linear issue is assigned to me | one sealed headless Claude Code call on Haiku through the Linear app set up in Claude Code | a model call |
| Something else… (in the user's words, through one named app) | the same sealed call, through that app | a model call |

**The rules.** The first check is a baseline (it notes what's there and
fires nothing). Nothing fires twice: ids seen are kept per routine; a
complete listing (a folder, or every assigned issue when all of them were
read) replaces them and is never capped, so a folder of 400 files never
re-fires; a window (the newest 50 notifications) is added to them, capped at
300. A file still settling keeps its place in what's seen, so a seen file
that's touched again isn't new. When more than 300 issues are assigned, the
row says so ("Covers the 300 most recently updated of 412 …"). The merge
happens inside the registry update, so two checks racing can't both fire.

**One firing at a time.** A check that finds something new wakes the agent
once with all of it (the first 20 listed) and marks a run running. Until that
run settles (or its retry does), the routine isn't checked, and Check now
says why instead of running, so a retry always works on exactly its own items
(`Watch::pending`). A retry with nothing left marks nothing running; a
firing whose turn couldn't be queued fails at once; a run nobody reported
back on for 5 hours is settled as lost. The ticket is settled by `runs.rs`
like a scheduled run, and its alerts say “When…” routine, not Scheduled.

**Failures.** A failed check backs off (interval doubled per failure, capped
at an hour) and says why on the row; after 5 failed checks in a row, or 3
runs in a row that failed for good, it pauses itself with a note. Runs cut
off by the app quitting (or lost) don't count toward that. A folder listing
is given 20 s (a dead network mount is a failed check, not a stalled tick),
and the tick starts checks in their own tasks, at most 4 at once.

**Outside text.** The items go to the agent in an `<external_items>`
envelope, one JSON object per line, control characters dropped and the tag
neutralised inside, so a title can't close it and pass for us (as the import
interview's `<from_assistant>`). The turn that answers them (or replaces one
that did: `runner::from_outside`) needs an Allow card for `create_agent`,
`update_agent`, `delete_agent`, `watch_for` and `schedule_check_in`
(`mcp::needs_card_in_routine_turn`), passes the taint on with what it says to
another agent (`message_agent`, and its answer to one that asked), and
can't write its own CLAUDE.md: on
Claude Code its edit tools are denied for that file (`--disallowedTools
Edit(//<home>/CLAUDE.md),…`), and for any engine a change to it is put back
when the turn ends, with a note in the chat, unless the app itself wrote it
meanwhile (`runner::MemorySeal`). Bash still asks through `approve` as always.
*Not verified:* that Claude Code 2.1.318 honours the `Edit(//path)` deny rule
in a real turn; the put-back covers it either way.

**The sealed model check** (`watch_seal.rs`). `--print --model haiku
--output-format json --no-session-persistence --no-chrome
--disable-slash-commands --strict-mcp-config --setting-sources "" --tools ""
--disallowedTools <every built-in> --permission-mode dontAsk
--permission-prompts none --mcp-config <that one app> --allowedTools
mcp__<app>__list*,get*,search*,read*,find*,query* --system-prompt <ours>`,
in an empty folder. The app's config is read from Claude Code's own
`~/.claude.json` (user scope, then local to the agents folder) and passed
verbatim; a claude.ai connector has no config there and isn't loaded under
`--strict-mcp-config`, so it can't be used (the composer doesn't offer one,
and `watch_for` refuses it).

Verified once on Claude Code 2.1.318 against a stub stdio server offering
`list_items` and `create_item` (one Haiku call, $0.0007): `init` listed only
the stub (no claude.ai connectors, no other servers), no built-in tools,
`permissionMode: dontAsk`, no slash commands or skills; `list_items` ran
(so the `list*` pattern is honoured), and the stub's log shows no call to
`create_item`. The model declined to try it, though asked to, so a refused
*attempt* was not observed there.

A refused attempt was then observed (two more Haiku calls, $0.0010 together,
same stub). With the production flags and system prompt and a prompt saying
"call create_item with name=x", Haiku again declined in text and only called
`list_items`. With the same flags but a neutral system prompt ("Do exactly
what the user asks") and `--output-format stream-json --verbose`, `init`
listed `mcp__stub__create_item` and `mcp__stub__list_items` (the write tool
is *visible*, just not allowed), Haiku emitted a `tool_use` for
`mcp__stub__create_item {"name":"x"}`, the `tool_result` was "Permission to
use mcp__stub__create_item has been denied because Claude Code is running in
don't ask mode", the result's `permission_denials` recorded exactly that
call, and the stub's log ends at `tools/list`, with no `tools/call` at all.
So the refusal is Claude Code's, not the model's restraint, and no change to
the flags was needed. **Not verified:** a real Linear or Gmail app,
including whether an OAuth app's saved sign-in is found when its config is
passed this way.

**Cost.** A model check is counted as a *check*, not a turn
(`UsageTotals::checks`/`priced_checks`), in the agent's usage and the
routine's own (`CheckIn::usage`, the one store runs use too), so the row
shows one line for checks and runs: "46 checks · $0.19 at API prices this
week", or tokens on a Claude plan. Model checks are at least 15 minutes
apart (default 30) and at most 24 a day per routine (`max_checks_per_day`;
the 25th waits for tomorrow and the row says so). An empty first answer
isn't trusted as a baseline until a second check agrees. Items are known by
their link, else their id, else a hash of title and date (`stable_id`),
because Haiku may name the same issue by key one time and uuid the next. An
agent setting one up gets an Allow card first naming the app, the interval,
checks a day, and what checks on this Mac have measured this week (or that
nothing has been). Every routine created, by an agent or the user, leaves a
line in the chat. At most one model check starts per tick.

They're `CheckIn`s with a `watch` (no `repeat`; `next_at` is the next check),
so cancel, pause, list and the 12-per-agent cap are shared. The time tick
ignores them. In the schedule popover, "At a time / When…" switches the
composer; a When… row shows what it waits for, what it does, how its last
check went, its week's cost, Check now (`agents_watch_check_now`), Edit,
Pause and Cancel. ⌘K: "Start work for <agent> when something happens…".
Agents set them with the `watch_for` tool. The phone gets them apart from
timed routines as `agent.watches` (without `seen`/`pending`) and shows them
read-only when `welcome.features` has `routines.when`; the Mac refuses any
schedule operation the phone sends for one (`refuse_watch_from_phone`).

Not verified against live accounts: a model check through a real connector,
and the GitHub search source (pagination included). The notifications
call's shape was checked with one read-only `gh api notifications` call.

## Usage before the wall (`agents/usage.rs`, `agents/quota.rs`)

Grok Bot's bots went silent at the usage limit. Here the limit is said
before it arrives, and only from what the engines report: a *reading* is
never estimated, and no reading means no line. Forecasts are a separate,
labelled thing (see "Usage awareness" below): they never stand in for a
reading and are never shown as one.

**Cost, per agent and per routine.** Each turn's `result` (Claude Code:
`usage`, `total_cost_usd`) or `turn/completed` (Codex: tokens only) is added
to the agent's last 7 days. A turn that finished having run nothing but
routine firings, all of one routine (every check-in each of its tickets
names), is also charged to that routine (`runs::charged_to`, inside the
id-based settlement of `runs::turn_ended`); a turn shared with a person's
message or with a second routine is charged to neither, because one turn's
cost can't be split honestly. An interrupted turn's cost carries over to the
turn that replaces it, as its tickets do, so the routine is charged all of
it; a person's message anywhere in that chain unmakes it. A turn that fails
or is stopped is charged to the agent only.

Claude Code's `modelUsage[*].costBasis` is `"list"`: its dollar figure is at
API list prices, not a Pro/Max bill. So once Claude has reported a plan (a
current Claude reading, `onClaudePlan`), every Claude cost on the desk and
the phone is said in tokens instead ("96k tokens this week"). Without one (an
API-key login) the figure is shown and says what it is, visibly: "$0.84 at
API prices this week", "$3.81 at API prices · 412k tokens · …". Codex
reports no price, so it is always tokens.

**The plan's limits.** Verified on Claude Code 2.1.318 (a subscription, a
Haiku "say ok" turn, $0.004): every stream-json turn emits a
`rate_limit_event` whose `rate_limit_info.unifiedWindows.<window>` carries
`utilization` (0–1), `resetsAt` (epoch s) and `status` (`allowed`,
`allowed_warning` past 75%, `rejected`); an `allowed` event may omit the
top-level `utilization` (`testdata/claude-rate-limit.jsonl`). Codex 0.166's
app-server has `account/rateLimits/read` and the sparse
`account/rateLimits/updated` (`primary` / `secondary`: `usedPercent`,
`windowDurationMins`, `resetsAt`); it is asked once per turn. **Unverified
against a signed-in Codex account**: on this machine the read answered
"authentication required". Codex keeps a limit per model too, each snapshot
naming its `limitId`; only `codex` (or a snapshot naming none) is read, so
another model's limit never shows as "Codex usage".

Readings go into `quota.json` (`agents_quota`), and a window past its reset
is dropped. A Claude event is the account's whole picture and replaces
Claude's reading; Codex's sparse updates merge per window. A reading never
outlives the login it came from: it is cleared when a turn fails signed out,
when Codex refuses the read for authentication, and when a Claude event names
no window and no limit type (no plan on this login). The top-level
`rateLimitType` of an event without `unifiedWindows` is read only when it is
a known plan window, never e.g. `overage`.

The sidebar foot, the foot of What's in flight, and the phone's agent list
and Settings show "Claude usage 85% · resets Sat" for the fullest window,
amber from 90% (Settings' rows too), and "Claude usage limit · resets Sat"
for a used-up one. A figure stands until its reset even when no turn has run
since, and use elsewhere isn't in it, so a reading's age is said: the tooltip
names its day when it isn't today ("reported it Tue at 3:00 PM"), and once it
is more than 6 hours old the line itself says so ("Claude usage 34% · resets
Sat · read Tue"; the phone has no tooltip). The figure is kept rather than
hidden: it is still the latest the engine said, now labelled as such. A
used-up window needs no age, since it stays used up until the reset it names.

A usage-limit failure whose message gave no reset takes the engine's reported
one (`failure::with_reported_reset`). Every reset is said by one rule for the
day: today a clock time, then "tomorrow", the weekday within the week, the
date beyond it. The chat's sentence ("It resets Sat at 2:00 PM.",
`failure::clock_phrase`), the button ("Retry Sat 2:00 PM"), the sidebar row
("Usage limit · resets Sat 2:00 PM") and the foot ("resets Sat") all name
the same day. The wording lives once, in
`packages/companion-protocol/src/quota.ts`, for the desk and the phone, and
in `clock_phrase` for the Mac's own sentences.

## Usage wallets (`agents/wallet.rs`)

Answers: **when one subscription runs out, can the agents keep going on
another?** Each engine has an ordered list of accounts (Settings → Agents →
Accounts; ⌘K "Usage accounts…", "Add a Claude Code account…", "Add a Codex
account…"). The first is always **This Mac**: the `claude` / `codex` login
already on the machine (`id: "default"`), which every turn used before
wallets and still uses while it is the only one. It can be renamed and moved
down, not removed. Each added account is signed in into a folder of its own,
reusing the isolation `commands/accounts.rs` already had for workspaces (an
added account's id is a fresh one, never a workspace's):

| | Claude Code | Codex |
|---|---|---|
| Folder | `CLAUDE_CONFIG_DIR=~/.<slug>/accounts/<id>/claude` | `CODEX_HOME=~/.<slug>/accounts/<id>/codex` |
| Sign-in | `claude setup-token` in a backend PTY; the printed token is captured and redacted in Rust (`claude_connect_start`), checked against the API, kept in the Keychain, injected as `CLAUDE_CODE_OAUTH_TOKEN` | `codex login` under that `CODEX_HOME` (`workspace_connect_start`), done when it exits 0 |
| Signed in means | a stored token whose recorded expiry (1 year) hasn't passed | its `auth.json` exists |

Nothing else of the account isolation comes along: no `GH_CONFIG_DIR`, no
workspace credentials, so an agent's `gh` and git identity are the user's
own on every account. The folder gets symlinks to This Mac's
`settings.json`, `CLAUDE.md`, `agents`, `commands`, `skills`, `plugins`
(Claude Code) or `config.toml`, `AGENTS.md`, `prompts`, `skills`,
`models_cache.json` (Codex), where it has none of its own, so an agent
behaves the same on every account. **Not** shared: logins, history and
Claude Code's `.claude.json`, which holds the signed-in account *and* the
user-scope MCP servers. So MCP servers added with `claude mcp add --scope
user` exist only on This Mac (a known difference, not papered over).

**Failover** (`runner::run_on_accounts`, around `run_turn`):

1. A turn runs on the first account, in order, that is signed in and not out
   (`wallet::choose`). With one usable account there is nothing to choose:
   it runs, and the engine says whether it can, exactly as before wallets.
2. A turn that fails as the usage limit (`failure::describe_now` →
   `FailureKind::UsageLimit`) marks its account out until the reset: the one
   in the failure (from the message, or the engine's own
   `rate_limit_event` / rate-limit snapshot read during the turn,
   `failure::with_reported_reset`). A `rate_limit_event` whose window is
   `rejected` marks it too, mid-turn (`wallet::reported_out`). No reset
   reported: out for an hour (`UNKNOWN_OUT_MS`), then tried again; one failed
   try is one quick refusal and re-marks it.
3. The turn runs again on the next account, with the same request and one
   bracketed line telling the model the last attempt stopped at a usage limit
   and to carry on rather than start over (`continue_prompt`). At most
   `MAX_SWITCHES` (4) per turn, and an account is never tried twice in one.
4. The chat gets a quiet Note whenever a turn runs on another account than
   the agent's last one: "Switched to Work: This Mac is out of usage until
   10:00 AM." (only the reset the engine reported is named; "is out of usage"
   without one). The phone shows the same Note as a Line.
5. Nothing left (two or more signed-in accounts, all out): the turn ends on
   one error line, tagged as the usage limit with the earliest reported reset
   so the usual "Retry at …" is offered: "Both Claude Code accounts have
   reached their usage limit. The first is back tomorrow at 10:00 AM." Never
   silent, and never refused while a lone account could still try.
6. Routines, check-ins and delegated turns go through the same path. Take
   over drives the session on the account the agent's turns last ran on.

**The conversation carries over.** Verified in Claude Code 2.1.318's own
code: transcripts live at `$CLAUDE_CONFIG_DIR/projects/<cwd with every
non-alphanumeric character as "-">/<session>.jsonl` (with a `<session>/`
folder beside it for sub-agents and saved tool output), and the Agent SDK's
own resume helper resumes a session by writing its transcript into another
config dir, so a copied transcript is the supported mechanism. Codex 0.166:
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`, found by id in
its sqlite state first and by a filename scan when that misses (source,
`rollout/src/list.rs`). So before a turn resumes on an account,
`wallet::carry_session` copies the **newest** copy of the transcript among
the engine's account folders into this one at the same relative path (mtime
kept, so A → B → A carries B's newer copy back). If the engine still can't
find it ("No conversation found", "no rollout found"), the existing fallback
starts a new session with the recent visible conversation (`with_recap`),
**except** on a switch after a try that already ran a tool: a new session
would see only the chat, not what its tools did, and could do it all again
(send a message twice, redo writes). That turn stops on a plain line instead
(`runner::not_carried_line`). Carried copies are written 0600.
Claude Code itself handles thinking written under another organization: it
says so and regenerates it (string in its binary), rather than failing.

**What is observed vs assumed** (research 2026-11-05, Claude Code 2.1.318,
Codex 0.166; sources: the installed binaries, openai/codex `main`,
anthropics/claude-code#103820, #103253, #70697):

- Claude Code's limit (observed in 2.1.304 output, #103820): a
  `rate_limit_event` with `status: "rejected"`, `resetsAt` (epoch s) and
  `rateLimitType`, then an assistant message and a `result` with
  `api_error: "usage_limit_reached"` and the text "You've hit your weekly
  limit · resets 11am (UTC)" (labels: 5-hour, weekly, Opus, Sonnet, Fable,
  usage credit), exit 1. `resetsAt` is the machine-readable reset; the text's
  time is display only. The old "Claude AI usage limit reached|<epoch>" is
  gone from 2.1.318 (still parsed). A server-side 429 throttle says "not your
  usage limit" and is not a switch. **Known gap:** #103820 reports long
  sessions exiting 1 with none of those events on stdout (only in the
  transcript); such a turn reads as an unfinished turn, not a limit, and
  doesn't fail over.
- Codex's limit (source): HTTP 429 `usage_limit_reached` with `resets_at`;
  `codex exec --json` carries only text ("You’ve hit your usage limit … try
  again at 3:15 PM.", with U+2019), app-server's `turn.error` carries
  `codexErrorInfo: "usageLimitExceeded"`; the reset is read from
  `account/rateLimits` when the text has none. Matched by text in both.
- Keychain: Claude Code 2.1.318 keys its own login per config dir
  (`Claude Code-credentials-<sha256 prefix>`); older builds shared one
  (#70697). The setup-token path is kept because it works on both and is
  already proven here.
- **Not verified:** a real failover against a live exhausted account (no
  exhausted account was available), resuming a copied transcript on a second
  real account of either engine, and Codex's keyring-backed auth
  (`cli_auth_credentials_store = "keyring"`), where `CODEX_HOME` isolation
  depends on how the "Codex Auth" item is keyed. Unit tests cover detection
  (real wordings), choosing, marking, the lines and the transcript copy.
- Not built: falling back across engines (Claude Code → Codex). It would move
  the agent to another model mid-conversation and lose its session; left out
  rather than done half-way.

The plan reading (`quota.json`) is one account's picture: when a turn on
another account reports one, the old reading is cleared first
(`wallet::reading_moves_to`), so Codex's sparse updates never merge two
accounts' windows. The wallet itself is `<agents root>/wallet.json`: the
ordered accounts with their last limit, which account each agent last ran on,
and which account each engine's reading came from. Removing an account
first carries every conversation in its folder that is newer there into this
Mac's own (`wallet::keep_sessions`), so an agent that last ran on it resumes
where it was, then deletes its Keychain items and its folder (`accounts::forget_isolated_account`,
which refuses any id a workspace uses). The phone reads the list read-only
(`agents.accounts`) in its Settings, once an engine has more than one.

## Usage awareness (`agents/inventory.rs`, `agents/forecast.rs`, `agents/usage_plan.rs`)

Answers: **do the agents know what the user has, and use it the way they
want?** The agents (the Chief above all) can read what there is to run on,
forecast what work will cost, and follow the user's chosen usage mode. They
never slow down for limits unless the user chose that.

**The capacity inventory** (`inventory::read`; the `usage_overview` tool,
`agents_usage_overview`, the phone's `agents.usagePlan`):

- Every engine (installed, signed in, how many agents run on it, the account
  its next turn runs on by `wallet::choose`, or that every account is out),
  and every account in the wallet.
- **Each account's own reading.** `quota.json` is one picture per engine;
  each account now also keeps its last reading in `usage-readings.json`
  (`usage_plan::archive`, from the same `Step::Quota` that records
  `quota.json`), so the inventory can say what *each* account last reported,
  with when. The engine-wide reading is given to an account only when the
  wallet recorded it came from that one (`wallet::reading_from`), or the
  engine has a single account; otherwise it is nobody's, and that account
  says "No reading yet". A signed-out failure forgets that account's own
  reading too. Windows past their reset drop, as in `quota::shown`.
- **Plan names only when reported**: Codex's snapshot carries `planType`
  (`Quota::plan`); Claude Code's stream reports none, so no Claude plan is
  ever shown.
- **Other compute**, detected, never assumed (`inventory::local_compute`,
  cached a minute): Opencode's binary; Ollama (binary or app) and LM Studio
  (`lms` or the app), each asked over loopback for its model list
  (`127.0.0.1:11434/api/tags`, `127.0.0.1:1234/v1/models`, 800 ms, no proxy,
  no redirects, so nothing leaves this Mac) and said
  "installed, not running" when it doesn't answer. Agents don't run on these;
  they are listed so the Chief can say what's there.

**Readings vs estimates.** The rule "only what the engines report, never
estimated" is about *readings* and stands unchanged. A forecast is an
estimate and is always said as one: every value carries `estimate: true`
and how many runs it rests on; tool text heads it "ESTIMATE from this user's
past runs (not a reading)"; the UI says "About 48k tokens a turn · estimate
from 212 past runs". With too little history there is no forecast at all,
never a default.

- **Tokens per run** (`forecast::per_run`) come from the per-day totals
  already kept for every agent and routine (`AgentUsage::days`, 7 days), so
  history from before this existed counts at once. At least `MIN_RUNS` (5)
  runs, else none. A day on which an agent also ran "When…" model checks is
  left out of its per-turn figure (that day's tokens mix both and can't be
  split). An agent with too little history is estimated as an average turn on
  its engine here (`forecast::pooled`), and says so. Low/high are the
  lightest and heaviest day's averages.
- **Share of a limit** is learned, because engines report windows in
  percent, never tokens: each reading is kept as a `forecast::Sample` with
  the account's running token count (`usage_plan::add_tokens`, from each
  turn's reported usage). Within one instance of a window (same kind, same
  reset) the first and last sample give points per token; instances pool
  (`forecast::rate`). No rate until the reading has moved `MIN_RATE_DELTA`
  (2) points with tokens in between. Use of the same plan elsewhere (the CLI,
  the web) moves the percent without our tokens, so the rate errs high: a
  forecast share is an upper-side estimate. This history starts with this
  build: until it exists, forecasts give tokens and say the share "isn't known
  yet".

**Modes** (`usage_plan::Mode`, `usage-plan.json`; Settings → Agents → Usage,
or the Chief's `set_usage_mode`, which always asks on a card first):

- **Normal** (default): no throttling. Before something big (a fan-out, a long
  routine, a nightly pipeline) an agent says in one line what it will likely
  use and which account it runs on, then goes ahead.
- **Save my limits**: ask before heavy work (`usage_plan::ask_first`: a
  forecast of a tenth of a window or more, or a fan-out with no forecast),
  and send light work to agents on lighter models or engines.
- **Use it all before reset**: the user's standing OK to spend capacity that
  would otherwise expire. When a window on the account turns would run on
  next is near its reset (within a fifth of its length, at most a day:
  `five_hour` → last hour, `seven_day` → last day; Codex's own
  `windowDurationMins`; a window we can't size is never spare) with at least
  `SPARE_MIN_PERCENT` (25) points unused, work waits on the spare-capacity
  list, and the Chief is free, the check-in tick (at most every 3 minutes)
  wakes the Chief once per window instance (`usage_plan::should_nudge`,
  `nudged`), with a quiet Note in its chat. The Chief hands items to agents,
  marks them started (`finish_spare_work`), and may bring a routine forward
  (`run_routine_now`, only in this mode; its next time doesn't move). It
  changes no approval: anything that sends, spends, pushes or changes what
  others see still waits for the user's Allow.

**The spare-capacity list**: users add in Settings; any agent adds with
`add_spare_work` ("sometime", "when there's spare capacity"). At most 50
items of 600 characters. A turn answering outside text (a "When…" routine's
items) can't add to it, take items off it or run a routine; and what such a
turn sends with `message_agent` (or answers back to whoever asked it)
carries the taint, so it can't ask the Chief to do it instead. A wake
already recorded for a window (`nudged`, on disk before the Chief is woken,
so a restart doesn't wake it again) also covers a later reading that puts
the same reset up to 30 minutes off.

**Instructions, for every agent, old or new.** The behaviour lives in the
app-owned system prompt (`prompts::usage_section`, built every turn by
`runner::system_prompt_for`) with the user's current mode, so every agent,
including ones created or imported by older builds, has it on its next turn,
and nothing in its own `CLAUDE.md` is rewritten (the safest upgrade: there
is no file text to migrate). The Chief also gets a line on `set_usage_mode`.
It is kept short (it is on every turn) and changes only with the mode:
nothing time-dependent goes in it, since a system prompt that changes every
turn costs the engine's prompt cache on the whole conversation. Spare
capacity reaches the Chief through the nudge, and the user through What's
in flight.

**UI.** Settings → Agents → Usage (⌘K "Usage limits and spare capacity…"):
the mode, each account's reading or "No reading yet", tags ("Plus plan",
"Next turns run here"), each engine's average turn (estimate), other
compute, and the list. What's in flight ends with one muted line when a
window on the next account is near its reset with capacity left ("Claude
5-hour limit resets 3:00 PM · 62% unused"). The phone's Settings shows the
same, read-only (`agents.usagePlan`, additive: an older phone never asks, an
older Mac doesn't list it in `welcome.methods`). Wording lives once in
`packages/companion-protocol/src/usage.ts`.

**What can't be done honestly, and isn't:**

- No engine reports limits in tokens, so "how much is left" is only ever a
  percentage, and any token→share conversion is learned and labelled.
- Claude Code reports no plan name; neither engine reports a reading for an
  account no turn has run on. Those accounts say "No reading yet".
- Opencode and local models aren't agent engines here; they're listed, not
  used.
- Choosing *accounts* by reset time isn't done: the wallet's order is the
  user's, and failover keeps it. Agents choose between *engines* (an agent on
  Codex vs one on Claude Code) by what resets sooner.
- "Route light work to cheaper models" is an instruction to the Chief
  (delegate to agents on lighter models); nothing reclassifies a turn
  automatically.
- Not verified against live accounts: a real nudge firing near a real
  reset, Codex's `planType` on a signed-in account, LM Studio's model list.

## Apps agents can use (`src-tauri/src/agents/apps.rs`)

Every turn is a `claude` process, and Claude Code loads the user's MCP servers
into it, so the apps an agent can use are exactly Claude Code's. "Apps your
agents can use" (the agent editor's Apps row, or ⌘K → "Connect an app for
agents…") is a window onto that, with no state of its own:

- **Connected**: `claude mcp list`, which health-checks each server, so the
  status is Claude Code's. Which rows are user scope is read (never written)
  from Claude Code's `.claude.json` top-level `mcpServers`; only those get
  Remove. claude.ai connectors (names starting `claude.ai `) say "Managed on
  claude.ai"; project/local/plugin servers say they're set up elsewhere.
- **Add an app**: a fixed list in Rust (`SUGGESTED`): Linear, Notion, Figma,
  Sentry, Stripe, Vercel, each the vendor's own remote MCP endpoint with OAuth.
  The webview sends only a name, never a URL. Added with
  `claude mcp add --scope user --transport http <name> <url>`. Left out:
  GitHub (its remote server wants a token header, not OAuth) and Gmail,
  Calendar and Slack, which have no vendor remote endpoint; they come from
  claude.ai's connectors, which Claude Code loads for a claude.ai account.
- **Sign in…** on a "Needs sign-in" row opens `claude` in a terminal sheet,
  where `/mcp` runs Claude Code's own OAuth. Whether a headless `--print`
  turn can start that sign-in itself is not verified, so the copy doesn't
  promise it.

Every call goes through `run_with_timeout` (60s for list, 30s for changes)
with `runner::strip_session_env`, from the agents folder, so what's listed is
what a turn sees. The project MCP modal edits the same Claude Code settings for
the active agent CLI, plus project scope; it's left as it is.

## When the Mac sleeps, a window closes, or the app quits

Agents are not a service. Each turn is one `claude --print --resume <session>`
process that the app starts on this Mac and reads to the end, and the
check-in tick is a loop inside the app. So:

- **A window closes.** By default closing a window quits the app (the
  frontend's close handler calls `exit`), so it is the same as quitting. With
  **Keep running when closed** on (opt-in, macOS), the window is hidden
  instead (`close_to_background`) and nothing stops: agents, check-ins,
  terminals and dev servers in that window carry on. Hiding rather than
  destroying matters, because a destroyed main window runs the global cleanup
  that kills agent processes. Clicking the Dock icon brings hidden windows
  back (`RunEvent::Reopen`); so do a notification and opening that project.
- **The app quits** (⌘Q, or a close with the option off). The turn in progress ends with it: its Claude Code
  process is stopped on the way out (`cleanup_agent_processes`), and any that
  outlived a crash are cleaned up at the next launch. What the agent already
  did (files written, commands run) stands. Messages queued behind that turn
  are on disk (`inbox.json`) and are sent once when the app reopens, after a
  note naming them (see "Quitting mid-turn"). Nothing fires while the app is
  closed.
- **It reopens.** Every conversation is on disk and the next message resumes
  the same Claude Code session, so the agent still has its context. The
  interrupted turn itself is not re-run (it may have done half its work):
  its chat ends on "The app closed while this agent was working…", with
  Retry. The app's own confirmation cards left
  pending are marked expired (`store::expire_stale_approvals`); permission
  cards stay answerable, and a late Allow wakes the agent again. Missed
  check-ins follow the rules above: a one-time one fires once, late; a routine
  doesn't backfill.
- **The Mac sleeps.** Everything, the agent's process included, is frozen
  with it, and carries on when it wakes. If its connection dropped meanwhile
  the turn can end in an error, shown with Retry like any other. A turn that
  instead just goes quiet (a half-open connection, a stalled MCP server) is
  not left looking busy: after 10 minutes of wall-clock time with no output
  from the CLI and no tool call open, the working line says "No word from
  Claude Code for N min. It may be stuck; Stop it if it doesn't move on."
  (`runner::quiet_line`). It is not stopped for you; the 3-hour limit still
  applies. A check-in due during sleep is late, under the same rules.

Three things help, offered together (`get_stay_on` / `set_stay_on`), each read
back from the thing itself:

- **Keep this Mac awake** holds the same idle-sleep assertion remote access
  uses (`remote_access::power::start_keep_awake`, `caffeinate -i -s -m -w
  <pid>`), as a standing preference of its own (`AppState.keep_awake`, held
  again at launch). It dies with the app, `-s` only holds on mains power, and
  it can't stop a laptop sleeping when the lid closes (see remote access's
  lid-closed mode). Turning remote access off leaves it held if the user asked
  for it here.
- **Keep running when closed** (`AppState.keep_running_when_closed`) is
  opt-in because it changes what closing a window does for every project, not
  only Agents. Nobody who hasn't turned it on here sees any difference.
- **Open at login** is remote access's own login item
  (`remote_access::power::set_open_at_login`, the
  `studio.ship.reopen-at-login` LaunchAgent): one file, so turning it on or off
  here shows in remote access's checklist too. Hidden in a dev build, which has
  no installed app to reopen.

They are offered in two quiet places only, and only once they matter: at the
foot of What's in flight while an agent is working or something is scheduled
(not on a new user's first screen, which is the Chief's hello), with a line
that says what happens ("Quitting the app stops them, and sleep pauses
them.", or with Keep running on, "Closing the
window keeps them going; quitting stops them, and sleep pauses them.") and one
line suggesting an always-on Mac, such as a Mac mini or a cloud Mac, for
round-the-clock agents; and as a "Keep this Mac awake" link at the end of the
schedule popover's footnote. Elsewhere than macOS none of it shows.

## Menu bar, quit guard and quick entry (`agents/tray.rs`, `agents/quick_entry.rs`)

Agents run inside the app, so staying alive, and being reachable while
the window is closed, is part of the product.

**Menu-bar icon.** A monochrome template image (`src-tauri/icons/tray/*.svg`,
rasterised by `pnpm icons:tray`): a placeholder ring (until real branding), with a dot while
anything needs you. The menu is a pure function of the agents and their live
status (`tray::menu_model`), rebuilt at most every 300ms on `agents://status`
and `agents://registry`:

- **Needs you** (up to 5): `Name · Needs your OK` (`· 3 need your OK`).
- **Working** (up to 5): `Name · <activity line>`, cut to one short line. An agent waiting for a free slot is listed after the running ones and isn't counted as working: the tooltip says `2 working, 1 waiting for a slot` (`runner::queued`).
- Overflow is counted (`2 more`), not listed. Hidden agents aren't listed; idle ones aren't either.
- Then Open <name>, New message to Chief… (quick entry), Keep this Mac awake / Keep running when closed (checkmarks, the same `set_stay_on`), Quit <name> (`brand::NAME`).
- Clicking an agent opens its chat (`notify::open_agent`, the notification click's path), showing a window that a close hid.

Shown by default **once the user has actually used Agents, or while Keep
running when closed is on** (`AppState.menu_bar_icon`, `None` = that rule).
"Used" is `AppState.agents_used`, set by `tray::mark_used` on the first
message sent to any agent (`agents_send`, so quick entry too) or the first
import (both import paths); an agent that already has a session counts, for
installs from before the flag. Someone who never touches Agents gets no new
icon in a crowded menu bar. Settings → General overrides it either way.
Rows are engine-agnostic: Claude Code and Codex turns report through the
same runner status and approval cards. Quick entry stays opt-in (it follows
Keep running only). Turning Keep running off *from the icon*
pins the icon on, so it doesn't vanish under the pointer.

**Quit guard.** ⌘Q, the icon's Quit, ⌘K "Quit…", and closing a
window while it would quit all go through `useQuitGuard`, which asks
`agents_quit_check` (`tray::quit_check`: agents mid-turn or queued for a slot,
agents with a check-in due in the next 24 hours, and agents with an open card,
hidden ones included). Only what a quit actually stops is a reason to warn: a
turn in progress, and a check-in that can't fire while the app is closed (it
runs late, on reopen). An open card is not: it survives the restart and a late
Allow resumes the turn, so it is only said, as "Lead Gen's request will still
be here when you reopen". Nothing stopped: the old "Are you sure?" (and the
icon's Quit just quits). Otherwise "2 agents are still working. Quit anyway?"
(or "Finance has a routine coming up."), naming them, with **Keep running in
background** (macOS; hides every window, `hide_all_to_background`) as the
default, then Quit, then Cancel. The backend brings the main window forward
first, since it may be hidden. The updater's restart is untouched: it still
waits for `agents_busy` to reach 0.

**Quick entry.** A system-wide shortcut (`tauri-plugin-global-shortcut`,
default ⌥Space, Settings → General) opens a small floating composer over any
app: its own window (`quick-entry`), created hidden at launch so the shortcut
only shows it, on the display under the pointer, a third of the way down.

- To the Chief of Staff; a leading `@Name` sends it to that agent instead (`quickEntryRecipient`, longest name wins). Other @mentions work as in a chat.
- Dictation is the chat composer's (`useDictation`). The camera runs `screencapture -i -o -x` (drag a region, or Space and click a window) with the composer hidden; the PNG goes to `<agents>/.quick-entry/` (cleared after a day) and is attached like a file. **macOS asks for Screen Recording permission the first time**; the composer says so until a screenshot has worked.
- Return sends (queued like any message), focus goes back to the app you were in (`[NSApp deactivate]`), and "Sent to Chief of Staff · Open chat" stays up 2.4s, unfocused, then hides. Esc or clicking elsewhere closes; closing hands focus back (`NSApp hide`) if the app wasn't in front.
- The shortcut is released while one of the app's own windows has focus, and taken again when they lose it: in-app, ⌥Space stays the composer's hold-to-dictate key.
- Conflicts we can know are refused with a reason (`Accelerator::conflict`): no ⌃/⌥/⌘, macOS's own (⌘Space, ⌃Space, ⌃⌥Space, ⌃⌘Space, ⌘⇧3/4/5, ⌘Tab…), and a bare ⌘-letter every app uses. Another app's global shortcut can only be found by trying; when macOS refuses, the old shortcut is put back and the reason shown.
- Off by default unless Keep running when closed is on (`AppState.quick_entry`): a global ⌥Space takes a non-breaking space from every other app.

Not verified in a real app yet (built and unit-tested only): the icon's look
in a light and a dark menu bar and its dot, the menu rebuilding while open,
the shortcut firing over other apps and full-screen Spaces, the composer
appearing without bringing the main window forward (it's a normal window,
not a non-activating panel), focus returning after send and Esc,
`screencapture` and its permission prompt, and the quit guard from the icon
with the window hidden.

## Engines: Claude Code or Codex (`agents/engine.rs`, `agents/codex_app.rs`, `agents/codex.rs`)

Each agent has `engine: "claude" | "codex"` (default `claude`), so it can run
on a ChatGPT plan with the same chat, tools, memory and Chief around it. The
editor's **Runs on** (`AgentEngine.tsx`) appears only once two engines are
installed; with one there is nothing to choose, and the dialog's foot has a
quiet "Also use Codex" that opens the same set-up terminal as the chat's. An
installed engine that isn't signed in (Codex: `codex login status`; Claude
Code counts once installed) is disabled, with "Codex isn't signed in." and
Sign in. A new agent starts where **Settings → Agents** says new agents start
(see "Defaults for new agents" below), and `agents_create` refuses an engine
that isn't ready, whether it was chosen or defaulted. One line says what protects an agent on that engine
(`engineProtections`), never more than is enforced: for Claude Code, the
app's own tools and the user's own allow rules don't ask; for Codex, apps
connected to Codex itself run outside its limits. When `EngineInfo.asks` is
false (a Codex without a usable app-server), the chat says so above the
composer and the phone's agent sheet says so under "Runs on"
(`engineCantAsk`). A schema check that timed out or didn't start is not
cached, so a slow moment doesn't stick as "can't ask". An
agent on an engine other than Claude Code wears a small badge in the sidebar
and the team view. Model offers
that engine's own list: Claude Code's aliases, or Codex's own
`models_cache.json` (`visibility: list`, its order). The Chief can set it on
`create_agent` / `update_agent`; both refuse an engine that isn't ready.
Switching clears the session and the model, leaves a note ("Runs on Codex
from its next message"), and the next turn gets the recent conversation
(`Agent.newEngine` → `with_recap`).

### Defaults for new agents (`agents/defaults.rs`)

Settings → Agents → Engines and models (`AgentDefaultsSettings.tsx`) sets what
a new agent starts on when nobody picked, saved in the app's settings
(`AppState::agent_defaults`: `engine`, `claudeModel`, `codexModel`):

- **New agents start on** — Claude Code | Codex, only the engines
  `agents::engine` runs. One that isn't installed and signed in is greyed out,
  and `agents_set_defaults` refuses it. Never chosen, the rule decides:
  Claude Code when ready, else the first engine that is
  (`engine::default_for`).
- **Model on Claude Code / Model on Codex** — one row per installed engine:
  "Engine's default" (no `--model`) and only the models that engine itself
  reports or accepts: Claude Code's aliases (said by what they're for, the
  alias beside it), Codex's `models_cache.json`. An engine that lists none
  has no menu, just "Codex hasn't listed its models, so new agents use its
  default."

Nothing is trusted on the way out (`defaults::view_of`, carried in the
overview as `defaults`): a chosen engine that stops being ready (signed out)
stays chosen, but `startsOn` falls back to the rule and the row says
"Codex isn't ready, so new agents start on Claude Code for now"; a saved model
the engine no longer lists is its default.

Who reads it: the New agent dialog opens on `startsOn` and that engine's
model, and switching engine there takes the other engine's default model;
`agents_create` fills in whichever of engine and model wasn't given (an empty
model is a choice, the engine's own); the Chief's `create_agent` (which takes
no model) and the phone's `agents.create` use both. **Existing agents never
change** with it, and an existing agent moved to another engine goes to that
engine's own default, as before. ⌘K "Engine and model for new agents…" opens
Settings on it. The phone reads it from the overview and sets it with
`agents.setDefaults` (docs/mobile.md, "Settings").

**The boundary.** `engine::Engine` is what an agent is on; `driver::Driver`
is how one turn runs it (`ClaudePrint`, `CodexApp`, `CodexExec`), picked once
per turn. It answers everything engine-specific about starting a turn (the
sign-in check, who names a new session, the command line, whether stdin stays
open, the leftover-process mark, capabilities read before the turn), and the
runner reads each engine's output as the shared `stream::Step`s. A third
engine is an `Engine` variant, a module for its command line and stream, and a
`Driver` variant; the compiler names the rest.

A Codex turn is one `codex app-server` (`agents/codex_app.rs`), spoken to
over JSON-RPC on stdin/stdout:

```
codex app-server
  -c permissions.shipstudio_agent={extends=":workspace",network={enabled=false},
       workspace_roots={<home or project dirs>=true},
       filesystem={<each existing .git / .shipstudio in them>="read"}}
  -c default_permissions="shipstudio_agent"
  -c mcp_servers.shipstudio_agents={url=…/mcp/agent,bearer_token_env_var="SHIPSTUDIO_AGENTS_BRIDGE_TOKEN",
       tool_timeout_sec=300,default_tools_approval_mode="approve"}
  -c project_doc_fallback_filenames=["CLAUDE.md"]
→ initialize, initialized
→ thread/start {cwd, approvalPolicy:"on-request", model, developerInstructions}
               (or thread/resume {threadId, …})
→ turn/start {threadId, input:[prompt]}
```

The permissions profile (Codex 0.166+, read off `codex --version`) is what
keeps `.git` and `.shipstudio` read-only: Codex accepts a glob only to deny
*reading*, so the folders are listed by path (`reach::protected_paths`: the
roots, the projects in them and copies under `.worktrees/<project>/`, three
levels deep, at most 400). Verified on 0.166 with `codex sandbox -P`: a nested
project's `.git` and `.shipstudio` refuse a write while the project stays
writable, and `thread/start` answers with the profile active. Re-checked on
0.166: a `"<root>/**/.git"="read"` entry is refused ("filesystem glob path …
only supports `deny` access"), and `deny` would stop git reading its own
store, so there is no pattern to fall back on. The list is fixed when the
turn's process starts, so a `.git` created during a turn (`git init`, `git
clone`), one deeper than three levels, or past the cap isn't protected until
the next turn scans again (the first two) or at all (the cap).
A thread names no `sandbox` of its own then, since it would replace the
profile. An older Codex keeps the legacy
`sandbox_workspace_write.writable_roots` + `network_access=false` (and the
thread's `sandbox:"workspace-write"`), which only protects each root's own
top-level `.git`.

Its messages map onto the same `stream::Step`s as Claude Code's stream-json,
and only those in our own thread (a sub-agent's run in threads of their own
and stay internal): the thread id → session; `item/started agentMessage` +
`item/agentMessage/delta` → a draft, and `item/completed agentMessage` → the
reply in its place; other items as they start → the activity line (labelled
as the matching Claude Code tool); `thread/tokenUsage/updated` (`last`,
summed over the turn) → usage (tokens only: a plan reports no price;
duration timed here); `turn/completed` → done, or the error when `failed`;
`error` with `willRetry` → "Reconnecting to Codex". Done closes stdin, and
the app-server exits.

**Approvals.** Sandboxed commands run without asking, like Claude Code's
`acceptEdits` edits. Anything that needs more reaches us as a request and
becomes the same card a Claude Code call gets, through `mcp::decide`
(one-time grant from a late Allow → "Always allow" rule → card):

| Codex asks | Card as | Allow / deny |
|---|---|---|
| `item/commandExecution/requestApproval` (the model asked to escalate) | `Bash {command}` (shell wrapper peeled), Codex's reason under it | `accept` / `decline` |
| `item/fileChange/requestApproval` | `Edit {file_path}` (paths from the item) | `accept` / `decline` |
| `mcpServer/elicitation/request` with `_meta.codex_approval_kind = "mcp_tool_call"` (a write tool on the user's own MCP servers) | `mcp__<server>__<tool> {tool_params}` | `accept` / `decline` |
| `item/permissions/requestApproval` | "Allow more access" (network, paths) | the requested profile for the turn / none |

A decline carries no message, so what the agent is told ("the user said no,
and told you: …", or "hasn't answered yet") goes as `turn/steer` just before
it: queued on the open turn, the model reads it with the declined call's
result (sent after, it can miss the turn). Questions (`requestUserInput`)
and other elicitations are declined with a steer to ask in the chat;
requests we don't handle get a JSON-RPC error rather than hanging.

No network is set on the command line and again on the thread, so a
`network_access = true` in the user's own `~/.codex/config.toml` can't widen
it (checked on 0.166: `codex sandbox` with `network_access=true` reaches the
internet and with `false` doesn't; `thread/start` echoes `networkAccess:
false` even when the command line said `true`).

**Stop and ⌘Enter** send `turn/interrupt` and wait up to 3s for the turn to
end (`interrupted`) before the process tree is stopped. Codex sends no
completed message for a reply cut off, so the draft is kept as stopped,
exactly as for Claude Code.

**Fallback.** `codex_app::available` asks the installed Codex for its own
protocol schema (`app-server generate-json-schema`, ~0.1s, once per binary
until it changes; a check that timed out, didn't start or was killed is asked
again next time) and needs every method above. Without them a turn is
`codex exec [resume <thread id>] --json --skip-git-repo-check` with the same
`-c` overrides plus `sandbox_mode="workspace-write"`, `approval_policy="never"`
and `developer_instructions`: replies arrive whole, nothing can ask (exec
forces approvals to "never"), and the prompt says so instead
(`prompts::for_codex_exec`). Debug builds force it with
`SHIPSTUDIO_AGENTS_CODEX_EXEC=1`.

Capabilities come from what we serve it, its built-ins and `codex mcp list
--json`, read before each turn (Codex announces no tools). Failures read as
"Codex's usage limit is reached. It resets at 7:18 PM." (from its "try again
at 7:18 PM", this Mac's time) and "Codex is signed out." (checked before the
turn, which otherwise spends 20s retrying a 401), with "Sign in to Codex"
running `codex login`. A vanished thread (`thread/resume` → "no rollout
found") is replaced once, like a lost Claude session.

What still differs from a Claude Code agent, verified on Codex 0.166:

- **What asks.** Claude Code asks for every command not allowed; Codex runs
  commands inside its sandbox (the agent's home and the user's projects, no
  network) without asking, and only going past it asks.
- **Memory.** `developer_instructions` is set when a thread starts; Codex
  re-reads the project doc every turn and hands over a changed one, so an
  unbound agent's CLAUDE.md is its project doc and memory edits reach the
  next turn. A bound Codex agent runs in its project, whose own AGENTS.md
  (or CLAUDE.md) loads; its identity rides in the developer instructions.
- No Claude in Chrome; "Apps" are the MCP servers set up in Codex.

Not verified against a signed-in ChatGPT account (none on the build machine):
real model behaviour on these prompts, the real usage-limit response (its
wording was produced by Codex itself from a scripted 429), and a real reset
time. The e2e Codex scenarios run on the account when one is signed in.

## Search, model and usage

- **Search.** In Agents mode the sidebar's top field searches conversations
  (⌘F focuses it; ⌘K stays the palette, and the palette's "Search agent
  conversations" does the same). With no sidebar to hold it (compact width, or
  the rail collapsed) it opens over the chat instead. It scans every agent's
  `messages.jsonl` directly, with no index: every word must appear, case is
  ignored, newest first, at most 50 hits (`src-tauri/src/agents/search.rs`).
  Results replace the list, grouped by agent. Enter opens the first hit;
  opening one loads older history if needed, expands a collapsed agent-to-agent
  thread that holds it, centres the line, and puts focus in the composer; the
  opened hit stays marked. Snippets are re-cut on the frontend to start a few
  words before the match, so it survives the sidebar's two-line clamp. Esc
  anywhere in Agents mode clears it.
- **Messages.** Agent replies are prose on the canvas; your messages are
  bubbles. Hover or focus shows Copy and the time (the exact time is its
  tooltip); Copy isn't a Tab stop, but a clicked message takes focus and ⌘C
  copies it. The newest error, with nothing said since, offers Retry (sends
  your last message again whole: words, quotes and files, re-copied from the
  agent's home) and, for an expired login, "Sign in to Claude Code" (the same
  `claude auth login` terminal the dashboard uses). A usage limit with a known
  reset also offers "Retry at 3:00 PM": a one-time check-in at the reset whose
  note carries what you asked; once it exists the line says "Retries at …".
  "Set up Claude Code" (no Claude Code yet) runs the install terminal, then
  sign-in, and the composer unlocks when the overview says it's there.
- **Routines' model.** The same menu says what routines run on, and changes
  it: Automatic (Haiku while the agent is on the default model, otherwise its
  own model), Same as its chats, or a model. A routine fires again and again,
  usually long after the last turn (so nothing is cached either way), and
  mostly checks things, so this is where a cheaper model saves the most.
  Haiku is Claude Code's: a Codex agent's routines run on its own model
  (Same as its chats) unless one of Codex's models is picked, because which
  of Codex's models is cheaper is not something Codex says. Moving an agent
  to another engine resets the setting along with its model.
  One-time check-ins, including "Retry at", run on the agent's own model
  (`store::Agent::routine_model`).
- **Model.** Said by what it's for — Default / Most capable / Balanced /
  Fastest — with Claude Code's own name (Opus / Sonnet / Haiku) in small
  text beside it; passed as `--model` from the next turn. Set it when creating
  the agent (it starts on the default for its engine, Settings → Agents),
  in the editor, or at the foot of the chat header's … menu, which
  also names the engine. The header itself shows the agent's role (idle) or
  what it's doing, never the engine. Only Claude Code's own aliases are accepted, and the backend
  enforces that too. Default means no `--model`, so whatever Claude Code
  defaults to.
- **Usage.** Each turn's final stream-json `result` event adds its token counts,
  `total_cost_usd` and `duration_ms` to the agent, all time and per day for the
  last 7 days (`src-tauri/src/agents/usage.rs`). Nothing is estimated: a turn
  that reports no cost adds tokens only, and a period containing one shows no
  dollar figure at all. The editor shows "This week" and "All time".

## Access

An agent can do what your user account can do: it runs as you, with your files,
logins, CLIs and Claude Code MCP servers. Approvals are the guard, not a
sandbox. That matches the request this was built for ("anything your computer
has access to, so does it"), and it's why the prompts forbid pushing,
deploying, sending or spending unless asked, and why those actions surface as
cards.

## Attachments and quoting (`src-tauri/src/agents/attachments.rs`)

- Paste an image (⌘V), drop files anywhere on the chat, or use the paperclip.
  Staged files sit above the text as removable chips; images show a thumbnail.
- On send each file is copied into `<home>/attachments/<message id>/`, so the
  agent reads its own copy and the chat keeps showing it after the original
  moves. Picked and dropped files are copied by path; a paste is sent as bytes.
- The log keeps what the user typed plus `attachments: [{name, path, mime,
  size}]`; the prompt the agent gets also lists the absolute paths and asks it
  to use the Read tool, which reads images and PDFs natively.
- Limits: 10 files a message, 25 MB a file, refused before sending with a
  message that says which file and why. Folders are refused.
- On the user bubble images render as thumbnails (click: full size, with Open);
  other files as chips that open in their default app
  (`agents_open_attachment`, which only opens paths under `attachments/`).
- Drops come from Tauri's window-global `tauri://drag-*` events, hit-tested
  against the chat (lib/dropTarget). The DOM drag handlers cover the browser
  harness and are inert in the app.
- Select text in an agent's reply and press ⌘L (or the Quote button that
  appears above it) to quote it. Each quote waits above the text as a chip
  (removable; more ⌘L presses add more) and is sent as a Markdown blockquote
  ahead of what you typed. User bubbles show those blockquotes as quote bars
  (`splitQuotes`); nothing else in a user's text is read as Markdown.

## @mentions and What's in flight

- **@mentions.** Typing `@` in the composer opens a small menu of your other
  agents (the app's menu surface; the field keeps focus: ↑ ↓, Return or Tab,
  Esc). Picking one writes `@Name`. `agents_send` takes the mentioned ids,
  keeps only real agents other than the recipient, records them on the
  message as `mentions: [{id, name}]`, and adds one line to the prompt
  (`prompts::mentions`): for the Chief, "delegate this to them with
  message_agent"; for anyone else, "involve them". No new routing: the
  recipient does it with `message_agent`. The bubble tints each recorded
  `@Name` in that agent's colour. A name typed without the menu still counts
  if it matches an agent exactly.
- **What's in flight** (⌘K, id `agents.team`, or the "Needs you · N" row at
  the top of the agent list while anything waits on you) shows,
  in a fixed order and present even when empty: who needs you (with their
  pending approval cards, answerable in place, and turns that didn't finish,
  with Retry or Sign in), who is paused by a usage limit (only when someone
  is, with Retry at the reset), who is working (their
  activity line), the next five active check-ins, and the six latest
  replies. Every row opens that chat; a reply opens it at that line. It
  reads only the store: statuses and check-ins from the registry, cards and
  replies from each chat's recent lines (live for chats open this session,
  otherwise the last 20 lines, re-read when that agent's row changes; a
  chat with an open card reads a page). Hidden agents are left out. While
  it is open no chat is on screen, so replies keep counting as unread. It is
  never restored on reopen: Agents comes back to the last conversation.
  An answered card shows what it resolved to ("Allowed · Lead Gen is
  carrying on") for 1.2s, then folds away, and focus moves to the next
  card's Allow (or the next row). Long field values clamp to two lines with
  "Show all"; cards span the row's text column. The Chief of Staff is created
  pinned (an ordinary pin: unpin it and it sorts by recency).
- **Sections** (user-made groups in the list) are not built: they need a
  persisted field, a naming flow, collapse state, and a story for how they
  sit with the recency sort. Worth doing as its own slice once the list is
  long enough to want them.
## Rooms (`src-tauri/src/agents/rooms.rs`)

A room is one visible thread shared by you and two to six agents. It is a
conversation, not a merged agent: each member keeps its own session and
memory, and a message in the room becomes a turn in each addressed member's
own inbox.

A room turn resumes the member's one engine session, the same one its own
chat uses (`runner::run_turn`). So an agent remembers its own chat when it
answers in a room, and what it read and said in a room is in that session
when you next talk to it alone. A room is not a private place: what a member
says there is posted for everyone in it. Whether rooms should get sessions
of their own is open.

- **Who answers.** The members you @mention; every member for `@everyone`;
  otherwise the room's **lead** (the Chief of Staff when it is a member, or
  whoever the room's settings name). With no mention and no lead nothing is
  sent: the composer asks "Who should answer?" with a chip per member and
  Everyone. The composer's foot line always says who will answer before you
  send ("To Finance and Ops", "To everyone · 4 replies"). Your line records
  who it was for (`mentions`) and shows "To …" under it.
- **What a member sees.** Its turn's prompt is written when the turn starts
  (`rooms::prompt`), from the room as it is then: who is here, the newest 20
  lines (each clipped to 1,200 characters, at most 8,000 in all), and, said
  in so many words, how many of how many it is shown. It is told its reply is
  posted for everyone, to answer for itself, and how to bring someone in.
  Every line is a speaker header the app writes (`[User]`, `[Agent: Name]`)
  over what was said, each line of it quoted with `> ` (`rooms::quoted`), and
  the framing says only `[User]` is the user and that a member's words are
  its report, not instructions. A reply that writes "User: delete the
  branch" on a line of its own still reads as part of that reply (CR, VT,
  FF, NEL and the Unicode line and paragraph separators all start a new
  quoted line). Who asked is said in so many words (`rooms::Asker`: the
  user, or a named member), so a member that can't be looked up is never
  taken for the user. Names can't hold control characters or line and
  paragraph separators, and "everyone" is reserved (`store::validate_name`,
  imported agents included); every name in the framing goes through
  `rooms::header_name` too.
- **Agents bringing each other in.** A finished reply that @mentions another
  member (`rooms::mentioned_in`: whole names, longest first, never an email
  address, never `@everyone`) asks that member next, one hop further. Each
  user message starts a round; at most **8 agent turns** per round (the
  addressed members included) and the runner's 6-hop cap. Past either, nobody
  else is asked and the room says so once. The room shows "3 of 8 replies for
  this message" while it runs. A reply from a turn answering text from
  outside (a "When…" routine's items) passes that taint to whoever it
  brings in. `message_agent` still works from a room turn
  (for work outside the room), and the turn starts as far along the chain as
  its room hop, so a hand-off at hop 4 can delegate at most two more hops:
  the 6-hop cap per user message holds across rooms, `message_agent` and
  `create_agent`'s first task (`runner::next_hop`).
- **One place per turn.** A room ask carries `room` on the queued message
  (`runner::Inbound`). `take_batch` takes only a run of messages said in the
  same place, so a room turn is never folded into the agent's own chat (or
  another room) and vice versa; the rest waits for the next turn, in order. A
  room ask owes no agent an answer. While it runs, `Runtime.room` is set and
  `Status.room` says so, so the room shows its members' working lines and
  drafts and no one else's; the agent's own chat doesn't stream that reply
  and its working line says "Replying in <room>", a link there. A member
  busy elsewhere shows as "will reply after what it's doing now"
  (`RoomView.waiting`).
- **Interrupting.** ⌘↵ in an agent's own chat moves what was said there
  ahead of any room asks (`runner::interrupt`), so the message you
  interrupted for is the one answered. What the cut-off turn was doing is
  told only to the next turn in the same place (`Runtime.interrupted_in`):
  the note about a cut-off room turn quotes what was asked there under the
  app's speaker headers, never as the user's words. (This scopes only that
  note; the engine session itself is shared, see above.)
  A room turn cut off this way leaves "X was interrupted for a message in
  its own chat, so it didn't answer here." in the room; a Stop in the
  agent's own chat that drops queued room asks leaves "X was stopped before
  answering." in each room, and a room turn that panics leaves "Something
  went wrong running X, so it didn't answer here." there (its error line
  stays in the agent's own chat).
- **Where lines live.** What a room turn records (its reply, cards and change
  cards; its own stop, interruption and error lines through
  `runner::record_in_turn`; never your own lines, another agent's request, a
  check-in, or a note the app records for its own reasons meanwhile, like an
  engine change or a saved secret) is tagged `room` in the member's own log
  and copied into `agents/rooms/<id>/messages.jsonl`. A line from an agent no
  longer in the room isn't copied. A room's page applies each member's card
  answers and timelines from that member's home, so Allow / Deny and
  "Worked … · N steps" work in the room as in the agent's chat; the newest
  change card for a member's open copy offers Keep / Discard there, and a
  result card's **Ask for changes** opens that member's own chat with the
  request staged (a room message can't revise a result). The agent's own
  chat folds its room lines into one line ("2 replies in Pricing launch", a
  link to the room); a card still waiting on you, and the card for its open
  copy, stay in full there too, and so do lines from a room that was
  deleted, which have nowhere else to be read (search finds them there). The room's row, not the agent's, gets the
  preview and the unread count; the agent's row still shows a failure.
- **Accent.** A room is neutral (the monochrome accent); each member's run of
  lines opens with its badge and name in its own colour.
- **The Chief makes rooms** (`agents/room_tools.rs`). `create_room {name,
  members, lead?, purpose}`, `add_to_room {room, agent}` and
  `remove_from_room {room, agent}` are served only to the Chief of Staff and
  refused to anyone else who calls them by name. Each call is checked in full
  first (real agents, two to six, a lead who is in the room, a purpose under
  300 characters folded to one line, no second room with the same name), and
  only then, in a turn answering text from outside (`runner::from_outside`:
  a "When…" routine's items, or a `message_agent` request or room hand-off
  carrying that taint), the user gets a card ("Make a room: Launch", who's in
  it, who answers, what it's for). After Allow the call is checked again, and
  refused if the team or room changed meanwhile. The tools send nothing into
  the room, so the 8-turn and 6-hop caps apply unchanged once people talk
  there. The Chief's chat gets an audit line ("Made a room, Launch, with …");
  adding or removing also leaves a line in the room. The room records
  `purpose` and `createdBy` (both optional and additive: older builds keep
  them untouched, as unknown fields); the desk's empty room shows the purpose
  and "Chief of Staff made this room", and every member's room prompt quotes
  the purpose under an app-written header. The phone gets both fields but
  doesn't show them yet. The Chief is told about the tools in its app-owned
  section (`prompts::CHIEF`, built every turn), so Chiefs made by older
  builds have it without touching their CLAUDE.md.
- **Managing.** "New room" at the foot of the agent list (once there are two
  agents), ⌘K → New room…, Open <room>, <room>: members and name…,
  Mute/Unmute, Delete…. Rooms sit in a "Rooms" section right after the
  agents (above Hidden, as on the phone). A room's badge is its own: its
  initials on an outlined neutral tile, so rooms with the same members still
  look different and none passes for an agent; member faces (three, then
  "+N") are in the room's header and empty state. A quiet room's row is one
  line; its newest words show (one line) while unread or while someone is
  replying or waiting on you there. An unnamed room of four or more is
  "Chief of Staff & 3 others" (`rooms::room_name`). Mute stops the unread count. Deleting a room removes its
  thread and never an agent; deleting an agent takes it out of its rooms
  (and as lead); a room left with fewer than two says so above the composer
  ("Only Finance is left in this room", Delete room / Add members), and with
  none it can't be sent to. "Stop replies here" (`agents_room_stop`) drops only what
  was asked in the room and stops a turn answering there; anything said to
  the agent elsewhere stays queued.
- **Search** scans room threads too; a room hit opens the room. A room line
  is found once, in its room, not again in the member's log.
- **Phone.** Rooms list and room chat (read, send with @mentions and
  @everyone, Who should answer?) for apps that say `hello.features: ["rooms"]`;
  older phones see no rooms, no room-only lines and no room-only search hits;
  a member's line said in a room is a hit in that agent's chat there
  (`wire::search_for_app`, docs/mobile.md).
- **Composer.** As in a 1:1 chat: paperclip, paste and drop for files,
  dictation, and the send button turns into Stop ("Stop replies here")
  while members are replying and nothing is typed. Files are saved into the
  first member's home and copied to every other member's under the same
  `attachments/<message id>/` path, so the room (desk and phone) shows them
  through any member; each asked member is told where they are in its own
  home. A member added later (the room's settings or `add_to_room`) is given
  a copy of every file already in the thread (the user's attachments and
  members' shared files) when it joins (`rooms::copy_files_to`): the same
  `attachments/<message id>/` path in its own home, copied from any home that
  still has it, never through a symlink, and all or nothing: if a copy fails,
  what it copied is removed and the member change is refused, so the room is
  as it was. A file sent while that copy runs is picked up by a second pass.
  Copying was chosen over a read path to a shared folder: each agent keeps
  reading only its own home, and the room keeps showing files through any
  member. Every member's turn in a room lists the files with each line it is
  shown, where they are in its own home. The startup sweep keeps those copies
  (`rooms::any_log_mentions`), since a member's own log never mentions them.
  A member's @mention of another member is tinted in that member's colour
  (whole names, as `rooms::mentioned_in` matches them). Under your message,
  "To everyone" when every member was asked, else "To Finance and Ops". The
  mention menu's @everyone is a group glyph, never initials, and the foot
  line stays empty while the menu is open. A stopped or cut-off member is one
  centred line with its name in its colour, whoever wrote the note.
- **What's in flight** knows rooms: a card or reply said in a room says
  "in <room>" after the agent's name, the card is answered there, and the row
  opens the room. A card waiting in a room is read from the room's thread too.
- **Not built.** Quotes in a room composer; the phone sending files to a room; jumping to a
  search hit's exact line in a room; OS notifications for room replies (cards
  still notify, as the agent's); a user "leave" separate from delete (a room
  with one person in it has nothing to leave; "leave" is an agent leaving,
  via members). A round is per room, not per message: a chain from the
  previous message still running draws on the new one's 8, and rounds live
  in memory (a restart starts them at 0). The desk and the backend match
  @mentions by slightly different rules (the desk wants a space before `@`
  and ASCII word characters after the name). The phone's room view doesn't
  offer Keep / Discard or Ask for changes yet. No real agent turns were run
  in a room for this slice: the routing is unit-tested and the UI is
  harness-tested on fixtures.

## Files back from agents (`src-tauri/src/agents/files.rs`)

- `share_file {path, caption?}` takes `~/…`, an absolute path, or one relative
  to the agent's home. The path is canonicalised and must land inside the
  agent's home or a registered project, so `..` and symlinks are judged by
  where they really lead; folders are refused (zip first). The file is
  **copied** into `<home>/attachments/<message id>/` under the attachments
  limits, so the card survives the agent editing or deleting the original.
- It's recorded as an `agent` message with `attachments` and the caption as
  its text, so unread, notifications ("Shared report.pdf" with no caption) and
  history all treat it like a reply. Images show inline; files are the same
  chips as yours, on the left. Click opens; Show in Finder sits on hover and in
  the image view. The prompt tells agents to share rather than paste.
- **Files** (header … menu, or ⌘K "Files shared with <agent>") lists every
  attachment in the conversation, both ways, newest first
  (`agents_files`, a scan of the whole log), filterable All / From you /
  From <agent>, each with Open and Show in Finder.
- **Paths in replies** become links: Markdown links without a scheme, `~/…`
  and absolute paths under `/Users`, `/Volumes`, `/tmp` and similar written
  out in prose, and inline code that is only such a path (`/careers` isn't).
  `agents_open_path` resolves relative paths against the agent's home and
  requires the target to exist. Documents open in their default app; folders,
  apps, scripts, anything executable or with a launching extension
  (`.command`, `.app`, `.py`, `.webloc`…) are only revealed in Finder, never
  run. ⌘-click always reveals.

## Result cards (`src-tauri/src/agents/results.rs`)

A finished piece of work comes back as **one** card, not prose plus a pile
of attachments. The agent calls `share_result { title, summary, items[],
checked[], not_verified[], revises?, changes?, project? }` at the end of the
work; the prompt (`prompts::FILES`) tells it to for deliverables, never for
chat.

- **Preview, when it names a project.** `project` is a project's name from
  `project_list`, resolved against the real list (an unknown one shares
  nothing) and stored as its path. The desk's card then offers Preview, which
  opens the project only when pressed; a revision keeps it. A card riding on
  a change card shows that card's Preview instead. The phone ignores it.

- **Only what exists.** `items` are files (`path`) or links (`url`). A file
  must resolve inside the agent's home or a registered project
  (`files::shareable`, so `..` and symlinks are judged by where they lead)
  and is copied into `attachments/<message id>/`; one bad file shares
  nothing. `.env*` files (examples aside) and private keys (SSH key names,
  `.key`/`.p12`/`.pfx`, any file with a PEM private key block) are refused
  with an honest error (`files::is_secret_file`), here and for `share_file`.
  Links are http/https with no sign-in details in them. `checked`
  and `not_verified` are the agent's own words; the app never fills either,
  and shows each only when given.
- **Refused, never trimmed.** Title 120, summary 2,000, each line 300, 12
  lines per list, 12 items (files also ≤ 10, 25 MB each). Cutting a "not
  verified" list would hide exactly what matters, so too much is an error the
  agent fixes. `role: before|after` is only for pictures.
- **One card per turn, at the end.** The call stages the card
  (`results::stage`; a second call replaces the first and deletes its
  copies). When the turn ends, the runner records it after the reply, so the
  reply ends on it and "What it did" hangs under it. A turn that also changed
  a project puts the card **on its change card** (`results::ride_on`: same
  message, the staged id), so a project copy's card is the result card with
  the copy's row inside it, in the card order: ⋯ · Discard · Preview · Ask
  for changes · Review changes · **Keep changes** (the affirmative last,
  neutral). Without a copy, Ask for changes is the card's only action, a
  text action on the right. A turn cut
  off by quitting loses a staged card (it was never shown); its copied files
  are swept on the next launch (`attachments::sweep_unreferenced`: any
  `attachments/<id>/` the raw log never mentions, older than two minutes).
- **No headless turn, no staging.** A take-over's terminal has the same MCP
  URL minus `?turn=`, and nothing would ever take a staged card there. So when
  the caller has no live turn (`broker::is_live`) the card is recorded into
  the chat at once and the agent is told it is there now
  (`results::recorded_reply`); a second call adds a second card.
- **Ask for changes** opens the composer with a "Changes to <title> · v1"
  chip; the send carries `revises` (the result id). `agents_send` pins the
  message to the result as the log has it (`revises: {id, version, title}`)
  and adds `results::revising_prompt` ahead of the text. The next
  `share_result` revises that result: explicitly (`revises`) or because the
  user's latest message is that ask and no result came after it. Anything
  the user says after an ask is a new request, so it can't capture an
  unrelated result. Retry on a failed ask keeps its `revises`. A revision keeps the id, becomes version
  n+1, and must say what changed (`changes`), shown as "Changes since v1: …".
  The log stays append-only: the older version is still there, folded to
  "<title> · v1 · earlier version" (`newestResults`), and opens on
  click, for reading only, with its change receipt (See changes, the diff)
  when it rode on a change card.
- **Checks are the agent's.** The list is headed "It says it checked"
  (`CHECKED_HEADING`) with plain bullets, never ticks, on desk and phone.
- **Open** that could only show a file in Finder (off the open allowlist)
  says so in a toast.
- **Wire**: `message.result` (`ResultCard`) on an `agent` or `changes`
  message; the files are also on `attachments`, so the Files list, search
  previews and older clients still see them. Types and the pure rules
  (`newestResults`, `beforeAfter`, `changesLine`…) live in
  `packages/companion-protocol/src/results.ts`, shared by desk and phone.
- **Screenshots**: a preview screenshot's result now names where it was kept
  (`attachments/<id>/<name>.jpg`), so the agent can put it on a result as
  `before` / `after` without taking it again.
- Not built: a PR straight from a non-copy result, recordings, and "Open"
  for a result whose project copy has since been kept or discarded (the
  card then reads as a record).

## Agents that work in a project (`src-tauri/src/agents/project.rs`)

An agent can be bound to one project (`Agent.project`, a path from
`list_projects`), from the editor's **Works in** or by the Chief
(`create_agent` / `update_agent` take `project`, a name or path; `"none"`
unbinds). Unbound agents run exactly as before; nothing is migrated.

- **The turn runs in the project** (cwd), so its CLAUDE.md, `.claude/` settings
  and `.mcp.json` load. `--add-dir` gets the agent's home first, then the usual
  folders.
- **The identity comes in the appended system prompt**, with the home's path
  so the agent can keep editing its memory. Verified on Claude Code 2.1.318: a
  CLAUDE.md in an `--add-dir` folder is not loaded; with
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` it is, but so is every other
  added folder's (every external project's rules would leak in). `--resume`
  works across a cwd change, so binding keeps the conversation.
- A bound folder that's gone fails the turn with an error naming it.
- The header shows a quiet folder chip that opens the project.

**Change cards.** Before a bound agent's turn the runner snapshots the
project's working tree as a git tree object (through a throwaway copy of the
index, so the user's staging is never touched); after the turn, however it
ended, it snapshots again and diffs the two (`--numstat`, `--name-status`). If
anything changed, a `changes` message records the files with +/- counts, the
branch and both snapshot ids. Edits already present before the turn don't
count; a commit mid-turn doesn't hide work. The card leads with **Open
preview** (opens the project) and **See changes**; the receipt — branch,
line counts, the file list — is one click down. A file opens the app's own
diff modal on this turn's change only (`agents_change_diff`, which reads the
project and snapshots from the stored card). No deploy status: nothing here knows whether that commit deployed.
Limits: another agent or the user editing the same project during the turn is
counted too; the snapshots are unreferenced git objects, so after `git gc`
prunes them the diff says it can't be shown.

### A copy of the project per task (`src-tauri/src/agents/task.rs`)

A bound agent works in its own copy of the project (a git worktree on its own
branch), never in the user's folder, so two agents, or an agent and the user,
can't trample each other. The UI says "a copy of acme-site", "Keep changes",
"Discard"; git stays underneath.

- **When**: a turn of a bound agent with no open copy makes one before it
  starts (the working directory is fixed at spawn, so it can't wait for the
  first edit). The copy (`Agent.copy`) stays open across turns until the user
  keeps or discards it, so follow-ups land in it. A turn that made a copy and
  left it exactly as it started removes it again: questions cost nothing.
  The timeline gets a "Started a copy of acme-site" step.
- **Where**: `<projects root>/.worktrees/<project>/<agent>-<task>-<id>`, the
  folder Ship Studio's own worktrees use (openable by the workspace, listed by
  no dashboard, never inside the project). Branch `<agent>/<task>-<id>` from
  the agent's name and the request's first words. Locked with reason
  `agent-copy:<agent id>`, so `git worktree prune` and a plain remove leave it.
  Ship Studio sees it as an ordinary locked worktree.
- **What comes along**: `.shipstudio/project.json` seeded on its own dev port
  (the seeding `add_worktree` uses), and git-ignored root `.env*`,
  `.claude/settings.local.json` and `node_modules` (up to 3 levels deep).
  Only ignored files are brought in, so none becomes a change Keep would
  commit. `node_modules` is cloned copy-on-write (`cp -c`): measured on a
  317 MB / 31k-entry pnpm tree, 4.7s and no measurable change in free space.
  Where cloning fails nothing is copied and the prompt says dependencies
  aren't installed.
- **Limits**: 4 open copies per project, and none made with under 2 GB free.
  Both fail the turn with a sentence saying what to do; nothing falls back to
  the user's folder.
- **Its own branch, always**: committing, Keep and cleanup first check the
  copy's HEAD is still `refs/heads/<its branch>`. If the agent switched branch
  or detached, they refuse and touch nothing ("The copy isn't on its own branch
  any more — open it to check"); the card shows that line. Even Discard keeps a
  detached copy whose commits no branch holds.
- **Commits**: what a turn leaves uncommitted is committed on the copy's
  branch at the end of the turn (`--no-verify`; bookkeeping, not the user's
  commits), with the `Made-With: <engine>` trailer when attribution is on.
  Never staged: `.shipstudio/` (excluded, and a tracked `project.json` is
  skip-worktree in the copy), `node_modules`, `.env*` (not `.env.example`),
  files over 5 MB, and files whose *added* lines look like a credential (a
  Keychain value, a known token prefix, a private key, `SECRET_NAME=literal`).
  They stay in the copy and the card lists them ("Not included: .env.local
  (looks like secrets)"); a root `.env` the agent edited that git ignores is
  "changed .env — not included". Nothing is committed while conflicts are
  unresolved or a file has added `<<<<<<<` / `>>>>>>>` lines (a bare `=======`
  isn't counted: Markdown underlines).
- **The card**: a turn that changed the copy leaves a `changes` card listing
  everything on the copy's branch (from the base commit's tree: what Keep
  brings), plus `leftOut` and `warning`. Only the newest card of the open copy
  is live: "Changes are ready" (or "Changes so far" while the agent works),
  Keep changes · Review · Preview · Discard, and ⋯ → Open a pull request.
  Keep's tooltip says it adds the agent's commits to `<branch>`.
- **Keep** (`agents_copy_keep`): only into the branch the copy was made from.
  If the project is on another branch now, it answers `otherBranch` and keeps
  nothing; "Keep into <current>" (the note names both branches) sends `into`,
  and only an `into` equal to the current branch keeps there. The project's
  branch is then merged into the copy, so an overlap stops *in the copy*
  (`conflict`); conflict markers stop it too (`markers`), checked before
  committing and again on what the fast-forward would bring. Then the project
  fast-forwards. A project mid-merge / cherry-pick / revert / rebase, unsaved
  edits to the same files, and untracked files in the way each refuse in a
  sentence. `conflict` / `markers` / `otherBranch` are kept on the copy
  (`copy.stuck`) until the next turn or Keep, so the Mac's and the phone's
  cards show them however often they re-render.
- **Discard** (`agents_copy_discard`): asks first; the copy and its branch go.
  Both re-check "is it working?" under the repository lock: a turn claims the
  agent before it prepares its copy, so a Keep can't remove the folder a turn
  is about to start in. Both name the copy, so a stale card can't act on a
  newer one.
- **Preview** opens the copy as a workspace project; **Open a pull request**
  opens it and queues the workspace's own Submit for review modal
  (`lib/reviewHandoff.ts`), which only creates the PR when the user submits.
- **Cleanup** (agent deleted, launch sweep): what's pending is committed to the
  copy's branch first; a copy holding anything that can't be committed (a
  secret, an unresolved merge, another branch) is kept. The branch goes only
  when merged. Changing an agent's project while a copy is open is refused
  (`agents_update`, `update_agent`); the editor asks Keep / Discard / Cancel
  first. The workspace's Force Remove of an agent's copy needs a confirmation
  naming the agent (`remove_worktree`'s `confirmAgent`).
- **Lock**: one per repository (its common git dir), so agents bound to a
  repo's main checkout and to one of its worktrees serialise. `git worktree
  add` gets 300s.
- **Opt out**: "Work directly in the project" in the editor (`workDirectly`).
  Unbound agents, non-git folders and repos without a commit run as before.
- **Phone**: `agents.keepCopy` (with `into`) / `agents.discardCopy` (gated by
  `welcome.methods`), as a card under the newest copy card: Discard outlined,
  Keep the neutral answer colour (as Allow), never the agent's. What stopped
  a Keep comes from `copy.stuck`. Preview and pull requests stay on the Mac.
- **Codex**: its sandbox keeps every `.git` read-only, writable roots or not
  (checked with `codex sandbox -P :workspace` on 0.166; adding the project's
  `.git` to `writable_roots` didn't help), so a Codex agent can't commit in its
  copy. It doesn't need to: the turn's end commits, and the prompt says so.
- Not built: a `start_task` tool to begin a fresh copy mid-conversation; the
  sidebar and dashboard still count agent copies as ordinary worktrees; the
  agent's project `session_*` tools still drive the user's own folder.

## The Chief's audit trail and live hand-offs

- `create_agent`, `update_agent` and `delete_agent` leave a quiet note in the
  Chief's chat ("Created Finance · Invoices and the books", "Updated Acme
  Site's instructions", "Deleted Social Posts"), and creates and updates one in
  the target's ("Created by Chief of Staff", "Instructions updated by Chief of
  Staff"). The note's `peer` makes the name a link.
- The newest line where an agent handed work to each peer shows that peer's
  live state: working (with its activity), needs your OK, didn't finish (its
  newest outcome line is an error, read from its chat or the last few lines of
  its log), or idle.
- In the receiving chat, the brief that started the turn in progress is open
  until the turn ends (or you toggle it).

## Known limits / next

- Claude Code and Codex (see "Engines"). Opencode would slot in the same
  way: a command line and a mapping onto `stream::Step`.
- Search scans files on every query. Fine at one person's scale (tens of
  agents, thousands of lines); an index would be needed well past that.
- Turns at once are scaled to RAM (3–16, `agents::capacity`); the rest wait,
  shown as "Waiting for a free slot". An agent waiting on an approval card
  holds its slot until it is answered or the wait runs out.
- A scheduled run's retry lives on the registry, but the ticket matching it to
  its turn is in memory: a turn cut off by quitting is recorded as such, not
  retried.
- Nothing a turn starts outlives it. `claude --print` waits for any
  background task its Bash tool started (observed with 2.1), so a dev server
  left running would keep the agent "working" for hours; instead, a few
  seconds after the turn's result the tree is stopped. An agent can't leave a
  server running for you to look at.
- Check-ins and routines only fire while the app is open.
- Notification click-through is unverified in a signed build.
- After a restart, the interrupted turn is not re-run (it may have done half
  its work); messages queued behind it are, once. Retry then belongs to
  whatever failed last.
- Debug builds: `research/design-canvas` (not on main) disables the agent
  bridge under `debug_assertions`. Agents depends on it, so that branch needs
  an exception for the `/agents/` route before both land.
- Mobile: the import tool and remote access already put Agents within reach of
  a phone assistant. A native client would talk to the same commands.

## Testing

- `cargo test --lib agents::`: store (including frozen compatibility
  fixtures in `agents/testdata/compat/`: every registry shape and message
  kind users have on disk must load, and a write must keep what a newer build
  added), process trees, share-path validation (traversal, symlinks), prompts framing, activity labels, MCP
  tool visibility, approval descriptions, import merge rules, memory parse and write-back (odd markdown included), the retry schedule and run settling, broker admission and the init check, memory-scaled slots.
- `cargo test --lib agents::rooms agents::runner::rooms_runner_tests`: who answers, mentions in replies, the turn and hop caps, a turn taking one place at a time, a room's Stop leaving the agent's own queue alone, the thread's card answers, the prompt's bounded and honest window, delete and leave, search.
- `pnpm vitest run src/lib/agentRooms.test.ts src/components/agents/RoomChat.test.tsx` and `node scripts/harness-capture.mjs agents-room`: the room view, composer mentions, Who should answer?, an approval in a room, the fold line, New room.
- `cargo test --lib agents::results`: share_result validation and size caps, files that must exist in the agent's own files (all or nothing), versioning and Ask for changes targets, one card per turn.
- `pnpm vitest run src/components/agents/AgentResult.test.tsx` and `mobile/__tests__/result.test.tsx`: the card on desk and phone, folding, Ask for changes.
- `cargo test --lib agents::templates` and `pnpm vitest run src/components/agents/AgentTemplates.test.tsx`: the catalogue, the Chief's section, `create_agent`'s schema, the dialog's fill-in and swap rules; `mobile/__tests__/start.node.test.ts`: the phone's list and create.
- `node scripts/harness-capture.mjs agents-first-win` / `agents-template-`: the starters and the gallery (`agents-ideas`, `agents-ideas-when`: team, brief and site typed; a document staged and New agent on Research, both from the gallery), first results (a team built, a document summarised), Inbox in the dialog with its connect line, and a Chief-made Inbox's first open.
- `node scripts/harness-capture.mjs agents-result`: v1, asking, v2, not verified, a copy's card with before/after.
- `pnpm vitest run src/lib/agents.test.ts`: chat grouping, dividers, ordering.
- `scripts/agents-e2e.sh [scenario…]` (opt-in, real turns, on Haiku): `src-tauri/examples/agents_e2e/main.rs` drives the real
  runner, store, bridge and MCP tools through the same Tauri commands the UI
  calls, on `claude --model haiku`, in a throwaway HOME (only the keychain is
  linked, for sign-in). Scenarios: memory across turns, quit mid-turn and
  relaunch (a second process, SIGKILLed), lost session file, a bound project agent
  (runs in the project, leaves a change card), delegation +
  two agents at once + the hop cap, Stop and interrupt, approvals (Allow,
  late Allow after a shortened wait, Always allow), a fake CLI (startup
  error, garbage output, crash, bare error code), damaged store files, 20
  rapid messages, a session's questions (`session-prompt`: Chief → Site
  Builder → a fresh untrusted project; the trust card in both chats, Allowed
  in the Chief's; trust recorded; the edit's permission card; the edit; a
  change card), Stop ending a turn's whole process tree (a background
  child included), quitting mid-turn (the Exit hook, then relaunch), and more
  turns than slots, and the Memory tab (`memory-tab`: an entry added there is
  read by the next turn, the instructions untouched, Remember this
  summarises on Haiku, and approval requests from no live turn are refused
  without a card). `SHIPSTUDIO_AGENTS_APPROVAL_WAIT_SECS` shortens the 240s
  approval wait in debug builds only. `AGENTS_E2E_KEEP=1` keeps the HOME.
- `cargo test --lib agents::tray agents::quick_entry`: the menu model (sections, order, labels, caps, hidden agents), the quit check, both icons decode, shortcut parsing, labels and conflicts.
- `pnpm vitest run src/lib/agentsDesktop.test.ts src/components/QuitConfirmModal.test.tsx`: the quit dialog's wording and defaults, shortcut recording, quick entry's recipient.
- `node scripts/harness-capture.mjs settings-agents` / `agents-new-with-defaults`: Settings → Agents with the defaults for new agents (chosen, a model menu open, the chosen engine signed out, an engine with no models listed), and the New agent dialog opening on them.
- `node scripts/harness-capture.mjs agents-quit` / `agents-quick-entry` / `agents-desktop`: the quit guard, quick entry's composer (`root: 'quick-entry'`), and its settings.
- Codex: `scripts/agents-e2e.sh codex-memory codex-stop codex-delegation
  codex-approvals` runs those scenarios on Codex. With Codex signed in they
  use the account (its `auth.json` copied into a throwaway `CODEX_HOME`);
  otherwise the real `codex` binary talks to a scripted Responses endpoint
  (`scripts/agents-e2e-codex-model.py`, passed in through the debug-only
  `SHIPSTUDIO_AGENTS_CODEX_CONFIG`), which proves resume, streaming drafts
  kept on Stop/interrupt, delegation through the bridge, and the approval
  round-trip (Allow, Deny with a note the model reads, late Allow, Always
  allow) for an escalated command, not a model's judgement.
  `AGENTS_E2E_CODEX=real|scripted|skip` forces one;
  `SHIPSTUDIO_AGENTS_CODEX_EXEC=1` runs them on the `exec` fallback.
- `scripts/agents-e2e.sh behaviour` (opt-in, about $1.50 for three runs):
  `examples/agents_e2e/behaviour.rs` checks behaviour rather than plumbing,
  each scenario in its own HOME, several runs, with pass rates per check:
  the Chief delegates work that belongs to a specialist (named or not) and
  answers trivial questions itself; one brief and no chatter between agents;
  the Chief reports back unprompted; reminders and "in two hours, tell me"
  get a check-in; no promise of a later update without a check-in or an
  answer actually arriving; every message gets a visible reply; a
  correction is fixed without apology; "ask before sending email" holds
  across turns and sending happens on yes; a fresh Chief offers a daily brief
  and sets it up only on yes; a blocked delegate's blocker reaches the user.
  It prints tokens (the CLI's own), cost, time to first word, and where turn
  time goes (`agents::timing`: our prep, CLI start-up, tail after the
  result). `AGENTS_E2E_RUNS`, `AGENTS_E2E_JOBS`, `AGENTS_E2E_ONLY`,
  `AGENTS_E2E_OUT=<file.json>`.
- `node scripts/harness-capture.mjs agents-`: memory (`agents-memory`, `agents-memory-edit`, `agents-remember`), a routine's past runs and a pending retry (`agents-schedule-history`), project binding (`agents-project-*`), Chief audit (`agents-chief-audit`), brief in progress, team, What's in flight (`agents-team-overview`, via ⌘K), @mention menu, approval, secure input (`agents-secret-*`, `agents-secrets-editor`), first run (keep-awake off and on), new
  agent, import, Claude Code missing, the engine picker (`agents-engine-picker`), Codex not signed in (`agents-engine-unavailable`), one engine installed (`agents-engine-one`), a Codex that can't ask (`agents-codex-cant-ask`) and a Codex agent's chat (`agents-codex-chat`).
