/**
 * @module extensions
 * Central extension registry and dynamic loader for krusch-context-mcp.
 * Houses companion extensions for Polygres Cloud and the Sovereign Triad (Nexus, Law, Biz).
 */

import polygresCloud from './polygres-cloud/index.js';
import semanticRouter from './semantic-router/index.js';
import law from './law/index.js';
import nexus from './nexus/index.js';
import biz from './biz/index.js';

const EXTENSIONS_REGISTRY = new Map([
  ['polygres-cloud', polygresCloud],
  ['semantic-router', semanticRouter],
  ['law', law],
  ['krusch-law', law],
  ['nexus', nexus],
  ['krusch-nexus', nexus],
  ['biz', biz],
  ['krusch-biz', biz],
  // Friendly aliases
  ['cloud', polygresCloud],
  ['router', semanticRouter],
  ['neural-router', semanticRouter],
  ['legal', law],
  ['citation', nexus],
  ['corporate', biz],
  ['commercial', biz]
]);

export function getAvailableExtensionNames() {
  return ['polygres-cloud', 'nexus', 'law', 'biz', 'semantic-router'];
}

export function resolveExtension(name) {
  const normalized = name.toLowerCase().trim();
  return EXTENSIONS_REGISTRY.get(normalized) || null;
}

export async function loadExtensions(names = [], pool = null) {
  const loaded = [];
  const requested = Array.isArray(names) ? names : names.split(',').map(s => s.trim()).filter(Boolean);
  
  const toLoad = requested.includes('all') 
    ? getAvailableExtensionNames()
    : requested;

  for (const name of toLoad) {
    const ext = resolveExtension(name);
    if (!ext) {
      console.error(`[krusch-context-mcp] Warning: Unknown extension '${name}' requested. Available: ${getAvailableExtensionNames().join(', ')}`);
      continue;
    }
    if (ext.init && pool) {
      try {
        await ext.init(pool);
      } catch (err) {
        console.error(`[krusch-context-mcp] Error initializing extension '${ext.name}':`, err.message);
      }
    }
    loaded.push(ext);
  }

  return loaded;
}

export default {
  registry: EXTENSIONS_REGISTRY,
  getAvailableExtensionNames,
  resolveExtension,
  loadExtensions
};
