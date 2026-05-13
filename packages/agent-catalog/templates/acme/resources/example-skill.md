# Example SKILL.md

A reference shape for authoring a workforce skill. Lives at
`<dataDir>/skills/<name>/SKILL.md`. The `name` in frontmatter must
match the directory name.

```markdown
---
name: incident-response
description: How we handle production incidents — sev levels, comm
  cadence, postmortem template. Read when an alert fires or the user
  reports a production issue.
tags: [ops, incident, sev]
---

# Incident response

## Severity levels

- **Sev 1** — full outage, paying customers can't use the product.
  Page the on-call, post in #incidents within 5 min.
- **Sev 2** — major degradation, subset of users impacted. Slack the
  team, status page yellow.
- **Sev 3** — single-user or minor feature impact. File a task, no
  paging.

## Communication

During sev 1/2:
- Post an update in #incidents every 15 min, even if there's nothing
  new ("still investigating, no new info").
- Update the status page when severity changes or fix lands.

## Postmortem template

Use `templates/postmortem.md` (sibling file in this skill folder).
Fill it out within 48h of resolution.

- **Summary** — 2-3 sentences.
- **Timeline** — UTC timestamps, every notable event.
- **Root cause** — what actually broke (not "the deploy went wrong").
- **Action items** — concrete owners + deadlines.
```

## What makes a good skill

- **Description is the trigger.** Be specific about WHEN this skill
  applies. "How we handle production incidents — read when an alert
  fires or the user reports a production issue" is good. "Incident
  handling" is too vague — the agent never decides to load it.
- **Body is reference, not script.** Don't write step-by-step
  instructions. Write the conventions; let the agent decide how to
  apply them.
- **Companion files** in the same dir (e.g., `templates/postmortem.md`
  in the example) are surfaced as resources the agent can read.
- **Tags** are loose taxonomy — used by humans browsing skills, not by
  the agent.

## Progressive disclosure

The platform injects the index (name + description + tags) into every
agent's system prompt. The body is loaded only when an agent calls
`skill_view` with this skill's name. Keep the description specific so
agents make good decisions about when to look deeper.

## Locally-authored vs installed

A skill you write by hand into `<dataDir>/skills/<name>/` is
"locally-authored" — no lockfile entry, no audit trail. SkillHub (the
install pipeline) refuses to clobber locally-authored skills. To
install from GitHub / marketplaces / URLs, use `openacme skills
install` — don't paste fetched SKILL.md content by hand.
