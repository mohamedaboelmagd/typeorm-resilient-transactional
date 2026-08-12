## What and why

<!-- What changes, and what problem it solves. -->

## How it was verified

<!-- Which command proved it. "Ran the suite" is not an answer; name the test. -->

- [ ] `pnpm test` passes (unit + integration + compat)
- [ ] New behaviour has a test that fails without the change
- [ ] `pnpm lint` and `pnpm typecheck` pass

## Checklist

- [ ] `src/core/` still imports nothing from `@nestjs/*`
- [ ] `dependencies` is still empty
- [ ] Changeset added (`pnpm changeset`) if anything user-visible changed
- [ ] ADR added under `docs/adr/` if this changes behaviour users could depend on
- [ ] `MIGRATION.md` updated if this deviates further from `typeorm-transactional`
- [ ] Any number added to the docs came from a command, not an estimate
