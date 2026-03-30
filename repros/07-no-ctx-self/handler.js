/**
 * Repro #7 — No ctx.self metadata (function ID, run ID, etc.)
 *
 * Functions have no built-in way to know their own identity at runtime.
 * This matters for:
 *   - Constructing fs9 paths (workaround for repro #5)
 *   - Self-referencing (cron functions that reschedule themselves)
 *   - Structured logging (attaching function name / run ID to log entries)
 *   - Debugging: knowing which version/invocation produced a result
 *
 * Expected: ctx.self = { functionId, functionName, databaseId, runId, version }
 * Actual:   ctx has no .self property; workaround requires reading fs9 paths
 *           (which fails if no file was pre-uploaded — see repro #5)
 */
const handler = async (input, ctx) => {
  // Attempt 1: check ctx directly
  const ctxKeys = Object.keys(ctx);

  // Attempt 2: try common property names that might exist
  const selfAttempts = {
    "ctx.self":         ctx.self,
    "ctx.functionId":   ctx.functionId,
    "ctx.id":           ctx.id,
    "ctx.name":         ctx.name,
    "ctx.runId":        ctx.runId,
    "ctx.invocationId": ctx.invocationId,
    "ctx.meta":         ctx.meta,
    "ctx.env":          ctx.env,
  };

  // Attempt 3: fragile workaround — derive function ID from fs9 path
  let derivedFuncId = null;
  try {
    const root = await ctx.fs9.list("/");
    derivedFuncId = root[0]?.path?.match(/^\/functions\/([^/]+)\//)?.[1] ?? null;
    // Only works if at least one file has been uploaded to this function's fs9
  } catch (e) {
    derivedFuncId = `FAILED: ${e.message}`;
  }

  // Attempt 4: check environment variables
  const relevantEnv = {};
  for (const key of ["FUNCTION_ID", "FUNCTION_NAME", "DB9_FUNCTION_ID",
                      "DB9_RUN_ID", "AWS_LAMBDA_FUNCTION_NAME", "K_SERVICE"]) {
    relevantEnv[key] = process.env[key] ?? undefined;
  }

  return {
    ctxTopLevelKeys: ctxKeys,
    selfPropertyAttempts: selfAttempts,
    derivedFuncIdFromFs9: derivedFuncId,
    environmentVariables: relevantEnv,
    // Expected: ctx.self.functionId = "<uuid>", ctx.self.runId = "<run-uuid>"
    // Actual:   all undefined; workaround is fragile and requires pre-uploaded files
  };
};

module.exports = { handler };
