---
name: review
description: Fetch the latest Review Mode annotations, implement the changes, resolve the comments, and re-open in Review Mode.
---

# /review

**What this does:** Automatically reads the latest Review Mode annotations for a file, implements the requested changes, marks comments as resolved, and re-opens the file in Review Mode for further feedback.

**When to use:** After the user has added comments in Review Mode and wants you to act on them. This is a shortcut for "read my comments, implement them, and show me the result."

**Prerequisite:** The `review-mode` MCP server must be configured in your MCP client settings.

---

## Workflow Steps

### Step 1 - Identify the file

Determine which file to review:
- If the user specifies a file path, use that.
- If there is a plan file from a recent `/plan` workflow, use that.
- If unclear, call `list_reviewed_files(workspace="/path/to/project/root")` to see all files currently under review.
- If still unclear, ask the user.

### Step 2 - Fetch annotations

Use the `get_annotations` MCP tool:
```python
get_annotations(
  file_path="<relative-path-to-file>",
  workspace="/path/to/project/root"
)
```

If the result is empty (no revisions), tell the user:
> No review annotations found. Please open the file in Review Mode and add your comments first.

### Step 3 - Summarize

Print a summary of what you found:
> 📝 Found N annotations (X open, Y in-progress, Z resolved).

If there are no open or in-progress annotations:
> ✅ All annotations are already resolved. Nothing to do.

### Step 4 - Implement changes

For each annotation with status `open` or `in-progress`:
1. Read the `textPreview` and `thread` to understand what the user wants.
2. Edit the `.md` file to implement the change.
3. If the comment is unclear, skip it for now and note it for Step 5.

### Step 5 - Resolve annotations

After implementing the changes, update annotations using the MCP tool:

```python
# Resolve specific IDs that were implemented
update_annotation(
  file_path="<file>",
  annotation_ids=["id1", "id2"],
  status="resolved",
  message="Implemented",
  workspace="/path/to/project/root"
)

# For comments needing clarification
update_annotation(
  file_path="<file>",
  annotation_ids=["id3"],
  status="in-progress",
  message="Need more details - see reply",
  workspace="/path/to/project/root"
)
```

### Step 6 - Re-open in Review Mode

```python
open_review(
  file_path="<relative-path-to-file>",
  workspace="/path/to/project/root"
)
```

The extension will detect the file change and automatically create a new revision with migrated annotations.

### Step 7 - Report

Print a status message:
> 📋 Plan updated and ready for review. N comments resolved, M need your input.

Then say:
> _"I've updated the plan based on your comments. Take a look and let me know if you have more feedback."_
