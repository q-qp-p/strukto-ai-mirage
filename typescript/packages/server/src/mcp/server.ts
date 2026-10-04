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

import { VERSION } from '@struktoai/mirage-core/version'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import {
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
  type ToolAnnotations,
} from '@modelcontextprotocol/server'
import {
  EDIT_DESCRIPTION,
  EDIT_INPUT,
  GLOB_DESCRIPTION,
  GLOB_INPUT,
  GREP_DESCRIPTION,
  GREP_INPUT,
  LS_DESCRIPTION,
  LS_INPUT,
  READ_DESCRIPTION,
  READ_INPUT,
  SHELL_DESCRIPTION,
  SHELL_INPUT,
  WRITE_DESCRIPTION,
  WRITE_INPUT,
} from '@struktoai/mirage-agents/tool_descriptions'
import {
  MirageToolOperations,
  type MirageToolOperationsOptions,
} from '@struktoai/mirage-agents/tool_operations'

const READ_ONLY: ToolAnnotations = { readOnlyHint: true }

/** The tools every door serves, in the order a client lists them. */
export const TOOLS: readonly {
  name: string
  description: string
  inputSchema: JsonSchemaType
  annotations?: ToolAnnotations
}[] = [
  {
    name: 'shell',
    description: SHELL_DESCRIPTION,
    inputSchema: SHELL_INPUT as JsonSchemaType,
  },
  {
    name: 'read',
    description: READ_DESCRIPTION,
    annotations: READ_ONLY,
    inputSchema: READ_INPUT as JsonSchemaType,
  },
  {
    name: 'write',
    description: WRITE_DESCRIPTION,
    inputSchema: WRITE_INPUT as JsonSchemaType,
  },
  {
    name: 'edit',
    description: EDIT_DESCRIPTION,
    inputSchema: EDIT_INPUT as JsonSchemaType,
  },
  {
    name: 'ls',
    description: LS_DESCRIPTION,
    annotations: READ_ONLY,
    inputSchema: LS_INPUT as JsonSchemaType,
  },
  {
    name: 'grep',
    description: GREP_DESCRIPTION,
    annotations: READ_ONLY,
    inputSchema: GREP_INPUT as JsonSchemaType,
  },
  {
    name: 'glob',
    description: GLOB_DESCRIPTION,
    annotations: READ_ONLY,
    inputSchema: GLOB_INPUT as JsonSchemaType,
  },
]

export interface MirageMcpServerOptions extends MirageToolOperationsOptions {
  name?: string
  version?: string
  /**
   * The tool table to serve, built from the workspace and these options
   * when absent. The HTTP door builds a server per request around one
   * table, so the read a request stamps guards the next request's edit.
   */
  operations?: MirageToolOperations
}

export function createMirageMcpServer(
  workspace: Workspace,
  options: MirageMcpServerOptions = {},
): McpServer {
  const operations = options.operations ?? new MirageToolOperations(workspace, options)
  const server = new McpServer({
    name: options.name ?? 'mirage',
    version: options.version ?? VERSION,
  })
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      },
      (args, ctx) => operations.call(tool.name, args, ctx.mcpReq.signal),
    )
  }
  return server
}
