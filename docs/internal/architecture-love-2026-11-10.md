# Architecture love, 2026-11-10

A structural pass over the Rust side and the background work: what is
neglected, what it costs, and what was fixed tonight. The agents store's own
locking (`agents/store.rs`) is out of scope; another branch fixes the deadlock.
UI rendering and launch profiling are another branch's too.

Measured on the live debug build (pid 52406, 12 minutes up): 0.1% CPU at idle,
~140 MB resident. Idle is not the problem. Bursts and blocked workers are.

## Ranked findings

### 1. Store I/O on the async workers (fixed in part)

Every `#[tauri::command] async fn` runs on the Tauri runtime's async workers,
the same small pool the agent bridge, the companion server, Remote Access and
every turn's I/O share. 72 of the 158 async commands in `commands/agents.rs`
did not use the file's own `blocking(..)` helper, and many of those read or
wrote the registry (`store::list/get/update`, a `std::sync::Mutex` plus file
I/O) directly on those workers. The routine loop (`schedule::spawn`) ran its whole
minute tick, registry writes and turn starts included, on a worker; the
"When…" loop (`watch::tick`) was an `async fn` with no `.await` in it, doing
the same.

Why it matters tonight: when the registry lock is held (or deadlocked), every
command that touches it parks a worker. A handful of concurrent overview calls
is enough to park the whole pool, at which point the bridge, the phone and
Remote Access stop answering too, so one stuck lock looks like the whole app
freezing. On the blocking pool (512 threads) a stuck lock holds only the
threads that need it.

**Fixed:** `agents_overview` (the hottest command: desk and phone both poll it),
`agents_focus`, `agents_mark_unread`, `agents_usage`, `agents_instructions`,
the six routine commands, quiet hours, account rename/reorder; the routine
loop's tick and restart pass; the "When…" tick. **Left:** 59 commands in
`commands/agents.rs` without the helper (some pure, some async all the way
down, the rest rarely called); convert them with the same
`blocking(..)` helper as they are touched. A lint for it would be worth having.

### 2. `claude auth status` stampede (fixed)

Today's log has **413** `claude auth verdict` lines in under six hours, in
bursts of up to **seven within 100 ms** (`agents_overview` 302,
`agents_usage_overview` 300, `get_full_setup_status` 78 by span). Each is a
Node process (~0.3 s CPU). `engine::signed_in_here` caches a yes for 60 s, but
callers that miss at the same moment each spawned their own probe.

**Fixed:** `joined::Joined`, a single-flight: callers that arrive while a
probe runs share its answer; nothing is cached beyond that, so no answer is
staler than before. Applied to `claude_cli_auth_status` (every caller of
`claude_auth_truth`) and Codex's `login status`.

The frontend side (why three to seven overview requests land at once) belongs
to the UI-performance branch.

### 3. ~0.3 s of process spawning before the window (fixed)

`run()` killed orphaned agent CLIs, `next-server`s and serve-sim daemons
synchronously before building the window: ten `sh`/`pkill` spawns each running
`pgrep` and `ps`. The log shows 300 ms between the first two startup lines;
the same script measured 230 ms in a shell. It also ran `pkill -P <our pid>`,
which can't match anything at launch (no children yet).

**Fixed:** orphans (ppid 1 only) are reaped on a thread of their own; the
own-children `pkill` stays in the quit/window-close cleanup where it means
something. Bundled-skill installs (file copies) moved from an async worker to
the blocking pool.

### 4. Loops that already got their love

`usage_read`, `disk`, `expiry` and Slack already use `spawn_blocking` and the
power-aware `power::sleep_aligned`/`power::every`; Slack sleeps up to five
minutes with nothing to do. Ship Studio's workflow scheduler is gone from this
build (older logs still show "workflow scheduler started"). Nothing to do.

### 5. Desk/phone duplication: smaller than it looks

Files with the same name in `src/lib` and `mobile/src/lib` (`diff`, `steady`,
`turnSteps`, `phoneSignin`, `accounts`, `teamSetup`) do different jobs on each
side (git diff rows vs. Claude Code's screen box; Tauri invokes vs. the paired
transport); the shared logic already sits in `packages/companion-protocol`
(87 modules). Not worth a move tonight.

### 6. Giant files

`commands/edit_css.rs` (7950 lines), `agents/runner.rs` (7669),
`commands/edit.rs` (5832), `companion/router.rs` (4964). All under the LOC
ceilings. `runner.rs` mixes the turn process, recovery, and status; splitting
recovery out (`prepare_recovery`/`recover_after_restart`) is the natural first
cut, best done after the store-lock fix lands to avoid conflicts.

### 7. Error paths

`let _ = store::update(..)` is common in loops (schedule, watch). Each is a
deliberate best-effort write, but a failed one leaves no trace. A
`store::update_or_log` would make them visible without changing behaviour.
Not done tonight.

## What changed

| Commit | Change | Test |
| --- | --- | --- |
| Single-flight auth probes | `src-tauri/src/joined.rs`, `commands/accounts.rs`, `agents/engine.rs` | `joined::tests` (shared answer, fresh after finish, cancellation) |
| Orphans off the launch path | `src-tauri/src/lib.rs` | builds; behaviour unchanged except timing |
| Store work off async workers | `commands/agents.rs`, `agents/schedule.rs`, `agents/watch.rs` | existing schedule/watch/commands tests |

Not verified: launch timing in a release build, and the deadlock scenario
itself (needs the store-lock branch's repro).
