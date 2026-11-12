---
title: Routines
order: 5
---

A routine is work an agent does without you starting it: at a time, or when something happens.

**Routines run only while the app is open and your computer is awake.** A routine missed while the app
was closed runs once when you reopen it, marked late. It never runs once per missed time.

## On a schedule

Ask in plain words, to the agent or the Chief: "Every weekday at 8am, send me a summary of X".
Or use the **Routines** button in the chat header, then **New routine**:

- **How often:** Every day, Weekdays, Weekly, Monthly, Every few hours, or Once.
- **At:** the time.
- **What:** what the agent should do.

Before you save, the app shows the whole routine back to you ("Every weekday at 8:00 AM — Send me
a summary of X") with its first run. A time it can't read is refused, never guessed.

Monthly works too: "the 1st", "the last Friday", "every 3 months on the 15th". A date a month
doesn't have (the 31st in November) runs on that month's last day. Routines can't run more often
than every 30 minutes.

Each routine can be paused, edited, cancelled, or run now with **Run now** (which doesn't move its
next time). **Past runs** shows what came of the last 10.

To see every agent's routines in one list, use **Routines** in the sidebar. **Pause all
routines…** and **Resume all routines…** are there too.

If a run fails for a temporary reason (a usage limit, the network), it's tried again a few times
and you're told once. A run that finds nothing new posts nothing, just a quiet "Checked · nothing
new" line.

## In steps, with your OK in the middle

A scheduled routine can have up to five steps. Mark a step **Your OK first** and the routine stops
before it with a card, **OK to go on?**, showing what the step before made.

Example: "Every Friday at 4pm: draft the weekly report, wait for my OK, then post it to #team."

- **Go ahead** runs the next step. **Stop here** ends the run.
- Only you can answer this card. No independence level answers it for you, and it doesn't expire;
  it closes if the routine's next run starts first.
- Your Go ahead covers exactly what the card showed, nothing more.

Steps are for scheduled routines only.

## "When…" routines

A routine can start when something happens. The app checks from your computer every few minutes:

- Someone mentions you on GitHub.
- An issue or pull request is assigned to you on GitHub.
- A new file appears in a folder.
- An email arrives in Mail on this Mac (optionally from a sender, with some words).
- A text arrives in Messages on this Mac (optionally from one number or email).
- A Linear issue is assigned to you.
- Something else, in your own words, checked through one app you've connected.

The first check only notes what's already there; nothing fires for it. After that, nothing fires
twice. The routine editor shows what each check costs: most are free, and the last two use a small
model call each time.

Mail and Messages need **Full Disk Access** for the app (System Settings → Privacy & Security →
Full Disk Access). The app shows you the way there and checks again until it's on.

What arrives through a "When…" routine (an email, a text, a comment) counts as text from outside,
so the agent works on it carefully: see [Independence](independence.md).

## Quiet hours

Tell the Chief "quiet hours 10pm to 7am". Inside them, nothing scheduled fires, except a routine
you set for a time inside that window. What waited runs once when quiet hours end. Notifications
are held too, except approvals.

## Morning brief

Once a day the Chief posts a short brief in its chat: what's waiting on you, what didn't work, what
runs today, what each agent did, and how much usage you have left. It's built from the app's own
records, so it doesn't use any of your plan.

- On by default at 8:00 AM. Change the time or turn it off by telling the Chief ("brief me at
  7:30", "stop the morning brief"), in **Settings → Notifications**, or on the phone.
- If there's nothing to say, nothing is posted, unless you turn on **Post on quiet days too**.
- If your computer was asleep or the app was closed for more than 3 hours past the time, that day's
  brief is skipped.
- You can add up to four of your own checks, like today's calendar events, through apps you've
  connected. These checks do use a small model call each.
