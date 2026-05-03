---
name: review-mode
description: >
  Use when the user asks to open a Markdown file in Review Mode inside VS Code,
  or when iterating on a plan/document based on Review Mode annotations.
  Review Mode renders the file in a read-only WebView panel with annotation
  support. This does NOT open a web browser.
---

# Review Mode Skill

## Overview

Review Mode is a VS Code extension that renders Markdown files in a read-only WebView panel with threaded annotation support. Users can highlight lines, add comments, set priorities, and track statuses — all stored as JSON alongside the file.

This skill teaches you how to:
1. Open any `.md` file in Review Mode
2. Read user feedback from annotations
3. Iterate on the document based on that feedback
4. Manage the annotation lifecycle (resolve, clarify, reject)

The skill is **agent-agnostic** — it works regardless of how the document was created.

**Prerequisite:** The `review-mode` MCP server must be configured in your MCP client settings. All operations use MCP tools — no CLI scripts or direct file reads are needed.

**Command trigger:** Treat `/review-mode` as an explicit user command to open the relevant Markdown plan/document in Review Mode via MCP (`open_review`), then confirm in chat that the file was created (if applicable) and opened in Review Mode.

### Tool Overview

The `review-mode-mcp` server provides the following tools:
- `open_review`: Opens a file in Review Mode inside the editor.
- `get_annotations`: Returns the full array of annotations for a file.
- `update_annotation`: Updates the status or adds an agent reply to an annotation.
- `list_reviewed_files`: Lists all files in the workspace that have reviews.
- `get_review_summary`: Returns summary metadata for a file's review (counts, dates).
- `create_annotation`: Creates a new annotation on a specific line as the agent.

> **Note on `workspace` parameter:** While listed as optional in some schemas, it is highly recommended (and sometimes mandatory depending on server config) to provide the `workspace` parameter with the absolute or relative path to the root of the project to ensure the MCP server resolves paths correctly.

---

## How to Open Review Mode

Use the `open_review` MCP tool:
```python
open_review(
  file_path="relative/path/to/file.md",
  workspace="/path/to/project/root" # Recommended
)
```

This opens the file in Review Mode inside VS Code (or whichever editor the MCP server is configured for).

After opening, print a brief message in chat:
> 📋 The plan is ready for review in Review Mode.

Do **NOT** print the plan content in chat. The user will read it in the Review Mode panel.

---

## How to Read Feedback

When the user says they've added comments, or asks you to iterate on a plan, you **MUST** proactively read annotations using the MCP tools. **Never ask the user to paste their annotations.**

### Step 1 — Get annotations

```python
get_annotations(
  file_path="relative/path/to/file.md",
  workspace="/path/to/project/root"
)
```

This returns the full annotation array from the latest revision.

### Step 2 — Summarize

Print a brief summary:
> 📝 Found N annotations (X open, Y in-progress, Z resolved).

### Step 3 — Filter actionable annotations

Only process annotations where `status` is `"open"` or `"in-progress"`. Ignore `"resolved"` and `"wont-fix"`.

---

## Annotation Format

Each annotation returned by `get_annotations` has this structure:

```json
{
  "id": "cc1rclk",
  "startLine": 3,
  "endLine": 3,
  "textPreview": "The line of text this annotation refers to",
  "priority": "none",
  "status": "open",
  "thread": [
    {
      "id": "2wu1xvj",
      "text": "User's comment about this line",
      "createdAt": "2026-04-28T17:10:19.928Z"
    }
  ]
}
```

**Fields:**

| Field | Description |
|-------|-------------|
| `id` | Unique identifier for the annotation |
| `startLine` / `endLine` | Line range in the markdown file (1-indexed) |
| `textPreview` | The text content at the annotated line(s) |
| `priority` | One of: `none`, `low`, `medium`, `high`, `urgent` |
| `status` | One of: `open`, `in-progress`, `resolved`, `wont-fix` |
| `thread` | Array of messages (the comment thread) |

Each message in `thread[]` has:

| Field | Description |
|-------|-------------|
| `id` | Unique message identifier |
| `text` | The message content |
| `createdAt` | ISO 8601 timestamp |

---

## How to Respond to Feedback

For each actionable annotation (status `open` or `in-progress`), decide one of three outcomes:

### 1. Fully addressable — Resolve it

Edit the `.md` file to implement the change, then mark resolved:
```python
update_annotation(
  file_path="relative/path/to/file.md",
  annotation_ids=["cc1rclk"],
  status="resolved",
  message="Implemented the requested change",
  workspace="/path/to/project/root"
)
```

### 2. Needs clarification — Ask the user

```python
update_annotation(
  file_path="relative/path/to/file.md",
  annotation_ids=["cc1rclk"],
  status="in-progress",
  message="Which kind of description do you want? Verbose, concise, etc.?",
  workspace="/path/to/project/root"
)
```

### 3. Won't implement — Explain why

```python
update_annotation(
  file_path="relative/path/to/file.md",
  annotation_ids=["cc1rclk"],
  status="wont-fix",
  message="Not feasible due to API limitations",
  workspace="/path/to/project/root"
)
```

### Bulk resolve

Pass multiple IDs at once:
```python
update_annotation(
  file_path="relative/path/to/file.md",
  annotation_ids=["id1", "id2", "id3"],
  status="resolved",
  message="All comments addressed",
  workspace="/path/to/project/root"
)
```

### Summary Table

| Scenario | Action on `.md` file | MCP call |
|----------|---------------------|----------|
| Fully addressable | Implement the change | `status="resolved"` |
| Needs clarification | No change (or partial) | `status="in-progress"`, with question in `message` |
| Won't implement | No change | `status="wont-fix"`, with reason in `message` |

The `message` is automatically prefixed with `[AGENT]` and added to the annotation's thread.

---

## Utility Tools

You can use these additional tools to manage the review workflow:

### Discover files under review

```python
list_reviewed_files(workspace="/path/to/project/root")
```
Returns an array of files that have reviews, along with their `revision_count`, `total_annotations`, `open_count`, etc. Useful if you're not sure which file the user wants you to look at.

### Get a quick summary

```python
get_review_summary(file_path="relative/path/to/file.md", workspace="/path/to/project/root")
```
Returns metadata about a file's review state without pulling down the entire annotation array.

### Create an annotation

If you need to leave a comment or question on a specific line of the file *for the user to see*:
```python
create_annotation(
  file_path="relative/path/to/file.md",
  line=42,
  message="Should we consider refactoring this section?",
  priority="medium",
  status="open",
  workspace="/path/to/project/root"
)
```

---

## How to Submit the Updated Plan

After processing all actionable annotations:

1. **Write the updated `.md` file** to disk (same path as the original).
2. **Mark annotations as resolved** using `update_annotation` (see above).
3. **Re-open Review Mode** to refresh the panel:
   ```
   open_review(file_path="relative/path/to/file.md")
   ```
   The extension will detect the file change and automatically create a new revision with migrated annotations.
4. **Print a brief status message** in chat:
   `📋 Plan updated and ready for review. N comments resolved, M need your input.`

---

## Iteration Flow

The user will trigger iteration with one of two intents:

### Intent A: "Refine with my comments" / "Update the plan"

1. Fetch annotations: `get_annotations(file_path=<file>)`
2. Process each actionable annotation (resolve, clarify, or reject)
3. Write updated `.md` file
4. Resolve annotations: `update_annotation(file_path=<file>, annotation_ids=[...], status="resolved", message="Done")`
5. Re-open Review Mode: `open_review(file_path=<file>)`
6. Print status message
7. Say: _"I've updated the plan. Take a look and let me know if you have more feedback."_

### Intent B: "Implement comments and proceed" / "Finalize and implement"

1. Fetch annotations: `get_annotations(file_path=<file>)`
2. Process each actionable annotation (resolve, clarify, or reject)
3. Write updated `.md` file
4. Resolve all: `update_annotation(file_path=<file>, annotation_ids=[<all IDs>], status="resolved", message="All addressed")`
5. Re-open Review Mode: `open_review(file_path=<file>)`
6. Print status message
7. Confirm: _"The plan has been finalized. Ready to proceed with implementation?"_

### When there's nothing left to review

After a round where **no annotations have status `open`** and no new feedback was given, gently ask:

> _"The plan looks solid with no outstanding comments. Would you like to proceed with implementation, or do you want to review it further?"_

Do **NOT** rush the user into implementation. Wait for explicit confirmation.

---

