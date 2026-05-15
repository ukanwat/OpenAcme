# Product

## Register

product

## Users

Operators of small, agent-heavy organizations — solo founders or tight teams whose explicit thesis is "minimum humans, maximum agents." The primary user is technical and runs the daemon. Secondary users are technically-curious operators and collaborators who don't live in a terminal but need to see what the agents are doing, what's running, and what's been said.

The job-to-be-done is not "talk to an AI." It's *operate a workforce of agents* — inspect their state, route work to them, read their output, intervene when they go off-track. The UI is a control surface for that workforce, not an assistant chat tool. Multi-human is allowed; multi-tenant SaaS-style team collaboration is not the goal.

## Product Purpose

OpenAcme is the substrate for organizations whose workforce is agents. The web UI is the human-facing console: where operators see the fleet (agents, sessions, tasks, processes, memory), read what each agent is doing, and intervene by chat, configuration, or scheduled work. Success is the user feeling like they oversee a small workforce — not like they're using a chatbot with extra panels.

## Brand Personality

Tactile and exact. Quiet on copy and color, with visible craft in small details (hairline rules, monospace metadata, weighted motion, real keyboard affordances). Made-by-a-person, for people who care that the tool is a tool. Three words: **instrument, deliberate, durable**.

Voice: short, declarative, no hedging. Labels say what they do. Errors are direct ("session 8a3f not found") not apologetic ("oops, something went wrong"). No exclamation points, no emoji in product copy, no marketing tone.

## Anti-references

- **Generic SaaS dashboard** — KPI tiles, gradient hero, sky-blue primary, stock illustrations, "14-day free trial" cadence. This is not a sales surface; it is an operating surface.
- **Cute consumer app** — rounded everything, mascots, smiling robots, pastel palette, friendly emoji peppered through UI.
- **ChatGPT / Claude.ai chat-wrapper** — centered input, two-column with chats sidebar, soft cards, pastel illustration empty states. The product is an agent fleet; framing it as a chat tool obscures what it is.
- **AI-startup neon / glassmorphism** — dark + radial gradient + glass blur + "orchestrate intelligence" framing. The currently saturated AI look.
- **Team-collaboration SaaS** — seats, roles, invite modals, activity feeds keyed on humans. The unit here is the agent, not the human collaborator.

## Design Principles

1. **The substrate, not the surface.** Show the fleet — agents, sessions, processes, schedules — as first-class objects. Don't hide them behind "AI assistant" framing. Identifiers, timestamps, and state are always reachable.
2. **Density earns trust.** Treat the user as capable. Real metadata, real timestamps, real IDs are visible by default. No infantilizing whitespace, no padded cards around single sentences.
3. **Quiet by default, loud on change.** Baseline UI is calm and monochromatic. Motion, color, and emphasis are reserved for state transitions, live signal, and the user's own focus.
4. **Made by a person.** Visible craft beats novelty. Hairline rules, considered type pairings, hand-tuned spacing, weighted motion. If a detail isn't tuned, leave it out rather than ship it rough.
5. **Teachable without being patronizing.** Empty states and onboarding explain what the thing *is* and how it works. Not encouragement, not "let's get started!" copy. Documentation-grade clarity.

## Accessibility & Inclusion

- **WCAG 2.2 AA** baseline: contrast, focus indicators, target sizes.
- **No color-only state.** Every state encoded in color also carries a glyph, weight, or label.
- **Reduced motion respected.** All animations gate on `prefers-reduced-motion`; the calm baseline becomes the only state.
- **Full keyboard reachability.** Every action a mouse can do, the keyboard can do. Visible focus rings on all interactive elements; command palette as the primary navigation accelerator for power users.
- **No mouse-required affordances.** Hover-only reveals are unacceptable for primary actions; hover may reveal *secondary* metadata only.
