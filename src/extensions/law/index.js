/**
 * @module extensions/law
 * KruschLaw Extension for krusch-context-mcp.
 * Exposes sovereign municipal search, section retrieval, brief drafting,
 * and assertion grounding tools to coding and research agents.
 */

import {
  searchOrdinances,
  getSection,
  draftGroundedBrief,
  verifyAssertionGrounding
} from './law-engine.js';

export const tools = [
  {
    name: "krusch_law_search_ordinances",
    description: "Search versioned municipal codes, county ordinances, and state statutes in the air-gapped KruschLaw store with authority weighting (controlling statute > regulation > ordinance).",
    inputSchema: {
      type: "object",
      properties: {
        query: { 
          type: "string", 
          description: "Search terms or colloquial grievance (e.g. 'rent hike notice', 'OMI eviction', 'security deposit')" 
        },
        state: { 
          type: "string", 
          description: "Two-letter state postal abbreviation (default: 'CA')" 
        },
        city: { 
          type: "string", 
          description: "City or county name (e.g. 'Oakland', 'San Francisco', 'Los Angeles')" 
        },
        topic: { 
          type: "string", 
          description: "Classification (e.g. 'Housing & Rent', 'Public Nuisance', 'Building Safety')" 
        },
        limit: { 
          type: "integer", 
          description: "Maximum sections to return (default: 5, max: 20)",
          default: 5 
        }
      },
      required: ["query"]
    }
  },
  {
    name: "krusch_law_get_section",
    description: "Retrieve unabridged statutory text, parent/child relationships, and exception clauses for a specific section.",
    inputSchema: {
      type: "object",
      properties: {
        section: { 
          type: "string", 
          description: "Section code (e.g. 'OMC 8.22.360', 'Cal. Civ. Code § 1950.5')" 
        },
        jurisdiction: { 
          type: "string", 
          description: "Optional jurisdiction filter (e.g. 'Oakland Municipal Code')" 
        }
      },
      required: ["section"]
    }
  },
  {
    name: "krusch_law_draft_brief",
    description: "Stage an air-gapped, citation-grounded 4-part legal brief for human attorney review. Refuses to draft if governing authorities are absent. Does NOT auto-file.",
    inputSchema: {
      type: "object",
      properties: {
        facts: { 
          type: "string", 
          description: "Matter narrative, parties, and factual circumstances" 
        },
        case_id: { 
          type: "integer", 
          description: "Optional existing matter ID from KruschLaw database" 
        },
        title: { 
          type: "string", 
          description: "Short descriptive title for the brief" 
        },
        city: { 
          type: "string", 
          description: "Governing city (default: 'Oakland')",
          default: "Oakland" 
        },
        state: { 
          type: "string", 
          description: "Two-letter state postal abbreviation (default: 'CA')",
          default: "CA" 
        }
      },
      required: ["facts"]
    }
  },
  {
    name: "krusch_law_verify_grounding",
    description: "Decompose a proposed legal draft into discrete claims and audit each against local governing authorities for invented citations, wrong propositions, and stale law.",
    inputSchema: {
      type: "object",
      properties: {
        draft_text: { 
          type: "string", 
          description: "Proposed legal text, memorandum, or draft brief to audit" 
        }
      },
      required: ["draft_text"]
    }
  }
];

export const handlers = new Map([
  ['krusch_law_search_ordinances', (args) => searchOrdinances(args)],
  ['krusch_law_get_section', (args) => getSection(args)],
  ['krusch_law_draft_brief', (args) => draftGroundedBrief(args)],
  ['krusch_law_verify_grounding', (args) => verifyAssertionGrounding(args)]
]);

export const extension = {
  name: "law",
  description: "Sovereign Legal Intelligence (KruschLaw) — statutory graph, authority-weighted retrieval, assertion grounding, and brief staging.",
  tools,
  handlers
};

export default extension;
