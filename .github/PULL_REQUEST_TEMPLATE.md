## What changed

<!-- Describe the user or operator problem and the resulting behavior. -->

## Scope and safety

- [ ] I identified the canonical source of truth affected by this change.
- [ ] I described owner/tenant, privacy, and authorization boundaries.
- [ ] I described restart, unknown-result, retry, reconcile, and rollback behavior where relevant.
- [ ] I did not include credentials, private Brain data, customer data, or unsanitized logs.

## Validation

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:postgres` (when applicable)
- [ ] Compose smoke (`npm run smoke:compose`) (when applicable)

## Compatibility and operations

<!-- Mention migrations, protocol changes, Temporal replay impact, metrics, runbook changes, or rollout limits. -->
