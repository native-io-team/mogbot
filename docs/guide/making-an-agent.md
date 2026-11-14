---
title: Making an agent
order: 3
---

## Your Chief of Staff

The app opens on a chat with your Chief of Staff. It's there from the first launch, and it runs
the rest of your team: it creates agents, briefs them, hands them work, keeps track of what
they're doing, and deletes them when you say so. You can talk only to the Chief and let it run
everything else.

Each agent runs on Claude Code, Codex or OpenCode on your computer, on your own accounts. You choose which
one per agent once you have more than one set up.

## Describe the agent you want

Click **New agent** (or press ⌘N) and write what you want in a sentence or two. **Draft it**
fills in the whole agent:

- a name and a colour,
- a one-line role,
- a briefing (its instructions),
- up to four routines, each shown the way the app read it ("Every Friday at 16:00"),
- the apps it will need.

Everything is editable, and nothing is made until you press **Create**. A routine the app couldn't
read as a time says so and can't be ticked; it's never guessed.

You can also ask the Chief in chat: "Make me an agent that…". It replies with the draft and asks
"Make it?" first.

There are also ready-made agents to start from (Research assistant, Inbox triage, Weekly review).

## The briefing

An agent's briefing is what it's told to do and how. Change it in the agent's editor (**Edit
agent**), or tell the Chief what to change. A new agent opens with a short welcome in its
own voice and three things you can tap to start.

## Edit agent

**Edit agent** is one sheet, laid out like Settings. At the top is the agent's key (click it to
change its colour, icon and shortcut key), its name, and what it runs on. Three tabs sit under
it: **Agent**, **Memory** and **Usage**.

On **Agent**, the rows are grouped:

- **What it does**: its name and its one line.
- **What it should know**: its briefing.
- **How it runs**: Claude Code, Codex or OpenCode (a choice once two are set up), the model, and
  the project it works in.
- **On its own**: its independence, what it may always do beyond its level, and the Admin switch.
- **What it can use**: its apps and access, and its skills.

A row with a › opens its own page in place; **‹ Edit agent** comes back. Independence, Admin,
apps and skills change the moment you change them. The name, line, briefing, model and project
save when you press **Done**; **Cancel** leaves them as they were. **Delete agent** is the red row
at the bottom.

The phone's agent sheet uses the same groups and words.

## Memory

Each agent keeps its own memory: things it learns about you and the work. Memory is shared across
all of that agent's conversations.

- See and edit it in the agent's editor, under **Memory**. Add, change or delete entries; there's
  an Undo.
- Hover a message and choose **Remember this** to add it as one line, which you can edit before
  it's saved.

## Conversations

Each agent can have several conversations, each its own thread, all sharing one memory. Switch or
start one from the chat header.

On your own messages you can:

- **Edit and resend.**
- **Fork from here**, to try a different direction in a new conversation.
- **Rewind to here.** What comes after folds away; it isn't deleted. Work the agent already did
  outside the chat (files, sends) isn't undone.

They're in the **…** beside your message (or a right-click on it). While the agent is working,
Edit and resend and Rewind to here wait, and the menu says so; Fork from here always works.

An agent works on one thing at a time. Messages sent while it's busy wait their turn.

## Dictation

Click the microphone in the message box (or press ⌘⇧D, or hold ⌥Space) and talk. On a Mac your words
appear as you speak. **Enter** (or Send) stops and sends; **Esc** cancels.

When you stop, your computer writes what you said out again with Whisper, a speech model that runs
on your computer, primed with your agents' and projects' names. Then a quick pass by Claude (Haiku,
with no tools) fixes only misheard names and punctuation, using the conversation you're in. The box
says **Tidying…** for a few seconds, then shows the better words; **Undo** puts back what it first
heard. On the phone your words stay in the box while that happens, with a soft light passing over
them, then only the words that changed swap, lit for a moment. If Claude Code isn't set up, you get
Whisper's words alone.

**Your words.** Settings → Agents → Dictation keeps the names and terms dictation should always get
right. Add one there, or just fix it: when you change the same dictated word twice before sending
("mog about" to "Mogbot"), it's added on its own, with Undo. Whisper and the names pass get your
words and the fixes you've made, on the desk and for the phone's dictation. Remove a word and it isn't
learned again unless you add it back.

The speech model is a one-time 574 MB download, fetched the first time you dictate. On Windows and
Linux dictation waits for it ("Getting dictation ready"); on a Mac you get the live words meanwhile.
Your recording never leaves your computer. Only the written words go to the names pass, on your own
Claude account.

From the phone, the same happens on your computer: the phone sends the recording, and the better
words come back.

If your default microphone is a Bluetooth headset
(AirPods and the like), dictation listens through your computer's built-in microphone instead, so your
headphones keep playing music at full quality rather than switching to call mode.

## Share an agent as a recipe

A recipe is an agent's definition without anything it knows: its role, briefing, routines (as
words), the apps it uses by name, its look, and a suggested independence level.

- Choose **Share as a recipe…** from the agent's menu, or ask the Chief.
- The sheet shows exactly what's in the file, and counts what was removed (emails, phone numbers,
  file paths, anything that looks like a key).
- **Never in a recipe:** memory, conversations, logins, keys, or which accounts it uses.
- **Save file…** or **Copy as text**.

To use a recipe, drop the file on the Agents window, or paste it into the Chief's chat. You review
it on one card before anything is made. Its routines arrive paused, and its suggested independence
is only applied if it's stricter than your team's.
