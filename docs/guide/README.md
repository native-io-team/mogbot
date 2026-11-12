# docs/guide

The user guide. The marketing site (mogbot.app) renders these pages as its help section, so they
are written for the people who use the app, not for people who work on it.

## Rules

- **Facts from the code only.** If it isn't built, it isn't in the guide. When something changes,
  the matching page changes in the same commit.
- **Plain and short.** Second person, one idea per paragraph, no marketing words.
- **The app's own words.** Use the labels people see on screen ("Allow", "Keep changes",
  "Independence", "refill"). Never internal names: no tool names, file names, settings keys or
  code identifiers.
- Limits come back on their own: say **refill**, never "reset".

## Frontmatter

Every page starts with YAML frontmatter:

```yaml
---
title: Install
order: 1
---
```

- `title`: the page's name as the site shows it in the navigation and as the page heading.
- `order`: a unique integer; the site lists pages from lowest to highest.

The page body is plain Markdown with no top-level `#` heading (the site prints `title`). Start
sections at `##`.

This README has no frontmatter, so the site skips it.
