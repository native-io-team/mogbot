# Privacy and permissions (Web Store answers, draft)

## Permission justifications

| Permission | Why |
|---|---|
| `nativeMessaging` | The only channel to the Mogbot app on this Mac. The native host Chrome starts is the app's own binary; it accepts only this extension's id and proves itself to the app with a per-launch secret. |
| `debugger` | Reading a page the way assistive tech does (the accessibility tree), clicking and typing with real input events, and taking a picture of the page, in tabs the agent opened. The extension relays a fixed list of 13 DevTools commands and evaluates only the app's own fixed expressions (page text, load state, "is this a password field", a scroll step); anything else is refused in the extension. Never attached to a tab an agent didn't open. |
| `tabs` | Open, list, focus and close the agents' own tabs, and read their address and title. |
| `tabGroups` | Put each agent's tabs in a group with its name, so the user sees whose they are. |
| `storage` | Remember which tabs belong to which agent (session storage, gone when Chrome quits), a random id for this Chrome profile and the name the user gave it (local storage). |
| `alarms` | Reconnect to the app once a minute when it isn't running, without keeping the service worker awake. |

No host permissions, no content scripts, no `scripting`, `cookies`,
`webRequest`, `history`, `downloads` or `management`.

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
