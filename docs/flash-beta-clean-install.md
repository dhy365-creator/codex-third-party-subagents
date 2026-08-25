# DeepSeek Flash Beta clean-install path

This is an explicit, default-off Beta path for exact DeepSeek V4 Flash on exact
Codex CLI `0.149.0`. It does not enable automatic External routing, V4 Pro,
MiniMax, or Qwen. A real E2E is billable and must have separate authorization.

## Install from a package artifact

Install the `.tgz` in a clean local project and use the generated commands. The
target user home must be absolute; `--home-dir` isolates all managed Codex files
without changing the real macOS account used by Keychain.

```sh
npm install /absolute/path/codex-third-party-subagents-0.4.0-beta.3.tgz

./node_modules/.bin/codex-third-party-subagents-doctor \
  --provider deepseek --model flash --home-dir /absolute/fixture-user

./node_modules/.bin/codex-third-party-subagents-install \
  --provider deepseek --model flash --transport external \
  --external-flash-beta --home-dir /absolute/fixture-user \
  --plan plus --spark-available false --luna-available true --threshold 50 \
  --confirm-main-preserved --consent-data \
  --catalog-source /absolute/path/to/reviewed-catalog.json
```

The first install command is a dry-run. Review it, then repeat it with
`--apply`. The flag installs only the exact Flash configuration. The ordinary
External registry, factory, runtime route, and automatic fallback remain off.
The installer accepts no API-key flag and keeps authentication command-backed
through the current macOS user's `codex-deepseek-api-key` Keychain item.

The `--catalog-source` must be a reviewed, complete Flash catalog. Production
installation and the controlled E2E enforce the exact Codex CLI `0.149.0`
catalog contract before Keychain verification, request-ledger mutation,
execution-permit creation, slot acquisition, or child launch. The intentionally
minimal `tests/fixtures/catalog.json` is unit-test data only; copying or renaming
it does not make it valid production input. A future Codex version requires an
explicit compatibility-contract review.

## Inspect before a live E2E

```sh
./node_modules/.bin/codex-third-party-subagents-doctor \
  --provider deepseek --model flash --home-dir /absolute/fixture-user

./node_modules/.bin/codex-third-party-subagents-verify \
  --provider deepseek --model flash --home-dir /absolute/fixture-user
```

On Codex `0.149.0`, Native remains Host-blocked. Before the first External E2E,
`runtimeVerified=false` is expected. Doctor and Verifier are read-only and do
not make Provider requests.

## One explicitly authorized Flash E2E

Only run this after local tests, artifact inspection, credential readiness, and
an explicit billable authorization have passed. Use one bounded workspace and
never retry automatically after a failure.

```sh
./node_modules/.bin/codex-third-party-subagents-flash-e2e \
  --execute --enable-external-flash --authorize-billable \
  --state-root /absolute/fixture-user/.codex/external-transports/codex-third-party-workers \
  --billing-ledger-root /absolute/fixture-user/.codex/external-transports/codex-third-party-workers \
  --codex /absolute/path/to/codex \
  --catalog /absolute/fixture-user/.codex/model-catalogs/deepseek-v4-flash.json \
  --cwd /absolute/fixture-workspace \
  --approved-root /absolute/fixture-workspace \
  --parent-codex-home /absolute/fixture-user/.codex \
  --authorization-id authorized-flash-beta-e2e
```

The runtime preserves an isolated `CODEX_HOME` for the child while resolving a
validated real macOS `HOME` for Keychain command authentication. It records
only safe credential-preflight metadata and strict local evidence. General
External availability stays off after completion.

## Restart, uninstall, and reinstall

Re-run Doctor and Verifier after restarting the shell or Codex environment; no
additional Provider request is required. Preview uninstall before applying it:

```sh
./node_modules/.bin/codex-third-party-subagents-uninstall \
  --provider deepseek --home-dir /absolute/fixture-user

./node_modules/.bin/codex-third-party-subagents-uninstall \
  --provider deepseek --home-dir /absolute/fixture-user --apply
```

Uninstall removes only hash-matching managed files and the exact managed AGENTS
block. It does not delete the Keychain credential. Reinstall from the same
artifact with the dry-run/apply sequence above; do not repeat the live E2E just
to prove reinstall.
