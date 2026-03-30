/**
 * Repro #5 — ctx.fs9.list() returns absolute paths; read/write expect relative
 *
 * Setup: upload any file to this function's fs9 before invoking:
 *   db9 fs cp test_data.xlsx <db>:/functions/<func-id>/uploads/test_data.xlsx
 *
 * ctx.fs9.list('/uploads') returns entries with ABSOLUTE paths:
 *   { path: "/functions/<uuid>/uploads/test_data.xlsx", ... }
 *
 * But ctx.fs9.read() and ctx.fs9.write() expect RELATIVE paths:
 *   ctx.fs9.read("/uploads/test_data.xlsx")  ← correct
 *   ctx.fs9.read("/functions/<uuid>/uploads/test_data.xlsx")  ← double-prefix error
 *
 * Using list()'s path directly in read() produces:
 *   Error: No such file or directory: /functions/<uuid>/functions/<uuid>/uploads/test_data.xlsx
 *   (the function prefix gets applied twice)
 */
const handler = async (input, ctx) => {
  let entries;
  try {
    entries = await ctx.fs9.list("/uploads");
  } catch (e) {
    return {
      error: `list failed: ${e.message}`,
      hint: "Upload a file first: db9 fs cp test_data.xlsx <db>:/functions/<func-id>/uploads/test_data.xlsx",
    };
  }

  if (!entries || entries.length === 0) {
    return { error: "No files in /uploads. Upload a file first." };
  }

  const listedPath = entries[0].path;
  // Extract filename to build a correct relative path manually
  const filename = listedPath.split("/").pop();
  const correctRelativePath = "/uploads/" + filename;

  const results = {
    // What list() actually returns
    pathFromList: listedPath,
    pathStartsWithFunctions: listedPath.startsWith("/functions/"),

    // Attempt 1: use list()'s path directly in read() — FAILS
    readWithListedPath: null,
    readWithListedPathError: null,

    // Attempt 2: use manually constructed relative path — WORKS
    readWithRelativePath: null,
    readWithRelativePathError: null,
  };

  // Attempt 1: use absolute path from list() directly
  try {
    const content = await ctx.fs9.read(listedPath);
    results.readWithListedPath = content === null ? "null" : `ok (length=${content.length})`;
  } catch (e) {
    results.readWithListedPathError = e.message;
    // Expected (if path was consistent): ok
    // Actual: "No such file or directory: /functions/<id>/functions/<id>/uploads/..."
    //         OR null (for binary files — see repro #2)
  }

  // Attempt 2: manually constructed relative path
  try {
    const content = await ctx.fs9.read(correctRelativePath);
    results.readWithRelativePath = content === null ? "null (binary file — see repro #2)" : `ok (length=${content.length})`;
  } catch (e) {
    results.readWithRelativePathError = e.message;
  }

  return results;
};

module.exports = { handler };
