/**
 * @module extensions/nexus
 * KruschNexus Universal Document Ingestion & Citation Spine Extension for krusch-context-mcp.
 * Exposes workspace management, multi-column OCR parsing, bit-for-bit span verification,
 * and page-faithful hybrid search to coding and research agents.
 */

import {
  listWorkspaces,
  listDocuments,
  searchCorpus,
  getIngestReport,
  ingestFile,
  verifySpan
} from './nexus-engine.js';

export const tools = [
  {
    name: "krusch_nexus_list_workspaces",
    description: "List document workspaces and indexed document counts in KruschNexus to prevent cross-contamination.",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Optional API token for workspace authorization"
        }
      }
    }
  },
  {
    name: "krusch_nexus_list_documents",
    description: "Enumerate ingested documents, page counts, chunk totals, and OCR status in a specific workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_name: {
          type: "string",
          description: "Target workspace name (e.g. 'Matter_104_Oakland', 'Vendor_Contracts_2026')"
        },
        token: {
          type: "string",
          description: "Optional API token for authorization"
        }
      }
    }
  },
  {
    name: "krusch_nexus_search_corpus",
    description: "Execute hybrid vector + full-text search across ingested documents in KruschNexus, returning physical page numbers, character span offsets, and citations.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search question, keywords, or statutory section tokens (e.g. 'security deposit refund', 'Section 10.1')"
        },
        workspace_name: {
          type: "string",
          description: "Target workspace name (REQUIRED to guarantee isolation)"
        },
        doc_type: {
          type: "string",
          description: "Optional classification filter ('authority', 'work_product', 'fact_narrative', 'general')"
        },
        limit: {
          type: "integer",
          description: "Maximum cited hits to return (default: 5, max: 20)",
          default: 5
        },
        page: {
          type: "integer",
          description: "Optional physical page number filter"
        },
        filename: {
          type: "string",
          description: "Optional filename filter"
        },
        token: {
          type: "string",
          description: "Optional API token"
        }
      },
      required: ["query", "workspace_name"]
    }
  },
  {
    name: "krusch_nexus_get_ingest_report",
    description: "Retrieve the Ingest Report for a document by its database ID or SHA-256 hash.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id_or_hash: {
          type: "string",
          description: "Document ID or SHA-256 hash"
        },
        token: {
          type: "string",
          description: "Optional API token"
        }
      },
      required: ["doc_id_or_hash"]
    }
  },
  {
    name: "krusch_nexus_ingest_file",
    description: "Ingest a local document (PDF, DOCX, TXT, MD, etc.) into the KruschNexus corpus with layout extraction, OCR fallback, and span offsets.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Absolute filesystem path to document file"
        },
        workspace_name: {
          type: "string",
          description: "Target workspace name (REQUIRED)"
        },
        doc_type: {
          type: "string",
          description: "Classification ('authority', 'work_product', 'fact_narrative', 'general')",
          default: "general"
        },
        archive: {
          type: "boolean",
          description: "Whether to move source file to .ingested/ upon indexing",
          default: false
        },
        token: {
          type: "string",
          description: "Optional API token"
        }
      },
      required: ["file_path", "workspace_name"]
    }
  },
  {
    name: "krusch_nexus_verify_span",
    description: "Verify that an assertion or excerpt corresponds to an authentic character span offset and physical page in the ingested corpus.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_name: {
          type: "string",
          description: "Target workspace containing the document"
        },
        query: {
          type: "string",
          description: "Proposition text or quote to verify against corpus spans"
        },
        physical_page: {
          type: "integer",
          description: "Optional target page number"
        },
        char_start: {
          type: "integer",
          description: "Optional expected character start offset"
        },
        char_end: {
          type: "integer",
          description: "Optional expected character end offset"
        },
        token: {
          type: "string",
          description: "Optional API token"
        }
      },
      required: ["workspace_name", "query"]
    }
  }
];

export const handlers = new Map([
  ['krusch_nexus_list_workspaces', (args) => listWorkspaces(args)],
  ['krusch_nexus_list_documents', (args) => listDocuments(args)],
  ['krusch_nexus_search_corpus', (args) => searchCorpus(args)],
  ['krusch_nexus_get_ingest_report', (args) => getIngestReport(args)],
  ['krusch_nexus_ingest_file', (args) => ingestFile(args)],
  ['krusch_nexus_verify_span', (args) => verifySpan(args)]
]);

export const extension = {
  name: "nexus",
  description: "KruschNexus Citation Spine — universal document ingestion, workspace isolation, physical page citations, and span verification.",
  tools,
  handlers
};

export default extension;
