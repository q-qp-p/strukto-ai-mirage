# pyodide

What only Pyodide has. TypeScript host only.

| File           | Pins                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `mounts.json`  | no mount preload; the cwd falls back without a root mount                                          |
| `streams.json` | a JSON tool closes its output; output after memory growth (also read by `pyodide_streams.test.ts`) |
| `env.json`     | each command's environment stays its own                                                           |
| `errors.json`  | user tracebacks                                                                                    |
| `invoke.json`  | a script file names the program; flags and import paths are scoped; `-O` reaches imported modules  |
