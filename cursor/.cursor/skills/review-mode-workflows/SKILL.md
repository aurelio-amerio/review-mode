---
name: review-mode-workflows
description: Runs plan drafting and annotation-driven review workflows with Review Mode MCP tools. Use when the user asks for implementation planning, /plan, /review, or iterative plan feedback.
disable-model-invocation: true
---

# Review Mode Workflows

## Triggers
- `/plan`
- `/review`
- "create a plan"
- "iterate comments"
- "apply review feedback"

## /plan
Follow `.cursor/workflows/plan.md`.

## /review
Follow `.cursor/workflows/review.md`.

## Constraints
- Do not ask the user to paste annotations.
- Keep status updates concise.
- Keep plan content in files rather than chat dumps.
