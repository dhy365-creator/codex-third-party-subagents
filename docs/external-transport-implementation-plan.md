# External transport phased implementation plan

Status: approved architecture plan. Phase 1 is implemented at a local disabled
checkpoint; it is not activated or integrated. Every later phase requires a
separate branch, checkpoint, tests, and acceptance decision.

## Global gates

Every phase must preserve:

- Main model/provider/auth unchanged;
- provider/model/transport identity separation;
- no silent Provider, Model, Transport, or OpenAI fallback;
- DeepSeek V4 Pro explicit-only;
- Keychain-only credentials;
- dry-run default and explicit writes;
- max External concurrency `1` until a later architecture review;
- bounded retry/timeout and explicit billable runtime requests;
- exact evidence scope with no promotion from config to runtime;
- original bridge archives and unrelated user changes.

## Phase 1 — External adapter productionization

### Scope

- Implement the provider-neutral adapter surface from
  [transport-contract.md](transport-contract.md).
- Extract reviewed generic behavior from Spike config, envelope, evidence,
  filesystem safety, launcher, result, supervisor, and snapshot modules.
- Add production error codes, lifecycle state transitions, evidence references,
  and a disabled adapter registry.
- Keep the adapter unreachable from active routing, Installer apply, Doctor,
  Verifier, and Preflight.

### Acceptance

- fake process/provider tests for prepare/execute/cancel/collect/cleanup;
- isolated home and minimal environment tests;
- credential, cwd, symlink, external-write, spoof, timeout, cancellation,
  forced-kill, orphan, result-size, and single-slot tests;
- no provider network request;
- full repository suite and security/path scans pass.

### Local outcome

Completed on 2026-08-24 with 37 local fake-child tests. The full repository
suite is `158/158` PASS, third-party live requests are `0`, production source
has no Spike dependency, and active routing/control-plane behavior is
unchanged. Runtime evidence produced by fixtures remains
`runtimeVerified: false`.

### Checkpoint

`external-transport-phase-1-adapter` — local code and tests, feature disabled.

### Rollback

Remove the unused adapter registry and extracted modules; current Native path is
untouched.

## Phase 2 — Doctor, Verifier, Preflight, and Installer contracts

### Scope

- Doctor reports Native/External prerequisites, maintainer evidence, and local
  installation state separately; remains read-only/non-billable.
- Verifier ingests local External evidence through the strict evidence schema;
  it never infers identity from result fields or Native discovery.
- Preflight computes provider policy plus transport eligibility and returns
  `ALLOW`, `BLOCK`, `REQUIRE_EXPLICIT`, or `BUSY` without executing.
- Installer dry-run describes `auto|native|external`; apply remains behind a
  disabled feature gate pending Phase 3.

### Acceptance

- current `0.149.x` Native remains blocked;
- maintainer evidence never becomes local `runtimeVerified`;
- no Doctor/ordinary Verifier provider request;
- no active bridge or child creation;
- Pro explicit-only tests cover both transports;
- dry-run and uninstall safety remain unchanged.

### Checkpoint

`external-transport-phase-2-integration-contracts` — control-plane reporting and
selection only, execution disabled.

### Rollback

Remove new reporting/selection fields while retaining Phase 1 disabled modules
and all existing Native behavior.

## Phase 3 — DeepSeek V4 Flash production E2E

### Scope

- Add an explicit, feature-gated External Flash apply/verification path.
- Run clean-install dry-run/apply and one bounded read/coding E2E.
- Label live verification `BILLABLE PROVIDER REQUEST` and require explicit
  authorization.

### Acceptance

- exact provider/model runtime attribution;
- task delivery, read/write/shell/test, strict result, workspace scope,
  lifecycle, archive, credential, parent-isolation, and Main acceptance pass;
- no Native or OpenAI fallback;
- clean public package artifact and migration rollback tests pass;
- local installation evidence remains distinct from maintainer evidence.

### Checkpoint

`external-transport-phase-3-flash-runtime` — Flash-only, exact verified Host/
binary range, still prerelease gated.

### Rollback

Disable the External feature gate, safely uninstall only managed hashes, retain
archives/evidence, and leave Native/config analysis available.

## Phase 4 — DeepSeek V4 Pro External E2E

### Scope

- Evaluate Pro against the same External adapter without creating a separate
  transport.
- Require explicit provider/model request for install and every execution.

### Acceptance

- dedicated Pro provider/model attribution and bounded tool/result evidence;
- no automatic selection from Flash, `auto`, quota policy, or transport
  fallback;
- provider dashboard attribution/reliability boundaries documented.

### Checkpoint

`external-transport-phase-4-pro-explicit-runtime`.

### Rollback

Remove/disable only the Pro capability record and managed Pro profile; Flash and
the adapter remain unchanged.

## Phase 5 — MiniMax and Qwen

### Scope

- Evaluate MiniMax M3, then Qwen3.7-Max independently.
- Reuse the same adapter; add no eligibility until each exact tuple passes.

### Acceptance

- separate provider/model/transport runtime evidence;
- capability matrix updated only for verified fields;
- Provider-specific streaming/tool limitations represented without changing
  common result/lifecycle semantics;
- credentials and billing policies remain provider-specific and Keychain-only.

### Checkpoints

- `external-transport-phase-5-minimax-runtime`
- `external-transport-phase-5-qwen-runtime`

### Rollback

Disable only the affected capability/pack integration. Never fallback to
another provider because one provider fails.

## Phase 6 — Clean install, packaging, migration, and release gate

### Scope

- Validate a clean macOS installation from the real package artifact.
- Exercise dry-run, explicit apply, restart/new session, External task,
  verification, uninstall, restoration, and archive preservation.
- Define migration from existing Native-only installs without modifying parent
  `config.toml` or deleting historical evidence.

### Acceptance

- CI and clean-machine QA pass;
- public docs/UI match the exact enabled provider/transport matrix;
- independent-user acceptance is recorded separately;
- security diff scan, internal links, secret/path scan, and release manifest
  pass;
- explicit maintainer release decision.

### Checkpoint

`external-transport-phase-6-release-candidate`.

### Rollback

Release remains blocked. A failed migration/uninstall stops atomically and
preserves user files, backups, parent configuration, archives, and the previous
runtime state.

## Non-blocking implementation decisions

These are resolved during their owning phase without weakening architecture
invariants:

1. Raw private evidence retention duration and user cleanup command (Phase 2 or
   Phase 6 before activation). Phase 1 preserves owner-only execution evidence
   and immutable portable archives; it exposes no cleanup CLI.
2. Exact project/user policy surface for authorizing billable External execution
   (Phase 2).
3. Version-range promotion beyond exact Codex CLI `0.149.0` (Phase 3, only after
   attributable regression evidence).

If a phase cannot satisfy the [security model](transport-security.md), strict
[evidence contract](transport-contract.md), or Provider matrix, it remains
disabled and returns a fail-closed decision.
