/**
 * @module extensions/research
 * AI Watch Research Suite Extension for krusch-context-mcp.
 * Implements ArXiv-grounded agent experimentation modules:
 * - AgentDebugX: Error Hub & Failure Observability (arXiv: 2607.18754)
 * - DataFlow: Grounded Operator Registry & Typed DAG Mutations (arXiv: 2607.16617)
 * - Rubric4Setwise: Redundancy & Complementarity Reranker (arXiv: 2607.19238)
 * - AREX: Recursively Self-Improving Deep Research (arXiv: 2607.21461)
 * - ACM: Agentic Context Management Lifecycle (arXiv: 2607.21503)
 * - Hierarchical Teacher Memory Distillation (arXiv: 2608.07169)
 * - Emergence Multi-Agent Resilience Gate (arXiv: 2609.17320)
 */

import { initAgentDebugXTable, logAgentFailure, searchFailures, getRecoveryPattern } from './agentdebugx-engine.js';
import { initDataFlowTables, registerOperator, inspectOperatorRegistry, mutatePipelineDag } from './dataflow-engine.js';
import { setwiseRerank } from './setwise-engine.js';
import { initArexTable, updateResearchState, auditResearchConstraints } from './arex-engine.js';
import { initAcmTable, manageContextLifecycle, auditContextBudget } from './acm-engine.js';
import { initTeacherMemoryTable, distillTeacherMemory, retrieveTeacherDistillation, distillFunctionMemory } from './teacher-distillation-engine.js';
import { handleEvaluateResilience } from '../../proactive-engine.js';

export async function initResearchTables(pool) {
    await initAgentDebugXTable();
    await initDataFlowTables();
    await initArexTable();
    await initAcmTable();
    await initTeacherMemoryTable();
}

export const tools = [
  // AgentDebugX Tools
  {
    name: "krusch_context_log_agent_failure",
    description: "AgentDebugX Error Hub: Log an agent execution failure trajectory, attributed root cause, and recovery patch bundle.",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string" },
        error_symptom: { type: "string" },
        trajectory: { type: "array", description: "Array of trajectory step objects" },
        root_cause: { type: "string" },
        recovery_patch: { type: "object", description: "Recovery patch or parameter modifications" }
      },
      required: ["agent_name", "error_symptom", "root_cause"]
    }
  },
  {
    name: "krusch_context_search_failures",
    description: "AgentDebugX Error Hub: Search for past agent failure bundles matching an error symptom or query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        agent_name: { type: "string" },
        limit: { type: "number", default: 5 }
      },
      required: ["query"]
    }
  },
  {
    name: "krusch_context_get_recovery_pattern",
    description: "AgentDebugX Error Hub: Get execution recovery pattern and patch for a failure bundle ID.",
    inputSchema: {
      type: "object",
      properties: {
        failure_id: { type: "number" }
      },
      required: ["failure_id"]
    }
  },
  // DataFlow-Harness Tools
  {
    name: "krusch_context_register_pipeline_operator",
    description: "DataFlow-Harness: Register a grounded dataflow/ingestion operator with strict input, output, and side-effect schemas.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        side_effects: { type: "string" },
        docs: { type: "string" }
      },
      required: ["name", "input_schema", "output_schema"]
    }
  },
  {
    name: "krusch_context_inspect_pipeline_registry",
    description: "DataFlow-Harness: Inspect active grounded operator schemas in the MCP registry.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string" }
      }
    }
  },
  {
    name: "krusch_context_mutate_pipeline_dag",
    description: "DataFlow-Harness: Mutate a pipeline DAG using grounded, typed operations (AddNode, RemoveNode, WireEdge, UpdateNodeConfig).",
    inputSchema: {
      type: "object",
      properties: {
        pipeline_name: { type: "string" },
        mutation_type: { type: "string", enum: ["AddNode", "RemoveNode", "WireEdge", "UpdateNodeConfig"] },
        node_data: { type: "object" },
        edge_data: { type: "object" }
      },
      required: ["pipeline_name", "mutation_type"]
    }
  },
  // Rubric4Setwise Tool
  {
    name: "krusch_context_setwise_rerank",
    description: "Rubric4Setwise: Rerank candidate document/memory sets against Redundancy, Conflict, and Complementarity rubrics into a minimal covering set.",
    inputSchema: {
      type: "object",
      properties: {
        candidates: { type: "array", description: "Array of candidate document/memory objects" },
        query: { type: "string" },
        target_count: { type: "number", default: 5 }
      },
      required: ["candidates", "query"]
    }
  },
  // AREX Deep Research Tools
  {
    name: "krusch_context_update_research_state",
    description: "AREX Deep Research: Update or create research state maintaining verified evidence and unresolved constraints.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        verified_evidence: { type: "array" },
        unresolved_constraints: { type: "array" },
        next_action_hints: { type: "array" }
      },
      required: ["task_id"]
    }
  },
  {
    name: "krusch_context_arex_audit",
    description: "AREX Deep Research: Audit research evidence and unresolved constraints for a task to produce self-improving next follow-up steps.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        candidate_response: { type: "string" }
      },
      required: ["task_id"]
    }
  },
  // ACM Tools
  {
    name: "krusch_context_manage_lifecycle",
    description: "Agentic Context Management (ACM): Manage context fragment lifecycle (stage, compact, evict, get, list) and retention policies.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "'stage' | 'compact' | 'evict' | 'get' | 'list'" },
        fragment_id: { type: "string", description: "Unique fragment identifier" },
        content: { type: "string", description: "Context text content or summary" },
        stage: { type: "string", description: "'staged' | 'active' | 'compacted' | 'evicted'" },
        ttl_days: { type: "number", description: "Retention time-to-live in days (default 30)" },
        project: { type: "string", description: "Project identifier" },
        metadata: { type: "object", description: "Optional arbitrary metadata" }
      }
    }
  },
  {
    name: "krusch_context_audit_budget",
    description: "Agentic Context Management (ACM): Audit context window pressure, token budget consumption, and eviction/compaction recommendations.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project identifier" },
        token_budget: { type: "number", description: "Total token budget (default 8192)" },
        current_tokens: { type: "number", description: "Unmanaged prompt token count" }
      }
    }
  },
  // Teacher Distillation Tools
  {
    name: "krusch_context_distill_teacher_memory",
    description: "Hierarchical Teacher Memory Distillation (Paper 2608.07169): Log a teacher execution trajectory (workflow, subtask, or function tier) for student LLM agent learning.",
    inputSchema: {
      type: "object",
      properties: {
        tier: { type: "string", enum: ["workflow", "subtask", "function"], description: "Memory tier: 'workflow' (task plan), 'subtask' (step goal), 'function' (tool error fix)" },
        task_pattern: { type: "string", description: "Task pattern name or tool name (e.g. 'tool:git_commit')" },
        teacher_model: { type: "string", description: "Identifier of the teacher model (e.g. 'gemini-3.5-flash')" },
        student_model: { type: "string", description: "Target student model (e.g. 'qwen2.5-coder:7b')" },
        trajectory: { type: "array", items: { type: "object" }, description: "Structured execution trajectory steps" },
        distilled_rule: { type: "string", description: "High-level operational rule distilled from the trajectory" },
        project: { type: "string", description: "Optional project association" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["tier", "task_pattern", "teacher_model", "trajectory", "distilled_rule"]
    }
  },
  {
    name: "krusch_context_retrieve_teacher_distillation",
    description: "Hierarchical Teacher Memory Distillation (Paper 2608.07169): Retrieve distilled teacher trajectories matching a query and optional memory tier.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or error message" },
        tier: { type: "string", enum: ["workflow", "subtask", "function"], description: "Optional memory tier filter" },
        project: { type: "string", description: "Optional project filter" },
        limit: { type: "number", description: "Max results to return (default 3)" }
      },
      required: ["query"]
    }
  },
  {
    name: "krusch_context_distill_function_memory",
    description: "Hierarchical Teacher Memory Distillation (Paper 2608.07169): Distill a tool call failure and teacher fix into a Tier 3 Function Memory entry for local student LLM error recovery.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Tool that experienced an error" },
        failed_input: { type: "string", description: "Input parameters that caused failure" },
        error_message: { type: "string", description: "Error output or status" },
        corrected_input: { type: "string", description: "Corrected input parameters provided by teacher" },
        explanation: { type: "string", description: "Explanation of why the fix works" },
        teacher_model: { type: "string", description: "Teacher model identifier" },
        project: { type: "string", description: "Optional project filter" }
      },
      required: ["tool_name", "failed_input", "error_message", "corrected_input", "explanation"]
    }
  },
  // Multi-Agent Resilience Gate
  {
    name: "krusch_context_evaluate_resilience",
    description: "Emergence World Multi-Agent Resilience Gate (arXiv: 2609.17320): Evaluates multi-agent execution traces and inter-agent handoffs for cascading failures, circular deadlocks, and credential leakage.",
    inputSchema: {
      type: "object",
      properties: {
        handoffs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              senderId: { type: "string" },
              recipientId: { type: "string" },
              message: { type: "string" },
              status: { type: "string", enum: ["SUCCESS", "ERROR", "FAILED", "PENDING", "RESOLVED"] },
              error: { type: "string" }
            },
            required: ["senderId", "recipientId", "message"]
          },
          description: "Array of inter-agent handoff trace events"
        },
        max_cascade_depth: { type: "number", default: 2, description: "Maximum allowed consecutive error cascade depth" }
      },
      required: ["handoffs"]
    }
  }
];

export const handlers = new Map([
  ['krusch_context_log_agent_failure', (args) => logAgentFailure(args)],
  ['krusch_context_search_failures', (args) => searchFailures(args)],
  ['krusch_context_get_recovery_pattern', (args) => getRecoveryPattern(args)],
  ['krusch_context_register_pipeline_operator', (args) => registerOperator(args)],
  ['krusch_context_inspect_pipeline_registry', (args) => inspectOperatorRegistry(args)],
  ['krusch_context_mutate_pipeline_dag', (args) => mutatePipelineDag(args)],
  ['krusch_context_setwise_rerank', (args) => setwiseRerank(args)],
  ['krusch_context_update_research_state', (args) => updateResearchState(args)],
  ['krusch_context_arex_audit', (args) => auditResearchConstraints(args)],
  ['krusch_context_manage_lifecycle', (args) => manageContextLifecycle(args)],
  ['krusch_context_audit_budget', (args) => auditContextBudget(args)],
  ['krusch_context_distill_teacher_memory', (args) => distillTeacherMemory(args)],
  ['krusch_context_retrieve_teacher_distillation', (args) => retrieveTeacherDistillation(args)],
  ['krusch_context_distill_function_memory', (args) => distillFunctionMemory(args)],
  ['krusch_context_evaluate_resilience', (args) => handleEvaluateResilience(args)]
]);

export const extension = {
  name: "research",
  description: "AI Watch Research Suite — ArXiv experimentation engines (AgentDebugX, DataFlow, Setwise, AREX, ACM, Distillation, Resilience Gate).",
  init: initResearchTables,
  tools,
  handlers
};

export default extension;
