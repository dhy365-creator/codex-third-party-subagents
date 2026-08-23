# External Third-Party Codex Child feasibility spike

This directory is an isolated experiment. It does not change production routing,
the native Custom Agent adapter, Installer, Doctor, Verifier, or release state.

## Candidate transport

```text
Sol Main
  -> bounded task envelope over stdin
  -> independent codex exec process
  -> DeepSeek V4 Flash
  -> schema-constrained result
  -> Sol review and acceptance
```

The launcher creates an owner-only tree under
`/private/tmp/codex-third-party-external-child-*`. `CODEX_HOME` and `TMPDIR`
point inside that tree. The OS `HOME` remains available only so the command-backed
lookup can reach the login Keychain; Codex configuration continues to resolve
exclusively through isolated `CODEX_HOME`. The child receives no inherited
API-key, token, password, user plugin, MCP, hook, skill, marketplace,
trust-history, or main-thread configuration. Optional plugin, skill-search,
memory, multi-agent, browser, desktop, image, and hook features are disabled on
the command line.

The minimal `config.toml` is generated from the reviewed DeepSeek Flash provider
pack and a locally installed, pack-validated Flash model catalog. The official
setup script is never executed. Authentication remains command-backed: Codex
invokes macOS Keychain at runtime, while the launcher never reads the credential
value. Prompts travel on stdin, not argv.

## Safety and lifecycle

- `read-only` sandbox for identity and read probes.
- `workspace-write` sandbox for the one coding probe; no extra writable roots.
- One scratch bridge slot with the existing task tuple and redacted archives.
- 180-second default timeout, `SIGTERM`, grace period, then `SIGKILL` if needed.
- Local timeout, cancellation, invalid-result, failed-archive, and cleanup tests.
- Parent `config.toml`, `AGENTS.md`, and `agents/` are hash-snapshotted before and
  after the live run.
- Runtime attribution is read only from isolated Codex `session_meta` and
  `turn_context` records. Model self-report and result-envelope fields are not
  identity evidence.

## Commands

Local harness tests do not call a provider:

```sh
node --test spikes/external-child/test/external-child.test.mjs
```

The live runner is intentionally opt-in and Flash-only:

```sh
node spikes/external-child/run-spike.mjs --live
```

To resume after provider identity is already runtime-attributed, use the bounded
two-probe completion mode. It skips the standalone identity request and disables
automatic HTTP/SSE retries in the isolated provider configuration:

```sh
node spikes/external-child/run-spike.mjs --live --runtime-completion
```

If the existing Keychain item is unavailable, it prints
`CREDENTIAL NOT READY` and performs no live request. The default live runner
permits identity, bounded read, and bounded coding; runtime-completion mode permits
only bounded read and bounded coding. Both also run one local controlled
failure/lifecycle probe. Neither calls DeepSeek V4 Pro, MiniMax, Qwen, or an
OpenAI paid fallback.

## Evidence boundary

Generated raw events, stderr, session metadata, results, task envelopes, and
archives remain in the private scratch tree. Only a sanitized report may be
committed here after credential scanning and Main acceptance.

## Runtime completion — 2026-08-23

The bounded runtime-completion run passed:

- Read-only Child read the disposable fixture, identified the intentional
  empty-array bug, changed no files, and returned a valid structured result.
- Workspace-write Child reproduced the failure, changed only `src/math.js`,
  ran `node --test` with `2/2` passing, and returned a valid structured result.
- Both sessions were runtime-attributed to `deepseek` /
  `deepseek-v4-flash`; no OpenAI fallback appeared.
- Main independently verified the diff, fixture tests, result envelopes,
  lifecycle, credential scan, and parent-config immutability.

One transient provider stream disconnect occurred after a successful file-read
tool call and passed on the single permitted retry. This controlled fixture is
`EXTERNAL CHILD RUNTIME VERIFIED`; it is not public-installer or independent-user
acceptance and does not modify production `runtimeVerified` behavior.

See the [runtime report](report-2026-08-23.md) and
[sanitized evidence](evidence/runtime-completion-2026-08-23.json).
