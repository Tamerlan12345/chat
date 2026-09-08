---
name: obsidian-core
description: "Shared engine for the obsidian-second-brain skills - the AI-first write spec (references/), the Python research + health toolkit (scripts/), and its uv project (pyproject.toml). Support files only; the other skills call into it. Do not invoke directly. Install it alongside the command skills."
metadata:
  category: meta
---

## What this is

The shared support tree the other obsidian-second-brain skills depend on. It is
not a task skill - do not run it on its own.

- `references/` - shared specs. `references/ai-first-rules.md` is the canonical,
  non-negotiable vault-write spec; `vault-schema.md`, `folder-map.md`, and
  `freshness-policy.md` back the other skills. These paths are relative to the
  install root, which is load-bearing: if one does not resolve from your working
  directory, search upward for it, and say so before writing if you still cannot
  read it. Every command skill also embeds the AI-first spec inline, so the rule
  survives an unreachable path - but an unreachable path must never pass in
  silence.
- `scripts/` - Python helpers for the research toolkit and vault health. The
  command skills invoke them as
  `uv run --directory .agents/skills/obsidian-core -m scripts.research.<name> ...`
  (or `uv run --directory .agents/skills/obsidian-core scripts/<name>.py ...`), run from
  your workspace root.
- `pyproject.toml` - makes this directory a self-contained uv project, so both
  modules and dependencies resolve without a separate install step.

If you installed the skills globally rather than into a workspace, replace
`.agents/skills/obsidian-core` in those commands with the absolute path to this directory.
