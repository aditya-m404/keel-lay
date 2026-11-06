# fireweave-tests

Inputs for the `fw tool` calls that author a test control point, one manifest per key (`docs/fireweave-testbed.md`). `fw` runs on the laptop, signed in to staging, from the repository root. The sequence for a key, with `lay-manual-1` as the example:

1. Classify: every test control point is a `change` (it adds a read of a new key).
2. `fw tool new-change-ids --input-file fireweave-tests/inputs/new-change-ids.json` prints a `chg_` id and one `stmp_` id. Put them into `manifests/<key>.json` (`CHG_ID`, `STAMP_ID`) and append the stamp to `FW_STAMPS` in `.fireweave/stamps.ts`.
3. `fw tool get-project-capabilities --input-file fireweave-tests/inputs/get-project-capabilities.json`: `bindings.observability.state` goes into the manifest's `metricsCheck.state`.
4. `fw tool upsert-rollout-manifest --input-file fireweave-tests/manifests/<key>.json` with `baseContentHash: null` for a new row. On `conflict`, copy `currentContentHash` into `baseContentHash` and run it again.
5. `fw tool assert-dev-checklist --input-file fireweave-tests/inputs/assert-dev-checklist-<key>.json` must pass before the pull request.
6. Open the pull request into `main`; merging it registers the rollout for `production`.

The manifest lives on the server. These files are the inputs that produced it, kept so a scenario can be repeated with the next key.
