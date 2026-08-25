# Roadmap

This roadmap is conservative and has no delivery dates.

## Status language

- **current**: already present in the public beta.
- **planned**: intended maintenance work, without a promised date.
- **under evaluation**: a candidate direction requiring evidence and review.
- **runtime verification pending**: implemented or documented, but live runtime
  evidence is incomplete.
- **not committed**: exploratory only; not a support promise.

## Current — v0.4.x Public Beta

Focus: documentation and operational maturity before adding new runtime claims.

- **current** — keep Codex as the main agent and provider handoff bounded.
- **current** — maintain read-only Doctor and the dry-run-first installer.
- **current** — DeepSeek V4 Flash packaged clean-install External Public Beta,
  verified by one bounded maintainer E2E on macOS with exact Codex CLI
  `0.149.0`; the route remains explicit and default-off.
- **planned** — stabilize onboarding, provider diagnostics, documentation, and
  contributor guidance from real user feedback.
- **planned** — keep provider evidence aligned across current state,
  compatibility, demos, and release notes.
- **planned** — obtain independent real-user acceptance for the DeepSeek Flash
  install path after the recorded controlled maintainer E2E; do not treat it as
  broad routing evidence.
- **current** — DeepSeek V4 Pro has an explicit-only Custom Agent configuration
  profile and a model-attributable controlled maintainer coding-fixture E2E with
  bridge completion and main-thread review. It remains excluded from automatic
  Flash/Pro routing; public-installer and independent user acceptance are still
  planned as separate evidence.

## Next — v0.5

Candidate directions, not release commitments:

- **under evaluation** — simplify installation without weakening dry-run,
  Keychain, backup, or explicit-apply boundaries.
- **under evaluation** — improve diagnostics and explain routing decisions more
  clearly before task handoff.
- **under evaluation** — expand runtime evidence and provider-pack validation.
- **under evaluation** — improve contributor triage and acceptance guidance.

## Later

- **under evaluation / not committed** — additional provider packs, only after
  protocol, tool-loop, failure, bridge-release, and main-review evidence.
- **under evaluation / not committed** — routing-policy improvements that retain
  safe OpenAI fallback behavior.
- **exploratory / not committed** — Windows or Linux support.
