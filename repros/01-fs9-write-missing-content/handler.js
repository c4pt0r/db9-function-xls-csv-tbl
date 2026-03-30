/**
 * Repro #1 — ctx.fs9.write() always throws "missing content"
 *
 * Expected: ctx.fs9.write(path, content) creates or overwrites the file.
 * Actual:   throws Error("missing content") regardless of path or content.
 *
 * Tested paths:
 *   - "/out.csv"                       (relative, root)
 *   - "/subdir/out.csv"                (relative, subdirectory)
 *   - "/functions/<id>/out.csv"        (absolute path derived from list())
 *
 * Tested content values:
 *   - "hello"                          (plain string)
 *   - "col1,col2\nval1,val2"           (CSV with newline)
 *   - ""                               (empty string)
 */
const handler = async (input, ctx) => {
  const results = {};

  // Case 1: relative path, non-empty content
  try {
    await ctx.fs9.write("/out.csv", "col1,col2\nval1,val2");
    results.case1_relative = "ok";
  } catch (e) {
    results.case1_relative = `ERROR: ${e.message}`;
  }

  // Case 2: relative path with subdirectory
  try {
    await ctx.fs9.write("/output/test.csv", "hello");
    results.case2_subdir = "ok";
  } catch (e) {
    results.case2_subdir = `ERROR: ${e.message}`;
  }

  // Case 3: empty content (should arguably fail, but error message is misleading)
  try {
    await ctx.fs9.write("/out.csv", "");
    results.case3_empty_content = "ok";
  } catch (e) {
    results.case3_empty_content = `ERROR: ${e.message}`;
  }

  // Case 4: derive absolute path from list(), then write using that
  try {
    // Only works if at least one file was pre-uploaded to this function's fs9 scope
    const root = await ctx.fs9.list("/");
    const funcPath = root[0]?.path?.match(/^(\/functions\/[^/]+\/)/)?.[1];
    if (funcPath) {
      await ctx.fs9.write(funcPath + "out.csv", "hello");
      results.case4_absolute = "ok";
    } else {
      results.case4_absolute = "SKIP: no files in fs9 yet (upload one first)";
    }
  } catch (e) {
    results.case4_absolute = `ERROR: ${e.message}`;
  }

  // Expected: all cases return "ok"
  // Actual:   all cases return "ERROR: missing content"
  return results;
};

module.exports = { handler };
