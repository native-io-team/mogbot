---
title: Projects and the visual editor
order: 6
---

When work becomes a website or an app, it lives in a **project**. Agents can create projects, run
them and work in them for you, and you can open one any time to look closely or edit it yourself.

Switch between your agents and your projects with the **Agents | Projects** toggle at the top of
the sidebar (⌘⇧A).

## Starting a project

From Projects you can:

- start from a template (web and mobile starters),
- import a repository from GitHub,
- add a folder that's already on your computer.

Projects need Node and Git. If either is missing, the app lists what's needed and has your engine
install it while a checklist ticks off each one. GitHub sign-in is optional.

Projects are shared with Ship Studio: each app opens the other's projects.

## The workspace

Opening a project opens its workspace, on an agent's chat: the agent you last worked with there,
or one that already works on it. When none does, it asks **Who should work on <project>?** Pick an
agent and chat with it right there. An agent can work on several projects: it keeps one
conversation (and its own copy) per project, and its memory is shared across them. **New agent for
this project** makes one. Rather type commands yourself? **Use a terminal** asks which: Claude Code,
Codex, OpenCode or a plain terminal, with **Open <project> this way next time**. Clicking an
agent or a terminal in the sidebar switches between them.

- **Sessions:** Claude Code, Codex or OpenCode working in the project, in tabs or side by side.
  Sessions stay running when you switch between projects. A new session opens on the engine and model your
  agents run on (Settings → Agents); changing them there changes them here too.
- **Find in a terminal:** ⌘F (or ⌘K → "Find in terminal") opens a small find bar at the top right
  of the terminal. Type to find as you go: every match is marked, with how many there are ("3 of
  12"). Enter and ⇧Enter (or the arrows) go to the next and previous, and Esc closes it and puts
  you back in the terminal. It searches everything the terminal still keeps, not just what's on
  screen.
- **Live preview:** your site as it runs, with device sizes, zoom and full screen. **Every
  breakpoint** shows every device size at once, each page in full. When the dev server returns an
  error, the preview shows it with **Copy error** and **Send to agent**. Send to agent asks first,
  then puts the error in the composer of the agent chat open in the project (or an agent tab) for
  you to send.
- **Panels:** every panel can be docked anywhere, floated, or moved. The layout is remembered per
  project.
- **Mobile apps:** Expo, React Native and Flutter apps build and show in the iOS Simulator.

## Terminal only

The terminal button at the right end of a project's title bar (or ⌘K → "Terminal only") shows the
project's terminals and nothing else: no preview, no Code or Branches view, no panel buttons and
no screenshot buttons. Branches and Push stay. The preview is closed, not just hidden, so the app
uses less memory. That helps most when you have several projects open, or when Agents and Projects
are side by side.

- Each project remembers it: turn it on for a backend or an agent-only project and leave your
  site's preview on.
- Your dev server keeps running, as it does when you hide the preview. If **Keep dev servers
  running** is off in Settings, it stops.
- Agents can't screenshot or click through the preview while it's closed. They're told the
  preview isn't open and can ask you to turn it back on.
- Click the button again (or open Branches from the Branches menu) and the preview comes back as
  you left it.

## Agents and a project side by side

⌘K → "Show Agents and Projects side by side" puts your agents and their chats on the left and the open project on the right, in one window.
The project half shows its terminals only: no preview or code, which come back when you click the
split button that appears at the top of the Agents sidebar, beside the sidebar toggle and the
bell, while it's on (or run the command again). Drag the line between the halves to resize them (double-click puts it back to half
and half). The window remembers both.

## Visual editing

Turn on edit mode in the preview and click any element on the page. Change its text and styles in
the editor panel, or find it in the element tree. Your changes are written back into the project's
code.

## Pushing and hosting

- **Push** commits any pending changes and pushes the current branch to GitHub. Whatever your host
  does next (deploying, for example) is up to the host.
- **Submit for review** opens a pull request, with a title and description written for you.
- **Hosting status** in the Push menu tells you whether the commit you just pushed actually
  deployed, on Vercel, Cloudflare Pages or Netlify. It shows the host's own status word ("Ready",
  "Uploading", "Pending review"…), and if the build failed, the line from the build log that says why.

When an agent wants to push, it asks you first on a card (at Unleashed, pushing to a protected or
production branch still asks).

## A copy per task

An agent that works in a project never edits your folder directly. Each task gets its own copy of
the project, on its own branch, so two agents, or an agent and you, can't get in each other's way.

When the agent has changed something, a card in the chat shows what changed:

- **Keep changes** brings the agent's work into the branch the copy was made from.
- **Review** shows the changes file by file.
- **Preview** opens the copy's preview beside the chat.
- **Discard** removes the copy and its changes (it asks first).
- **Open a pull request** is in the card's menu.

Good to know:

- Follow-up messages keep working in the same copy until you keep or discard it. A question that
  changes nothing leaves no copy behind.
- If your project has moved to a different branch, Keep tells you and offers to keep into the
  current one instead. If the changes overlap with yours, it stops and says so rather than
  overwriting anything. Files your folder already has exactly as the agent made them (the same
  file copied in, the same edit) don't stop it.
- Files that look like secrets (like `.env` files) and very large files are never included, and
  the card lists what was left out.
- The copy runs the same dev server you already allowed for the project, so picking an agent in a
  project never asks you to start it again. If the copy changes what its dev server would run, it
  asks, like any change.
- Picking an agent in a project, or coming back to the project from Agents, starts its dev server
  if it isn't running, so the preview beside the chat is live.
- Any number of agents can each have their own copy of a project. A copy needs at least 2 GB free on your computer.
- To have an agent work straight in your folder instead, tell it in its chat ("work in the real
  folder"), or turn on **Work directly in the project** in its editor. Asked in your own message,
  it switches with no card. If it has a copy open, what it did there goes into your folder, as
  Keep would bring it, and the copy goes. If that can't be done (the changes overlap with yours,
  or your folder moved to another branch), the chat says why and the copy's card still has Keep
  and Discard.
- On the phone you can Keep or Discard. Preview and pull requests are on the computer.
- When a task in a project asks something (a menu like Claude Code's folder trust or Bypass
  Permissions warning), the phone offers every answer, not only the one already highlighted.
