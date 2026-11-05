# Mission

Read this first. Every decision in this repo is measured against it.

## Why we exist

**To give the people who refuse mediocrity the best way to work there is.**

Knowledge workers, designers, engineers, tinkerers — people who want more
from their tools than they're being sold. The way work gets done is changing
under everyone's feet: you no longer just *do* the work, you direct agents
that do it with you. Almost nobody has a good place to do that yet. We're
building it.

This is an open-source tool for professionals, on desktop and on mobile. It
should feel like the answer to what knowledge workers need today — and it
will keep evolving to be exactly what matters as the times change.

The working name is **Dashbot** (set in `brand.json`; real branding comes
later — never hardcode the name, and never make it prominent in the UI).

## What it is

**The best place to run your own team of AI agents.** You open the app and
you're talking to your Chief of Staff. It creates, briefs and delegates to
named agents that remember you, do real work, and come back with results —
at your desk and in your pocket.

## The inspiration

**Grok Bot got the experience right and everything else wrong.** Named,
persistent agents you just talk to; approvals that arrive as a tap; a chat
that feels like a team. That is the bar for UX. But people are stuck with
its agents' intelligence and its usage limits.

We keep the experience and replace what's underneath:

- **Your agents are the best agents there are** — Claude Code and Codex,
  chosen per agent, on your own machine, on your own accounts.
- **You own your setup.** Your models, your data, no ceilings we impose.
- **Owning it doesn't mean suffering for it.** A refined, calm, simple UX on
  desktop and mobile. Nobody should have to live in a terminal to have this.

## Benchmarks

We combine the most flexible intelligence with the most beautiful, usable,
enjoyable experience. Hold the work to these:

- **Experience: Grok Bot.** Talk to a team of agents like people; approvals
  are a tap; it feels calm and personal on desktop and phone.
- **Capability: T3 Code, Replicas and their kind.** Real agents (Claude Code,
  Codex) doing real work; isolated environments per project; work handed
  back as something reviewable — a result, a PR, a preview, a screenshot —
  not just a claim that it's done. Work starts from wherever it comes up.

Their audiences are engineers; ours is every professional who wants more.
Take their capability, never their jargon.

## Open source first, compute optional

The open-source app is the product. Anyone can install it and run it on
their own computer, free, forever. Later there will be an optional paid
service: from your phone, subscribe (around $40/month) and we set up the
same app on a cloud computer for you. Same app, someone else's hardware —
your choice.

What that means for the code today: don't assume the machine is a Mac on a
desk with someone sitting at it. The phone must be a complete way in, and
nothing should block a future headless, always-on host.

## What it is not

- **Not a coding tool.** T3 Code and its kind are for developers — "code" is
  in the name. Code is one thing agents do here, not the point.
- **Not an infrastructure company.** We don't build our own models, clouds,
  relays or runtimes when the best ones already exist. We stand on Claude
  Code, Codex, git, Tailscale and the user's own machine, and spend our
  effort on the experience.

## How it's built

- **Agents on top.** The primary view is Agents. Onboarding flows straight
  into a conversation with the Chief of Staff; going from nothing to
  understanding how it works should take one sitting.
- **Ship Studio underneath.** When work becomes a project (a site, an app),
  it lives in the Ship Studio workspace — terminal, live preview, visual
  editor, git, hosting. Agents make, manage and use these projects; people
  drop in to go deep and focus on something hard. Each project is isolated
  and runs on its own.
- **The workspace and visual editor stay.** They're crucial and will improve
  over time, but they are not being redesigned now.

## How we work on it

You — human or agent — are building the tool you'd want to use yourself.
Act like it.

- **End to end, or it isn't done.** A feature works from onboarding to the
  result on a phone screen, or it's not finished. Look at what you built
  (`pnpm harness`, the real app, the simulator) before calling it done.
- **Taste is the job.** Fewer, better things. Keep Ship Studio's tactile
  feel and simplicity. If something feels like a dev tool, an admin panel or
  a settings maze, it's wrong — fix it or flag it.
- **Be honest in the UI.** Show what's known, never what's guessed (see
  "Never Assume Data" in CLAUDE.md). Trust is the whole product when agents
  act on someone's behalf.
- **Push back.** If a request makes the product worse, say so, with reasons.

## Rules that follow from this

- **Compatible with Ship Studio, both directions.** Either app opens
  projects made by the other: the in-project `.shipstudio/` format and the
  projects folder are shared. App state (settings, agents, Remote Access,
  logs, keychain) is Dashbot's own, so both apps run side by side.
- **Black and white, plus one accent the user chooses.** No brand green.
  Semantic colours (success, warning, error) keep their meaning. Dark only,
  for now.
- **Big infrastructure changes are welcome now**, as long as everything
  still works.
