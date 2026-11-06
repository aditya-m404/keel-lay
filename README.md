# keel-lay

A fork of [fireweave-HQ-Demo/keel](https://github.com/fireweave-HQ-Demo/keel) used to test FireWeave's ramping flow (automated rollouts on metrics, metrics from several accounts, breach, manual ramping, schedule edits) against a product that behaves like a customer's.

Keel itself is documented in `plan.html` (the decisions), `explanation.html` (how it works) and `implementation.html` (the contract, twelve phases with a script each). `CLAUDE.md` holds the rules. The test design lives in `docs/fireweave-testbed.md`.

## Remotes

| Remote | Repository | Push |
| --- | --- | --- |
| `origin` | `aditya-m404/keel-lay` | yes |
| `upstream` | `fireweave-HQ-Demo/keel` | disabled (`no_push`) |

Take a newer base when you want it: `git fetch upstream && git merge upstream/main`. Nothing done here reaches the base.

## What differs from the base

- Compose projects are `keel-lay` (local) and `keel-lay-local-prod`, so containers and the Postgres volume never collide with a base checkout on the same laptop. Ports are unchanged: do not run the base and keel-lay local stacks at the same time.
- `KEEL_INSTANCE` (default `lay` in `.env.example`) is stamped on every API signal as `keel.instance`.
- `deploy.yml` is guarded to the upstream repository. There is no server, registry or production environment for keel-lay; `local` is the environment under test.
- FireWeave is added on top: the harness, control points and manifests the tests need. The base keeps none of this.

## Day one

Same as the base: Node 22, pnpm 11.9.0, Docker; `pnpm install`, `./scripts/init`, `./scripts/up`; web on `http://127.0.0.1:4100`, Studio on `http://127.0.0.1:4102`; `./scripts/down` at the end. `pnpm check` is the local gate and `pnpm phase` runs the phase scripts.
