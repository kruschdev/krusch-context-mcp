/**
 * @module extensions
 * Extensions loader for krusch-context-mcp.
 * In accordance with single-product focus, companion engines (Nexus, Law, Biz)
 * live in their own independent repositories and run as separate MCP servers.
 */

export function getAvailableExtensionNames() {
  return [];
}

export function resolveExtension(_name) {
  return null;
}

export async function loadExtensions(_names = [], _pool = null) {
  return [];
}

export default {
  getAvailableExtensionNames,
  resolveExtension,
  loadExtensions
};
