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

import { Buffer } from 'node:buffer'

export const MAX_REQUEST_PART = 1024 * 1024
const MAX_HEADER_COUNT = 8
const MAX_HEADER_SIZE = 4096 + 128

/** A body refused with the status it is answered with. */
export class MultipartError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

export type PartEvent =
  | { kind: 'begin'; name: string }
  | { kind: 'data'; data: Uint8Array }
  | { kind: 'end' }

/** A parameter of a header value, as `boundary` of a `Content-Type`. */
function headerParam(value: string, name: string): string | undefined {
  for (const param of value.split(';').slice(1)) {
    const eq = param.indexOf('=')
    if (eq >= 0 && param.slice(0, eq).trim().toLowerCase() === name) {
      return param
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1')
    }
  }
  return undefined
}

/**
 * A multipart body as part events, parsed as it arrives. A part begins
 * once its headers end, before any of its data, and its data goes out as
 * it comes; only bytes that may open the next boundary wait for the next
 * chunk.
 */
class Parts {
  private static readonly CR = 0x0d
  private static readonly DASH = 0x2d
  private static readonly CRLF = Buffer.from('\r\n')
  private static readonly HEADERS_END = Buffer.from('\r\n\r\n')

  private state: 'preamble' | 'boundary' | 'headers' | 'data' | 'end' = 'preamble'
  private pending: Buffer = Parts.CRLF
  private readonly delimiter: Buffer

  constructor(boundary: string) {
    this.delimiter = Buffer.from(`\r\n--${boundary}`)
  }

  get finished(): boolean {
    return this.state === 'end'
  }

  write(chunk: Buffer): PartEvent[] {
    const events: PartEvent[] = []
    let buf = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    for (;;) {
      if (this.state === 'end') {
        buf = Buffer.alloc(0)
        break
      }
      if (this.state === 'boundary') {
        if (buf.length < 2) break
        if (buf[0] === Parts.DASH && buf[1] === Parts.DASH) {
          this.state = 'end'
          continue
        }
        if (!buf.subarray(0, 2).equals(Parts.CRLF)) {
          throw new MultipartError(400, 'bad multipart body: no line break after a boundary')
        }
        buf = buf.subarray(2)
        this.state = 'headers'
        continue
      }
      if (this.state === 'headers') {
        const at = buf.subarray(0, 2).equals(Parts.CRLF) ? -2 : buf.indexOf(Parts.HEADERS_END)
        if (at === -1) {
          this.checkHeaders(buf.toString('latin1'))
          break
        }
        const headers = at === -2 ? '' : buf.subarray(0, at).toString('latin1')
        this.checkHeaders(headers)
        buf = buf.subarray(at === -2 ? 2 : at + Parts.HEADERS_END.length)
        events.push({ kind: 'begin', name: this.partName(headers) })
        this.state = 'data'
        continue
      }
      const at = buf.indexOf(this.delimiter)
      if (at >= 0) {
        if (this.state === 'data') {
          if (at > 0) events.push({ kind: 'data', data: buf.subarray(0, at) })
          events.push({ kind: 'end' })
        }
        buf = buf.subarray(at + this.delimiter.length)
        this.state = 'boundary'
        continue
      }
      const keep = this.held(buf)
      if (this.state === 'data' && keep < buf.length) {
        events.push({ kind: 'data', data: buf.subarray(0, buf.length - keep) })
      }
      buf = buf.subarray(buf.length - keep)
      break
    }
    this.pending = buf
    return events
  }

  /** How many trailing bytes of `buf` may be the start of the next boundary. */
  private held(buf: Buffer): number {
    for (let i = Math.max(0, buf.length - this.delimiter.length + 1); i < buf.length; i++) {
      if (
        buf[i] === Parts.CR &&
        buf.subarray(i).equals(this.delimiter.subarray(0, buf.length - i))
      ) {
        return buf.length - i
      }
    }
    return 0
  }

  /** Refuse headers past python-multipart's limits, which the Python server keeps. */
  private checkHeaders(block: string): void {
    const lines = block.split('\r\n')
    if (lines.some((line) => line.length > MAX_HEADER_SIZE)) {
      throw new MultipartError(400, 'bad multipart body: Maximum header size exceeded')
    }
    if (lines.filter((line) => line !== '').length > MAX_HEADER_COUNT) {
      throw new MultipartError(400, 'bad multipart body: Maximum header count exceeded')
    }
  }

  private partName(headers: string): string {
    for (const line of headers.split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon >= 0 && line.slice(0, colon).trim().toLowerCase() === 'content-disposition') {
        return headerParam(line.slice(colon + 1), 'name') ?? ''
      }
    }
    return ''
  }
}

/**
 * A multipart body's part events, as the body arrives. A part begins
 * once its headers end, before any of its data, and its data goes out
 * chunk by chunk, so a reader can act on a part while it is still
 * uploading.
 *
 * @throws MultipartError 400 for a body without a boundary, a malformed
 *   one, or one that stops before its closing boundary.
 */
export async function* partEvents(
  source: AsyncIterable<Buffer>,
  contentType: string,
): AsyncGenerator<PartEvent> {
  const boundary = headerParam(contentType, 'boundary')
  if (boundary === undefined || boundary === '') {
    throw new MultipartError(400, 'multipart body without a boundary')
  }
  const parts = new Parts(boundary)
  for await (const chunk of source) yield* parts.write(chunk)
  if (!parts.finished) throw new MultipartError(400, 'multipart body ended early')
}
