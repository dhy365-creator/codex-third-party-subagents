# Provider-neutral transport contract

Status: architecture contract. The pure modules described here are not connected
to Installer, Doctor, Verifier, Preflight, routing, or an active runtime path.

## Separation invariant

The orchestration layer treats these identities independently:

```text
Role != Provider != Model != Transport
```

For example:

```text
role: coding_worker
provider: deepseek
model: deepseek-v4-flash
transport: external-codex
```

If a future Host restores verified native cross-provider children, only the
transport changes to `native`. The task request and acceptance contract do not.

## Adapter surface

A transport adapter is a plain object with six functions:

| Method | Responsibility |
| --- | --- |
| `prepare(request, context)` | Validate policy, capability, paths, permissions, isolation, and busy state without starting a paid request. |
| `execute(prepared)` | Start exactly one execution and return an execution handle with PID and immutable task identity. |
| `cancel(execution)` | Request bounded cancellation; it must be idempotent and must not select another provider. |
| `collect(execution)` | Collect the result, runtime evidence, workspace evidence, and lifecycle record. |
| `cleanup(execution)` | Redact/archive the task, release the slot, close resources, and verify no orphan remains. |
| `describe()` | Return static transport capability and compatibility metadata without live provider calls. |

No inheritance hierarchy or provider-specific method names are part of the
contract. `src/transport-contract.mjs` validates this function surface.

## Request

The request is strict data with no unknown fields:

| Field | Contract |
| --- | --- |
| `taskName` | Stable bounded identifier. |
| `cwd` | Absolute, validated task root. The adapter must resolve and re-check it before execution. |
| `message` | Bounded task body delivered over the selected transport's non-argv channel. |
| `providerId` | Requested provider; transport selection cannot change it. |
| `providerRole` | Policy role, independent of transport implementation. |
| `model` | Requested model; transport selection cannot change it. |
| `expectedScope` | Canonical, unique paths relative to `cwd`. |
| `acceptanceCriteria` | Non-empty bounded conditions evaluated by Main. |
| `permissionProfile` | `read-only` or `workspace-write`. |
| `timeoutMs` | Integer from 10 seconds through 5 minutes. |
| `explicitOnly` | Role policy; applies to every transport. |
| `metadata` | Small JSON-only non-credential metadata. |
| `transportPreference` | `auto`, `native`, or `external-codex`. |

The request must never contain an API key, bearer token, password, Keychain
value, or parent Personal Codex configuration.

## Result

Every adapter returns one normalized envelope:

```text
taskName
status
providerId
model
transport
changedFiles
tests
findings
summary
risks
lifecycle
evidenceRefs
```

Requirements:

- no unknown fields;
- maximum serialized size of 64 KiB;
- `status` is `completed`, `failed`, `timed_out`, or `cancelled`;
- `changedFiles` contains unique canonical paths relative to `cwd`;
- tests are structured as `{ name, status, exitCode }`;
- lifecycle outcome matches result status;
- evidence references are non-empty, content-hashed, and do not expose absolute
  or parent paths;
- provider/model fields are claims to cross-check, never identity proof.

Main accepts a result only after comparing:

```text
result + runtime evidence + workspace evidence
```

## Evidence

`src/transport-evidence.mjs` preserves the verifier's existing state meanings:

| State | Meaning |
| --- | --- |
| `configured` | Static transport/provider configuration is valid. |
| `discoverable` | Native discovery state when applicable; `null` is valid for an External adapter. |
| `providerResolved` | Runtime session/turn/endpoint evidence independently attributes provider and model. |
| `taskDelivered` | The bounded task is present in attributable child runtime evidence. |
| `runtimeExecuted` | A model turn or Codex tool execution occurred. |
| `runtimeVerified` | Provider, delivery, execution, result, workspace, lifecycle, credential, and parent-isolation gates all pass. |
| `configurationReady` | The local configuration and relevant compatibility contract pass. |
| `ready` | Configuration is ready and the required local credential check passes. |

Evidence also records:

```text
evidenceSource = maintainer-controlled | local-installation
credentialReady
hostVersion
codexBinary
provider
model
transport
verifiedAt
providerAttribution
acceptance
evidenceRefs
```

`maintainer-controlled` evidence cannot be presented as local-installation or
independent-user acceptance. `providerResolved=true` requires separate runtime
attribution whose single provider/model tuple matches the request. Result JSON
self-report cannot satisfy that gate.

## Lifecycle

The state machine is explicit:

```text
prepared -> running -> completed | failed | timed_out | cancelled
terminal state -> cleanup_pending -> closed
```

Preparation may also fail or be cancelled before start. A collected lifecycle
must be `closed` and include:

- PID;
- start/end timestamps and duration;
- exit code/signal;
- timeout, cancellation, and forced-kill flags;
- orphan result;
- active-slot release result.

`completed` requires exit `0`, no timeout/cancellation/orphan, and a released
slot. Invalid or skipped transitions fail closed.

## Selection contract

`src/transport-selection.mjs` returns one of:

```text
ALLOW
BLOCK
REQUIRE_EXPLICIT
BUSY
```

It records requested transport, selected transport, provider, role, model,
permission profile, reason, and compatibility level.

Rules:

1. Evaluate provider policy before transport availability.
2. Enforce role-level `explicitOnly` independently of transport.
3. An explicitly requested transport either passes its own gates or blocks; it
   never falls through to another transport.
4. `auto` prefers an eligible runtime-verified Native adapter, then an eligible
   runtime-verified External adapter.
5. No eligible runtime-verified transport means `BLOCK`.
6. An occupied External single slot means `BUSY` with `EXTERNAL CHILD BUSY`.
7. Selection never changes provider or model and never falls back to OpenAI.

Provider routing policy and transport selection are separate decisions. An
available External transport does not authorize automatic third-party model use.

## Cost and concurrency

- Production External concurrency starts at `1`.
- Retry and timeout limits are adapter configuration, not provider defaults.
- Doctor and ordinary Verifier checks must be non-billable.
- Any runtime verification entry point must say `BILLABLE PROVIDER REQUEST`
  before execution and require the appropriate explicit policy.
- Pro roles are never automatically selected.

## Pure contract modules

- `src/transport-contract.mjs`: adapter, request, result, permission, lifecycle,
  and evidence-reference validation.
- `src/transport-evidence.mjs`: evidence-state and anti-spoof invariants.
- `src/transport-selection.mjs`: provider-policy-aware, fail-closed selection.

These modules have no filesystem, Keychain, process, network, Installer,
Verifier, Doctor, Preflight, bridge, or routing side effects.

See also [External Codex transport](external-transport.md),
[transport security](transport-security.md), the
[Host compatibility contract](host-compatibility.md), and
[ADR 001](adr/001-external-codex-transport.md).
