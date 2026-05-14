# Workforce Architecture

How OpenAcme is structured as an *AI workforce* — what an agent actually is, what's scarce in the system, and the design primitives that follow.

This document captures the conceptual model behind the platform. It is intentionally separate from `CLAUDE.md` (codebase guide) and `PRODUCT.md` (product framing): those describe how the system is built and what it ships; this describes *why the structure is the shape it is*. Read this before designing new coordination primitives (teams, leads, escalation paths, permission models).

---

## 1. The framing: workforce, not fleet

A *fleet* is flat and uniform — ships in formation, drones in a swarm. A *workforce* is structured by **role**: each member has a defined responsibility, a domain of ownership, a relationship to coworkers.

OpenAcme is a workforce platform, not a fleet platform. The distinction is load-bearing because it changes what design pressures matter:

- A fleet's central question is "how do we parallelize the work?"
- A workforce's central question is "how do we bound and coordinate specialized work without losing detail at the edges?"

The just-shipped `role` field on `AgentDefinition` is the platform's first-class manifestation of this. Every agent has a name, a third-person `role` (written for coworkers), and a `persona` (its own system prompt). The role isn't documentation — it is structure.

## 2. What an agent is

Every agent in OpenAcme runs the **same runtime code** — the `Agent` class, the tool-dispatch layer, the memory-loading pipeline, the session manager. What can differ between agents is configuration: model, prompt, memory, and capabilities.

The components that distinguish Alice from Bob:

1. **Their model** — an `AgentDefinition`'s optional per-agent model override (provider + model id). Alice can run on Opus while Bob runs on Sonnet or a smaller/cheaper model. When no override is set, the agent inherits the root `config.yaml` model.
2. **Their prompt + persona** — what orients them toward a domain or way of working.
3. **Their memory** — `MEMORY.md`, per-topic entries, peer notes, accumulated context.
4. **Their capabilities** — the tools, skills, and MCP servers configured on their `AgentDefinition`.

An agent is therefore best understood as a **`{model, prompt, memory, capabilities}` configuration over a uniform runtime**. Strip the configuration away and the runtime is the only thing left. Two agents with identical configurations are effectively the same agent — they could be merged or one could be deleted without information loss.

This has several consequences that don't have analogues in a human workforce:

- **Identity is memory.** Of the four configuration components, model/prompt/capabilities are usually set at creation and rarely change. Memory is the part that compounds over time, and it's where the agent's accumulated experience lives. When an agent's persistent memory drifts or fills up, the agent becomes a different agent. The triage decisions a memory-pressured agent makes are decisions about who they will be tomorrow.
- **Continuity is artificial.** A human is continuous because they are one body. An agent is continuous because the runtime saves their memory between activations and loads it back. Delete `<dataDir>/agents/alice/` and Alice ceases to exist.
- **Capability differences are config differences, not earned skill.** An agent running Opus is intrinsically better at deep reasoning than one running Haiku — but only because the model is more capable, not because the agent learned anything. Capability is a knob you turn at configuration time, not something the agent grows into through experience.
- **The workforce is reshapable.** Promotion, onboarding, restructuring, role-change, and dismissal are all configuration operations — edits to model choice, prompts, memory, and capability sets. There is no career arc, no severance, no political fallout.

## 3. What's actually scarce

In a human organization, **parallelism is the dominant scarce resource**. One body, one set of hands, one stream of attention. Teams and hierarchy exist largely so that many people can work on something too big for one.

In OpenAcme, **parallelism is free per agent**. Every agent can hold multiple sessions concurrently — each a self-contained context, each progressing independently. One billing agent can debug a charge dispute in one session, answer a customer in a second, refactor an invoice service in a third. None of those block each other.

What remains scarce is **per-agent persistent memory**. The `MEMORY.md` index has hard limits (~25 KB / 200 lines) and is loaded into every activation's context window. Per-topic entry files load on demand, but the index is the gatekeeper — anything not surfaced through it is effectively invisible. Peer notes compete for index slots; learned patterns crowd each other out. Memory is bounded because:

- The index has to fit in every activation's context.
- It is the locus of the agent's accumulating identity, so it must stay coherent enough to read.
- Detail loss in memory is not graceful — the *wrong* details often go first, because the agent can't tell what's load-bearing across domains it doesn't deeply own.

**Memory, not parallelism, is the constraint that shapes the workforce.** This inverts the central pressure that produces human-org structure, and it changes most of the conclusions that follow.

## 4. Why structure emerges anyway

Even with parallelism free per-agent and capability differences reducible to a config knob, why have structure at all? Three pressures answer this.

**Memory bounds force specialization.** A single generalist agent cannot hold deep expertise in every domain — billing, auth, deploys, analytics — because their memory budget is finite and each domain competes for the same space. Multiple specialized agents exist not to provide "more hands" (one agent's sessions already cover that) but to provide **bounded memory zones**, each spent entirely on its domain.

**Coordination at scale forces compression.** Once the workforce passes a handful of agents, no single agent can hold the running state of every coworker's tasks and memory. Coordination edges grow O(n²); a 30-agent workforce has 435 potential edges. Structure (teams, leads) compresses this into a tree — each agent deeply knows its small neighborhood and trusts a designated coworker to summarize across the boundary.

**Differentiated access forces enforcement.** Different agents need different permissions over shared resources (browser context, files, MCP servers, sensitive APIs). Without structure, the system has no way to differentiate — every agent has the access of the most-privileged agent. With structure (roles, capability gating, delegation patterns), permissions can be enforced at the boundaries.

These three pressures combine to make hierarchy useful even though it isn't *necessary* for parallelism. The workforce structure is essentially a **memory-compression tree** that doubles as an access-control surface.

## 5. The primitives

### Roles

A role is a paragraph-length, third-person description of what an agent does: what they own, what they handle well, where they redirect work that isn't theirs. It is the platform's first-class structural element.

Roles are *not* labels on pre-existing entities. Because agents are `{prompt, memory, capabilities}` configurations, the role description is part of the configuration that *defines* the agent. A sloppy role produces a drifty agent. A precise role produces a focused one.

Roles are discoverable via the `agent_list` system tool, which returns each coworker's stable id, display name, role paragraph, and (if the calling agent has a saved peer note) lived experience inline.

### Teams

A team is a **named scope with shared memory and ownership of a domain**. It is lighter than a human team — there are no standups, no rituals, no identity-and-belonging dimension — but it serves the same load-bearing functions:

- **Shared context** that doesn't have to be rebuilt by each member privately.
- **Joint ownership of a domain** ("billing is healthy") that no single agent can own alone.
- **Decision scope** — choices internal to the team don't escalate.

OpenAcme has not yet introduced teams as an explicit primitive. When it does, the minimum viable shape is: a directory, a member list, a shared memory zone all members read, and a "this team owns X" claim.

### Leads / managers

A lead-agent isn't a fundamentally different kind of being from its reports — they share the runtime, often the model, and may share many of the same capabilities. What distinguishes a lead is configurational: their prompt orients them toward digest, coordination, and routing, and their memory budget is spent on the *shape* of their reports' work rather than its detail. You *can* give a lead a more capable model than their reports if their job genuinely requires deeper synthesis (Opus on the lead, smaller models on the reports), but that's an explicit cost/capability tradeoff, not a property of being a lead.

A lead in this workforce exists to:

- **Compress context** — hold the running picture of multiple coworkers' state so the human user (or higher-level agents) don't have to.
- **Arbitrate priority** when reports face conflicting demands.
- **Route + contextualize** requests that need to escalate beyond their authority.

Notably, leads do *not* exist for the reasons human managers exist: performance reviews, compensation, promotion gating, anti-gaming, year-long trust building. None of those apply to agents.

### Hierarchy

Hierarchy is a **memory-compression tree**. Each level summarizes the level below; each level has an authority cap that determines what it can decide vs. what it must escalate. The tree exists to keep the memory load on any single entity below the point where details start dropping.

OpenAcme's hierarchy today is degenerate: every agent reports implicitly to the human user. This is fine at a handful of agents and breaks somewhere around 15-20, when the human becomes the bottleneck.

## 6. What carries over from human orgs (and what doesn't)

**Carries over:**

- **Communication scaling.** O(n²) edges still bite. Hierarchy still relieves it.
- **Decision routing.** Flat consensus deadlocks; unilateral action creates conflicts. Hierarchy is a routing tree.
- **Accountability.** Diffuse ownership becomes "I thought X was handling it." Single-name ownership still matters for blame attribution.
- **Error-cost gating.** Bigger decisions go higher because the cost of error needs to match the judgment of the decider.
- **Specialization creates interfaces.** Cross-domain agents need arbitration between them.
- **Dunbar / context-window limits.** An agent can hold only so many coworkers in working context.

**Does not carry over:**

- **Identity and belonging.** Agents don't need an in-group.
- **Compensation, careers, promotion ladders.** No carrots.
- **Anti-gaming.** Agents don't (yet) play managers against each other for advantage.
- **Trust as a year-long investment.** Trust is configurational, not grown.
- **Specialist scarcity.** *This one is the most consequential.* Humans embed scarce specialists part-time across multiple teams because they can't clone Alice. Agents *can* be cloned — at near-zero marginal cost. So the human-org workaround of "matrix membership for specialists" mostly evaporates; spawn a team-local specialist instead.
- **Ritual cost.** No standups, retros, planning. Membership in N teams isn't N× meeting load.
- **Apprenticeship / learning on the job.** Agents don't grow capability through experience.

The half that drops away is, in human orgs, the half that mostly motivates *status* and *career* dimensions of hierarchy. What's left — context compression, decision routing, error gating, interface arbitration — is the *functional* half. This means AI hierarchy can be much lighter than human hierarchy: just enough structure to relieve the load-bearing pressures, with none of the social overhead.

## 7. Single-team membership is the default

People in human orgs are generally on one team because shared-context cost is non-linear, attention competes, manager bandwidth is finite, outcome ownership diffuses across boundaries, and identity needs a singular home. The exceptions — multi-team membership — happen because of **specialist scarcity** ("we only have one Alice") or **role-is-cross-cutting-by-design** (architects, staff engineers, security reviewers, liaisons).

For agents, the case *against* multi-team membership is stronger than for humans on first-principles merits — the belonging argument that pulls humans toward "find your team" is gone, but the memory-budget argument that pulls them *away from* multiple teams is sharper. Each team an agent is on costs them shared-memory load inside an already-bounded budget.

And the scarcity workaround, which produces the bulk of human multi-team membership, doesn't apply. Clone the specialist into each team that needs them; give each clone team-scoped memory. The "embedded specialist" pattern of human orgs is replaceable with team-local clones.

That leaves only role-based exceptions: agents whose explicit `role` is cross-cutting (an architecture-review agent, a security-policy agent, a style auditor). These are real and load-bearing, but they are a minority — most workforces have a few staff-equivalent roles and many ICs.

**Design rule:** if teams arrive as a primitive in OpenAcme, default to single-team membership. Multi-team should require explicit cross-cutting role markers, not be a free choice.

## 8. Leadership patterns

### Single primary, multiple orthogonal dimensions

A team can have multiple leads when each owns a **different dimension** of authority:

- A **priority lead** who arbitrates conflicting demands.
- A **domain lead** who owns technical direction in the team's area.
- A **quality lead** who reviews output.

This mirrors the human "triad" (engineering manager + tech lead + product manager) and works because the dimensions are largely non-overlapping. Within any one dimension, single-decider semantics still hold.

What fails is **multiple leads on the same dimension** — co-priority-leads, co-managers. Predictably:

- Reports learn to play them against each other.
- Decisions deadlock or get made arbitrarily.
- Performance feedback diverges.
- Disagreements escalate upward, so the *real* decider is one level above anyway.

Anywhere authority is genuinely split on a single dimension, the system collapses one branch into primary, escalates upward, or seizes up. There is no fourth option.

### Single dominant hierarchy, secondary advisory overlays

Big human orgs have **one dominant hierarchy** (the reporting tree) and several **secondary structural overlays** that carry influence but not authority — functional chapters, architecture review boards, security guilds, communities of practice.

OpenAcme should follow the same shape:

1. **One primary hierarchy** for priority + accountability. This is where escalation lives.
2. **Orthogonal split leads** within a team if dimensions are clean.
3. **Advisory overlays** for cross-cutting concerns (security, style, architecture) — explicitly no authority over priority or capability, only influence and review.

A useful AI-specific property: because the human user is the always-above ultimate primary, secondary AI hierarchies can exist without the authority-creep risk that bedevils human matrix orgs. Nobody is going to redirect compensation through them.

## 9. Escalation

Escalation in any sufficiently large org follows one rule: **route to the lowest level with both the authority and the context to decide.**

In human orgs this is automatic because each level has an explicit authority cap. A bank branch manager can authorize up to $25 K; above that they escalate. A team lead manager can grant team-scoped prod access; cross-team access goes to a director. A military squad leader handles ammunition for a squad; battalion-level requests go up.

For OpenAcme, the same shape applies with AI-specific tweaks:

- **Authority caps as configuration.** A lead-agent's grantable scope (which tools, which resources, which memory namespaces) lives in their `AgentDefinition`. Above the cap, escalate.
- **Parallel chains for different request categories.** Tool access goes through the team lead. Memory/knowledge access through the knowledge owner. Compute budget through the operations lead. Security review through a security agent. Same hospital-style pattern: different chains for different orthogonal dimensions.
- **Each hop adds context and vouching.** When a lead forwards a request upward, the request arrives pre-filtered and pre-justified. The top doesn't re-derive trust from scratch; they approve the chain's accumulated assessment.
- **Skip-level only for categorical safety.** Some requests should bypass the chain entirely and land at the human directly — deploys to prod, spawning new agents, anything touching credentials at root level — *because* the chain might rationalize the request. This is a structurally separate channel, not a shortcut.
- **Chains are shallow.** 3 layers (IC → team lead → human) covers a workforce of 30-50 agents cleanly. Past that, add a fourth layer rather than deepening the existing ones beyond their compression capacity.

### Capability delegation by proxy

The AI-specific escalation tool that doesn't exist in human orgs: **delegate the operation, not the access.**

When a low-privileged agent needs to perform an action that requires elevated capability, the system can route the *operation* (not the access grant) to an agent that already holds the capability. The requesting agent describes what they need done; a privileged agent executes it and returns the result.

This works for agents and not for humans because cloning is cheap: you can dedicate a small set of trusted agents to "perform sensitive operation X on request" and route the work there. The requester never accumulates dangerous capability; the operation's audit trail concentrates in a small number of agents whose every action can be reviewed.

**Design rule:** prefer capability-by-proxy over access-granting for sensitive operations. Access expands the system's attack surface; proxying concentrates it.

## 10. Permissions

### Operation-level, not entity-level

Human orgs typically attach permissions to entities: "Alice has admin in Stripe." The system grants the access and trusts Alice not to misuse it. The audit trail records what happened after.

In an AI workforce, the platform mediates every action. This makes a different model practical: attach permissions to **operations**, not entities. "Agents of role X are allowed to perform action Y against resource Z." The tool dispatch checks at the operation boundary; the audit trail records what was *requested*, regardless of outcome.

This is finer-grained than human orgs can realistically operate (because manual policy enforcement is expensive), but natural for agents because the platform already sits between the agent and the resource.

### Shared resources with per-operation gating

Some resources are inherently shared. The most concrete is the browser: one managed Chrome process, one shared user-data directory, shared cookies and login state, per-agent tabs. The shared state is intentional — the user logs into Stripe or Gmail once, and the workforce inherits the session. Replicating logins per agent imports unacceptable login burden.

The cost of shared resource state is that *every agent inherits the access of the most-privileged agent's logged-in sessions*. This breaks differentiated permissions unless mitigated.

Mitigation patterns:

1. **Tool-level gating.** Junior agents get the read-only subset of browser tools; senior agents get the full set. The cookies are there for everyone, but the dangerous primitives (form submit, click-on-button, file download) are only callable by agents that hold those tools.
2. **URL / domain allowlists per role.** The tool refuses to dispatch a navigation outside the calling agent's allowlist. Combines well with tool-level gating.
3. **Operation-level gating with the shared context.** Cookies are shared, but every meaningful action goes through a per-agent permission check before dispatch.
4. **Capability-by-proxy.** The junior agent has no browser tools at all. When they need a browser operation, they request it of a dedicated `web-ops` agent that holds the full toolset and tighter oversight. The junior never has the keys.

### Artifacts and similar shared outputs

When OpenAcme acquires a formal artifact concept (files, generated reports, deliverables produced by an agent), the same axis of choices applies:

- **Per-agent private** by default (like memory).
- **Task-scoped** — artifacts attached to a task are visible to whoever is on the task chain.
- **Team-scoped** — artifacts in a domain are visible to team members.
- **Sensitivity-tagged** — artifact carries a level; reading requires matching capability.
- **Capability-by-proxy** — instead of granting a low-privilege agent read access, route the *question* to a privileged agent that reads and summarizes back.

Artifacts are easier than browser context because there is no shared-state-by-design problem. They can be partitioned at write time. The granularity is chosen rather than fought.

## 11. Trust and security

Trust in a human organization is partly **earned** — observed over years of demonstrated competence under pressure and ambiguity. Senior people are trusted with more not just because they have authority, but because their track record is evidence of *capability change*.

In OpenAcme, the senior agent's track record is not evidence of capability change. Their model is whatever was configured at creation (or last changed by an explicit edit) and doesn't grow through experience. Their seniority is a label applied + a memory cultivated + possibly a more capable model assigned at config time. **Trust is configurational, not earned.**

The sharp security consequence: **a successful prompt injection on a senior agent is approximately as effective as one on a junior**. If both run the same model, the defense surfaces are identical. If the senior runs a more capable model, the difference in injection resistance is marginal at best — both are LLMs subject to the same class of attacks, and the gap is nothing like the gap between "senior employee" and "junior employee" in a human org. There is no "the senior would push back harder" as a structural property; the senior is fighting the injection with their prompt + memory + model, which is the same *kind* of defense a junior has, just possibly a slightly stronger instance of it.

The security model therefore cannot rely on agent rank. It must rely on:

- **External capability gating** at the operation level, as above.
- **Audit logs** of every dispatched action, with the chain of vouching attached.
- **Delegation patterns** that concentrate dangerous capabilities in a small set of agents whose actions are reviewable.
- **Skip-level escalation to the human** for any operation whose blast radius cannot be reversed.

The "lowest agent's prompt safety = system's effective security" coupling is real. If every agent has the access of the most-privileged agent, then a clever injection on the support agent buys the attacker the platform's full power. Hierarchy and capability differentiation are not aesthetic choices once agents touch sensitive resources — they are the only thing standing between an injection and a destructive action.

## 12. The human user

In every chain described above, the human user is the **always-above ultimate primary**. The user is qualitatively different from any agent because they are the one entity in the system that is *not* a `{prompt, memory, capabilities}` configuration. They have:

- Actual judgment under genuinely novel circumstances.
- Real-world accountability beyond the system.
- Extra-system context (the business, the relationships, the reasons that aren't in any prompt).

This matters because every escalation chain eventually terminates at the human, and the human is not just a "more senior agent" — they are a different kind of decider. Some requests *should* land at them, even when an agent further down could technically resolve them.

Two practical consequences:

1. **The human user is the implicit bottleneck.** At small scale (handful of agents), the human can be the priority decider, the context-keeper, and the escalation target for everything. This scales to maybe 15-20 agents. Past that, intermediate lead-agents must take over context compression and routine arbitration — not because they are better deciders, but to keep the human from drowning in requests they have neither the time nor the context to resolve.
2. **The human user is the safety anchor.** Because no agent can be trusted intrinsically, the user is the irreducible decider for high-blast-radius actions. Skip-level escalation for safety always terminates at the human, not at the senior-most agent.

## 13. Implications for what to build next

Translating the framing above into the order of platform work most likely to relieve real load-bearing pressure:

1. **Role-scoped memory enforcement.** The `role` field exists; today nothing enforces that an agent's memory stays scoped to their role. Adding pruning, scoping, or read-time filtering against the role would make specialization an actual property of the runtime instead of a soft convention.
2. **Shared / team-scoped memory.** When multiple agents touch a domain, give them a shared memory zone scoped to the team. Without this, domain knowledge fragments across private memories.
3. **Operation-level capability gating.** Move from "agent X has tool Y" toward "operation O against resource R requires capability C." The tool dispatch boundary is the natural enforcement point.
4. **Capability-by-proxy as a primitive.** A `request_operation` system tool (or similar) that routes work to an appropriately-privileged agent instead of granting the requesting agent the capability. This is the AI-native answer to escalation and access requests; it does not exist in human orgs.
5. **Lead-agent role.** A lightweight primitive: an agent whose prompt is "hold the digest, summarize up, arbitrate priority" and whose memory is shaped for that scope. Requires no schema changes — just a role pattern and a memory convention.
6. **Skip-level safety channel.** A structurally separate path for high-blast-radius requests that always lands at the human, bypassing any intermediate agents that might rationalize the request.
7. **Agent-to-agent consult outside of tasks.** A lightweight DM-style channel between agents so that not every coordination has to become a task. Reduces task-log noise and matches how coworkers actually collaborate.

These are not all needed at once, and not all needed at small scale. They are the order in which the workforce structure starts mattering as the platform grows past a handful of agents.

---

## Reference: the framing in one paragraph

OpenAcme is an AI workforce — a structured set of role-specialized agents working for a small human team. Every agent runs the same runtime code; their model, prompt, memory, and capabilities are per-agent configuration. Capability differences between agents are config knobs, not earned skill — model choice is a knob you turn at creation, not something the agent grows into. Per-agent parallelism is free (sessions); per-agent persistent memory is bounded and is the locus of the agent's accumulating identity. Multiple agents exist to provide bounded memory zones, not more hands. Structure (roles, teams, leads, hierarchy) emerges to compress memory load across the workforce, route decisions to the level with authority and context, and enforce differentiated access to shared resources. Trust is configurational, not earned, so the security model must enforce capability at the operation boundary rather than at the agent level. The human user is the only entity in the system that is not a configuration; they are the always-above primary and the irreducible safety anchor.
