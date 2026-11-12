---
title: Your phone
order: 7
---

The phone app is a full way in to your agents when you're away from your desk: chats, approvals,
result cards, routines, starting new agents, voice messages and more. Your agents still run on your
computer (your Mac or PC), so it needs to be awake with the app open.

## Get the app

The iPhone app is in a free public beta on **TestFlight**. Install TestFlight, then open the invite
link from [mogbot.app/start](https://mogbot.app/start) or from the desktop app (it shows a code you can
scan with your iPhone's camera).

It isn't on the App Store yet, and there's no Android app to download yet.

## How your phone reaches your computer

There are two ways. You can use either, or both.

- **Our phone relay (when your computer is signed in).** Sign in to a free Mogbot account on the computer
  (see [Accounts and usage](accounts-and-usage.md)) and your phone reaches your computer from anywhere,
  with nothing else to set up. Everything between them is end to end encrypted with your computer's
  key; the relay can't read it or pretend to be your computer.
- **Your own Tailscale.** Free, and no Mogbot account needed. Install Tailscale on the computer and on
  the phone, and **sign in to both with the same Tailscale account** before you pair. That's the one
  thing that makes pairing fail without a clear reason.

If both are set up, the phone tries the relay first and falls back to Tailscale.

## Pair your phone

1. **On your computer:** click **Pair your phone** at the bottom of the sidebar (or open
   **Settings → Phone**). The app walks you through each step, including turning on phone access
   and, if you're not signed in, Tailscale on both devices. Then it shows a code.
2. **On your phone:** open the app and tap **Scan the code**. It asks "Pair with *your computer's name*?"
   first; tap **Pair**.
3. **On your computer:** click **Allow**. Both sides say **Paired**.

Your phone checks that it's really talking to your computer before it sends anything. If you scan a code
from a different computer than the one you paired with, it says it isn't
yours and stops.

If the phone can't reach your computer, it shows a short checklist of what to look at: the computer awake
with the app open, Tailscale on with the same account (when you use Tailscale), and the phone
paired.

## What the phone can't do

Pushing to git, deleting agents, and a few room settings are done on the computer.

## Notifications

On a Mac, you get macOS notifications and a Dock badge when an agent needs you, finishes, or a
routine posts. Change them in **Settings → Notifications**.

While the phone app is connected to your computer, it gets the same alerts: approvals and anything that
needs you right away, plus replies. The badge on the app icon matches the Mac's Dock badge, and an
alert goes away once you've handled it on either device.

Approvals always come through, even during quiet hours. Other alerts are held during quiet hours
and summed up in one when they end.
