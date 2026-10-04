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
const ENC = new TextEncoder()
const require = createRequire(import.meta.url)
const INDEX_LOCKED = "fatal: Unable to create '/repo/.git/index.lock': Read-only file system\n"

let parser: ShellParser
let fixture: string

beforeAll(async () => {
  parser = await createShellParser({
    engineWasm: readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm')),
    grammarWasm: readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm')),
  })
  fixture = join(mkdtempSync(join(tmpdir(), 'mirage-git-session-')), 'repo')
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

/** The fixture behind a read-only mount, with `side` and `extra` written first. */
async function readOnly(extra: Record<string, string> = {}): Promise<Workspace> {
  const ram = new RAMVFS()
  const writer = new Workspace({ '/repo': ram }, { mode: MountMode.WRITE, shellParser: parser })
  await load(writer, fixture)
  const head = readFileSync(join(fixture, '.git/refs/heads/main'))
  await writer.dispatch('write', '/repo/.git/refs/heads/side', [head])
  for (const [path, text] of Object.entries(extra))
    await writer.dispatch('write', `/repo/${path}`, [ENC.encode(text)])
  const ws = new Workspace({ '/repo': ram }, { mode: MountMode.READ, shellParser: parser })
  ws.registerCli('git', GIT)
  return ws
}

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const result = await ws.shell(`git -C /repo ${line}`)
  return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
}

it.each([
  [
    'branch newb',
    128,
    "fatal: cannot lock ref 'refs/heads/newb': Unable to create " +
      "'/repo/.git/refs/heads/newb.lock': Read-only file system\n",
  ],
  [
    'branch -D side',
    1,
    "error: could not delete reference refs/heads/side: cannot lock ref 'refs/heads/side': " +
      "Unable to create '/repo/.git/refs/heads/side.lock': Read-only file system\n",
  ],
  [
    'tag t9',
    128,
    "fatal: cannot lock ref 'refs/tags/t9': Unable to create " +
      "'/repo/.git/refs/tags/t9.lock': Read-only file system\n",
  ],
  [
    'tag -a t10 -m x',
    128,
    'error: unable to create temporary file: Read-only file system\n' +
      'error: unable to write tag file\n' +
      'The tag message has been left in .git/TAG_EDITMSG\n',
  ],
  [
    'symbolic-ref HEAD refs/heads/side',
    1,
    "error: cannot lock ref 'HEAD': Unable to create '/repo/.git/HEAD.lock': " +
      'Read-only file system\n',
  ],
  [
    'switch -c sw',
    128,
    "fatal: cannot lock ref 'refs/heads/sw': Unable to create " +
      "'/repo/.git/refs/heads/sw.lock': Read-only file system\n",
  ],
  ['checkout -q side', 128, INDEX_LOCKED],
  ['commit --allow-empty -m x', 128, INDEX_LOCKED],
  ['add letters.txt', 128, INDEX_LOCKED],
  [
    'clone /repo /repo/clone',
    128,
    "fatal: could not create work tree dir '/repo/clone': Read-only file system\n",
  ],
])('a read-only mount is refused in git words: %s', async (line, code, stderr) => {
  const [exit, , err] = await run(await readOnly(), line)
  expect([exit, err]).toEqual([code, stderr])
})

it('warns of an ambiguous name ahead of the answer', async () => {
  const head = readFileSync(join(fixture, '.git/refs/heads/main'), 'utf8')
  const ws = await readOnly({ '.git/refs/tags/main': head })
  expect(await run(ws, 'rev-parse main')).toEqual([
    0,
    head,
    "warning: refname 'main' is ambiguous.\n",
  ])
  expect(await run(ws, 'rev-parse -q main')).toEqual([0, head, ''])
  const quiet = await readOnly({
    '.git/refs/tags/main': head,
    '.git/config': `${readFileSync(join(fixture, '.git/config'), 'utf8')}[core]\n\twarnAmbiguousRefs = false\n`,
  })
  expect(await run(quiet, 'rev-parse main')).toEqual([0, head, ''])
})
