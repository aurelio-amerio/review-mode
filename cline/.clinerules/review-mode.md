---
name: review-mode
description: Persist the current plan to disk (if needed) and open it in Review Mode for annotation-based feedback.
---

# /review-mode

**What this does:** Ensures the current implementation plan is saved as a Markdown file, then opens it in Review Mode so the user can annotate it with inline comments.

**When to use:** When the user explicitly types `/review-mode` or asks to review the current plan.

**Context — Cline's planning workflow:**
In planning mode, Cline iterates on an implementation plan **in chat** — the plan is not written to a file until it is considered final or the user explicitly requests review. The `/review-mode` command bridges the gap: it writes the plan to disk first (if it hasn't been already), then opens it in the Review Mode panel.

**Prerequisites:**
- The [Review Mode](https://marketplace.visualstudio.com/items?itemName=aurelio-amerio.review-mode) VS Code extension must be installed.
- The `review-mode` MCP server must be configured in your MCP client settings.

---

## Workflow Steps

### Step 1 — Determine the plan to review

Check, in order:
1. If the user specifies a file path, use that and skip to Step 3.
2. If there is a plan that was **already written** to a `.md` file in the `./plans` directory during this session, use that and skip to Step 3.
3. If there is a plan that was discussed and iterated on **in chat** but has **not yet been written to a file**, proceed to Step 2.
4. If there is no plan at all, ask the user what they'd like to review.

### Step 2 — Write the plan to disk

Take the latest version of the in-chat plan and write it to a Markdown file in the `./plans` directory at the project root.

- Create the `./plans` directory if it doesn't exist.
- Use a descriptive filename based on the plan topic, e.g. `plans/add-auth-flow.md`.
- Write the **full plan content** — not a summary, not a reference. The file should be self-contained.
- Confirm in chat that the file was created:
  > 📄 Plan saved to `plans/<filename>.md`.

### Step 3 — Open in Review Mode

Use the `open_review` MCP tool:
```python
open_review(
  file_path="plans/<filename>.md",
  workspace="/path/to/project/root"
)
```

### Step 4 — Confirm

Print a brief status message:
> 📋 The plan is now open in Review Mode. Add your comments, then type `/update` when you're ready for me to act on them.

Do **NOT** print the plan content in chat. The user will read it in the Review Mode panel.
