# Interaction Memory: The Ontology of Human Coordination
**Author:** Ashwin Gopinath

Almost everything important in a company happens in meetings, messages, or emails. That sounds exaggerated until you start listing the actual places where decisions are made. A customer complains on a call. A sales rep promises a workaround. A manager says a project is blocked, but only after someone asks twice. A founder changes the priority in a five-minute Slack exchange. Legal approves something with conditions. Engineering agrees to ship, but only if one assumption holds.

Later, some artifacts appeared. A ticket. A CRM update. A roadmap note. A line in a launch doc. By then, the real context has already been compressed.

The last post was about factual memory: what happened, where the source is, who owns it, when it changed, and how things connect. Interaction memory is different. It is not the memory of artifacts. It is the memory of what happened between people before the artifact existed.

Its goal is to preserve the parts factual memory usually drops: why something happened, how people expected the work to be done, what constraint mattered, which assumption was fragile, and what was left unsaid. Interaction is the chain of thought of the organization. It is the trace of how a group moved from partial information to judgment.

That difference matters because companies do not make most decisions inside databases. They make them in conversation. The database records the aftermath. A CRM field may say an account is at risk, but the customer call explains the real objection. A roadmap document may say launch moved by two weeks, but the meeting explains the tradeoff. A ticket may say SSO is needed, but the sales conversation explains why it mattered and who made the promise.

Human-human interaction is still upstream of human-agent interaction. Agents matter, and agent traces will matter more over time. But today, most agent work inherits its purpose from human conversations. The agent may draft the email, update the ticket, summarize the thread, or execute the workflow. The reason the work exists usually came from people talking to each other.

If factual memory is the company remembering its artifacts, interaction memory is the company remembering how meaning was created.

A transcript is not enough. A summary is not enough. Even a good meeting note is only a surface representation of the interaction. The hard problem is interpretation. What was actually decided? What was implied but not said? What did people disagree about? Which objection was real? Which commitment was made casually but will later matter?

Ontology is the word for this problem. An ontology is the set of concepts and relationships a system uses to make sense of a domain. In a company, the ontology decides whether something in a conversation is a decision, commitment, objection, escalation, dependency, assumption, customer pain, owner, precedent, or open question. Those labels are not just metadata. They decide what gets remembered.

Take a boring sentence from a meeting: “We can ship this Friday if legal signs off and Acme is okay with the beta limitation.”

A transcript stores the sentence. A meeting summary might say the team discussed the Friday launch. Interaction memory has to see the structure underneath. From a product lens, this is a launch plan with a constraint. From a legal lens, it is an approval dependency. From a customer lens, it is a conditional commitment to Acme. From a sales lens, it may be a deal risk. From an action lens, it contains follow-ups. From an executive lens, it is not actually a closed decision.

Humans do this naturally. We hear the same sentence differently depending on the customer, the project, the speaker, the history of the account, and what happens if the interpretation is wrong. Existing systems usually do not. They store the sentence once, attach a summary, and hope retrieval will recover the meaning later.

Interaction memory cannot be a static note archive. The meaning of an interaction depends on the ontology used to interpret it. Change the ontology, and the same interaction can mean something different. A casual objection from a customer can later become evidence of churn risk. A technical concern in an architecture meeting can later explain why a launch slipped. A one-line approval in an email can later become precedent.

The company has to be able to reread its own past.

Humans do this all the time. Something that seemed like a minor complaint becomes important after three more customers repeat it. A vague concern becomes the thing everyone should have listened to. A decision that looked settled becomes obviously conditional once the missing assumption shows up. A real Company Brain should be able to do some version of that.

Here the context graph matters. A context graph is the structure connecting people, teams, customers, projects, commitments, decisions, risks, assumptions, dependencies, and time. Interaction memory should update that graph. A meeting should not only produce a note. It should change the map of what the company believes, what it has promised, what remains unresolved, and what should happen next.

The diagram version of this is clean. The real version is messy. People hedge. They disagree politely. They imply ownership without assigning it. They make decisions without announcing that a decision has been made. They refer to prior context with phrases like “same issue as last time” or “the enterprise thing.” They move between strategy, emotion, execution, and politics in the same ten minutes.

A useful system has to know what to remember and what to ignore. Too little memory, and the company keeps forgetting why things happened. Too much memory, and the system becomes noisy or creepy. Interaction memory sits very close to how people think, negotiate, disagree, and change their minds. If you get the product wrong, it feels like surveillance. If you get it right, it feels like the company finally stopped losing the thread.

That means permissions and boundaries are not a detail. Some interactions are personal. Some are team context. Some are company records. Some can be summarized but not quoted. Some should contribute to aggregate memory without exposing the raw conversation broadly. A Company Brain has to understand those differences, or people will not trust it with the most important context.

It also means the interface cannot just be a meeting recorder. Recording, transcription, and action items are useful, but they are not the category. The interface should help before, during, and after an interaction. Before a customer call, it should surface prior commitments, open issues, decision history, and unresolved questions. After a meeting, it should identify decisions, assumptions, risks, and follow-ups. Weeks later, it should notice patterns across interactions that no one person is holding in their head.

For an IC, interaction memory might answer: “What did we decide in the last architecture discussion, and what assumptions still need validation?” The answer should not be a transcript. It should say what changed, what stayed open, who owned the next step, and which prior discussions matter.

For a manager, the question might be: “Which commitments did my team make across customer calls and internal meetings this week?” The answer should connect human promises to tickets, owners, deadlines, and risks. It should also notice the awkward cases: commitments that were implied but never assigned, or decisions that different people understood differently.

For a CEO, the question is often broader: “Where are teams making decisions from different assumptions?” This is where interaction memory becomes much more than note-taking. It can show that sales believes a feature is committed, product believes it is exploratory, engineering believes it is blocked, and support believes it is already late. No dashboard will show that cleanly. The truth lives in interactions.

The proactive version is the interesting one. A Company Brain should notice when the same objection appears in three customer calls. It should notice when two teams use conflicting definitions of the same metric. It should notice when a decision keeps getting reopened because the original tradeoff was never recorded clearly. It should notice when an owner is implied but never named. It should notice when an escalation has quietly become a product signal.

Here is the bridge between memory and action. Factual memory can tell you what exists. Interaction memory tells you what people meant, debated, promised, and left unresolved. It preserves the organizational reasoning that rarely makes it into the artifact. Without it, agents will keep operating downstream of incomplete context. They may retrieve the ticket, draft the email, or update the CRM, but they will not know the human reason the work matters.

That is why I think the Company Brain problem starts with human communication. Not because documents and data are unimportant. They are obviously important. But the company’s meaning is created in interaction before it is formalized anywhere else.

Interaction memory is the second layer of a Company Brain. It turns meetings, messages, emails, calls, complaints, and debates into structured memory. But it still does not complete the loop. Once the company remembers what happened and understands what the interaction meant, it has to coordinate what happens next.

That is the third layer: action memory.
