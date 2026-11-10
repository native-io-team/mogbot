# Menus and keyboard shortcuts

The macOS menu bar (`src-tauri/src/app_menu.rs`), the Dock menu
(`src-tauri/src/dock_menu.rs`), and the keys they own. The Help window
(`HelpModal`, ⌘/) lists the same keys for people; this is the map for code.

## Rules

- **Every item works where you are or is greyed out.** The page reports where
  the focused window is (`set_menu_context`, from `src/lib/nativeMenu.ts`):
  Agents, Projects or a project's workspace, a preview showing, an agent open,
  and the names ⌘1…⌘9 lead to. Nothing sits in a menu doing nothing.
- **A choice goes to the focused window only.** One event, `menu://action`,
  payload the item id, sent with `emit_to`; the page listens per window
  (`onMenuAction`). It used to be broadcast, so ⌘W closed a terminal tab in
  every open project window.
- **On macOS the menu owns its keys.** A page key handler for the same key
  steps aside there (`menuOwnsShortcuts()`: macOS *and* the real app, so the
  UI harness in Chrome keeps the page handlers). One path per key: handling
  the keydown as well made some act twice. Menu keys also work while the
  preview's cross-origin iframe has focus, which page handlers can't see.
- **Every key is in ⌘K too**, with its key shown: on the command that already
  existed, or on a twin in `src/commands/useMenuCommands.tsx` that runs the
  same handler (`runMenuAction`). Off macOS there is no menu bar, so the page
  handlers and the palette are the way in.
- **Names come from `brand.json`** (`brand::NAME`): the app menu, About,
  Quit, the website item. Help's Report a Bug… / Request a Feature… exist
  only when `links.issueRepo` is set, the website item only with
  `links.website`.

## The menu bar

| Menu | Item | Key | Works in |
| --- | --- | --- | --- |
| App | About | | always (name, version, website from `brand.json`) |
| | Settings… | ⌘, | always |
| | Services, Hide, Hide Others, Show All | ⌘H, ⌥⌘H | always (macOS's own) |
| | Quit | ⌘Q | always: the quit guard asks if agents are mid-turn |
| File | New Agent… | ⌘N | always (switches to Agents) |
| | New Conversation | ⇧⌘N | Agents, with an agent open |
| | New Window | ⌥⌘N | always |
| | Open Project… | ⌘O | the app (the palette's Projects tab) |
| | New Terminal Tab | ⌘T | a project |
| | Close Tab | ⌘W | a project (the last tab stays) |
| | Close Window | ⇧⌘W | always: a second window just closes; the main one quits, or hides with "Keep running when closed" on |
| | Capture Preview | ⇧⌘S | a project with its web preview showing |
| | Crop Preview… | ⇧⌘C | the same |
| Edit | Undo … Select All | ⌘Z ⇧⌘Z ⌘X ⌘C ⌘V ⌘A | always (in a project, ⌘Z outside a text field undoes the agent's last snapshot) |
| | Search Conversations… | ⌘F | Agents |
| View | Command Palette… | ⌘K | the app |
| | Workspace Mode ▸ Preview / Focus / Code | ⌃⌘1–3 | a project |
| | Edit Mode | ⌘E | a project |
| | Inspector | ⌘I | a project |
| | Enter Full Screen | ⌃⌘F | always (macOS's own) |
| Go | Switch to Projects / Switch to Agents | ⇧⌘A | the app |
| | Next Agent That Needs You | ⌘J | Agents |
| | Previous Agent / Next Agent | ⌘[ / ⌘] | Agents (also ⌥↑ / ⌥↓) |
| | Workspace ▸ 1–9 | ⌥1–9 | always |
| | Terminal Tab ▸ 1–9 | ⌃1–9 | a project |
| | *the numbered places, by name* | ⌘1–9 | Agents: the agents in list order. Elsewhere: pinned, then open, projects (`projectShortcutOrder`). Only as many as exist, so a free number stays the page's |
| Window | Minimize, Zoom, Bring All to Front, the open windows | ⌘M | macOS's own |
| Help | Keyboard Shortcuts | ⌘/ (and F1) | always |
| | Show Logs | | always |
| | Report a Bug…, Request a Feature… | | when `links.issueRepo` is set |
| | *Name* Website | | when `links.website` is set |

macOS adds the search field to Help and the window list to Window.

## Page-only keys

Not in the menu bar, so they never fire through the preview iframe:

- Agents: an agent's own key (A–Z, 0–9) opens it when no text field has the
  cursor (`useAgentKeyShortcuts`); ⌥Space held in the message box dictates;
  ⌘⇧D dictation toggle; ⌘L quotes a selection.
- Workspace: plain 1–9 toggle the panels in toolbar order; ⌘S saves in Code;
  ⌘C/⌘X/⌘V/⌘D/⌫ act on the selected element in Edit mode.
- The quick-message key is the user's own, global, set in Settings → Agents
  (`agents/quick_entry.rs`).

## The Dock menu

Right-click (or hold) the Dock icon: the agents that need you (up to five,
the rest counted, the same rows as the menu-bar icon, `tray::menu_model`),
then **New Agent…**, **Open** *the Chief*, **Quick Message…**. macOS adds the
windows, Options, Hide and Quit. Tauri has no Dock-menu API, so `dock_menu`
teaches the app delegate `applicationDockMenu:` at launch and builds the menu
fresh each time it opens. A click opens that agent the way a notification
does (`notify::open_agent`, showing a hidden window first).

## Window titles

The title bar is hidden, but the title is what the Window menu, the Dock's
window list and Mission Control show. `useNativeMenu` keeps it on what the
window shows: "Agents", "Projects", or the project's name.
