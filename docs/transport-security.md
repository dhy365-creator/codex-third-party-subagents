# External transport security model

Status: scoped threat model plus Phase 3 controlled Flash enforcement. External
execution remains default-off and unreachable from public/automatic runtime
paths; one exact maintainer-gated Flash production path has strict local evidence.

## Overview

Codex Third-Party Subagents is a macOS-only local tool for bounded text/code
handoffs to reviewed third-party provider packs. The proposed External transport
starts an independent `codex exec` process because current Codex `0.149.x`
Native children cannot override the parent provider configuration.

Security objectives:

- keep provider credentials in the macOS Keychain;
- prevent child access to Personal Codex state and unrelated workspace paths;
- preserve the exact provider/model/task tuple selected by policy;
- contain writes and subprocesses to an approved permission profile;
- make runtime identity, workspace changes, results, cost, and lifecycle
  independently auditable;
- fail closed when any gate is unknown, inconsistent, busy, or unsupported.

The repository's [Security Policy](../SECURITY.md) remains authoritative for
reporting, credentials, the single-slot bridge, redaction, and supported scope.

## Threat Model, Trust Boundaries, and Assumptions

### Assets

- macOS Keychain provider credentials;
- user source code and other files reachable from the task workspace;
- Personal Codex configuration, agents, plugins, skills, MCP, hooks, memory,
  trust history, sessions, and routing policy;
- provider/model/task integrity and billable API usage;
- result, runtime, workspace, lifecycle, and archive evidence;
- availability of the parent Codex process and local machine.

### Trust boundaries

1. **User/operator -> Main:** provider policy, explicit selection, task scope,
   permissions, cost authorization, and acceptance criteria.
2. **Main -> Handoff orchestrator:** validated immutable request and policy
   decision.
3. **Orchestrator -> External child:** stdin task envelope, isolated environment,
   sandbox, PID, and lifecycle controls.
4. **External child -> workspace:** reads/writes/tools constrained by `cwd`,
   expected scope, and permission profile.
5. **External child -> Keychain:** command-backed auth; secret value must not
   cross into Parent, argv, task, result, or public evidence.
6. **External child -> provider endpoint:** billable network boundary and
   untrusted remote responses.
7. **Child/result/provider -> Main:** all output is untrusted until schema,
   attribution, workspace, lifecycle, and secret checks pass.
8. **Runtime evidence -> durable/public docs:** raw private evidence must be
   sanitized and explicitly selected before publication.

### Input control

- **Potentially attacker-controlled:** repository contents, task message,
  filenames, symlinks, test output, provider/model output, structured result,
  stdout/stderr, and archive names derived from task input.
- **Operator-controlled:** provider/model/role, explicit provider policy,
  transport preference, `cwd`, permission profile, timeout, and retention.
- **Developer-controlled:** provider packs, transport adapters, schemas,
  compatibility matrix, binary lookup policy, and release artifacts.

### Assumptions

- The logged-in OS account, macOS Keychain, and selected Codex binary are not
  already compromised.
- Provider endpoint and catalog host policies are reviewed before installation.
- Node.js and operating-system sandbox/process primitives enforce their stated
  local behavior.
- Root or same-user malware can bypass local file permissions; defending an
  already-compromised account is out of scope.
- Provider privacy, retention, regional, and billing behavior remains an
  external user decision.

## Attack Surface, Mitigations, and Attacker Stories

| Risk | Attacker story / failure mode | Required mitigation | Fail-closed result |
| --- | --- | --- | --- |
| Credential exposure | A key appears in config, argv, env, task, output, logs, result, archive, or evidence. | Keychain-only command-backed auth; allowlisted env; stdin task; strict scans; never let Parent read the value. | `CREDENTIAL UNSUPPORTED` or execution failure. |
| argv leakage | Process listings reveal task or credential data. | Only fixed flags/paths in argv; task travels on stdin; evidence paths contain no task body. | Preparation fails. |
| env leakage | Child inherits API keys, tokens, proxy secrets, or unrelated state. | Build a minimal env from an explicit allowlist; reject credential-named inherited variables. | Preparation fails. |
| config leakage | Generated config stores a plaintext bearer token or copies Personal Codex settings. | Generate a minimal isolated config containing only reviewed provider fields and Keychain command auth. | Preparation fails. |
| Prompt injection | Repository text tells the child to escape scope, read secrets, change policy, or return forged evidence. | Treat repository/provider output as untrusted; immutable envelope; no plugins/MCP/browser; sandbox; Main acceptance independent of child statements. | Result rejected or task failed. |
| `cwd` escape | Relative traversal, alternate spelling, mount, or path substitution reaches unrelated files. | Resolve/canonicalize `cwd`; require an approved root; re-check before spawn and collection; compare workspace snapshot. | `BLOCK`. |
| Symlink escape | A task swaps a file or directory for a symlink to an external path. | `lstat`/realpath validation, reject symlinks at managed boundaries, pre/post scope snapshots, protected-path sandbox behavior. | `BLOCK` or result rejection. |
| External path write | A command writes outside `cwd` or an extra writable root. | Only `read-only`/`workspace-write`; no add-dir; network off for task tools; canonical changed-file comparison. | Result rejected; lifecycle failed. |
| Subprocess abuse | Tests launch an unexpected process, network client, or long-lived daemon. | Minimal PATH/env; sandbox; task suitability policy; timeout/process-group supervision; orphan verification. | Task failed/timed out. |
| Archive injection | A crafted name overwrites or escapes the bridge/archive root. | Strict task-name grammar, final-basename validation, owner-only paths, exclusive create, atomic unique rename, never overwrite archives. | Preparation/archive failure. |
| Active-slot race | Concurrent tasks overwrite one another or mix evidence. | Max concurrency `1`; atomic single-slot acquisition; second task returns `EXTERNAL CHILD BUSY`. | `BUSY`. |
| Result spoofing | Child claims another provider/model, hides changed files, or invents passing tests. | Strict bounded schema; no unknown fields; canonical scope; test/workspace/lifecycle cross-check; result fields are claims only. | Result rejected. |
| Provider identity spoofing | A result self-reports DeepSeek while runtime used OpenAI or another model. | Attribute from isolated session/turn metadata plus provider endpoint/request evidence; require one exact tuple; no fallback. | `providerResolved=false`; never runtime verified. |
| Malicious output | Provider emits oversized, malformed, terminal-control, path, or secret-like content. | Output/result size limits; JSON schema; treat strings as data; no command evaluation; redaction/secret scan before persistence or display. | Result rejected. |
| Timeout race | Process exits while timeout/cancel handlers kill a reused PID or record conflicting flags. | One execution handle; process-group ownership; idempotent termination; explicit state transitions; clear timers; verify PID/group after close. | Lifecycle failed, then cleanup. |
| Orphan process | Child or test subprocess survives completion/cancellation and keeps reading/writing or consuming API cost. | Detached process group, graceful terminate, bounded force-kill fallback, group liveness check before `closed`. | Lifecycle cannot close successfully. |
| Log persistence | Private prompts, paths, code, or provider output remains indefinitely or reaches Git. | Owner-only logs, redacted archives, explicit retention/cleanup policy, sanitized evidence allowlist, repository secret/personal-path scans. | Publication blocked. |
| Parent contamination | Child writes trusted-project entries, sessions, plugins, or routing into Personal Codex. | Isolated `CODEX_HOME`; no copied personal state; before/after snapshots of config, AGENTS, and agents; `--skip-git-repo-check`. | Acceptance fails. |
| Provider/model switch | Transport fallback silently changes provider/model or uses OpenAI. | Provider policy before transport policy; selection echoes immutable tuple; explicit transport never falls through. | `BLOCK`. |
| Cost amplification | Hidden probes, retries, parallel tasks, or automatic Pro selection increase charges. | Billable label, explicit policy, zero/bounded retry, timeout, concurrency `1`, no ordinary Doctor/Verifier requests, Pro explicit-only. | `REQUIRE_EXPLICIT`, `BUSY`, or `BLOCK`. |

### Realistic attacker stories

- A malicious repository places instructions in source files asking the child to
  read Keychain or paths outside `cwd`.
- A compromised provider response returns a valid-looking JSON result that lies
  about model identity, tests, or changed files.
- A local task creates a symlink or daemon during execution to escape the
  expected file/lifecycle boundary.
- A caller submits two paid tasks concurrently or requests Pro without explicit
  authorization.

### Lower relevance or out of scope

- Web CSRF/XSS, multi-tenant authorization, and server session theft are not
  primary surfaces because this repository does not run a public web service.
- Physical device compromise, root compromise, and malicious same-user malware
  defeat local process/file assumptions and are outside this architecture.
- Provider-side retention or billing errors are governed externally, but the
  project must present the boundary and avoid hidden requests.

## Phase 2 security checkpoint

The Phase 2 control plane preserves the activation boundary:

- the active Doctor, Verifier, Preflight, and Installer paths do not import or
  instantiate the External adapter;
- registry factory, feature gate, and runtime-route gate all remain disabled;
- result provider/model self-report cannot satisfy strict runtime evidence;
- Flash maintainer evidence is scoped and cannot become local installation
  verification; Pro, MiniMax, and Qwen External evidence remains unknown;
- provider/model tuples are echoed unchanged by Transport selection, Pro stays
  explicit-only, and an ineligible explicit Transport never falls through;
- Doctor and ordinary Verifier/Preflight/Installer paths make no Provider
  request and never expose Keychain values;
- reachability tests fail if an active control-plane module imports the adapter
  or if a production External factory becomes available.

These controls report readiness only. They do not authorize a billable request
or create a public External execution route.

## Severity Calibration (Critical, High, Medium, Low)

### Critical

- Committed or broadly logged plaintext provider credentials.
- A default execution path that silently sends arbitrary user workspaces to an
  unapproved provider/model with unrestricted permissions.

### High

- Reliable workspace escape that reads/writes unrelated private files.
- Provider identity spoofing accepted as runtime verification and used for
  subsequent automatic routing.
- Cancellation/cleanup failure that leaves controllable child processes running
  with credentials and workspace access.

### Medium

- Result/workspace mismatch that can mislead Main but cannot escape the bounded
  workspace or expose credentials.
- Unbounded retries or concurrency that can materially amplify third-party cost.
- Raw task/log retention beyond policy in owner-only local storage.

### Low

- Missing non-sensitive descriptive metadata when provider/task/workspace and
  lifecycle gates still fail closed.
- Documentation ambiguity that does not change code but could confuse
  maintainer evidence with local installation status; it becomes more severe if
  used to enable runtime automatically.

## Security acceptance before activation

Production activation requires tests proving:

- safe credential absence in argv/env/config/task/result/log/archive;
- `cwd`/symlink/external-write rejection;
- result/provider spoof rejection;
- single-slot collision handling;
- timeout, cancellation, forced-kill, and no-orphan closure;
- parent config immutability;
- sanitized evidence publication;
- no active Provider/Model fallback and no automatic Pro selection.

See the [transport contract](transport-contract.md),
[External transport architecture](external-transport.md), and
[ADR 001](adr/001-external-codex-transport.md).
