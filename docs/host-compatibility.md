# Host compatibility contract

This project targets one specific topology:

```text
OpenAI Codex main agent -> third-party-provider child agent
```

Compatibility is scoped to an exact Codex Host contract. A valid Custom Agent
TOML file and `multi_agent=true` do not, by themselves, prove that the child can
select a third-party provider.

## Compatibility levels

- **Level A — Runtime Verified:** the exact Host version is known; the intended
  child provider/model is attributable; the task arrives intact, executes, and
  returns to Codex Main; bridge cleanup and credential safety pass.
- **Level B — Configuration Compatible:** the Host discovers and accepts the
  agent/provider configuration, but the exact cross-provider runtime path has
  no completed E2E. It is not runtime verified and automatic provider routing
  remains disabled.
- **Level C — Host Blocked:** the Host contract is known not to support the
  required parent-to-child provider switch. Active installation, provider
  routing, bridge creation, and runtime success claims are blocked.
- **Level D — Unknown:** the exact Host version or capability has not been
  established. It fails closed like Level C for active installation and
  routing, but remains labelled unknown rather than incompatible.

## Codex 0.149 role contract

Codex 0.149 applies a bounded role override. The role value for provider-level
fields is ignored; the effective child value remains inherited from the parent.

| Field | Role value | Effective child value |
| --- | --- | --- |
| `model` | SUPPORTED ROLE OVERRIDE | role override |
| `model_reasoning_effort` | SUPPORTED ROLE OVERRIDE | role override |
| `developer_instructions` | SUPPORTED ROLE OVERRIDE | role override |
| skills / feature reductions | SUPPORTED ROLE OVERRIDE | reductions only |
| `model_provider` | IGNORED | INHERITED FROM PARENT |
| `model_providers` | IGNORED | INHERITED FROM PARENT |
| `model_catalog_json` | IGNORED | INHERITED FROM PARENT |
| provider endpoint and auth | IGNORED | INHERITED FROM PARENT |

The key upstream change is the merged
[bounded role override implementation](https://github.com/openai/codex/pull/39299).
The official [Subagents documentation](https://developers.openai.com/codex/subagents)
describes agent discovery and supported role fields, while the
[configuration reference](https://developers.openai.com/codex/config-reference)
documents parent-level provider, endpoint, authentication, and model-catalog
configuration.

## Current version matrix

| Host | Config | Discovery | Cross-provider child | Flash E2E | Pro E2E | Support status |
| --- | --- | --- | --- | --- | --- | --- |
| Codex CLI `0.147.0` | PASS (historical) | PASS (historical) | PASS (historical) | **HISTORICAL RUNTIME VERIFIED** | **HISTORICAL RUNTIME VERIFIED** | Level A for the recorded legacy contract |
| Codex `0.148.x` | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | Level D — fail closed |
| Codex CLI `0.149.x` | Role TOML may parse; provider values do not apply | `multi_agent=true` does not prove provider switching | **BLOCKED** by bounded role contract | Not current | Not current | Level C — fail closed |
| Current Desktop bundled `0.149.0-alpha.4.1` | UNKNOWN | UNKNOWN | **BLOCKED** by the conservative `0.149.x` line gate | Not performed | Not performed | Level C — fail closed |

The `0.147.0` records are historical evidence, not a recommendation to
downgrade or pin Codex. No current-runtime claim is made for those records.
MiniMax and Qwen provider evidence is unchanged by this Host audit; provider
evidence never overrides a blocked or unknown Host contract.

## Detection and fail-closed behavior

The inspector reads the Host version from `codex --version` and the native
multi-agent state from `codex features list`. The current public Host surface
does not expose a reliable runtime/schema probe for per-role provider override
support. The project therefore uses a conservative version-scoped gate backed
by the official `0.149` source contract:

- exact `0.147.0` plus `multi_agent=true`: historical Level A;
- the `0.149.x` line and its prereleases: Level C;
- an explicit future provider-override capability without E2E: Level B;
- every other unverified version: Level D.

Doctor and dry-run remain available at every level. `--apply` requires Level A
or B. Automatic provider routing and bridge creation require Level A. A blocked
or unknown Host returns an OpenAI route or denies an explicit provider request
before provider readiness checks or bridge creation.

## Verifier state model

The verifier reports these states independently:

- `configured`: managed local files, configuration, and any requested
  credential check pass integrity checks;
- `discoverable`: the local definitions are valid and native multi-agent is on;
- `providerResolved`: the child provider is attributable at runtime;
- `taskDelivered`: the intended task reached that child;
- `runtimeExecuted`: a live child task executed;
- `runtimeVerified`: the full runtime evidence contract was independently met;
- `configurationReady`: local configuration and Host compatibility both pass;
- `ready`: `configurationReady` plus a verified Keychain credential.

On Codex `0.149.0`, an intact installation may still report
`configured=true` and `discoverable=true`, while `providerResolved=false`,
`taskDelivered=false`, `runtimeExecuted=false`, `runtimeVerified=false`, and
`ready=false`. Local configuration is never promoted into a third-party runtime
success claim.
