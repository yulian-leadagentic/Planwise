# bm2 phase 1 — investigation notes

Findings for the items in `phase1-bugs.md` marked INVESTIGATE-ONLY.
A teammate has local WIP on the permissions / session layer, so nothing
here has been rewritten from this branch — the notes below are just
enough for that owner to land a fix without re-diagnosing.

---

## Item 6 · "Some users are invisible" (permissions / people list)

**Root cause candidate — strict `userType` equality in the list filter**

`apps/api/src/modules/users/users.service.ts:212`

```ts
if (query.userType) where.userType = query.userType;
```

The `UserType` enum (`apps/api/prisma/schema.prisma:12-16`) has THREE
values:

- `employee`
- `partner`
- **`both`**

The People page splits into two tabs that call this endpoint with:

- **Employees** tab → `?userType=employee`
- **External Employees** tab → `?userType=partner`

(`apps/web/src/features/people/people-page.tsx:241`)

Because the `where` clause is strict equality, users whose row was
seeded / imported with `userType='both'` are excluded from BOTH tabs —
they don't show as an employee OR as a partner. Amit Maimoni and
Daniel Malka are almost certainly `userType='both'` rows.

The same code path already knows about the "both" case elsewhere —
`users.service.ts:119` (`if (dto.userType === 'employee' || dto.userType === 'both')`
when syncing employment fields on update). And the sister query in
`apps/api/src/modules/execution-planning/execution-planning.service.ts:630`
uses the correct pattern:

```ts
userType: { in: ['employee', 'both'] },
```

**Recommended fix (for the permissions owner):** in
`users.service.ts:findAll`, translate `query.userType` before applying
it to `where`:

```ts
if (query.userType === 'employee') where.userType = { in: ['employee', 'both'] };
else if (query.userType === 'partner') where.userType = { in: ['partner', 'both'] };
else if (query.userType) where.userType = query.userType;
```

Anything that filters users by type against a strict enum value has the
same bug shape — worth grepping the API for other `userType:` writes
that don't use `in`. (I found only the two above in this pass;
mention-search, assignee pickers etc. call `/users` through the same
endpoint, so fixing `findAll` covers them.)

**Not the cause of "I don't see myself":** the `isActive` default in
`findAll` (defaults to `true` when unset) hides inactive users from
every picker but not from the People page's "all" filter. If a user
still can't see themselves after switching the People page's status
filter to "all", the second candidate is the `partners:read`
permission gate on `GET /users` (`users.controller.ts:65`) — a role
without that permission gets an empty list rather than a self-only
list. Leaving that for the permissions owner to look at alongside the
in-progress rewrite.

---

## Item 8 · "App throws the user out mid-work" (session / refresh / token)

_(Filled in with the item 8 investigation.)_
