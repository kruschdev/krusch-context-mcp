/**
 * @module extensions/session-bridge
 * Jean SRE Session Bridge Extension for krusch-context-mcp.
 */

import { writeSessionHandoff, readSessionReview, initSessionEngineTable } from './session-engine.js';

export const tools = [
  {
    name: "krusch_context_write_session_handoff",
    description: "Session Bridge (IDE ↔ Jean): Write the IDE session summary, calculate modified files, insert the DB record, and autonomously spawn the Jean SRE companion for review. Call this when executing /close.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        summary: { type: "string" }
      },
      required: ["project", "summary"]
    }
  },
  {
    name: "krusch_context_read_session_review",
    description: "Session Bridge (Jean ↔ IDE): Fetch the latest session review from the Jean SRE companion. This is guaranteed to be idempotent (it atomically marks the review as consumed). Call this when executing /continue.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" }
      },
      required: ["project"]
    }
  }
];

export const handlers = new Map([
  ['krusch_context_write_session_handoff', (args) => writeSessionHandoff(args)],
  ['krusch_context_read_session_review', (args) => readSessionReview(args)]
]);

export const extension = {
  name: "session-bridge",
  description: "Session Bridge (IDE ↔ Jean SRE) — session handoffs, automatic review triggers, and idempotent review ingestion.",
  init: initSessionEngineTable,
  tools,
  handlers
};

export default extension;
