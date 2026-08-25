# Custom Agents architecture migration

Status: implemented configuration migration; controlled Flash and explicit-only
Pro runtime evidence is recorded per model and remains deliberately bounded.

## Why this changed

Older project wording used a routing request's `requestedAgent` value and the
preflight role list as though they created a Codex Host identity. They do not.
They are this repository's policy inputs only.

Current Codex custom-agent documentation defines the Host identity in a TOML
definition: the `name` field is authoritative, while the filename is the
normal discovery convention. The supported scopes are user
`~/.codex/agents/*.toml` and project `.codex/agents/*.toml`. See the official
[Subagents documentation](https://developers.openai.com/codex/subagents)
and [configuration reference](https://developers.openai.com/codex/config-reference).

## Historical Host audit — 2026-08-16

- Local Codex CLI: `0.147.0`.
- `multi_agent` reports enabled; `multi_agent_v2` reports disabled.
- The current CLI exposes no direct `--agent` execution flag.
- The already-open Host session discovered `deepseek_worker` but had not loaded
  the new `deepseek_pro_worker` definition. A fresh Host session discovered and
  ran both identities, confirming that agent inventory changes require reload.

Historical conclusion for exact `0.147.0`: the architecture was **Mode A —
native Custom Agent definitions**.
The project writes valid Host definitions and treats the policy router as a
separate defense-in-depth layer. It never claims that a router allowlist itself
registers an agent.

## Current Host contract — 2026-08-23

Codex CLI `0.149.0` narrows agent-role application to bounded overrides. Model,
reasoning effort, developer instructions, and reductions are supported, while
role-level provider/catalog/endpoint/auth values are ignored and inherited from
the parent. The current OpenAI Main -> third-party Provider child topology is
therefore Level C Host Blocked even when `multi_agent=true`. See the
[version matrix and fail-closed contract](../host-compatibility.md).

## Identity and routing contract

| Custom Agent name | Provider | Model | Routing rule |
| --- | --- | --- | --- |
| `deepseek_worker` | DeepSeek | `deepseek-v4-flash` | Default DeepSeek fallback only when policy prerequisites pass |
| `deepseek_pro_worker` | DeepSeek | `deepseek-v4-pro` | Explicit-only; never selected by automatic fallback |
| `minimax_worker` | MiniMax | `MiniMax-M3` | Pack-selected |
| `qwen_worker` | Alibaba Model Studio | `qwen3.7-max` | Pack-selected |

Each generated TOML requires `name`, `description`, and
`developer_instructions`, declares its model/provider tuple, and uses command-backed
macOS Keychain auth. A compatible Host is required for that provider tuple to
take effect. Unsupported legacy handoff keys such as `complete` and
`fail` are rejected by local validation rather than emitted into the TOML.

The bridge carries the configured tuple so the worker can refuse a mismatched
task. That is configuration metadata, not proof that a live Host/provider
runtime returned the same metadata.

Before preparing a provider bridge task, preflight also inspects every
`.codex/agents` layer in the real task directory's ancestor chain, while
excluding only the user's own `~/.codex/agents` user layer. The presence of any
project-scoped TOML definition, or an unreadable agent layer, keeps an OpenAI
worker and writes no bridge task. This conservative fail-closed boundary covers
custom project-root markers and nested repositories, preventing a
higher-precedence project definition from silently replacing the user-scoped
provider identity.

## Installer migration

The installer remains dry-run by default. Dry-run checks Host capability,
expected user/project identities, duplicate names, and legacy candidates without
writing files or calling a paid provider API.

`--apply` is blocked when:

- the exact Host is Level C Host Blocked or Level D Unknown;
- an expected identity is invalid, duplicated, mismatched, or shadowed by a
  project-scoped definition;
- a matching existing user definition has not been explicitly adopted.

For a matching legacy user definition, first review dry-run output, then use:

```sh
node scripts/install.mjs ... --migrate-legacy --apply
```

Migration records an owner-only backup before replacing the managed definition.
Uninstall validates hashes before mutation and restores that backup; it never
removes Keychain credentials or historical bridge archives.

The installer does not edit `~/.codex/config.toml`, Host feature flags, the
primary model/provider/authentication, or a project `.codex/agents` directory.
After an apply, restart or begin a new Codex session so the Host can rediscover
the user-scoped definition. Do the same after any project `.codex/agents`
change: preflight inspects current disk state but cannot rewrite an agent
inventory already loaded by the Host.

## Doctor and verify

`npm run doctor` is read-only. It separately checks native multi-agent state and
the cross-provider Host contract, plus expected definition identity, missing or
duplicated names, project-scope conflicts, legacy-migration state, install
state, and ordinary provider prerequisites. It performs no write, no paid API
call, and never reads a Keychain secret value.

`verify` reports local configuration, discovery, provider resolution, task
delivery, execution, and runtime verification as separate fields. Its per-agent
local evidence contains provider, agent name, model, and a timestamp. It keeps
`hostRuntimeMetadata: null` and `runtimeVerified: false` because it does not
ingest or independently accept external runtime records. Flash evidence never
verifies Pro, and Pro evidence never verifies Flash.

## Runtime evidence boundary

On exact Codex CLI `0.147.0`, fresh Host sessions completed the same read-only
coding fixture through
`deepseek_worker -> deepseek-v4-flash` and
`deepseek_pro_worker -> deepseek-v4-pro`. Each child reproduced the failing
tests, identified the exact one-line fix, used tools, completed and released its
owner-only bridge, and was independently reviewed by the main thread. Sanitized
session metadata recorded the expected provider/model tuple for each run.

This is **historical** controlled maintainer Level 3 evidence for those named
paths. It does
not supply provider-dashboard attribution, public-installer validation in an
unrelated environment, broad task reliability, or independent user acceptance;
it does not change `runtimeVerified: false`. Pro remains explicit-only, with no
automatic Flash/Pro switching. See the
[sanitized runtime record](../validation/deepseek-custom-subagents-runtime-e2e-2026-08-16.md).
