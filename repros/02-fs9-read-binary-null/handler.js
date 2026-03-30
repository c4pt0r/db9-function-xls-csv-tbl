/**
 * Repro #2 — ctx.fs9.read() returns null for binary files
 *
 * Setup: upload a binary file (xlsx, zip, png, etc.) to this function's fs9
 *   before invoking:
 *     db9 fs cp test_data.xlsx <db>:/functions/<func-id>/uploads/test_data.xlsx
 *
 * Expected: ctx.fs9.read() returns the file contents as a string or Buffer.
 * Actual:   returns null, silently, with no error thrown.
 *
 * Side effect: null is indistinguishable from "file not found", making it
 *   impossible to detect whether the file is missing vs. unreadable.
 */
const handler = async (input, ctx) => {
  // List files in /uploads to confirm the binary file exists
  let entries;
  try {
    entries = await ctx.fs9.list("/uploads");
  } catch (e) {
    return { error: `ctx.fs9.list failed: ${e.message}` };
  }

  if (!entries || entries.length === 0) {
    return {
      error: "No files found in /uploads. Please upload a binary file first:",
      hint: "db9 fs cp test_data.xlsx <db>:/functions/<func-id>/uploads/test_data.xlsx",
    };
  }

  const absolutePath = entries[0].path;
  // Extract just the filename, reconstruct relative path
  const filename = absolutePath.split("/").pop();
  const relativePath = "/uploads/" + filename;

  // Attempt to read the binary file
  const contentByRelative = await ctx.fs9.read(relativePath);
  const contentByAbsolute = await ctx.fs9.read(absolutePath);

  return {
    file: filename,
    absolutePathFromList: absolutePath,
    relativePathUsed: relativePath,

    // Both should return file content but both return null for binary files
    readByRelativePath: {
      value: contentByRelative,
      type: typeof contentByRelative,
      isNull: contentByRelative === null,
      length: contentByRelative?.length ?? null,
    },
    readByAbsolutePath: {
      value: contentByAbsolute === null ? null : "(non-null)",
      type: typeof contentByAbsolute,
      isNull: contentByAbsolute === null,
    },

    // Expected: isNull: false, length: <file size in bytes>
    // Actual:   isNull: true
  };
};

module.exports = { handler };
