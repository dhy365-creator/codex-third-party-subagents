# Security Policy

## Supported versions

Only the current `0.4.0-beta.3` source line is supported. Pre-release versions
are experimental; report issues promptly.

## Reporting a vulnerability

Do not open a public issue with sensitive details. Report privately to the
maintainers through the repository's private contact channel (for example, a
GitHub private advisory or the maintainer's contact listed on the repository
profile) and include:

- The affected file or command.
- A minimal reproduction that does not expose credentials or task payloads.
- Whether the issue involves secrets, the Keychain, or the task bridge.

You should receive an acknowledgement within 7 days. Do not share the bridge
task body or credentials in any report.

## Security model

- API keys are never stored in this repository. Credentials live in the macOS
  Keychain and are read at runtime only.
- The reviewed credential path in `v0.4.0-beta.3` is macOS Keychain via the
  command-backed `/usr/bin/security` semantics only. A supported Windows
  Credential Manager, DPAPI, or equivalent secure backend is not implemented;
  do not work around this with plaintext `.env` files or long-lived
  `DEEPSEEK_API_KEY` environment variables.
- Users must review each provider's privacy, pricing, data-retention, and
  regional policies. Provider behavior and compatibility may change without a
  release from this repository.
- The task bridge allows exactly one active provider task at a time. The active
  slot and its task file are owner-only (`0700` / `0600`), reject symlinks, and
  are atomically archived to `completed-*` or `failed-*` when the task ends.
  `message` and `cwd` are replaced with `[REDACTED]` before the atomic archive
  rename; archives are never deleted automatically.
- The installer never accepts an API key as a CLI argument. It only verifies a
  macOS Keychain item, and it does not modify the main `config.toml`.
- Uninstall validates every managed hash and backup before applying any action.
  A conflict stops the entire uninstall plan instead of partially removing
  files or overwriting user edits.
- Only bounded, pre-approved text and code tasks are delegated to fallback
  providers.
  Images, audio, video, desktop control, and browser control are out of scope.
- The Desktop preflight is a policy-assisted guardrail and is not guaranteed
  native automatic interception; treat it as defense-in-depth, not a boundary.
