/**
 * MCP transport helpers for claude-tg-plugin.
 *
 * Provides connectStdio() — the only transport used for Claude plugin integration.
 *
 * INVARIANT: no console.log — stdout is JSON-RPC (MCP transport).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

/**
 * Connect an MCP Server to Claude via stdio (JSON-RPC over stdin/stdout).
 * This is the required transport for Claude Code plugin integration.
 */
export async function connectStdio(server: Server): Promise<void> {
  await server.connect(new StdioServerTransport())
}
