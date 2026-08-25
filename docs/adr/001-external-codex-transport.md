# ADR 001: Provider-neutral External Codex transport

- Status: Accepted for phased implementation
- Date: 2026-08-23
- Scope: architecture only; no active production routing

## Context

The project requires a bounded topology in which Codex Main can hand an
authorized task to a third-party provider/model child and independently review
the result.

The [Host compatibility contract](../host-compatibility.md) establishes that
Codex `0.149.x` Native role overrides inherit provider configuration from the
parent. Native cross-provider child execution therefore fails closed on that
line even when Custom Agent discovery and `multi_agent=true` are available.

The controlled
[External Child Spike](../../spikes/external-child/report-2026-08-23.md) used an
independent Codex CLI `0.149.0` process and verified DeepSeek V4 Flash provider/
model attribution, read, bounded write, shell tests, structured result, Main
acceptance, lifecycle, Keychain safety, and parent isolation. It remains
maintainer evidence, not public-installer or independent-user acceptance.

## Decision

Introduce a provider-neutral Transport layer between the third-party handoff
orchestrator and execution adapters.

```text
Role != Provider != Model != Transport
```

The first architecture supports two adapters:

- **Native:** retained and eligible only when the exact Host compatibility
  contract and provider/model capability are runtime verified.
- **External Codex:** independent `codex exec` with isolated state, safe
  command-backed auth, bounded task/permission/lifecycle, structured result,
  and independent evidence.

Transport selection is fail-closed. Explicit transport requests never fall
through. `auto` prefers eligible Native, then eligible External; otherwise it
blocks. Provider policy is evaluated first and cannot be inferred from
transport availability.

External production concurrency starts at one. DeepSeek V4 Pro remains
explicit-only at the role-policy layer for every transport.

## Alternatives

### Wait for future Native support only

Safe but leaves no maintainable path for the already-verified External
mechanism. Rejected as the sole architecture; Native remains preferred when
verified.

### Pin or recommend Codex `0.147.0`

Would turn historical evidence into a downgrade policy and create security,
maintenance, and user-expectation risk. Rejected.

### Copy the Spike directly into production

Fixture/probe concerns, experimental names, and acceptance shortcuts would
become runtime dependencies. Rejected; generic behavior must be extracted and
reviewed behind formal contracts.

### Build a provider-specific DeepSeek sidecar

Would couple role, provider, model, and transport and make MiniMax/Qwen or future
Native support require parallel architectures. Rejected.

### Silently use OpenAI when third-party transport fails

Changes provider/model semantics and can hide policy or evidence failure.
Rejected. The selection result is `BLOCK`, `REQUIRE_EXPLICIT`, or `BUSY`.

## Consequences

### Positive

- Native support can return without changing the task/result protocol.
- External isolation and evidence become explicit testable requirements.
- Provider capability/evidence is tracked per model and transport.
- Doctor, Installer, Verifier, and Preflight can share one vocabulary.
- Failure, cost, and fallback behavior become explainable.

### Costs

- External execution adds process startup, evidence, cleanup, and maintenance
  complexity.
- Local and maintainer evidence must remain separately stored and presented.
- Current single-slot concurrency limits throughput.
- Each provider/model/transport combination needs separate verification.

## Security

- Keychain-only, command-backed authentication; Parent never reads the value.
- Isolated `CODEX_HOME`, minimal environment, and no copied personal extensions.
- Strict request/result/evidence contracts and workspace cross-checks.
- Provider identity comes from runtime metadata and endpoint evidence, not
  result self-report.
- Owner-only state, atomic single-slot archives, bounded retry/timeout,
  cancellation, orphan verification, and parent hash snapshots.
- See the full [External transport security model](../transport-security.md).

## Compatibility

- Native eligibility continues to use the exact Host compatibility contract.
- Codex `0.149.x` Native remains blocked.
- External Flash evidence is exact to Codex CLI `0.149.0` and does not establish
  a version range.
- Pro External, MiniMax External, and Qwen External remain unknown.
- No Host downgrade/pin or automatic provider fallback is introduced.

## Evidence

- Host checkpoint: `cb23f05023b9af19bea7630e043cc6fb0640c686`.
- External runtime checkpoint: `956b193a570c9c42d46cbaca0cca2490b1eb69d8`.
- Sanitized Flash evidence:
  [runtime-completion-2026-08-23.json](../../spikes/external-child/evidence/runtime-completion-2026-08-23.json).
- Evidence scope: controlled maintainer fixture only.

## Rollback

Before activation, rollback is deletion of the unused pure contracts and docs.
After phased implementation begins, every phase must remain separately
revertible and feature-gated. Disabling External must leave Native eligibility,
current Host fail-closed behavior, Installer dry-run, and historical evidence
intact. Rollback must never delete task archives or Personal Codex data.
