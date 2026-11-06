---
name: keel-journey
description: Write one Keel journey file with a ui block and an api block, then run journeys:check. Use when adding a feature rehearsal under packages/journeys.
---

# Keel journey

Write one journey file. Do not start a run, do not open a browser, and do not hold a vendor key.

1. Read `CATALOG.md` and the YAML files in `packages/journeys`. If the feature already has an id, stop and say which file has it.
2. Read the web app for the route and the visible labels. Name only a button, heading, or field label that is on the screen.
3. Write `packages/journeys/<id>.yaml`. The id matches the file name. Every step has a `ui` block, an `api` block with `method`, `path`, and `expect`, and a `thinkMs` range a person would pause for. Copy labels from the screen. The actor is one of Ada, Grace, or Linus, and the actor can do the action.
4. Run `pnpm journeys:check`. The schema must accept the file. When the local API is up, the api steps run once and the status must match `expect`.
5. Stop. A person presses Start in Studio.
