# Repro #9 — `ctx.db.query` row format undocumented

## Summary

The `ctx.db.query()` API returns array rows (see repro #4), which differs from every
major PostgreSQL client library. This behavior is not documented, and the functions
documentation contains no example that would reveal it. Developers naturally write
`row.columnName` and get silent `undefined` returns.

## What the docs should say

In the "Querying the database" section of FUNCTIONS.md, add an explicit note and
a before/after comparison:

---

### Database query results

> ⚠️ **Important**: `ctx.db.query()` returns rows as **arrays** indexed by column
> position, not as objects keyed by column name. This differs from `pg`, `psycopg2`,
> `mysql2`, and most other database clients.

```javascript
const result = await ctx.db.query(
  "SELECT id, name, score FROM users WHERE id = $1",
  [userId]
);

// ❌ Does NOT work — column name access always returns undefined
const name = result.rows[0].name;   // undefined
const id   = result.rows[0].id;     // undefined

// ✅ Correct — use column index (0-based, in SELECT order)
const id    = result.rows[0][0];    // first column:  id
const name  = result.rows[0][1];    // second column: name
const score = result.rows[0][2];    // third column:  score
```

Tip: use destructuring to make index-based access more readable:
```javascript
const [[id, name, score]] = result.rows;
```

---

## Suggested fix (API change)

Return objects instead of arrays (standard behavior). If backwards compatibility is
required, add a `rowObjects` field alongside `rows`:

```javascript
result.rows        // current: [[1, "Alice", 99.5]]
result.rowObjects  // new:     [{ id: 1, name: "Alice", score: 99.5 }]
```
