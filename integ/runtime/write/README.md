# write

Writes that reach a mount. Runs on monty and quickjs on both hosts, wasi on the python host and pyodide on the typescript host. A case with a `backends` list also
runs over RAM, S3 and redis.

| File         | Pins                                                                                                                        | Differs                                                                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write.json` | `write_text`, `write_bytes` and `write` reach the mount; a read-only mount refuses; a mount at `/` is served like any other | monty (ts): a read-only refusal is `OSError`, not `PermissionError`. pyodide: a read-only refusal shows only when its journal flushes at exit, and a mount at `/` is not served. quickjs (ts): `write(ArrayBuffer)` writes `[object ArrayBuffer]`, and `errorObj` stays unset |
