# Review Mode — Plan Review Workflow

When writing an implementation plan, design spec, or architecture document:

1. Follow the workflow in `.cursor/workflows/plan.md`
2. Write the plan to a Markdown file — do NOT print its content in chat
3. Open the plan in Review Mode for user feedback using the `open_review` MCP tool:
   ```
   open_review(file_path="<relative-path-to-plan>")
   ```
   *(If the `open_review` tool is not available due to being in Plan Mode, ask the user to open the file manually by right-clicking it in the Explorer sidebar and selecting "Open in Review Mode".)*
4. Print a brief status message: "📋 The implementation plan is ready for review in Review Mode."
5. When the user asks to iterate (or types `/review`), follow `.cursor/workflows/review.md` to fetch annotations from disk, implement changes, resolve comments, and re-open in Review Mode. **Never ask the user to paste their comments.**
6. Iterate based on annotations until the user explicitly approves the plan
