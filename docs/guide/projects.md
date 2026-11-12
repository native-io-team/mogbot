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

Opening a project opens its workspace:

- **Sessions:** Claude Code, Codex or OpenCode working in the project, in tabs or side by side.
  Sessions stay running when you switch between projects.
- **Live preview:** your site as it runs, with device sizes, zoom and full screen. **Every
  breakpoint** shows every device size at once, each page in full. When the dev server returns an
  error, the preview shows it with **Copy error** and **Send to agent**. Send to agent asks first,
  then puts the error in the composer of the agent chat open in the project (or an agent tab) for
  you to send.
- **Panels:** every panel can be docked anywhere, floated, or moved. The layout is remembered per
  project.
- **Mobile apps:** Expo, React Native and Flutter apps build and show in the iOS Simulator.

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
  overwriting anything.
- Files that look like secrets (like `.env` files) and very large files are never included, and
  the card lists what was left out.
- Up to 4 open copies per project, and a copy needs at least 2 GB free on your computer.
- To have an agent work straight in your folder instead, turn on **Work directly in the project**
  in its editor.
- On the phone you can Keep or Discard. Preview and pull requests are on the computer.
