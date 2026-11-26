# Mogbot 1.1.2

## Fixed

- **Work in your real folder** - Asking an agent to work in your own folder instead of a copy just works, and its open copy no longer gets in the way.
- **Pause keeps what was waiting** - Messages queued for a paused agent, yours and other agents', wait in order and run once on Resume. Nothing runs twice and nothing is lost after a restart.
- **Card keys stay on the card** - A, D, O and L answer the card in front of you and no longer also open the agent with that key.
- **Codex usage stuck at 100%** - A Codex refill that keeps its reset time now shows.
- **The phone stays smooth** - Opening after time away applies everything you missed in one update. A line from one agent no longer redraws every row, and one bad event can't close the app.
- **The phone stays connected** - A long catch-up waits for the phone instead of dropping it.
- **Updates on Windows and Linux** - Every installer kind (.msi, .deb, .rpm) now updates itself, not only the .exe and AppImage.
- **Lighter terminals** - Terminals stop asking for a layout every frame while their pane is hidden.
