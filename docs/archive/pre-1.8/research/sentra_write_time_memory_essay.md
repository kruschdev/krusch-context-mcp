# MCP and Write-Time Memory: The Finger and the Moon

The first time you connect Claude to a real tool and watch it work, it feels like the future has arrived. It can read a file, inspect a database, search a repo, open a ticket, call an API, and stitch together an answer from systems that used to require ten browser tabs and a lot of patience. That moment is real. MCP is a big deal because it turns tool access into infrastructure instead of bespoke glue.

The official MCP docs describe it as an open-source standard for connecting AI applications to external systems, and use the analogy of a USB-C port for AI applications. Anthropic introduced MCP as a way to connect AI assistants to the systems where data lives, replacing fragmented custom integrations with a single protocol.

I agree with the direction completely. Agents need a standard way to reach files, databases, SaaS apps, internal systems, workflows, and APIs. Without something like MCP, every AI product becomes a pile of custom integrations with slightly different auth, schemas, permissions, and failure modes. But there is a category error hiding inside the excitement: MCP moves context. It does not create context.

There is an old Zen warning about not mistaking the finger pointing at the moon for the moon itself. The finger is useful because it points you toward reality, but it is not reality. The same metaphor appears in Zen discussions of the finger and moon: the pointing finger is the expression or tool, while the moon is what the tool is meant to reveal.

The protocol is the finger; company context is the moon. That does not make the finger unimportant. The finger matters because it points the model toward the systems where work happens. The mistake is believing that access to those systems means Claude now understands the company.

The agent can fetch more data, search more places, call APIs, pull the latest ticket, read the latest doc, inspect the latest Slack thread, and look up the latest account record. For level-one tasks, this is often enough. If the question is “what is the status of this ticket?” or “summarize the last call” or “find the contract renewal date,” query-time access through MCP may work beautifully.

That level-one magic is why MCP will spread fast. It makes agents feel connected to the real world. It turns isolated chat into tool-using software. The more tools you connect, the more useful the agent becomes, at least at first.

The problem starts when the work requires context that lives between tools. A churn risk is not sitting neatly inside Salesforce. It may emerge from a renewal date in CRM, a frustrated customer call, a missed support follow-up, a roadmap delay, a Slack thread where an engineer explains the real blocker, and an executive comment in a meeting. MCP can move each piece into the agent’s view. It does not automatically know that those pieces form one evolving risk.

A product decision rarely lives cleanly in the PRD. It may live across the original customer request, the engineering objection, the design review, the legal constraint, the compromise made in a meeting, the ticket that captured only half of it, and the code path that later became the real decision. A connector can retrieve the artifacts. It does not automatically preserve the decision.

The phrase “context layer” matters because raw access gives the agent artifacts, while context gives the agent structure. It tells the agent what those artifacts are, how they relate, whether they are still current, who can see them, and why they matter for the task.

That requires semantics and ontology. Semantics tells the system what something is: a customer promise, a blocker, a stale decision, a repeated complaint, a dependency, an owner, a contradiction. Ontology tells the system why that thing matters from a perspective. The same artifact can look like renewal risk to sales, roadmap pressure to product, escalation severity to support, execution drift to leadership, or an architectural constraint to engineering.

MCP gets the agent to the systems, but the semantic state of the company has to live somewhere else. The next objection is obvious: why not create that context at query time? Give Claude access to all the tools, let it search, let it reason, and have it build the context on demand.

You can do a lot that way. Anthropic’s context engineering guide describes “just in time” context strategies where agents load information at runtime using references like file paths, stored queries, and web links. That approach is useful, and every serious agent system will use some version of it.

But query-time context has a ceiling. At query time, the agent is reconstructing the world after the fact. It has to identify the relevant systems, search them, resolve identities, compare timestamps, detect stale artifacts, reconcile contradictions, infer permissions, and decide which retrieved pieces matter. It is doing all of that while also trying to answer the question or perform the task. That is fine for shallow context. It breaks down for organizational memory.

The reason is simple: some meaning is easiest to capture when the work happens. A customer promise is clearest at the moment it is made. A decision change is clearest when the meeting ends. A contradiction is clearest when a new action conflicts with an old commitment. A handoff is clearest when ownership moves. If the system waits until query time, it has to rediscover those state changes from residue.

Write-time memory means the system curates meaning as work enters the organization. When a call happens, a ticket changes, a doc is edited, a customer promise is made, or a decision is reversed, the memory layer records the state change with provenance, permissions, relationships, and ontology. It does not wait for an agent to ask the perfect question later.

The easy thing to miss is that query time retrieves artifacts, while write time captures state transitions. Artifacts are things; state transitions are what changed. Companies do not run on artifacts alone. They run on changes: this customer moved from happy to at risk, this decision moved from open to accepted, this owner changed, this project drifted, this promise was made, this assumption became false.

If you only build context at query time, every agent has to rediscover those transitions again. It burns tokens, wastes time, and often misses the weak signal because the weak signal did not look important until later.

Model quality alone will not solve this problem. Models are improving quickly, and the best agentic systems are already starting to converge around similar patterns: tools, memory, compaction, planning, subagents, retries, evals, and context management. Claude may be ahead in one agentic loop today, another system may catch up tomorrow, and the frontier will keep moving.

When models and agents converge, the differentiator becomes the state they can act from. Level one is connecting Claude to tools. That is necessary, and it will feel magical for a while. Level two is making sure the agent is not merely pulling fragments from tools, but acting from a maintained understanding of the company. That understanding has to live in the intermediate layer between the tools and the model.

This layer is a semantic memory system, not a chatbot, a bigger prompt, or a vector database with more connectors. It maintains identities, relationships, decisions, commitments, contradictions, permissions, provenance, and action traces as work happens.

That is what we have been building at Sentra through the Company Brain work. MCP and connectors are part of the story because the agent has to reach the systems. But the deeper problem is what happens before the query: how the company’s work is turned into memory, how memory becomes context, and how context becomes usable by agents without rebuilding the organization from scratch every time.

MCP is the wire through which memory flows. The next enterprise AI stack will not be “Claude plus every connector.” It will be models connected to tools through protocols, grounded by a semantic memory layer that is maintained as work happens. MCP lets agents reach the company. Memory lets them understand it.

At Sentra, where we are building what can be only described as a "company brain", a shared intelligence/memory layer that sits on all communication channels, knowledge bases, action and agent traces to understand how everyone in an organization actually works as well as how work actually gets done, constructing a living world model of the entire company in near real time.
