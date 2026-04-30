---
name: plan
description: Write an implementation plan and iterate on it via Review Mode annotations.
---

# /plan

**What this does:** Guides an AI agent through writing an implementation plan, opening it in Review Mode for user feedback, and iterating until approved.

**When to use:** When you need to create an implementation plan, design spec, or architecture document and want structured user review before implementation.

**Prerequisites:**
- The [Review Mode](https://marketplace.visualstudio.com/items?itemName=aurelio-amerio.review-mode) VS Code extension must be installed.
- The `review-mode` MCP server must be configured in your MCP client settings.

---

## Workflow Steps

### Step 1 — Gather Information

Follow your normal procedure to research, explore the codebase, and design the plan. This step is agent-specific and not prescribed by this workflow.

### Step 2 — Determine Output Location

- If the project has an existing convention for plan files (e.g., `docs/plans/`), use that.
- Otherwise, default to `.plans/` at the workspace root.
- Create the directory if it doesn't exist.

### Step 3 — Write the Plan

Save the plan as a Markdown file with a descriptive, date-prefixed name:

```
.plans/YYYY-MM-DD-<descriptive-slug>.md
```

Examples:
- `.plans/2026-04-28-sidebar-dashboard-design.md`
- `.plans/2026-04-28-auth-refactor.md`

**Do NOT print the plan content in chat.** The user will read it in Review Mode.

### Step 4 — Open in Review Mode

Use the `open_review` MCP tool:
```python
open_review(
  file_path=".plans/YYYY-MM-DD-my-feature.md",
  workspace="/path/to/project/root"
)
```

### Step 5 — Print Status

Output a brief message:

> 📋 The implementation plan is ready for review in Review Mode.

### Step 6 — Iterate

When the user says they've added comments (or asks you to iterate), **immediately fetch the annotations** — do NOT ask the user to paste their comments.

Use the `get_annotations` MCP tool:
```python
get_annotations(
  file_path="<relative-path-to-plan>",
  workspace="/path/to/project/root"
)
```

Then:
1. Summarize what you found (e.g., "📝 Found 3 annotations: 2 open, 1 resolved")
2. Process each actionable annotation (resolve, clarify, or reject) — see the review-mode skill
3. Write the updated plan file
4. Resolve annotations via `update_annotation`
5. Re-open Review Mode via `open_review`
6. Ask for more feedback or confirmation to proceed

### Step 7 — Proceed

When the user approves the plan, transition to implementation. This step is agent-specific — hand off to whatever implementation workflow or skill the agent uses.
