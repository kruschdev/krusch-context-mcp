/**
 * @module extensions/law/law-engine
 * Bridge engine connecting KruschContext to the sovereign KruschLaw service.
 * Supports air-gapped local queries, brief staging with assertion grounding,
 * and resilient offline error handling.
 */

import { getProjectDb } from '../../sqlite-engine.js';

const KRUSCHLAW_HOST = process.env.KRUSCHLAW_API_URL || 'http://127.0.0.1:8085';
const KRUSCHLAW_KEY = process.env.KRUSCHLAW_API_KEY || '';

/**
 * Internal helper to query KruschLaw FastAPI endpoints.
 * @param {string} endpoint 
 * @param {RequestInit} [options={}] 
 * @returns {Promise<any>}
 */
async function fetchKruschLaw(endpoint, options = {}) {
  const url = `${KRUSCHLAW_HOST}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(KRUSCHLAW_KEY ? { 'X-API-Key': KRUSCHLAW_KEY } : {}),
    ...options.headers
  };

  try {
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`[KruschLaw HTTP ${response.status}] ${errorText}`);
    }
    return await response.json();
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed')) {
      throw new Error(
        `KruschLaw service is unreachable at ${KRUSCHLAW_HOST}. Ensure KruschLaw backend is running (docker compose up -d or uvicorn src.backend.main:app).`
      );
    }
    throw err;
  }
}

/**
 * Searches versioned municipal codes, county ordinances, and state statutes.
 * @param {Object} args
 * @param {string} args.query - Natural language inquiry or statutory search terms
 * @param {string} [args.state='CA'] - Two-letter state abbreviation
 * @param {string} [args.city='Oakland'] - City or county name
 * @param {string} [args.topic] - Subject matter classification
 * @param {number} [args.limit=5] - Maximum sections to return
 * @returns {Promise<{content: Array<{type: string, text: string}>}>}
 */
export async function searchOrdinances({ query, state = 'CA', city = 'Oakland', topic, limit = 5 }) {
  if (!query || !query.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Missing required query string." }]
    };
  }

  const params = new URLSearchParams({ q: query.trim(), limit: String(Math.min(20, Math.max(1, limit))) });
  if (state) params.set('state', state);
  if (city) params.set('city', city);
  if (topic) params.set('topic', topic);

  try {
    const data = await fetchKruschLaw(`/api/laws/search?${params.toString()}`);
    
    if (!data.results || data.results.length === 0) {
      return {
        content: [{ type: "text", text: `No statutory authorities found matching "${query}" in ${city}, ${state}.` }]
      };
    }

    const formatted = data.results.map((r, i) => (
      `### [${i + 1}] ${r.section} — ${r.title} (Authority Weight: ${r.authority_weight || '1.0'}x)\n` +
      `**Jurisdiction**: ${r.jurisdiction} | **State**: ${r.state || 'N/A'} | **City**: ${r.city || 'N/A'}\n` +
      `**Temporal Status**: ${r.repealed ? '🛑 REPEALED' : '✅ Active'} | Effective: ${r.effective_date || 'Current'}\n` +
      `\`\`\`text\n${(r.content || '').trim()}\n\`\`\``
    )).join('\n\n---\n\n');

    return {
      content: [{
        type: "text",
        text: `## ⚖️ KruschLaw Statutory Authorities (${data.results.length} retrieved)\n\n${formatted}`
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error searching ordinances: ${err.message}` }]
    };
  }
}

/**
 * Retrieves full statutory text with parent/child links and exception clauses.
 * @param {Object} args
 * @param {string} args.section - Section number (e.g. 'OMC 8.22.360')
 * @param {string} [args.jurisdiction] - Jurisdiction name filter
 * @returns {Promise<{content: Array<{type: string, text: string}>}>}
 */
export async function getSection({ section, jurisdiction }) {
  if (!section || !section.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Missing required section identifier." }]
    };
  }

  const params = new URLSearchParams({ section: section.trim() });
  if (jurisdiction) params.set('jurisdiction', jurisdiction);

  try {
    const data = await fetchKruschLaw(`/api/laws/section?${params.toString()}`);
    
    return {
      content: [{
        type: "text",
        text: `### 📜 ${data.section}: ${data.title}\n` +
              `**Hierarchy**: ${data.chapter || ''} > ${data.article || ''}\n` +
              `**Controlling Status**: ${data.authority_tier || 'Statute'} (${data.authority_weight || 1.0}x)\n\n` +
              `${data.body || data.content || ''}`
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error retrieving section "${section}": ${err.message}` }]
    };
  }
}

/**
 * Stages an air-gapped 4-part legal brief with mandatory assertion-level grounding.
 * Refuses to draft if governing authorities are absent.
 * @param {Object} args
 * @param {string} args.facts - Comprehensive matter facts
 * @param {number} [args.case_id] - Existing matter ID
 * @param {string} [args.title] - Brief title
 * @param {string} [args.state='CA'] - State postal code
 * @param {string} [args.city='Oakland'] - City name
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function draftGroundedBrief({ case_id, facts, title, state = 'CA', city = 'Oakland' }) {
  if (!facts && !case_id) {
    return {
      isError: true,
      content: [{ type: "text", text: "Either 'facts' or 'case_id' must be provided to draft brief." }]
    };
  }

  const payload = { case_id, facts, title, state, city };

  try {
    const data = await fetchKruschLaw('/api/cases/brief', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    // Guardrail check: Refusal propagation
    if (data.status === 'CANNOT_DRAFT_WITHOUT_AUTHORITIES') {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `🛑 **KruschLaw Ethical Refusal**: Cannot draft legal brief without governing authorities in the local corpus.\n\n` +
                `Reason: ${data.message || 'No supporting statutes found for the presented fact pattern.'}\n` +
                `Action: Ingest municipal codes for ${city}, ${state} or supply primary statutory authorities before drafting.`
        }]
      };
    }

    const groundingSummary = data.grounding_audit 
      ? `\n\n### 🛡️ Grounding Audit Summary\n` +
        `- Supported Claims: ${data.grounding_audit.supported_count || 0}\n` +
        `- Unverified / Divergent: ${data.grounding_audit.divergent_count || 0}\n` +
        `- Stale Law Flags: ${data.grounding_audit.stale_count || 0}\n`
      : '';

    return {
      content: [{
        type: "text",
        text: `## 📄 Provisional Legal Work Product (Review Required)\n\n` +
              `> **Mandatory UPL Notice**: Generated on-premise for exploratory issue-spotting. Requires independent attorney verification.\n\n` +
              `${data.brief_markdown || data.analysis || ''}${groundingSummary}`
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error drafting brief: ${err.message}` }]
    };
  }
}

/**
 * Verifies discrete claims in draft text against retrieved authorities.
 * @param {Object} args
 * @param {string} args.draft_text - Proposed legal text or brief
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function verifyAssertionGrounding({ draft_text }) {
  if (!draft_text || !draft_text.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Missing required draft_text parameter." }]
    };
  }

  try {
    const data = await fetchKruschLaw('/api/verify/assertions', {
      method: 'POST',
      body: JSON.stringify({ draft_text })
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify(data, null, 2)
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Grounding verification unavailable: ${err.message}` }]
    };
  }
}

/**
 * Flags memories citing an amended statute as STALE_PENDING_REVIEW instead of silently superseding them.
 * Surfaces a human/agent review queue.
 * @param {Object} args
 * @param {string} args.section - Amended section (e.g. 'Section 1950.5(b)')
 * @param {string} [args.amendment_diff] - Text diff of statutory amendment
 * @param {string} [args.chaptered_bill_ref] - Legislative enactment reference
 * @param {string} [args.project='krusch-law'] - Target project repository
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function flagStaleMemories({ section, amendment_diff, chaptered_bill_ref, project = 'krusch-law' }) {
  if (!section || !section.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Missing required section identifier." }]
    };
  }

  const cleanSec = section.trim().replace(/^Section\s+/i, '');
  const searchPatterns = [`%${cleanSec}%`, `%${section.trim()}%`];

  let flaggedCount = 0;
  const affectedMemories = [];

  try {
    const db = await getProjectDb(project);
    if (db) {
      const rows = db.prepare(`
        SELECT id, category, content, tags, status
        FROM ide_agent_memory
        WHERE status = 'ACTIVE'
          AND (content LIKE ? OR content LIKE ? OR tags LIKE ? OR tags LIKE ?)
      `).all(searchPatterns[0], searchPatterns[1], searchPatterns[0], searchPatterns[1]);

      for (const row of rows) {
        db.prepare(`
          UPDATE ide_agent_memory
          SET status = 'STALE_PENDING_REVIEW'
          WHERE id = ?
        `).run(row.id);

        flaggedCount++;
        affectedMemories.push({
          id: row.id,
          category: row.category,
          snippet: row.content.slice(0, 140) + '...'
        });
      }
    }

    return {
      content: [{
        type: "text",
        text: `### ⚠️ KruschLaw Stale Memory Review Queue\n\n` +
              `**Amended Section**: ${section}\n` +
              (chaptered_bill_ref ? `**Authority Reference**: ${chaptered_bill_ref}\n` : '') +
              `**Flagged Conclusions**: ${flaggedCount} memories set to \`STALE_PENDING_REVIEW\`\n\n` +
              (affectedMemories.length > 0
                ? affectedMemories.map(m => `- [Memory #${m.id}] (${m.category}): ${m.snippet}`).join('\n') + '\n\n'
                : 'No existing active memories currently cite this provision.\n\n') +
              (amendment_diff ? `#### Amendment Diff:\n\`\`\`diff\n${amendment_diff}\n\`\`\`\n` : '')
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error flagging stale memories: ${err.message}` }]
    };
  }
}

/**
 * Reviews the queue of memories flagged as STALE_PENDING_REVIEW due to statutory changes.
 * @param {Object} args
 * @param {string} [args.project='krusch-law'] - Project name
 * @param {number} [args.limit=10] - Maximum queue items to return
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function reviewStaleQueue({ project = 'krusch-law', limit = 10 } = {}) {
  try {
    const db = await getProjectDb(project);
    if (!db) {
      return {
        content: [{ type: "text", text: `Project database for '${project}' not initialized.` }]
      };
    }

    const rows = db.prepare(`
      SELECT id, category, content, tags, updated_at
      FROM ide_agent_memory
      WHERE status = 'STALE_PENDING_REVIEW'
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);

    if (rows.length === 0) {
      return {
        content: [{ type: "text", text: `✅ Stale Legal Memory Queue is clean (0 conclusions pending review).` }]
      };
    }

    const items = rows.map((r, i) => (
      `**[${i + 1}] Memory ID #${r.id}** (${r.category})\n` +
      `> ${r.content}\n` +
      `*Action Required*: Use \`krusch_law_resolve_stale_memory\` with 'reaffirm', 'supersede', or 'invalidate'.`
    )).join('\n\n---\n\n');

    return {
      content: [{
        type: "text",
        text: `## ⚠️ Stale Legal Memory Queue (${rows.length} pending review)\n\n` +
              `The following stored conclusions cite amended or repealed statutes. They are paused from automated drafting until reviewed:\n\n` +
              `${items}`
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error reviewing stale queue: ${err.message}` }]
    };
  }
}

/**
 * Resolves a memory in STALE_PENDING_REVIEW status.
 * @param {Object} args
 * @param {number} args.memory_id - Memory row ID to resolve
 * @param {'reaffirm'|'supersede'|'invalidate'} args.resolution - Action to take
 * @param {string} [args.new_content] - Required if resolution is 'supersede'
 * @param {string} [args.project='krusch-law'] - Target project repository
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function resolveStaleMemory({ memory_id, resolution, new_content, project = 'krusch-law' }) {
  if (!memory_id || !resolution) {
    return {
      isError: true,
      content: [{ type: "text", text: "Both 'memory_id' and 'resolution' ('reaffirm', 'supersede', 'invalidate') are required." }]
    };
  }

  try {
    const db = await getProjectDb(project);
    if (!db) {
      return {
        isError: true,
        content: [{ type: "text", text: `Project database for '${project}' not found.` }]
      };
    }

    const existing = db.prepare(`SELECT * FROM ide_agent_memory WHERE id = ?`).get(memory_id);
    if (!existing) {
      return {
        isError: true,
        content: [{ type: "text", text: `Memory #${memory_id} not found.` }]
      };
    }

    if (resolution === 'reaffirm') {
      db.prepare(`UPDATE ide_agent_memory SET status = 'ACTIVE' WHERE id = ?`).run(memory_id);
      return {
        content: [{ type: "text", text: `✅ Memory #${memory_id} reaffirmed and restored to ACTIVE status.` }]
      };
    } else if (resolution === 'invalidate') {
      db.prepare(`UPDATE ide_agent_memory SET status = 'INVALIDATED' WHERE id = ?`).run(memory_id);
      return {
        content: [{ type: "text", text: `🛑 Memory #${memory_id} marked as INVALIDATED due to statutory change.` }]
      };
    } else if (resolution === 'supersede') {
      if (!new_content || !new_content.trim()) {
        return {
          isError: true,
          content: [{ type: "text", text: "'new_content' is required when resolution is 'supersede'." }]
        };
      }
      const info = db.prepare(`
        INSERT INTO ide_agent_memory (category, content, tags, status, supersedes_id)
        VALUES (?, ?, ?, 'ACTIVE', ?)
      `).run(existing.category, new_content.trim(), existing.tags, memory_id);

      db.prepare(`UPDATE ide_agent_memory SET status = 'SUPERSEDED', superseded_by = ? WHERE id = ?`).run(info.lastInsertRowid, memory_id);

      return {
        content: [{
          type: "text",
          text: `✅ Memory #${memory_id} superseded by new Memory #${info.lastInsertRowid} with updated statutory terms.`
        }]
      };
    } else {
      return {
        isError: true,
        content: [{ type: "text", text: `Invalid resolution '${resolution}'. Must be 'reaffirm', 'supersede', or 'invalidate'.` }]
      };
    }
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error resolving stale memory: ${err.message}` }]
    };
  }
}
