/**
 * Repro #4 — ctx.db.query() returns array rows, not object rows
 *
 * Expected (consistent with pg, psycopg2, mysql2, Drizzle, etc.):
 *   r.rows[0] = { id: 1, name: "Alice", value: 42 }
 *   r.rows[0].name  → "Alice"
 *
 * Actual:
 *   r.rows[0] = [1, "Alice", 42]      ← plain array
 *   r.rows[0].name  → undefined       ← column name access breaks
 *   r.rows[0][1]    → "Alice"         ← must use numeric index
 *
 * Impact: any code written following standard PostgreSQL client conventions
 *   silently returns undefined for every column value.
 */
const handler = async (input, ctx) => {
  // Create a temporary table with named columns for this demonstration
  await ctx.db.query(`
    CREATE TEMP TABLE IF NOT EXISTS repro_04 (
      id    INTEGER,
      name  TEXT,
      score NUMERIC
    )
  `);
  await ctx.db.query(`
    INSERT INTO repro_04 VALUES (1, 'Alice', 99.5)
    ON CONFLICT DO NOTHING
  `).catch(() => {
    // TEMP table may already exist from a previous invocation — that's fine
  });

  const r = await ctx.db.query("SELECT id, name, score FROM repro_04 LIMIT 1");
  const row = r.rows[0];

  return {
    // --- Access by column name (standard behavior, expected to work) ---
    byName: {
      id:    row.id,      // expected: 1,       actual: undefined
      name:  row.name,    // expected: "Alice",  actual: undefined
      score: row.score,   // expected: 99.5,     actual: undefined
    },

    // --- Access by index (non-standard, but works) ---
    byIndex: {
      id:    row[0],      // actual: 1
      name:  row[1],      // actual: "Alice"
      score: row[2],      // actual: "99.5"
    },

    // --- Diagnostic ---
    rowType:    Array.isArray(row) ? "array" : "object",   // actual: "array"
    rowKeys:    Object.keys(row),                           // actual: ["0","1","2"]
    rowJSON:    JSON.stringify(row),                        // actual: "[1,\"Alice\",\"99.5\"]"
  };
};

module.exports = { handler };
