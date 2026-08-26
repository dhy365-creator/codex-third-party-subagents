# Frequently Asked Questions

**English** | [简体中文](faq.zh-CN.md)

## Project

### Is this an OpenAI product?

No.

This repository is an unofficial, community OSS project. It is not endorsed by
OpenAI and is not a replacement for Codex itself.

### Does this replace Codex?

No.

Codex is still the main agent. Third-party workers only handle bounded text/code
tasks and return results for Codex review and final synthesis.

### Why use this if I can call models directly?

The project is useful if you want to keep Codex orchestration, review, and
routing while moving suitable tasks to potentially lower-cost provider APIs for
bounded execution. It does not guarantee savings.

## Cost and quota

### Does this give me unlimited Codex usage?

No.

Your Codex subscription and quotas still apply to OpenAI usage.

### Does this bypass OpenAI limits?

No.

Routing is bounded and policy-aware, and it does not expand or alter OpenAI
limits.

### Does it guarantee fixed savings?

No.

Cost depends on selected provider, task type, token usage, pricing, and routing.

## Security and privacy

### Where are API keys stored?

In macOS Keychain only. This repository does not store provider credentials.

### Does the installer print API keys?

No.

The installer rejects `--api-key` and never logs credential values.

### Is task content sent to third-party providers?

Yes. When a provider route is selected, the bounded delegated task and request
context needed for worker execution are sent to that provider. Do not delegate
credentials, private content, or material you are not authorized to send.

You should review provider privacy, retention, pricing, and regional rules before
using any key.

### Does this modify main Codex configuration?

No.

The installer does not rewrite the main `~/.codex/config.toml`, primary model,
provider, or authentication. With explicit `--apply`, it manages the selected
pack files, helper artifacts, manifest/backups, and one bounded AGENTS block.

## Compatibility

### Is Windows supported?

The public `v0.4.0-beta.3` artifact remains macOS-only for apply/runtime.
The current Windows Phase 1 source candidate adds a secure configuration
foundation using the current user's Windows Credential Manager and owner-only
ACLs. Configuration apply can complete, but Provider runtime remains
`BLOCKED_PENDING_PHASE_2`, `runtimeVerified=false`, and External default-off.
This is not Windows Provider runtime support. Do not use plaintext `.env`
files, secret files, or persistent `DEEPSEEK_API_KEY` environment variables
as a workaround.

### Which providers are currently supported?

Current packs/profiles and evidence are:

- DeepSeek V4 Flash: packaged clean-install External Public Beta; one bounded
  maintainer E2E on macOS with exact Codex CLI `0.149.0` produced strict local
  runtime evidence, while independent-user acceptance remains pending.
- DeepSeek V4 Pro: an explicit-only Custom Agent profile with direct API and
  controlled maintainer Level 3 E2E evidence; public-installer and independent
  user acceptance remain pending.
- MiniMax-M3: built-in and runtime verified for the recorded API, CLI, and
  Desktop worker path.
- Qwen3.7-Max: built-in and runtime verified for the recorded API, CLI, and
  Desktop worker path.

Candidates and gateway listings are not supported packs. See the complete
[compatibility matrix](provider-compatibility.md).

### How are provider claims defined?

- **Built-in pack**: implemented and verified in isolation.
- **Runtime-verified**: real Codex subagent run and human-reviewed result.
- **Candidate**: protocol and docs alignment found, runtime verification pending.
- **API-verified candidate**: a limited direct API probe also passed, but no
  installer, Codex Desktop, bridge-release, or human-review claim follows.
- **Incompatible**: missing protocol or required translator constraints.

### Why isn't model X supported?

This project verifies strict boundaries:

- Responses protocol compatibility
- text/code capability boundary
- tool-call loop behavior
- offline validation and bridge safety
- verified subagent handoff and release

Availability changes by model docs, pricing, and provider behavior.

### Can I configure DeepSeek V4 Pro now?

You can review an explicit-only `--model pro` dry-run when Doctor confirms the
Host and identity conditions. It never becomes the automatic fallback. A matching
legacy user definition additionally requires `--migrate-legacy --apply`.

A controlled maintainer run now records the expected Host provider/model tuple,
tool use, bridge completion/release, and main-thread review. That does not claim
automatic routing, provider-dashboard attribution, public-installer success in
an unrelated environment, broad reliability, or independent user acceptance;
the verifier remains `runtimeVerified: false`. See the
[Custom Agents migration guide](migration/custom-agents.md) and
[sanitized runtime record](validation/deepseek-custom-subagents-runtime-e2e-2026-08-16.md).

### How can I request another provider?

Open the [Provider compatibility request form](https://github.com/dhy365-creator/codex-third-party-subagents/issues/new?template=provider-compatibility.yml).

## Installation

### What should I run first?

Run `npm run doctor` first.

It is read-only and checks the OS, Node version, Codex environment,
provider/model pairing, Keychain item presence, fallback hints, installation
state, permissions, and verify prerequisites before any `--apply`.

### What does Doctor change?

Nothing. `doctor` is read-only.

## Doctor PASS / WARN / BLOCKED

### Why does Doctor show WARN or BLOCKED?

The three values are triage states:

- `PASS`: checked state meets expected boundaries.
- `WARN`: attention is needed, but the finding is not necessarily blocking.
- `BLOCKED`: hard stop needed before proceeding safely.

## Runtime and limits

### What is `runtimeVerified`?

`runtimeVerified` remains `false` until this project records independently
accepted runtime evidence. It does not auto-promote one controlled maintainer
observation.

Configured installers can still be healthy while `runtimeVerified` is false.
