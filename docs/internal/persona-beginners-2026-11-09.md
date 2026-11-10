# Beginner persona review, 2026-11-09

An adversarial walk-through of the whole journey (site, install, first run,
the Chief, first agent, first approval, first result, phone, usage, failure)
as three people who have never run an agent or a terminal. Done against
`mogbot/foundation` at `f2b0ff64d`.

**How it was looked at.** The live site (fetched as text), README, WELCOME,
INSTALL and MISSION; the desk UI through `pnpm harness` (`onboarding-*`,
`agents-first-*`, `agents-new*`, `agents-approval`, `agents-usage-limit`,
`agents-quota-limited`, `agents-error`, `agents-no-engine*`,
`settings-agents-independence*`, `phone-*`); the phone through `qa:web`
(pairing, Catch up, chats, usage, offline). Not looked at: a real install
on a bare Mac, a real Tailscale pairing, a real phone, real model turns.
What a model *says* in a turn (the Chief's replies) is outside this review;
only the app's own words are.

Ratings: 1 = would give up, 3 = gets through with friction, 5 = no thought
needed.

## The personas

- **Dana**, runs a three-person bookkeeping-and-design studio. Claude Pro.
  Never opened Terminal. Wants an agent to chase invoices and sort email.
- **Marcus**, COO. Lives on his iPhone. Wants "a chief of staff" that
  briefs him and asks before doing anything. Has an assistant who could
  install things on his Mac once.
- **Priya**, grad student, ChatGPT Plus (so Codex). Wants agents to
  research and draft. Comfortable with apps, not with code.

## The journey

### 1. The website

| | Rating | In their words |
|---|---|---|
| Dana | 2 | "It says Mac, Windows and Linux and has download buttons. The GitHub page says there's no download and macOS only. Which is it? Then the steps say `pnpm install`, `pnpm tauri dev`. I don't know what any of that is." |
| Marcus | 2 | "'iPhone app soon.' So I can't actually use it from my phone yet? The page doesn't say what I'd do today." |
| Priya | 3 | "It lists OpenCode, Ollama, qwen2.5-coder. Do I need those? The FAQ about 'multiple accounts violating terms' makes me nervous." |

The site promises things the repo says don't exist (Windows, Linux, a
download, local models through Ollama) and its build steps (`pnpm tauri
dev`) are a developer's, not the README's. It isn't in this repo, so it
isn't fixed here. **Recommendation 1.**

### 2. Install instructions

| | Rating | In their words |
|---|---|---|
| Dana | 1 | "'Open this folder in Claude Code.' What folder? I don't have Claude Code, I have Claude. How do I get the folder?" |
| Marcus | 2 | "My assistant could do this, but it's 10 to 25 minutes, then Tailscale, then *building* the phone app with Xcode for an hour, and it stops working after 7 days?" |
| Priya | 2 | "Same chicken-and-egg: I need Codex to install the app that installs Codex." |

The runbook itself is excellent for an agent. The gap was the step before
it: someone who has never used Claude Code had no way in. **Fixed:** README,
WELCOME and INSTALL now say how to start from nothing (the Claude desktop
app's Code tab or the Codex app, and one sentence to paste that clones the
repo and follows INSTALL.md). WELCOME also says what a permission prompt
from their agent means. Not verified on a bare machine.

WELCOME.md still described the old five-screen onboarding (independence,
phone and a Ready screen that no longer exist). **Fixed:** it now describes
the two screens and the things offered later; INSTALL Step 18 no longer
says "the app asked you once (Careful, Steady, Bold)", and Step 19 points
at the card, not "the app's last screen".

### 3. First run (onboarding)

| | Rating | In their words |
|---|---|---|
| Dana | 4 | "'Your own team of AI agents… anything risky waits for your OK.' Good. 'Claude Code: uses a Claude Pro or Max plan.' I have Pro, so that one. Not sure why it's called *Code*." |
| Marcus | 4 | Two screens and he's in. "About five minutes" held for the screens themselves. |
| Priya | 4 | "Codex, ChatGPT Plus. Then 'Get your Mac ready for Codex, 1 of 4' and a Mac password. A bit scary but it told me why." |

Calm, one button per screen, honest failures. Two wrinkles:

- The engine names. "Claude Code" reads as a coding tool to Dana. The card
  subtitle ("Claude, by Anthropic") helps; WELCOME now says outright that
  you don't need to code. **Recommendation 6** (a line on the card itself).
- A network failure said "Couldn't reach the download server (network
  timeout)" and then "quit and reopen the app", which doesn't fix Wi-Fi.
  **Fixed:** a network-shaped error now says "Check this Mac is online
  (open any website), then press Try again." (`engineItemCheck`, tested).

### 4. First message with the Chief

| | Rating | In their words |
|---|---|---|
| Dana | 3 | "'Run an inbox triage crew'? Triage is a hospital word. 'Run my launch as a team', I'm not launching anything. Where's invoices?" |
| Marcus | 4 | "Brief me every morning. That's me." |
| Priya | 3 | "Nothing about research. 'More ideas…' has 'Ship fixes while I sleep', 'Babysit my errors', 'Turn client briefs into sites'. That's for programmers." |
| All | 3 | The import card's bright button is **Bring my agents**. "Am I supposed to bring agents? I don't have any." |

**Fixed:**
- The inbox chip is now **Sort my inbox, draft replies**.
- Two ideas in More ideas…: **Chase unpaid invoices** (weekly, finder +
  reminder drafter, nothing sent without Allow) and **Research it and
  write it up** (researcher + writer, every source linked, weekly update).
  A test holds the chips free of "triage / crew / repo / deploy / GitHub".
- The import card now asks **"Already have agents in another assistant?"**
  and ends "New to agents? Start fresh." Its words live once in
  `cardWords.ts` for desk and phone (the phone's decline now says
  **Start fresh** too).

### 5. First agent created

| | Rating | In their words |
|---|---|---|
| Dana | 4 | "Describe the agent you want. Draft it. 'Its name, briefing and routines.' Routines like my morning routine?" |
| Marcus | 4 | Dictates it on the phone; fine. |
| Priya | 4 | Fine. |

**Fixed:** "Its name, briefing and routines" now reads "Its name, what it
does and when it runs" (desk and phone, and the drafting line and the
phone's accessibility hint).

### 6. First approval

| | Rating | In their words |
|---|---|---|
| Dana | 5 | "Send an email, To, Subject, Body, Deny or Allow. Clear." |
| Marcus | 4 | On the phone in Catch up: clear. But an agent working on a site showed "Do you want to make this edit to Hero.tsx?". "What's Hero.tsx?" |
| Priya | 4 | Fine. |

The email card is the best screen in the app for a beginner. File-edit
cards surface the engine's own wording and file names. Beginners rarely
reach project agents, so this is **Recommendation 7**, not a fix.

### 7. First result

| | Rating | In their words |
|---|---|---|
| Dana | 5 | The summary of an attached PDF, with what it couldn't read. "It told me page 7 was unreadable. I trust that." |
| Marcus | 3 | "Use your agents from your phone? About ten minutes." Then the Phone panel: TestFlight *Not available yet*; the only route is "Install it yourself (advanced)": Xcode, a cable, an Apple ID, re-install every 7 days. "That isn't ten minutes." |
| Priya | 5 | Fine. |

**Fixed:** the phone offer no longer promises ten minutes. It says "There's
no App Store app yet, so setting it up takes ten minutes to an hour."
(`PHONE_OFFER_NOTE`, tested). WELCOME says the same.

### 8. Phone pairing and Catch up

| | Rating | In their words |
|---|---|---|
| Marcus | 2 | "Turn on Tailscale on this phone. 'Without it, the Mac never sees the request.' What request? What's Tailscale?" Unreachable: "Nothing answered at localhost:50898. Check that Tailscale is connected… that the Mac is awake… that the app is open…". One paragraph, four conditions, a port number. |
| Dana | 3 | Catch up's "12 things need you" with Review / Answer per row is clear. "Keep these changes? 2 files in a copy of acme-site": a copy of what? |

**Fixed:** the Tailscale step now says what Tailscale is: "Tailscale is a
free app that links this phone to your Mac privately. It's the only way
this phone reaches your Mac, so it needs to be on first."
**Recommendation 3** (the unreachable screen as a checklist, without the
host:port in the first line).

The real problem for Marcus is structural: no installable phone app, and
the companion app is the product (MISSION). **Recommendation 2.**

### 9. Usage and limits

| | Rating | In their words |
|---|---|---|
| Dana | 3 | Sidebar: "No usage reading yet." "Reading of what?" |
| Marcus | 2 | Phone Usage: "CONTEXT. 180K of 200K tokens. Estimate from 11 readings across 2 accounts. 62% of sam@example.com's 5-hour limit resets in 40 min. Add something to your spare-capacity list." "I have no idea what I'm looking at." |
| Priya | 3 | Knows ChatGPT has limits; the 5-hour/weekly split is new to her but explained by the rows. |

**Fixed:** the "Context" section is now **Conversation length** (desk and
phone). **Recommendation 4** (a beginner headline above the detail: "You
have plenty left" / "You'll run out around 11 PM").

### 10. Something going wrong

| | Rating | In their words |
|---|---|---|
| Dana | 3 | Out of usage: "Retry at 11:15 PM · Try anyway · Add another account." "Try *anyway*? Will that cost me extra?" |
| Priya | 4 | Signed out: "Claude Code is signed out. Retry / Sign in to Claude Code." Clear. |
| Marcus | 3 | From the phone, nothing he can do about the Mac being asleep; the app says so honestly. |

**Fixed:** "Try anyway" is now **Try now** (it re-sends now in case the
limit lifted early; "anyway" read as a risk).

## Ranked recommendations (not done here)

1. **Make the site match the repo.** No Windows/Linux, no download, no
   Ollama/OpenCode claims while README says macOS only and "no download
   yet"; replace `pnpm tauri dev` with the README's "ask your agent" path.
   Every beginner's first impression is a contradiction.
2. **Ship an installable phone app (TestFlight).** Every phone-first user
   stops at "Install it yourself (advanced)". Until then, say on the site
   and in the Phone panel's first line that the phone needs a one-time
   build on the Mac.
3. **Pairing "Can't reach" as a checklist.** One line per condition with
   its own fix, the address in a quiet detail line, not the first sentence.
4. **A beginner headline on Usage.** One sentence in plain words before the
   meters ("Plenty left this week" / "Runs out around 11 PM; resets
   Thursday"), and "tokens" behind a disclosure.
5. **Bring the build step into the app's voice.** A non-technical person's
   setup agent asks to run dozens of commands; INSTALL could tell the agent
   to explain, before Step 2, that it will ask permission many times and
   that saying yes is expected.
6. **One line on the engine cards: "You don't need to code."** "Claude
   Code" reads as a programming tool to the people the mission is for.
7. **Translate engine permission prompts.** "Do you want to make this edit
   to Hero.tsx?" should read like the email card: what changes, in which
   project, in words.
8. **"No usage reading yet"** in the sidebar: say "Usage shows after the
   first reply" instead.
9. **More ideas… still leans technical** (ship fixes, babysit errors,
   client briefs → sites). Consider ordering the gallery so the
   non-technical ideas come first in each group.
10. **"Model" in every chat header** means nothing to a beginner; "Runs on"
    is the app's own word for it elsewhere.

## What changed in this pass

- Chief chips and gallery: "Sort my inbox, draft replies"; new "Chase
  unpaid invoices" and "Research it and write it up" (`lib/chiefIdeas.ts`,
  tests in `ChiefIdeas.test.tsx`; docs/agents.md).
- Import card: "Already have agents in another assistant?", "New to agents?
  Start fresh." Shared words in `cardWords.ts`, desk and phone.
- New agent: "Its name, what it does and when it runs" (desk and phone).
- Phone offer: honest time, no App Store app yet (`PHONE_OFFER_NOTE`).
- Usage-limit line: "Try now" for "Try anyway".
- Onboarding network failure: "Check this Mac is online…".
- Phone pairing: what Tailscale is, in one sentence.
- Usage: "Conversation length" for "Context" (desk ring and phone sheet).
- README, WELCOME, INSTALL: a start-from-nothing path; WELCOME and INSTALL
  match the two-screen onboarding.
