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

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { createShellParser, type ShellParser } from '../../../../shell/parse/index.ts'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'

const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/build.sh', import.meta.url),
)
const DEC = new TextDecoder()
const require = createRequire(import.meta.url)

let parser: ShellParser
let fixture: string

beforeAll(async () => {
  parser = await createShellParser({
    engineWasm: readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')),
    grammarWasm: readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
  })
  fixture = join(mkdtempSync(join(tmpdir(), 'mirage-symbolic-ref-')), 'repo')
  execFileSync('bash', [BUILDER, fixture], { stdio: 'ignore' })
})

afterAll(() => {
  rmSync(dirname(fixture), { recursive: true, force: true })
})

async function load(ws: Workspace, root: string, relative = ''): Promise<void> {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await ws.shell(`mkdir -p /repo/${name}`)
      await load(ws, root, name)
    } else await ws.dispatch('write', `/repo/${name}`, [readFileSync(join(root, name))])
  }
}

async function workspace(mode: MountMode = MountMode.WRITE): Promise<Workspace> {
  const ram = new RAMVFS()
  const writer = new Workspace({ '/repo': ram }, { mode: MountMode.WRITE, shellParser: parser })
  await load(writer, fixture)
  const ws =
    mode === MountMode.WRITE
      ? writer
      : new Workspace({ '/repo': ram }, { mode, shellParser: parser })
  ws.registerCli('git', GIT)
  return ws
}

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const result = await ws.shell(`git -C /repo ${line}`)
  return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
}

async function cat(ws: Workspace, path: string): Promise<string> {
  return DEC.decode((await ws.shell(`cat /repo/.git/${path}`)).stdout)
}

async function logLines(ws: Workspace, path: string): Promise<string[]> {
  return (await cat(ws, `logs/${path}`)).split('\n').filter(Boolean)
}

async function exists(ws: Workspace, path: string): Promise<boolean> {
  return (await ws.shell(`test -e /repo/.git/${path}`)).exitCode === 0
}

it('reads where HEAD points', async () => {
  const ws = await workspace(MountMode.READ)
  expect(await run(ws, 'symbolic-ref HEAD')).toEqual([0, 'refs/heads/main\n', ''])
  expect(await run(ws, 'symbolic-ref --short HEAD')).toEqual([0, 'main\n', ''])
})

it('refuses a ref holding an id, or quietly exits 1', async () => {
  const ws = await workspace(MountMode.READ)
  expect(await run(ws, 'symbolic-ref refs/heads/main')).toEqual([
    128,
    '',
    'fatal: ref refs/heads/main is not a symbolic ref\n',
  ])
  expect(await run(ws, 'symbolic-ref -q refs/heads/main')).toEqual([1, '', ''])
})

it('logs a line with no message when pointing HEAD', async () => {
  const ws = await workspace()
  const before = (await logLines(ws, 'HEAD')).length
  expect(await run(ws, 'symbolic-ref HEAD refs/heads/topic')).toEqual([0, '', ''])
  expect(await cat(ws, 'HEAD')).toBe('ref: refs/heads/topic\n')
  const lines = await logLines(ws, 'HEAD')
  expect(lines).toHaveLength(before + 1)
  expect(lines.at(-1)).not.toContain('\t')
  expect(lines.at(-1)?.endsWith(' +0000')).toBe(true)
})

it('records a reason as the log message', async () => {
  const ws = await workspace()
  await run(ws, "symbolic-ref -m 'my msg' HEAD refs/heads/topic")
  expect((await logLines(ws, 'HEAD')).at(-1)?.endsWith('\tmy msg')).toBe(true)
  const [, short] = await run(ws, 'rev-parse --short HEAD')
  expect(await run(ws, 'reflog -1')).toEqual([0, `${short.trim()} HEAD@{0}: my msg\n`, ''])
})

it('refuses an empty reason', async () => {
  const ws = await workspace()
  expect(await run(ws, "symbolic-ref -m '' HEAD refs/heads/main")).toEqual([
    128,
    '',
    'fatal: Refusing to perform update with empty message\n',
  ])
})

it('moves HEAD to a dangling target without a log line', async () => {
  const ws = await workspace()
  const before = await logLines(ws, 'HEAD')
  expect(await run(ws, 'symbolic-ref HEAD refs/heads/unborn')).toEqual([0, '', ''])
  expect(await run(ws, 'symbolic-ref HEAD')).toEqual([0, 'refs/heads/unborn\n', ''])
  expect(await logLines(ws, 'HEAD')).toEqual(before)
})

it('logs only branch, remote and notes refs', async () => {
  const ws = await workspace()
  await run(ws, 'symbolic-ref refs/heads/sym refs/heads/main')
  await run(ws, 'symbolic-ref refs/other refs/heads/main')
  const sym = await logLines(ws, 'refs/heads/sym')
  expect(sym).toHaveLength(1)
  expect(sym[0]?.startsWith('0'.repeat(40))).toBe(true)
  expect(await exists(ws, 'logs/refs/other')).toBe(false)
})

it('lets core.logAllRefUpdates decide which refs are logged', async () => {
  const ws = await workspace()
  await ws.shell("printf '[core]\\n\\tlogAllRefUpdates = always\\n' >> /repo/.git/config")
  await run(ws, 'symbolic-ref refs/other refs/heads/main')
  expect(await logLines(ws, 'refs/other')).toHaveLength(1)
  await ws.shell("printf '[core]\\n\\tlogAllRefUpdates = false\\n' >> /repo/.git/config")
  await run(ws, 'symbolic-ref refs/heads/sym refs/heads/main')
  expect(await exists(ws, 'logs/refs/heads/sym')).toBe(false)
})

it('follows the chain unless told not to', async () => {
  const ws = await workspace()
  await run(ws, 'symbolic-ref refs/x refs/y')
  await run(ws, 'symbolic-ref refs/y refs/heads/main')
  expect(await run(ws, 'symbolic-ref refs/x')).toEqual([0, 'refs/heads/main\n', ''])
  expect(await run(ws, 'symbolic-ref --no-recurse refs/x')).toEqual([0, 'refs/y\n', ''])
  expect(await run(ws, 'symbolic-ref --no-recurse --recurse refs/x')).toEqual([
    0,
    'refs/heads/main\n',
    '',
  ])
})

it('answers a cycle as no such ref', async () => {
  const ws = await workspace()
  await run(ws, 'symbolic-ref CYCLE_A CYCLE_B')
  await run(ws, 'symbolic-ref CYCLE_B CYCLE_A')
  expect(await run(ws, 'symbolic-ref CYCLE_A')).toEqual([128, '', 'fatal: No such ref: CYCLE_A\n'])
})

it('deletes the ref and its log, never HEAD', async () => {
  const ws = await workspace()
  await run(ws, 'symbolic-ref refs/heads/sym refs/heads/main')
  expect(await run(ws, 'symbolic-ref -d refs/heads/sym')).toEqual([0, '', ''])
  expect(await exists(ws, 'refs/heads/sym')).toBe(false)
  expect(await exists(ws, 'logs/refs/heads/sym')).toBe(false)
  expect(await run(ws, 'symbolic-ref -d HEAD')).toEqual([
    128,
    '',
    "fatal: deleting 'HEAD' is not allowed\n",
  ])
  expect(await run(ws, 'symbolic-ref -d -q refs/heads/main')).toEqual([
    128,
    '',
    'fatal: Cannot delete refs/heads/main, not a symbolic ref\n',
  ])
})

it.each([
  ['symbolic-ref HEAD main', 128, 'fatal: Refusing to point HEAD outside of refs/\n'],
  [
    'symbolic-ref HEAD refs/heads/../x',
    128,
    "fatal: Refusing to set 'HEAD' to invalid ref 'refs/heads/../x'\n",
  ],
  [
    'symbolic-ref lower refs/heads/main',
    1,
    "error: refusing to update ref with bad name 'lower'\n",
  ],
  [
    'symbolic-ref refs/heads/main/x refs/heads/main',
    1,
    "error: cannot lock ref 'refs/heads/main/x': 'refs/heads/main' exists; cannot create 'refs/heads/main/x'\n",
  ],
])('leaves HEAD alone when it refuses: %s', async (line, code, stderr) => {
  const ws = await workspace()
  expect(await run(ws, line)).toEqual([code, '', stderr])
  expect(await cat(ws, 'HEAD')).toBe('ref: refs/heads/main\n')
})

it('prints the usage for a wrong operand count', async () => {
  const ws = await workspace(MountMode.READ)
  const [code, out, err] = await run(ws, 'symbolic-ref a b c')
  expect([code, out]).toEqual([129, ''])
  expect(err.startsWith('usage: git symbolic-ref [-m <reason>] <name> <ref>\n')).toBe(true)
  expect(err.endsWith('    -m <reason>           reason of the update\n\n')).toBe(true)
})

it('is refused by a read-only mount', async () => {
  const ws = await workspace(MountMode.READ)
  const [code] = await run(ws, 'symbolic-ref HEAD refs/heads/topic')
  expect(code).toBe(1)
  expect(await cat(ws, 'HEAD')).toBe('ref: refs/heads/main\n')
})
