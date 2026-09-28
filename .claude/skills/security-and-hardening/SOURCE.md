# Source

- Upstream listing: https://www.skills.sh/addyosmani/agent-skills/security-and-hardening
- Upstream repository: https://github.com/addyosmani/agent-skills
- Path in repo: `skills/security-and-hardening/` (SKILL.md + references/hardening-patterns.md)
- Raw files fetched from:
  - https://raw.githubusercontent.com/addyosmani/agent-skills/main/skills/security-and-hardening/SKILL.md
  - https://raw.githubusercontent.com/addyosmani/agent-skills/main/skills/security-and-hardening/references/hardening-patterns.md
  - https://raw.githubusercontent.com/addyosmani/agent-skills/main/references/security-checklist.md
    (repo-root shared reference, linked from SKILL.md and hardening-patterns.md via
    `../../references/security-checklist.md` / `../../../references/security-checklist.md`;
    copied here into this skill's own `references/` folder for a self-contained install —
    the relative-path text inside the copied markdown still reads `../../references/...`,
    which will NOT resolve on disk in this location. It is documentation prose, not a
    loader path, so this does not affect the skill's function, but note it if you later
    diff against upstream.)
- Commit SHA at fetch time (repo `main` HEAD): `2686b620fc1fed2e8f60c704839c766b8594c6b6`
- Date fetched: 2026-09-28
- License: per upstream repo (LICENSE file present at repo root; not independently re-verified beyond MIT-style terms visible in repo listing)

## Notes

- All three files installed verbatim, byte-for-byte identical to the fetched raw files.
- No scripts were fetched or executed as part of this review/install (this skill folder contains no `scripts/`).
