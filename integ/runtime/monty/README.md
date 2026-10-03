# monty

What only Monty has. Monty is a Python subset, so a missing module or call
here is Monty's to add upstream; the cases pin the working forms.

| File           | Pins                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `invoke.json`  | the default world, the `python` alias, file names, `-m` refused by name |
| `argv.json`    | the `argv` global, script argv, typed argv that names no mount          |
| `stdin.json`   | piped stdin                                                             |
| `env.json`     | the session environment                                                 |
| `limits.json`  | a timeout                                                               |
| `surface.json` | the CPython surface Monty lacks, what it has, `os.urandom`              |
| `policy.json`  | relative writes and script operands obey path policy                    |
