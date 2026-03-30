/**
 * Repro #3 — fs9_read_bytea() ignores SECURITY DEFINER context
 *
 * Setup:
 *   1. Run setup.sql as admin:
 *        db9 db sql <db> < setup.sql
 *   2. Upload a binary file to the function's fs9:
 *        db9 fs cp test_data.xlsx <db>:/functions/<func-id>/uploads/test_data.xlsx
 *
 * Expected: SECURITY DEFINER function owned by superuser allows authenticated
 *   callers to indirectly use fs9_read_bytea() — standard PostgreSQL behavior.
 *
 * Actual: "ERROR: fs9: permission denied (superuser required)"
 *   The fs9 extension checks the *original* caller's role (GetOuterUserId in C)
 *   rather than the current security context (GetUserId), bypassing SECURITY DEFINER.
 */
const handler = async (input, ctx) => {
  const results = {};

  // Check what role the function runs as
  try {
    const r = await ctx.db.query("SELECT current_user, session_user");
    results.current_user = r.rows[0][0];
    results.session_user = r.rows[0][1];
    // Expected for authorized access: some privileged role
    // Actual: "authenticated"
  } catch (e) {
    results.role_check = `ERROR: ${e.message}`;
  }

  // Attempt 1: call fs9_read_bytea directly (expected to fail — needs superuser)
  try {
    const r = await ctx.db.query(
      "SELECT encode(fs9_read_bytea('/functions/dummy/test.xlsx'), 'base64')"
    );
    results.direct_call = `ok, length=${r.rows[0][0]?.length}`;
  } catch (e) {
    results.direct_call = `ERROR: ${e.message}`;
    // Expected: "ERROR: fs9: permission denied (superuser required)"
  }

  // Attempt 2: call via SECURITY DEFINER wrapper (should work — but doesn't)
  // Requires setup.sql to have been run first
  const uploadEntries = await ctx.fs9.list("/uploads").catch(() => []);
  const absPath = uploadEntries[0]?.path;

  if (!absPath) {
    results.secdef_call = "SKIP: no file in /uploads — upload one first";
  } else {
    try {
      const r = await ctx.db.query(
        "SELECT public.read_binary_b64($1)",
        [absPath]
      );
      results.secdef_call = `ok, b64_length=${r.rows[0][0]?.length}`;
    } catch (e) {
      results.secdef_call = `ERROR: ${e.message}`;
      // Expected: ok (SECURITY DEFINER should grant access)
      // Actual:   "ERROR: fs9: permission denied (superuser required)"
    }
  }

  return results;
};

module.exports = { handler };
