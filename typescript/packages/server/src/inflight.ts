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

import type { JsonValue } from '@struktoai/mirage-core/types'

/** The JSON-RPC messages a request body carries, one or a batch. */
export function rpcMessages(body: unknown): Record<string, unknown>[] {
  const items: unknown[] = Array.isArray(body) ? body : [body]
  return items.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  )
}

/**
 * Calls still running, so a cancel that arrives on another request
 * reaches them. A stateless endpoint answers each HTTP request on its
 * own, so a client's cancel (MCP's `notifications/cancelled`, RPC's
 * `$/cancelRequest`) comes in on a request of its own. Calls are keyed by
 * the workspace, the session and the request id the client chose.
 */
export class InFlight {
  private readonly running = new Map<string, () => void>()

  static key(workspaceId: string, sessionId: string, requestId: JsonValue | undefined): string {
    return JSON.stringify([workspaceId, sessionId, requestId ?? null])
  }

  add(key: string, cancel: () => void): void {
    this.running.set(key, cancel)
  }

  discard(key: string): void {
    this.running.delete(key)
  }

  /** Stop a running call; false when none runs under the key. */
  cancel(key: string): boolean {
    const cancel = this.running.get(key)
    if (cancel === undefined) return false
    this.running.delete(key)
    cancel()
    return true
  }
}
