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
it. Three starters sit under it until the user's first message; while the
greeting is all there is, it and the starters sit in the middle of the page as
an empty state (`data-greeting` on the message column), not at the foot of an
empty screen.

In Agents mode the sidebar's top row is the toggle (Home, Workflows and the
Inbox belong to the Projects side). **What's in flight** — the one name for
the cross-agent overview — is reached from a **"Needs you · N"** row at the
top of the agent list, shown only while an agent waits on you (a card, or a
turn that didn't finish; the same set ⌘J visits), and from ⌘K. There is no
icon for it: an unlabeled one was three names for one place. Its foot has the Phone row (the companion
app: pair, or which phone is connected); remote access, for driving the app
from another assistant, appears there only while it is on and is otherwise
reached from the Phone panel's last line or ⌘K. In a project's workspace
sidebar, agents bound to that project are listed above its terminal
Sessions; clicking one opens its chat.

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
       --mcp-config '{"mcpServers":{"shipstudio_agents":{"type":"http","url":…?turn=<id>}}}'
       --allowedTools mcp__shipstudio_agents
       --append-system-prompt <voice + role + team rules>
       --add-dir <projects root> --add-dir <each external project>
cwd = the agent's home, prompt on stdin, MCP_TOOL_TIMEOUT raised (see below)
```

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

Served by the existing loopback agent bridge at
`/mcp/<bridge token>/agents/<agent id>`. The id in the path is the caller, and
the URL is passed only inline to the process the app spawned for that agent.

| Tool | Who | What |
| --- | --- | --- |
| `list_agents` | all | names, roles, busy / waiting |
| `message_agent` | all | async: records "Messaged X" here and "Message from Y" there, queues a turn for X |
| `project_*`, `session_*`, `preview_screenshot`, `git_status`, `push`, `deploy_status` | all | working on projects, below |
| `share_file` | all | hands the user a file it made: copied into its `attachments/`, posted as its own message with a file card |
| `share_result` | all | ends a piece of work on one result card: files, links, what it checked and did not verify; revisions become v2 (below, "Result cards") |
| `request_secret` | all | a secure input card for a password, key, token or login; the agent gets `$VAR` and a reference, never the value (below) |
| `create_agent` | Chief | name, role, instructions, optional `project` and `first_task` |
| `update_agent` | Chief | name / role / instructions / project (memory kept) |
| `delete_agent` | Chief | puts an Allow / Deny card in the Chief's chat first |
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

## Approvals

`acceptEdits` lets an agent edit files inside its home and every project
without asking. Anything else Claude Code would prompt for (a shell command
that isn't read-only, a web fetch, an MCP tool like sending email, a file
outside those folders) goes to `approve`, which puts a card in that agent's
chat showing the exact command, file, URL or tool input, and waits for
**Allow** or **Deny**. While it waits, the agent's row says "Needs your OK".

**What the broker trusts** (`agents/broker.rs`). Each turn gets an id on its
MCP URL (`?turn=`), open until `run_turn` returns. An `approve` call with no
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

Codex turns get the same: the `?turn=` URL is what `codex_app::args` passes
Codex for our server, and Codex's own approval requests go through
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

**Answered where you are** (`AgentInlineRequests`). Another agent's open card
is offered at the foot of the chat you're in, as a quiet "Review Lead Gen's
request" chip that opens the same card in place: in the Chief's chat for every
agent, elsewhere for the agents that chat has worked with. Answering it there
answers it everywhere (one request id). A card already in the chat (a
session's question) isn't offered twice. A run of the same request from one
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
From the agent menu ("Take over" / "Hand back"), the working line and the
live timeline, and ⌘K ("Take over <agent>", "Hand <agent> back"). Offered once
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
    The MCP URL carries no `?turn=`, so anything that reaches `approve` is
    refused; the agent's other tools (message an agent, share a file) work.
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
  too. Bash still asks. The banner's tooltip says so once; Shift-Tab changes
  it in Claude Code.
- **Trust.** If Claude Code hasn't recorded the folder as trusted
  (`hasTrustDialogAccepted` on it or a folder above, in `.claude.json` under
  `CLAUDE_CONFIG_DIR` or home — read, never written), the banner adds:
  "Claude Code will ask whether to trust this folder — choose “Yes,
  proceed”. Choosing No ends the take-over." Codex's trust prompt isn't
  checked.
- **Where.** A bound agent's session becomes a tab in its project's workspace
  (`adoptTakeover` + focus, through `useRemoteAgentControl`), which opens. The
  tab is never saved: `set_terminal_state` drops `takeover-` tabs, and
  `get_terminal_state` drops any on disk and adds the ones running now, so
  a quit, crash or hand-back leaves no ghost tab to respawn.
  Any other agent's shows in its chat in place of the conversation
  (`AttachedTerminal`, attach-only), with "Show chat" to see the conversation
  and composer. Either way one line under the header says "You're driving
  Finance in a terminal · Hand back"; the sidebar row and chat header read "You're driving Finance";
  a message you send waits ("Waiting, sends when you hand Finance back").
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

Only the other assistant knows its own agents, instructions and memory, so the
import runs from its side, over Remote Access. Nothing it sends becomes an
agent by itself: every connector import ends on one review card in the
Chief's chat, and the user imports what they keep (`agents/review.rs`).

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
   ("From Grok · via connector"), the interview's replies `sent_to_agent`
   lines to the same peer, indented as "To Grok". Neither ever reaches the
   Chief's own session (`runner::recap_lines` skips them), and the other
   assistant only hears what the interview wrote. A bar above the composer
   says where it is, that what you type stays between you and the Chief, and
   has a red **Stop import**; the Chief's own Stop (desktop or phone, where
   its row reads "Talking to Grok (import)") stops it too.
4. `finish` posts the review card: each agent ticked, with its role and the
   first lines of its instructions in view (**Show all** for the rest), its
   memory, routines (paused) and the logins it asks for a click away; a
   name already taken (or a lookalike of one) comes in as "<Name> (from
   Grok)" unless the user picks **Replace**, which lists what it does to
   that agent: new instructions (the diff), a fresh conversation (memory
   kept), its running routines paused, its project unbound, its
   Always-allow rules removed, and its saved logins removed unless "Keep its
   saved logins" is ticked (off by default). The managing agent's notes are
   an optional "Add to <Chief>'s notes", off by default. **Import** creates
   what's ticked; **Don't import** creates nothing. Only the Mac's card
   imports: the phone's says "Review on your Mac". Logins arrive as secure
   cards in each agent's chat that don't wake it
   (`secrets::Request::quiet`): an imported agent first runs when the user
   messages it.

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
gains a segmented choice, "From Ship Studio" | "From another assistant" (and
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

## Usage before the wall (`agents/usage.rs`, `agents/quota.rs`)

Grok Bot's bots went silent at the usage limit. Here the limit is said
before it arrives, and only from what the engines report: nothing is ever
estimated, and no reading means no line.

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
(or "Finance has a check-in coming up."), naming them, with **Keep running in
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
Sign in. A new agent starts on the first engine that is ready
(`defaultEngine`), and `agents_create` refuses one that isn't, whether it was
chosen or defaulted. One line says what protects an agent on that engine
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
  -c sandbox_workspace_write.writable_roots=[<home or project dirs>]
  -c sandbox_workspace_write.network_access=false
  -c mcp_servers.shipstudio_agents={url=…,tool_timeout_sec=300,default_tools_approval_mode="approve"}
  -c project_doc_fallback_filenames=["CLAUDE.md"]
→ initialize, initialized
→ thread/start {cwd, approvalPolicy:"on-request", sandbox:"workspace-write",
                config:{"sandbox_workspace_write.network_access":false},
                model, developerInstructions}    (or thread/resume {threadId, …})
→ turn/start {threadId, input:[prompt]}
```

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
  the agent, in the editor, or at the foot of the chat header's … menu, which
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
  with Retry, Retry at the reset, or Sign in), who is working (their
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
checked[], not_verified[], revises?, changes? }` at the end of the work; the
prompt (`prompts::FILES`) tells it to for deliverables, never for chat.

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
  Keep · Review · Preview · Ask for changes · Discard inside it. A turn cut
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
  "<title> · v1 · a newer version is below" (`newestResults`), and opens on
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
- `cargo test --lib agents::results`: share_result validation and size caps, files that must exist in the agent's own files (all or nothing), versioning and Ask for changes targets, one card per turn.
- `pnpm vitest run src/components/agents/AgentResult.test.tsx` and `mobile/__tests__/result.test.tsx`: the card on desk and phone, folding, Ask for changes.
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
