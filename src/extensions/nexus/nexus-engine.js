/**
 * @module extensions/nexus/nexus-engine
 * Bridge engine connecting KruschContext to the sovereign KruschNexus service.
 * Exposes universal document ingestion, workspace isolation, physical page citations,
 * and character-span verification with resilient offline error handling.
 */

import fs from 'node:fs';
import path from 'node:path';

function getNexusHost() {
  return process.env.NEXUS_API_URL || process.env.NEXUS_URL || 'http://127.0.0.1:8000';
}

function getNexusToken() {
  return process.env.NEXUS_API_TOKEN || '';
}

/**
 * Internal helper to query KruschNexus FastAPI endpoints.
 * @param {string} endpoint 
 * @param {RequestInit} [options={}] 
 * @param {string} [tokenOverride]
 * @returns {Promise<any>}
 */
async function fetchNexus(endpoint, options = {}, tokenOverride = null) {
  const host = getNexusHost();
  const url = `${host}${endpoint}`;
  const token = tokenOverride || getNexusToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}`, 'X-API-Token': token } : {}),
    ...options.headers
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
    const response = await fetch(url, { ...options, headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`[KruschNexus HTTP ${response.status}] ${errorText}`);
    }
    return await response.json();
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.name === 'AbortError' || err.message.includes('fetch failed')) {
      throw new Error(
        `KruschNexus service is unreachable at ${host}. Ensure KruschNexus backend is running (docker compose up -d or uvicorn krusch_nexus.api:app --port 8000).`
      );
    }
    throw err;
  }
}


/**
 * Lists document workspaces and indexed document counts.
 * @param {Object} [args={}]
 * @param {string} [args.token]
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function listWorkspaces({ token } = {}) {
  try {
    const data = await fetchNexus('/v1/workspaces', { method: 'GET' }, token);
    
    if (!Array.isArray(data) || data.length === 0) {
      return {
        content: [{ type: "text", text: "No document workspaces found in KruschNexus." }]
      };
    }

    const rows = data.map((w, i) => (
      `| ${i + 1} | **${w.name}** | ${w.doc_count || 0} | ${w.chunk_count || 0} | ${w.last_active_at ? new Date(w.last_active_at).toLocaleDateString() : 'N/A'} |`
    )).join('\n');

    const formatted = 
      `### 🗂️ KruschNexus Document Workspaces (${data.length} registered)\n\n` +
      `| # | Workspace Name | Documents | Chunks | Last Active |\n` +
      `|---|---|---|---|---|\n` +
      `${rows}\n\n` +
      `*Tip*: Specify \`workspace_name\` when ingesting files or searching the corpus.`;

    return {
      content: [{ type: "text", text: formatted }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error listing KruschNexus workspaces: ${err.message}` }]
    };
  }
}

/**
 * Lists ingested documents within a specific workspace or across authorized workspaces.
 * @param {Object} args
 * @param {string} [args.workspace_name] - Target workspace
 * @param {string} [args.token]
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function listDocuments({ workspace_name, token } = {}) {
  try {
    const endpoint = workspace_name 
      ? `/v1/documents?workspace=${encodeURIComponent(workspace_name.trim())}`
      : '/v1/documents';
    const data = await fetchNexus(endpoint, { method: 'GET' }, token);

    if (!Array.isArray(data) || data.length === 0) {
      return {
        content: [{ 
          type: "text", 
          text: workspace_name 
            ? `No documents found in workspace '${workspace_name}'.` 
            : `No documents indexed in KruschNexus.` 
        }]
      };
    }

    const items = data.map((d, i) => (
      `**[${i + 1}] ID #${d.id} — ${d.filename}**\n` +
      `- **Workspace**: \`${d.workspace}\` | **Type**: \`${d.doc_type || 'general'}\`\n` +
      `- **Pages**: ${d.page_count || 1} | **Chunks**: ${d.chunk_count || 0} | **OCR Applied**: ${d.has_ocr ? '✅ Yes' : 'No'}\n` +
      `- **SHA-256**: \`${(d.sha256 || '').slice(0, 16)}...\`\n` +
      `- **Indexed**: ${d.created_at ? new Date(d.created_at).toLocaleString() : 'N/A'}`
    )).join('\n\n---\n\n');

    return {
      content: [{
        type: "text",
        text: `### 📄 KruschNexus Indexed Documents (${data.length} found)\n\n${items}`
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error listing KruschNexus documents: ${err.message}` }]
    };
  }
}

/**
 * Searches the corpus with physical page citations and character span offsets.
 * @param {Object} args
 * @param {string} args.query - Natural language inquiry or keywords
 * @param {string} args.workspace_name - Target workspace name
 * @param {string} [args.doc_type] - Document classification filter
 * @param {number} [args.limit=5] - Top chunks to return
 * @param {number} [args.page] - Physical page number predicate
 * @param {number} [args.doc_id] - Document ID predicate
 * @param {string} [args.filename] - Source filename predicate
 * @param {string} [args.token]
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function searchCorpus({ query, workspace_name, doc_type, limit = 5, page, doc_id, filename, token } = {}) {
  if (!query || !query.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Missing required 'query' parameter." }]
    };
  }
  if (!workspace_name || !workspace_name.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "workspace_name is required. Cross-contamination defaults are disallowed." }]
    };
  }

  const payload = {
    query: query.trim(),
    filter: {
      workspace: workspace_name.trim(),
      ...(doc_type ? { doc_type } : {}),
      ...(page !== undefined && page !== null ? { page: Number(page) } : {}),
      ...(doc_id !== undefined && doc_id !== null ? { doc_id: Number(doc_id) } : {}),
      ...(filename ? { filename } : {})
    },
    limit: Math.min(20, Math.max(1, limit))
  };

  try {
    const hits = await fetchNexus('/v1/search', {
      method: 'POST',
      body: JSON.stringify(payload)
    }, token);

    if (!Array.isArray(hits) || hits.length === 0) {
      return {
        content: [{
          type: "text",
          text: `No citation-grounded chunks found matching "${query}" in workspace '${workspace_name}'.`
        }]
      };
    }

    const formatted = hits.map((h, i) => {
      const pageInfo = h.physical_page !== undefined ? `Page ${h.physical_page}` : (h.page_number ? `Page ${h.page_number}` : 'Page N/A');
      const offsetInfo = (h.char_start !== undefined && h.char_end !== undefined)
        ? ` | Spans: [${h.char_start}-${h.char_end}]`
        : '';
      const rrfInfo = h.rrf_score !== undefined
        ? ` | RRF: ${(h.rrf_score).toFixed(4)}`
        : (h.score !== undefined ? ` | Score: ${(h.score).toFixed(4)}` : '');

      return (
        `### [${i + 1}] 📌 ${h.citation || `${h.filename} (${pageInfo})`}\n` +
        `**Source**: \`${h.filename}\` | **${pageInfo}**${offsetInfo}${rrfInfo}\n` +
        `\`\`\`text\n${(h.content || h.text || '').trim()}\n\`\`\``
      );
    }).join('\n\n---\n\n');

    return {
      content: [{
        type: "text",
        text: `## 🔍 KruschNexus Cited Hits (${hits.length} retrieved | Workspace: \`${workspace_name}\`)\n\n${formatted}`
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error searching KruschNexus corpus: ${err.message}` }]
    };
  }
}

/**
 * Retrieves the Ingest Report for a document by its database ID or SHA-256 hash.
 * @param {Object} args
 * @param {string|number} args.doc_id_or_hash
 * @param {string} [args.token]
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function getIngestReport({ doc_id_or_hash, token } = {}) {
  if (!doc_id_or_hash) {
    return {
      isError: true,
      content: [{ type: "text", text: "Missing required 'doc_id_or_hash' parameter." }]
    };
  }

  try {
    const data = await fetchNexus(`/v1/documents/${encodeURIComponent(String(doc_id_or_hash).trim())}/report`, {
      method: 'GET'
    }, token);

    return {
      content: [{
        type: "text",
        text: `### 📋 KruschNexus Ingest Report: ${data.filename || doc_id_or_hash}\n\n` +
              `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error fetching ingest report: ${err.message}` }]
    };
  }
}

/**
 * Ingests a local document into the KruschNexus corpus.
 * @param {Object} args
 * @param {string} args.file_path - Filesystem path to document
 * @param {string} args.workspace_name - Target workspace name
 * @param {string} [args.doc_type='general'] - Classification category
 * @param {boolean} [args.archive=false] - Whether to archive upon indexing
 * @param {string} [args.token]
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function ingestFile({ file_path, workspace_name, doc_type = 'general', archive = false, token } = {}) {
  if (!file_path || !file_path.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Missing required 'file_path' parameter." }]
    };
  }
  if (!workspace_name || !workspace_name.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "workspace_name is required. Cross-contamination defaults are disallowed." }]
    };
  }

  const resolvedPath = path.resolve(file_path.trim());
  if (!fs.existsSync(resolvedPath)) {
    return {
      isError: true,
      content: [{ type: "text", text: `File not found at path: ${resolvedPath}` }]
    };
  }

  try {
    const fileBuffer = fs.readFileSync(resolvedPath);
    const fileName = path.basename(resolvedPath);
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), fileName);
    formData.append('workspace', workspace_name.trim());
    formData.append('doc_type', doc_type);
    formData.append('archive', String(archive));

    const response = await fetch(`${getNexusHost()}/v1/ingest`, {
      method: 'POST',
      body: formData,
      headers: {
        ...(token || getNexusToken() ? { 'Authorization': `Bearer ${token || getNexusToken()}` } : {})
      }
    });


    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`[HTTP ${response.status}] ${errText}`);
    }

    const report = await response.json();

    return {
      content: [{
        type: "text",
        text: `### ✅ KruschNexus Ingestion Complete\n\n` +
              `- **Document ID**: #${report.doc_id || report.id}\n` +
              `- **File**: \`${report.filename || fileName}\`\n` +
              `- **Workspace**: \`${report.workspace || workspace_name}\`\n` +
              `- **Pages Processed**: ${report.page_count || 1}\n` +
              `- **Chunks Indexed**: ${report.chunk_count || 0}\n` +
              `- **OCR Applied**: ${report.ocr_applied ? '✅ Yes' : 'No'}\n` +
              `- **Status**: \`${report.status || 'indexed'}\`\n` +
              `- **SHA-256**: \`${(report.sha256 || '').slice(0, 16)}...\``
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error ingesting document into KruschNexus: ${err.message}` }]
    };
  }
}

/**
 * Verifies a discrete character span offset or citation claim against the physical document in the corpus.
 * @param {Object} args
 * @param {string} args.workspace_name - Target workspace
 * @param {string} args.query - Text query or assertion to verify
 * @param {number} [args.physical_page] - Target page number
 * @param {number} [args.char_start] - Expected character start
 * @param {number} [args.char_end] - Expected character end
 * @param {string} [args.token]
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function verifySpan({ workspace_name, query, physical_page, char_start, char_end, token } = {}) {
  if (!workspace_name || !query) {
    return {
      isError: true,
      content: [{ type: "text", text: "workspace_name and query are required for span verification." }]
    };
  }

  try {
    const searchRes = await fetchNexus('/v1/search', {
      method: 'POST',
      body: JSON.stringify({
        query: query.trim(),
        filter: {
          workspace: workspace_name.trim(),
          ...(physical_page !== undefined && physical_page !== null ? { page: Number(physical_page) } : {})
        },
        limit: 3
      })
    }, token);

    if (!Array.isArray(searchRes) || searchRes.length === 0) {
      return {
        content: [{
          type: "text",
          text: `🛑 **UNVERIFIED SPAN**: No matching text found in workspace '${workspace_name}' on page ${physical_page || 'any'}.`
        }]
      };
    }

    const topHit = searchRes[0];
    const hitText = topHit.content || topHit.text || '';
    const hasSubstring = hitText.toLowerCase().includes(query.trim().toLowerCase());

    const resultReport = {
      verified: hasSubstring,
      document_id: topHit.document_id || topHit.doc_id,
      filename: topHit.filename,
      physical_page: topHit.physical_page || topHit.page_number,
      citation: topHit.citation,
      char_start: topHit.char_start,
      char_end: topHit.char_end,
      exact_match: hasSubstring,
      corpus_snippet: hitText.slice(0, 300)
    };

    return {
      content: [{
        type: "text",
        text: `### 🛡️ KruschNexus Citation Span Audit\n\n` +
              `- **Verdict**: ${hasSubstring ? '✅ VERIFIED SPAN' : '⚠️ PARTIAL / CONTEXTUAL ONLY'}\n` +
              `- **Document**: \`${resultReport.filename}\` (ID #${resultReport.document_id})\n` +
              `- **Physical Page**: ${resultReport.physical_page}\n` +
              `- **Citation**: ${resultReport.citation || 'N/A'}\n` +
              `- **Corpus Excerpt**:\n\`\`\`text\n${resultReport.corpus_snippet}\n\`\`\``
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error verifying citation span: ${err.message}` }]
    };
  }
}
