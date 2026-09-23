/**
 * @module extensions/biz
 * KruschBiz Corporate Intelligence & Contract Graph Extension for krusch-context-mcp.
 * Exposes commercial agreement search, controlling-document resolution,
 * contract conflict detection, instrument diffing, and grounded executive memoranda.
 */

import {
  searchContracts,
  getClauseDetails,
  resolveControllingClause,
  detectContractConflicts,
  diffInstruments,
  draftDealBrief,
  listDeals
} from './biz-engine.js';

export const tools = [
  {
    name: "krusch_biz_search_contracts",
    description: "Search corporate contracts, MSAs, SLAs, NDAs, and company policies in KruschBiz using hybrid vector + lexical retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query or commercial term (e.g. 'limitation of liability', 'net 30 payment terms', 'uptime SLA')"
        },
        organization: {
          type: "string",
          description: "Company or enterprise name (e.g. 'Acme Corp')"
        },
        agreement_type: {
          type: "string",
          description: "Agreement classification (e.g. 'Master Services Agreement', 'Service Level Agreement')"
        },
        domain: {
          type: "string",
          description: "Commercial domain (e.g. 'Procurement & Invoicing', 'Risk & Indemnification')"
        },
        limit: {
          type: "integer",
          description: "Maximum clauses to return (default: 5, max: 20)",
          default: 5
        },
        tenant_id: {
          type: "string",
          description: "Multi-tenant partition identifier (default: 'org_default')",
          default: "org_default"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "krusch_biz_get_clause",
    description: "Retrieve the unabridged contractual text, parent/child relationships, and structured commercial slots for a specific section.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description: "Section identifier (e.g. 'Section 10.1', 'Exhibit B Section 2.1')"
        },
        organization: {
          type: "string",
          description: "Optional organization filter"
        },
        tenant_id: {
          type: "string",
          description: "Multi-tenant partition identifier (default: 'org_default')",
          default: "org_default"
        }
      },
      required: ["section"]
    }
  },
  {
    name: "krusch_biz_resolve_controlling_clause",
    description: "Traverse the commercial agreement relation graph (AMENDS, SUPERSEDES) to resolve which clause governs a topic as of a specific date.",
    inputSchema: {
      type: "object",
      properties: {
        counterparty: {
          type: "string",
          description: "Counterparty or vendor corporate name (e.g. 'CloudScale AI LLC')"
        },
        topic: {
          type: "string",
          description: "Canonical commercial topic (e.g. 'PAYMENT_TERMS', 'LIMITATION_OF_LIABILITY', 'SLA_PERFORMANCE')"
        },
        as_of_date: {
          type: "string",
          description: "Optional ISO date (YYYY-MM-DD) for historical or point-in-time precedence"
        },
        tenant_id: {
          type: "string",
          description: "Multi-tenant partition identifier (default: 'org_default')",
          default: "org_default"
        }
      },
      required: ["counterparty", "topic"]
    }
  },
  {
    name: "krusch_biz_detect_conflicts",
    description: "Detect conflicting numeric terms and slot discrepancies (e.g. Net 30 vs Net 45) across concurrently active instruments.",
    inputSchema: {
      type: "object",
      properties: {
        counterparty: {
          type: "string",
          description: "Counterparty or vendor corporate name"
        },
        as_of_date: {
          type: "string",
          description: "Optional ISO date (YYYY-MM-DD)"
        },
        tenant_id: {
          type: "string",
          description: "Multi-tenant partition identifier (default: 'org_default')",
          default: "org_default"
        }
      },
      required: ["counterparty"]
    }
  },
  {
    name: "krusch_biz_diff_instruments",
    description: "Diff two legal instruments side-by-side: aligns clauses by topic, extracts text diffs, and highlights diverging structured slots.",
    inputSchema: {
      type: "object",
      properties: {
        agreement_a_id: {
          type: "integer",
          description: "Base Agreement ID (e.g. 2021 Master Agreement)"
        },
        agreement_b_id: {
          type: "integer",
          description: "Target Agreement ID (e.g. 2025 Master Agreement or Amendment)"
        },
        tenant_id: {
          type: "string",
          description: "Multi-tenant partition identifier (default: 'org_default')",
          default: "org_default"
        }
      },
      required: ["agreement_a_id", "agreement_b_id"]
    }
  },
  {
    name: "krusch_biz_draft_deal_brief",
    description: "Stage an air-gapped executive commercial memorandum with assertion-level grounding audit. Refuses to draft if governing agreements are absent.",
    inputSchema: {
      type: "object",
      properties: {
        context_facts: {
          type: "string",
          description: "Transaction background narrative, key deal points, and vendor proposals"
        },
        deal_id: {
          type: "integer",
          description: "Optional ID of an existing logged deal matter"
        },
        title: {
          type: "string",
          description: "Title of the transaction or executive memorandum"
        },
        counterparty: {
          type: "string",
          description: "Counterparty corporate name"
        },
        organization: {
          type: "string",
          description: "Internal company name"
        },
        limit: {
          type: "integer",
          description: "Number of governing clauses to retrieve (default: 5)",
          default: 5
        },
        tenant_id: {
          type: "string",
          description: "Multi-tenant partition identifier (default: 'org_default')",
          default: "org_default"
        }
      }
    }
  },
  {
    name: "krusch_biz_list_deals",
    description: "Enumerate active corporate deals, vendor transactions, and matter codes in KruschBiz.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum deals to return (default: 10)",
          default: 10
        },
        status: {
          type: "string",
          description: "Optional status filter ('active', 'closed', 'under_review')"
        },
        tenant_id: {
          type: "string",
          description: "Multi-tenant partition identifier (default: 'org_default')",
          default: "org_default"
        }
      }
    }
  }
];

export const handlers = new Map([
  ['krusch_biz_search_contracts', (args) => searchContracts(args)],
  ['krusch_biz_get_clause', (args) => getClauseDetails(args)],
  ['krusch_biz_resolve_controlling_clause', (args) => resolveControllingClause(args)],
  ['krusch_biz_detect_conflicts', (args) => detectContractConflicts(args)],
  ['krusch_biz_diff_instruments', (args) => diffInstruments(args)],
  ['krusch_biz_draft_deal_brief', (args) => draftDealBrief(args)],
  ['krusch_biz_list_deals', (args) => listDeals(args)]
]);

export const extension = {
  name: "biz",
  description: "KruschBiz Sovereign Corporate Intelligence — contract graph, controlling-document resolution, conflict detection, and grounded executive memoranda.",
  tools,
  handlers
};

export default extension;
