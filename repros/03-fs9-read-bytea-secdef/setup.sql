-- Repro #3 — fs9_read_bytea() ignores SECURITY DEFINER context
--
-- Run this as the database ADMIN (superuser) before deploying the function.
--
-- Creates a SECURITY DEFINER wrapper so that authenticated users (db9 functions)
-- can call read_binary_b64() without needing direct superuser access.
-- Standard PostgreSQL semantics: a SECURITY DEFINER function owned by a superuser
-- should execute with superuser privileges. fs9_read_bytea() bypasses this.

-- Step 1: Create the wrapper function as admin/superuser
CREATE OR REPLACE FUNCTION public.read_binary_b64(path TEXT)
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
-- OWNER is the superuser who runs this script
AS $$
  SELECT encode(fs9_read_bytea(path), 'base64')
$$;

-- Step 2: Grant execute to authenticated role (db9 function runtime role)
GRANT EXECUTE ON FUNCTION public.read_binary_b64(TEXT) TO authenticated;

-- Verify: as admin, calling directly should work
-- SELECT length(read_binary_b64('/functions/<id>/uploads/test.xlsx'));
