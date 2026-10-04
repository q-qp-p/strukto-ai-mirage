// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// diff's stdin operands and as-typed names, pinned on GNU diffutils 3.10.
// Mirrors python/tests/commands/builtin/generic/test_diff.py.

import { describe, expect, it } from 'vitest'
import { diffGeneric, switchWords } from './diff.ts'
import { UsageError } from '../../errors.ts'
import { materialize } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function operand(raw: string, virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: virtual.slice(3), rawPath: raw })
}

const DASH = operand('-', '/d/-')
const DEV_STDIN = new PathSpec({ virtual: '/dev/stdin', directory: '/dev', vfsPath: 'stdin' })
const FILE = operand('a.txt', '/d/a.txt')
const SUB = operand('sub', '/d/sub')
const SUB2 = operand('sub2', '/d/sub2')
const FILES: Record<string, string> = {
  '/d/a.txt': 'hello\n',
  '/d/sub/x': '1\n',
  '/d/sub2/x': '2\n',
  '/d/sub2/y': '3\n',
}
const DIRS: Record<string, string[]> = { '/d/sub': ['x'], '/d/sub2': ['x', 'y'] }
const MISSING = operand('gone', '/d/gone')

function read(p: PathSpec): AsyncIterable<Uint8Array> {
  return (async function* gen() {
    await Promise.resolve()
    const text = FILES[p.virtual]
    if (text === undefined) {
      throw Object.assign(new Error(p.virtual), { code: 'ENOENT', path: p.virtual })
    }
    yield ENC.encode(text)
  })()
}

function readdir(p: PathSpec): Promise<string[]> {
  return Promise.resolve(DIRS[p.virtual] ?? [])
}

function stat(p: PathSpec): Promise<FileStat> {
  const type = p.virtual in DIRS ? FileType.DIRECTORY : FileType.FILE
  return Promise.resolve(new FileStat({ name: p.virtual.split('/').pop() ?? '', type }))
}

function statOrMissing(p: PathSpec): Promise<FileStat> {
  if (p.virtual === '/d/gone') {
    return Promise.reject(Object.assign(new Error('/d/gone'), { code: 'ENOENT', path: '/d/gone' }))
  }
  return stat(p)
}

async function run(
  paths: PathSpec[],
  stdin: string | null = null,
  flags: Record<string, boolean | string[]> = {},
  argv: string[] = [],
  statOf: (p: PathSpec) => Promise<FileStat> = stat,
): Promise<[string, string, number]> {
  const opts = {
    flags,
    argv,
    stdin: stdin === null ? null : ENC.encode(stdin),
  } as unknown as CommandOpts
  const [out, io] = await diffGeneric(paths, opts, read, readdir, statOf)
  return [DEC.decode(await materialize(out)), DEC.decode(await materialize(io.stderr)), io.exitCode]
}

describe('diffGeneric with stdin', () => {
  it('names the operands as typed in unified headers', async () => {
    const [out, , code] = await run([FILE, DEV_STDIN], 'x\n', { u: true })
    expect(out.startsWith('--- a.txt\n+++ /dev/stdin\n')).toBe(true)
    expect(code).toBe(1)
  })

  it('takes two stdin operands as one file', async () => {
    const unread = (p: PathSpec): AsyncIterable<Uint8Array> => {
      throw new Error(`read ${p.virtual}`)
    }
    const opts = { flags: {}, stdin: ENC.encode('abc') } as unknown as CommandOpts
    const [out, io] = await diffGeneric([DASH, DEV_STDIN], opts, unread, readdir, stat)
    expect([out, io.exitCode]).toEqual([null, 0])
  })

  it('refuses a directory against a dash', async () => {
    expect(await run([SUB, DASH], 'x\n')).toEqual([
      '',
      "diff: cannot compare '-' to a directory\n",
      2,
    ])
  })

  it("refuses a lone operand with GNU's missing operand usage error", async () => {
    const call = run([FILE])
    await expect(call).rejects.toThrow(
      new UsageError(
        "diff: missing operand after 'a.txt'\ndiff: Try 'diff --help' for more information.",
      ),
    )
    await expect(call).rejects.toMatchObject({ exitCode: 2 })
  })

  it('names recursive children under the typed operands', async () => {
    expect(await run([SUB, SUB2], null, { recursive: true }, ['-r', 'sub', 'sub2'])).toEqual([
      'diff -r sub/x sub2/x\n1c1\n< 1\n---\n> 2\nOnly in sub2: y\n',
      '',
      1,
    ])
  })

  it('reads a missing operand as empty under -N', async () => {
    expect(await run([FILE, MISSING], null, { new_file: true }, [], statOrMissing)).toEqual([
      '1d0\n< hello\n',
      '',
      1,
    ])
  })

  it('spares only the first operand under --unidirectional-new-file', async () => {
    const flags = { unidirectional_new_file: true }
    expect(await run([MISSING, FILE], null, flags, [], statOrMissing)).toEqual([
      '0a1\n> hello\n',
      '',
      1,
    ])
    const [, err, code] = await run([FILE, MISSING], null, flags, [], statOrMissing)
    expect([err, code]).toEqual(['diff: gone: No such file or directory\n', 2])
  })

  it('reports both of two missing operands', async () => {
    const [, err, code] = await run([MISSING, MISSING], null, { new_file: true }, [], statOrMissing)
    expect([err, code]).toEqual(['diff: gone: No such file or directory\n'.repeat(2), 2])
  })

  it('diffs one-sided entries against empty under -rN', async () => {
    const flags = { recursive: true, new_file: true }
    expect(await run([SUB, SUB2], null, flags, ['-rN', 'sub', 'sub2'])).toEqual([
      'diff -rN sub/x sub2/x\n1c1\n< 1\n---\n> 2\ndiff -rN sub/y sub2/y\n0a1\n> 3\n',
      '',
      1,
    ])
  })

  it('drops excluded entries inside the walk', async () => {
    const flags = { recursive: true, exclude: ['y'] }
    expect(await run([SUB, SUB2], null, flags, ['-r', '-x', 'y'])).toEqual([
      'diff -r -x y sub/x sub2/x\n1c1\n< 1\n---\n> 2\n',
      '',
      1,
    ])
  })

  it('reports identical files under -s and exits 0', async () => {
    expect(await run([FILE, FILE], null, { report_identical_files: true })).toEqual([
      'Files a.txt and a.txt are identical\n',
      '',
      0,
    ])
  })

  it('keeps the option words as typed for the header', () => {
    expect(switchWords(['-ru', '--exclude', '.git', 'a', 'b', '-x*.log'])).toEqual([
      '-ru',
      '--exclude',
      '.git',
      '-x*.log',
    ])
    expect(switchWords(['--exclude=.git', '-r', 'a', '--', '-b'])).toEqual([
      '--exclude=.git',
      '-r',
      '--',
    ])
    expect(switchWords(['-rx', 'pat', '-U', '1', 'a', 'b'])).toEqual(['-rx', 'pat', '-U', '1'])
  })
})
