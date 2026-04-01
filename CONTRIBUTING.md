# Contributing

Thanks for taking an interest in the project.

For collaboration or technical discussion, contact:

- `lonely121522521@gmail.com`

The maintainer has five years of AI development experience and is happy to collaborate on practical improvements around provider compatibility and engineering quality.

## Current Contribution Policy

- Issues are welcome.
- Pull requests are currently limited and are not the default contribution path unless explicitly invited.
- Large unsolicited refactors are especially likely to be declined while the codebase is still stabilizing.

This repository is moving quickly and still contains decompilation artifacts, compatibility shims, and intentionally disabled feature-flag paths. That means maintainability matters more than broad cleanup.

## Good Ways To Help

- Report reproducible bugs.
- Improve documentation and setup instructions.
- Share provider compatibility findings with clear reproduction details.
- Point out behavioral regressions, broken commands, or missing environment variables.

## Before Opening An Issue

Please include:

- operating system
- Bun version
- which provider or backend you are using
- exact command or workflow that failed
- expected behavior
- actual behavior
- relevant logs or screenshots

## Development Notes

### Setup

```bash
bun install
bun run dev
```

### Useful Commands

```bash
bun run build
bun run lint
bun test
```

## Project-Specific Expectations

- Do not try to "fix all TypeScript errors" in one sweep. Many are decompilation leftovers and are not runtime blockers.
- Keep provider support honest. Do not document or expose a provider as first-class unless the runtime, setup flow, and capability checks actually support it.
- Prefer targeted changes over broad formatting churn.
- Avoid rewriting large generated or decompiled sections unless the behavior change clearly requires it.

## Pull Request Expectations

If you were asked to prepare a PR, keep it narrow and include:

- a clear problem statement
- the exact user-facing behavior change
- notes about provider impact, if any
- a simple test plan

Please also mention whether the change touches:

- provider routing
- model defaults
- onboarding or settings UX
- permissions or sandbox behavior
- networking or authentication
