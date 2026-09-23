/**
 * @module extensions/biz/biz-engine
 * Bridge engine connecting KruschContext to the sovereign KruschBiz service.
 * Supports commercial contract search, controlling clause graph resolution,
 * contract conflict detection, instrument diffing, and grounded executive memoranda.
 */

function getBizHost() {
  return process.env.KRUSCHBIZ_API_URL || process.env.KRUSCHBIZ_URL || 'http://127.0.0.1:8086';
}

function getBizKey() {
  return process.env.KRUSCHBIZ_API_KEY || '';
}

/**
 * Internal helper to query KruschBiz FastAPI endpoints.
 * @param {string} endpoint 
 * @param {RequestInit} [options={}] 
 * @param {string} [tenantId='org_default']
 * @returns {Promise<any>}
 */
async function fetchKruschBiz(endpoint, options = {}, tenantId = 'org_default') {
  const host = getBizHost();
  const key = getBizKey();
  const url = `${host}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Tenant-ID': tenantId,
    ...(key ? { 'X-API-Key': key } : {}),
    ...options.headers
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
    const response = await fetch(url, { ...options, headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`[KruschBiz HTTP ${response.status}] ${errorText}`);
    }
    return await response.json();
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.name === 'AbortError' || err.message.includes('fetch failed')) {
      throw new Error(
        `KruschBiz service is unreachable at ${host}. Ensure KruschBiz backend is running (docker compose up -d or uvicorn src.backend.main:app --port 8086).`
      );
    }
    throw err;
  }
}


/**
 * Search commercial contracts, MSAs, SLAs, NDAs, and corporate policies.
 * @param {Object} args
 * @param {string} args.query - Natural language inquiry or keywords
 * @param {string} [args.organization] - Enterprise name
 * @param {string} [args.agreement_type] - Agreement classification
 * @param {string} [args.domain] - Commercial domain
 * @param {number} [args.limit=5] - Maximum clauses to return
 * @param {string} [args.tenant_id='org_default']
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function searchContracts({ query, organization, agreement_type, domain, limit = 5, tenant_id = 'org_default' } = {}) {
  if (!query || !query.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Missing required 'query' parameter." }]
    };
  }

  const params = new URLSearchParams({
    q: query.trim(),
    limit: String(Math.min(20, Math.max(1, limit)))
  });
  if (organization) params.set('organization', organization);
  if (agreement_type) params.set('agreement_type', agreement_type);
  if (domain) params.set('domain', domain);

  try {
    const clauses = await fetchKruschBiz(`/api/clauses?${params.toString()}`, { method: 'GET' }, tenant_id);

    if (!Array.isArray(clauses) || clauses.length === 0) {
      return {
        content: [{ type: "text", text: `No commercial clauses found matching "${query}".` }]
      };
    }

    const formatted = clauses.map((c, i) => {
      const slots = c.structured_slots && Object.keys(c.structured_slots).length > 0
        ? `\n**Structured Slots**: \`${JSON.stringify(c.structured_slots)}\``
        : '';
      const scoreInfo = c.score ? ` (Score: ${Number(c.score).toFixed(4)})` : '';

      return (
        `### [${i + 1}] 📜 ${c.section || 'Clause'} — ${c.title || c.agreement_type}${scoreInfo}\n` +
        `**Agreement**: ${c.agreement_type} | **Counterparty**: ${c.counterparty || 'N/A'} | **Org**: ${c.organization}\n` +
        `**Tier**: ${c.authority_class || 'governing_agreement'} | **Status**: ${c.superseded ? '🛑 SUPERSEDED' : '✅ Active'}${slots}\n` +
        `\`\`\`text\n${(c.content || '').trim()}\n\`\`\``
      );
    }).join('\n\n---\n\n');

    return {
      content: [{
        type: "text",
        text: `## 💼 KruschBiz Commercial Clauses (${clauses.length} retrieved)\n\n${formatted}`
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error searching commercial contracts: ${err.message}` }]
    };
  }
}

/**
 * Retrieve unabridged text and metadata for a specific section.
 * @param {Object} args
 * @param {string} args.section - Section code (e.g. 'Section 10.1', 'Exhibit B Section 2.1')
 * @param {string} [args.organization]
 * @param {string} [args.tenant_id='org_default']
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function getClauseDetails({ section, organization, tenant_id = 'org_default' } = {}) {
  if (!section || !section.trim()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Missing required 'section' parameter." }]
    };
  }

  const params = new URLSearchParams({ q: section.trim(), limit: "3" });
  if (organization) params.set('organization', organization);

  try {
    const clauses = await fetchKruschBiz(`/api/clauses?${params.toString()}`, { method: 'GET' }, tenant_id);
    if (!Array.isArray(clauses) || clauses.length === 0) {
      return {
        content: [{ type: "text", text: `Clause '${section}' not found in KruschBiz agreement graph.` }]
      };
    }

    const target = clauses.find(c => (c.section || '').toLowerCase() === section.trim().toLowerCase()) || clauses[0];

    const slotsBlock = target.structured_slots && Object.keys(target.structured_slots).length > 0
      ? `\n\n### 🧩 Structured Commercial Slots\n\`\`\`json\n${JSON.stringify(target.structured_slots, null, 2)}\n\`\`\``
      : '';

    return {
      content: [{
        type: "text",
        text: `### 📄 ${target.section || 'Clause'}: ${target.title || target.agreement_type}\n` +
              `**Agreement Type**: ${target.agreement_type}\n` +
              `**Counterparty**: ${target.counterparty || 'N/A'} | **Organization**: ${target.organization}\n` +
              `**Hierarchy**: ${target.parent_section ? `${target.parent_section} > ` : ''}${target.hierarchy_level || 'clause'}\n` +
              `**Controlling Tier**: ${target.authority_class || 'governing_agreement'}\n` +
              `**Status**: ${target.superseded ? '🛑 SUPERSEDED' : '✅ Active'}\n\n` +
              `\`\`\`text\n${(target.content || '').trim()}\n\`\`\`${slotsBlock}`
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error retrieving clause details: ${err.message}` }]
    };
  }
}

/**
 * Traverse the commercial agreement relation graph (AMENDS, SUPERSEDES) to resolve the controlling clause.
 * @param {Object} args
 * @param {string} args.counterparty - Vendor or partner name
 * @param {string} args.topic - Canonical commercial topic (e.g. 'PAYMENT_TERMS', 'LIMITATION_OF_LIABILITY')
 * @param {string} [args.as_of_date] - Point-in-time ISO date (YYYY-MM-DD)
 * @param {string} [args.tenant_id='org_default']
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function resolveControllingClause({ counterparty, topic, as_of_date, tenant_id = 'org_default' } = {}) {
  if (!counterparty || !topic) {
    return {
      isError: true,
      content: [{ type: "text", text: "Both 'counterparty' and 'topic' are required." }]
    };
  }

  const params = new URLSearchParams({
    counterparty: counterparty.trim(),
    topic: topic.trim()
  });
  if (as_of_date) params.set('as_of_date', as_of_date);

  try {
    const res = await fetchKruschBiz(`/api/resolver/controlling-clause?${params.toString()}`, { method: 'GET' }, tenant_id);

    return {
      content: [{
        type: "text",
        text: `### ⚖️ KruschBiz Controlling Clause Resolution\n\n` +
              `- **Counterparty**: \`${counterparty}\`\n` +
              `- **Topic**: \`${topic}\`\n` +
              `- **Governing Agreement**: ${res.controlling_agreement || res.agreement || 'Resolved'}\n` +
              `- **Controlling Section**: \`${res.controlling_section || res.section || 'N/A'}\`\n` +
              `- **Effective Date**: ${res.effective_date || 'Current'}\n\n` +
              `#### Governing Content:\n\`\`\`text\n${(res.content || res.text || JSON.stringify(res, null, 2)).trim()}\n\`\`\``
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error resolving controlling clause: ${err.message}` }]
    };
  }
}

/**
 * Detect conflicting numeric terms and slot discrepancies across active agreements.
 * @param {Object} args
 * @param {string} args.counterparty - Vendor or partner name
 * @param {string} [args.as_of_date] - ISO date
 * @param {string} [args.tenant_id='org_default']
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function detectContractConflicts({ counterparty, as_of_date, tenant_id = 'org_default' } = {}) {
  if (!counterparty) {
    return {
      isError: true,
      content: [{ type: "text", text: "Missing required 'counterparty' parameter." }]
    };
  }

  const params = new URLSearchParams({ counterparty: counterparty.trim() });
  if (as_of_date) params.set('as_of_date', as_of_date);

  try {
    const data = await fetchKruschBiz(`/api/resolver/conflicts?${params.toString()}`, { method: 'GET' }, tenant_id);

    const conflicts = data.conflicts || [];
    if (conflicts.length === 0) {
      return {
        content: [{
          type: "text",
          text: `✅ **No Contract Conflicts Detected**: Active instruments for '${counterparty}' are harmonized.`
        }]
      };
    }

    const items = conflicts.map((c, i) => (
      `**[${i + 1}] Conflict on \`${c.topic || c.slot_name}\`**\n` +
      `- **Instrument A**: ${c.agreement_a} (Value: \`${c.value_a}\`)\n` +
      `- **Instrument B**: ${c.agreement_b} (Value: \`${c.value_b}\`)\n` +
      `- **Priority Risk**: ${c.risk_level || 'HIGH'} — ${c.description || 'Conflicting active terms without explicit superseding clause.'}`
    )).join('\n\n---\n\n');

    return {
      content: [{
        type: "text",
        text: `### ⚠️ KruschBiz Active Contract Conflicts (${conflicts.length} detected for \`${counterparty}\`)\n\n${items}`
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error detecting contract conflicts: ${err.message}` }]
    };
  }
}

/**
 * Diff two legal instruments side-by-side with aligned clauses and highlighted slot divergences.
 * @param {Object} args
 * @param {number} args.agreement_a_id - Base Agreement ID
 * @param {number} args.agreement_b_id - Target Agreement ID
 * @param {string} [args.tenant_id='org_default']
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function diffInstruments({ agreement_a_id, agreement_b_id, tenant_id = 'org_default' } = {}) {
  if (!agreement_a_id || !agreement_b_id) {
    return {
      isError: true,
      content: [{ type: "text", text: "Both 'agreement_a_id' and 'agreement_b_id' are required." }]
    };
  }

  const params = new URLSearchParams({
    agreement_a_id: String(agreement_a_id),
    agreement_b_id: String(agreement_b_id)
  });

  try {
    const report = await fetchKruschBiz(`/api/resolver/diff?${params.toString()}`, { method: 'GET' }, tenant_id);

    return {
      content: [{
        type: "text",
        text: `### 🔍 KruschBiz Contract Diff Report\n\n` +
              `- **Base Instrument**: #${agreement_a_id} (${report.base_title || 'Base'})\n` +
              `- **Target Instrument**: #${agreement_b_id} (${report.target_title || 'Target'})\n` +
              `- **Diverging Slots**: ${report.slot_divergences ? Object.keys(report.slot_divergences).length : 0}\n\n` +
              `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error diffing contract instruments: ${err.message}` }]
    };
  }
}

/**
 * Stages an air-gapped executive commercial memorandum with mandatory assertion-level grounding.
 * Refuses to draft if governing authorities are absent.
 * @param {Object} args
 * @param {number} [args.deal_id] - Existing deal matter ID
 * @param {string} [args.context_facts] - Transaction narrative and deal points
 * @param {string} [args.title] - Brief title
 * @param {string} [args.counterparty] - Counterparty name
 * @param {string} [args.organization] - Enterprise name
 * @param {number} [args.limit=5] - Number of governing clauses to retrieve
 * @param {string} [args.tenant_id='org_default']
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function draftDealBrief({ deal_id, context_facts, title, counterparty, organization, limit = 5, tenant_id = 'org_default' } = {}) {
  if (!context_facts && !deal_id) {
    return {
      isError: true,
      content: [{ type: "text", text: "Either 'context_facts' or 'deal_id' must be provided to draft brief." }]
    };
  }

  const params = new URLSearchParams({ limit: String(limit) });
  if (deal_id !== undefined && deal_id !== null) params.set('deal_id', String(deal_id));
  if (context_facts) params.set('query', context_facts);
  if (organization) params.set('organization', organization);

  try {
    const data = await fetchKruschBiz(`/api/consult?${params.toString()}`, { method: 'GET' }, tenant_id);

    // Refusal propagation
    if (data.analysis && data.analysis.includes("CANNOT_DRAFT_WITHOUT_AUTHORITIES")) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `🛑 **KruschBiz Refusal**: Cannot draft commercial memorandum without governing agreements in the corpus.\n\n` +
                `Action: Ingest the governing MSA, SLA, or vendor contracts before drafting analysis.`
        }]
      };
    }

    const grounding = data.grounding_stats || {};
    const auditSummary = 
      `\n\n### 🛡️ Commercial Grounding Audit\n` +
      `- Supported Claims: ${grounding.supported_claims || 0} / ${grounding.total_claims || 0}\n` +
      `- Divergent Terms: ${grounding.divergent_terms || 0}\n` +
      `- Invented Clauses: ${grounding.invented_clauses || 0}\n` +
      `- Pass Rate: ${grounding.pass_rate || 100}%`;

    return {
      content: [{
        type: "text",
        text: `## 📋 Grounded Executive Commercial Memorandum\n\n` +
              `> **Internal Work Product**: Prepared on-premise for commercial transaction evaluation.\n\n` +
              `${data.analysis || ''}${auditSummary}`
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error drafting commercial deal brief: ${err.message}` }]
    };
  }
}

/**
 * List corporate deal matters, transactions, and status.
 * @param {Object} args
 * @param {number} [args.limit=10]
 * @param {string} [args.status]
 * @param {string} [args.tenant_id='org_default']
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function listDeals({ limit = 10, status, tenant_id = 'org_default' } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set('status', status);

  try {
    const deals = await fetchKruschBiz(`/api/deals?${params.toString()}`, { method: 'GET' }, tenant_id);

    if (!Array.isArray(deals) || deals.length === 0) {
      return {
        content: [{ type: "text", text: "No corporate deal matters found in KruschBiz." }]
      };
    }

    const items = deals.map((d, i) => (
      `**[${i + 1}] Deal #${d.id}: ${d.title}** (${d.status.toUpperCase()})\n` +
      `- **Deal Code**: \`${d.deal_code || 'N/A'}\` | **Type**: \`${d.deal_type || 'General'}\`\n` +
      `- **Counterparty**: ${d.counterparty_name || 'N/A'} | **Company**: ${d.company_name || 'Internal'}\n` +
      `- **Logged**: ${new Date(d.created_at).toLocaleString()}`
    )).join('\n\n---\n\n');

    return {
      content: [{
        type: "text",
        text: `### 💼 KruschBiz Deal Matters (${deals.length} active)\n\n${items}`
      }]
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error listing corporate deals: ${err.message}` }]
    };
  }
}
