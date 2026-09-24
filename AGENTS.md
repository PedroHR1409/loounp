# Codex project instructions

This project carries the complete Claude configuration under .codex/claude-source/ (674 source files). Keep that tree as the canonical knowledge and asset archive. Use the Codex-native adapters below when working in Codex.

## Available adapters

- .codex/agents/*.toml: 60 specialist agents. Each adapter includes the original Claude agent metadata and instructions, with source paths redirected to .codex/claude-source/.
- .codex/prompts/*.md: 30 slash-prompt files, named by original category and command.
- .agents/skills/: the complete 18-file skill tree, including both SKILL.md files and all supporting references, scripts, templates, and lockfiles.
- .codex/claude-source/kb/: complete knowledge base (545 files).
- .codex/claude-source/sdd/: workflow contracts, templates, reports, and indexes.

For knowledge material, read only the relevant source files under .codex/claude-source/; agent instructions retain their original workflows. Claude-specific settings are preserved at .codex/claude-source/settings.json for reference. They are not activated as Codex permissions or MCP settings; configure Codex tools and approvals through Codex settings.

The original .claude/ directory remains untouched. The source mirror and adapters should be updated together when changing shared guidance.
