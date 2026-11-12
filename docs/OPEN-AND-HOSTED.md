# Open source and hosted services

The one source of truth for what is free and open and what Native hosts. README, MISSION, the site and the terms quote this.

## The rule

Mogbot is open source (MIT). Everything that runs on your own computers is in it, free, forever, with no account.

Native also runs a few services for people who don't want to run their own. We only host something when it needs a server that someone has to pay for. We never take a feature out of the app, or hold one back, to sell it. Every hosted service has a route that doesn't need us: your own network, or your own copy of the service from this repo.

An account exists only to say who may use our servers. It never unlocks anything in the app itself.

## What's in the app (free, no account)

- The desktop app, all agents, engines (Claude Code, Codex, OpenCode with any provider or local models), projects, workspace, visual editor, routines, permissions.
- The phone app, paired to your computer over your own Tailscale.
- Push notifications (our push relay holds the Apple/Google keys; no account; no content passes through it).
- Error reports, on by default, with an off switch.

## What Native hosts

| Service | What it does | Needs | Costs you | Do it without us |
|---|---|---|---|---|
| Push relay | Sends the "needs you" alert to your phone | Nothing | Free | Your own build with your own Apple/Google keys |
| Phone relay | Phone reaches your computer from anywhere, no VPN | Free Mogbot account (Google or email) | Free | Tailscale, or run `services/relay` yourself |
| Error reports | Files crashes as issues | Nothing (switch to turn off) | Free | Turn it off |
| Cloud computer (later) | The same app on a computer we run for you | Account + subscription | Around $40/month | Your own computer |

## Every way to run it

| You are | Phone reaches your computer | Push | Account |
|---|---|---|---|
| Official app, not signed in | Your Tailscale | Yes | None |
| Official app, signed in | Our relay, or Tailscale | Yes | Mogbot (free) |
| Built from source / a fork | Tailscale, or your own relay | Only with your own keys | None |
| Running your own relay | Your relay | Your keys | None of ours |
| Cloud computer (later) | Our relay | Yes | Mogbot + subscription |

## What we keep, per service

Phone relay: which computer key, when, IP address, bytes. Never content (end to end encrypted with your computer's key). Account: email and an id (Clerk), linked to that computer key. Push relay: push tokens and send times, no content, no IP. Error reports: see privacy page.

Signing out unlinks your computer at the relay. Deleting your account removes the email, id and link.

## Rules for building it

- A new hosted service needs: a reason it can't run on the user's machines, an open route around it, a line in this file, the privacy page and the terms.
- No feature check against the account anywhere in the app. The account is checked only by our servers.
- Copy says "Mogbot is free and open source. Some extras are hosted by Native." Never "free tier", "Pro", "upgrade" or "premium" for anything in the app.
