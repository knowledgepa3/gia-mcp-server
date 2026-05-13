/**
 * @module    index
 * @layer     TRANSPORT
 * @inherits  governance-root
 * @mai       N/A — entry point, no governed operations
 * @audit     false
 * @owner     William J. Storey III / ACE / GIA
 *
 * GIA MCP Server — package entry point.
 * Launches the stdio transport (used by Claude Desktop, Glama, and other
 * MCP hosts that invoke the server as a subprocess via the bin entry).
 *
 * For the HTTP transport (production deployment), use server-http.ts directly.
 */

// Re-export the stdio server — this is what `bin/gia-mcp-server.js` loads.
export * from './mcp/server.js';
