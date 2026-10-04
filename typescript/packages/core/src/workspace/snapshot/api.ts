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

import { S3Accessor } from '../../accessor/s3.ts'
import { read as readObject } from '../../core/s3/read.ts'
import { write as writeObject } from '../../core/s3/write.ts'
import { PathSpec } from '../../types.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import type { Workspace } from '../workspace/workspace.ts'
import { readFileBytes, writeFileBytes } from './fs.ts'
import { splitManifestAndBlobs } from './manifest.ts'
import { toStateDict } from './state.ts'
import { readSnapshotTar, writeSnapshotTar } from './tar_io.ts'

function keyPath(key: string): PathSpec {
  return PathSpec.fromStrPath(`/${key.replace(/^\/+/, '')}`)
}

/**
 * Serialize a workspace to a tar. With a target it goes to that file,
 * or with `s3` to that key of an S3-like store, under its `key_prefix`.
 *
 * @returns The tar's bytes.
 */
export async function snapshot(
  ws: Workspace,
  target?: string,
  options: { s3?: S3Config } = {},
): Promise<Uint8Array> {
  const state = await toStateDict(ws)
  const [manifest, blobs] = splitManifestAndBlobs(state as unknown as Record<string, unknown>)
  const tar = await writeSnapshotTar(manifest, blobs)
  if (target !== undefined && options.s3 !== undefined) {
    await writeObject(new S3Accessor(options.s3), keyPath(target), tar)
  } else if (target !== undefined) {
    await writeFileBytes(target, tar)
  }
  return tar
}

/**
 * Read a snapshot tar back into a state dict: a file, the bytes
 * themselves, or with `s3` a key of an S3-like store.
 */
export async function readSnapshot(
  source: string | Uint8Array,
  options: { s3?: S3Config } = {},
): Promise<unknown> {
  let bytes: Uint8Array
  if (typeof source !== 'string') bytes = source
  else if (options.s3 !== undefined) {
    bytes = await readObject(new S3Accessor(options.s3), keyPath(source))
  } else bytes = await readFileBytes(source)
  return readSnapshotTar(bytes)
}
