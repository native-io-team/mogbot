# Privacy and permissions (Web Store answers, draft)

## Permission justifications

| Permission | Why |
|---|---|
| `nativeMessaging` | The only channel to the Mogbot app on this Mac. The native host Chrome starts is the app's own binary; it accepts only this extension's id and proves itself to the app with a per-launch secret. |
| `debugger` | Reading a page the way assistive tech does (the accessibility tree), clicking and typing with real input events, and taking a picture of the page, in tabs the agent opened. The extension relays a fixed list of 15 DevTools commands and evaluates only the app's own fixed expressions (page text, load state, "is this a password field", a scroll step); anything else is refused in the extension. Never attached to a tab an agent didn't open. |
| `tabs` | Open, list, focus and close the agents' own tabs, and read their address and title. |
| `tabGroups` | Put each agent's tabs in a group with its name, so the user sees whose they are. |
| `storage` | Remember which tabs belong to which agent (session storage, gone when Chrome quits), a random id for this Chrome profile and the name the user gave it (local storage). |
| `scripting` and host access to web pages | Only for a tab an agent opened that Chrome won't let the debugger into, because another extension has put its own frame in the page. Then the extension reads that tab without the debugger: the page's text, an outline of its headings, links and controls, and scrolling, through fixed functions that ship in the package. No content scripts; nothing runs in a tab an agent didn't open. |
| `management` | Only to name the other extension that keeps the debugger out of a tab (its name, from its id), so the user knows which one to adjust. Nothing is changed, enabled or disabled. |
| `alarms` | Reconnect to the app once a minute when it isn't running, without keeping the service worker awake. |

No content scripts, no `cookies`, `webRequest`, `history` or `downloads`.

## Data use disclosures

- **Collected and sent off the device**: nothing. There is no server.
- **Passed to the Mogbot app on the same Mac**: the text, accessibility tree
  and screenshots of tabs agents opened, when an agent asks for them, so the
  user's agent can do the task the user gave it. Website content, as Chrome's
  form calls it; used only for the app's single purpose.
- **Not sold, not used for advertising or credit, not transferred** to anyone.
- What the user's agents (Claude Code or Codex, on the user's own accounts)
  do with page content is under the user's own agreements with those
  providers; the app tells them which tab and site it came from.

## Remote code

None. Everything the extension runs ships in the package.
