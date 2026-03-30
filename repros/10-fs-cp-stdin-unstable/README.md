# Repro #10 — `db9 fs cp /dev/stdin` intermittently fails on macOS

## Summary

Piping data into `db9 fs cp /dev/stdin <db>:/path/to/file` occasionally fails with a
connection-refused error on macOS, making shell pipeline uploads unreliable.

## Steps to reproduce

```bash
DB=myapp   # replace with your database alias
FUNC_ID=<your-function-id>

# Run multiple times — some invocations succeed, some fail
for i in $(seq 1 10); do
  echo "test content $i" | db9 fs cp /dev/stdin "$DB:/functions/$FUNC_ID/test-$i.txt" 2>&1
done

# Typical output mix:
# /dev/stdin -> /functions/<id>/test-1.txt (18 bytes)          ← success
# /dev/stdin -> /functions/<id>/test-2.txt (18 bytes)          ← success
# cp: /functions/<id>/test-3.txt: connection error: IO error: Connection refused (os error 61)  ← failure
# /dev/stdin -> /functions/<id>/test-4.txt (18 bytes)          ← success
```

## Environment

- OS: macOS 15.x (Darwin 25.1.0)
- Shell: zsh
- db9 CLI version: (check with `db9 --version`)

## Expected behavior

`db9 fs cp /dev/stdin` should reliably upload stdin content on every invocation.

## Notes

- Failure rate is roughly 10–30% in testing, non-deterministic.
- Does not appear to be related to file size (fails even for tiny files like `echo "x"`).
- Regular file uploads (`db9 fs cp local_file.txt <db>:/path/`) appear stable.
- Workaround: retry on failure, or write stdin to a temp file first:
  ```bash
  TMP=$(mktemp)
  cat > "$TMP"
  db9 fs cp "$TMP" "$DB:/functions/$FUNC_ID/file.txt"
  rm "$TMP"
  ```
