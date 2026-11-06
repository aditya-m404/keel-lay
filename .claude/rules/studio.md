---
paths:
  - "apps/studio/**"
  - "packages/journeys/**"
---

# Studio

`POST /runs` takes `target`, `mode` (`computer` or `person`), `journey`, `pace`, `seed`, and `confirm`. `confirm` is `""` except for target `production`, which requires `confirm` to be `production`. Person mode forces one actor. Production forces one actor and at most 10 minutes.

The default mode is `computer`. Person mode is one Playwright context. It clicks the journey's `ui` steps and posts the browser span to `POST /otel`. Same-origin path changes use `history.pushState`.

Journeys live in `packages/journeys/<id>.yaml`. Each `ui` entry is a one-key action: `goto`, `see`, `fill`, or `click`. A new product action needs a catalog metric, an API emit, a button whose accessible name matches the journey, and a journey file. `pnpm journeys:check` calls the API steps when the API is up.

Targets are `apps/studio/targets.json`. Local-prod points at `127.0.0.1:4200` and `127.0.0.1:4201`. The host Studio on 4102 reads that file from the repo.
