# Inline Diff Feature — Design Spec

## Overview

Enhance Review Mode with inline diff capabilities, allowing users to see what changed between file versions directly in the code pane. The diff is always computed against the current (latest) revision, with the user selecting which older version to compare from.

## Core Model

### Constraints

1. **Target is always the latest revision.** Users cannot review or annotate old versions — the diff is a visual overlay on the current state.
2. **Line numbering is sacred.** Injected deleted lines are visual-only and bear no line number. Annotations always reference current-file line numbers.
3. **Comments on deleted lines** anchor to the nearest surviving line above (or line 1 if none above) in the current version.
4. **Two history modes, fully separate.** "Local" shows Review snapshots (`.revX.md`), "Git" shows commits. No mixing. You can only pin within the active mode.
5. **Single revision edge case.** Diff Mode still works — shows everything as added (green). Pin icons are hidden since there's nothing to pin.
6. **Raw content in diff mode.** When Diff Mode is ON, Markdown files are shown as raw text with Markdown syntax highlighting, not rendered. This avoids confusion when diffing structural Markdown changes. Rendered Markdown resumes when Diff Mode is OFF.

## Phase 1: Local Inline Diffs

### 1.1 UI — Secondary Toolbar

A persistent toolbar row below the `[Comments | History]` tabs, visible in both tabs:

```
[Comments | History]
[Diff Mode: ON/OFF]  [Local | Git (disabled, greyed out)]
```

- **Diff Mode toggle**: On/Off. When ON, the code pane shows inline diff. When OFF, normal view.
- **Local / Git toggle**: Selects the history mode. In Phase 1, "Git" is greyed out with tooltip: *"Git diffs will be available in a future update."*
- Both toggles persist their state when switching between Comments and History tabs.
- Toggling Local/Git switches the History tab list and resets the pin to the default (previous version).

### 1.2 History Tab — Local Mode

- **Order**: Reverse chronological (latest revision first).
- Each entry shows: revision number, timestamp, annotation count (as today, but newest-first).
- The **latest revision** (top of list) is always the target — no pin icon on it.
- Every other entry has a **pin icon** representing the diff base.
- **Default pin**: The second entry (revision N-1) is pinned by default.
- Clicking a pin on a different entry unpins the previous one and sets the new base. Diff updates immediately.
- Clicking the currently pinned entry unpins it and reverts to the default (N-1). If N-1 is already pinned (the default state), this is a no-op.

### 1.3 Diff Computation

- Computed extension-side in `diffUtils.ts` using the existing `diff` package (`diffLines`).
- **Trigger**: Whenever diff mode is ON and either (a) a pin changes, or (b) the view is refreshed.
- The extension reads both file versions (pinned `.revX.md` snapshot and current snapshot), computes the diff, and sends structured data to the webview.

**Data format sent to webview**:
```typescript
interface DiffHunk {
    type: 'added' | 'removed' | 'unchanged';
    lines: string[];
}
// Message: { command: 'showDiff', hunks: DiffHunk[] }
// Message: { command: 'clearDiff' }
// The webview builds a line-to-hunk index during rendering,
// used for context extraction when addNote fires on a diffed line.
```

### 1.4 Diff Rendering in the Code Pane

When Diff Mode is ON:

- **Unchanged lines**: Rendered normally with their current-file line number.
- **Added lines** (in current but not in base): Green background, current-file line number in gutter, `+` marker in gutter.
- **Deleted lines** (in base but not in current): Red background, **no line number** in gutter, `-` marker in gutter. Injected at their original position relative to surrounding unchanged context.
- **Syntax highlighting**: Applied to all lines (added, deleted, and unchanged) via Shiki. For Markdown files, Markdown syntax highlighting is used on raw content (no rendering).
- **Comment buttons**: The `+` gutter button appears on all lines including deleted lines. Commenting on a deleted line anchors the annotation to the nearest surviving line above it (or line 1 if none exists above).
- When Diff Mode is OFF: deleted lines disappear, the view returns to normal, and Markdown files resume rendered display.

### 1.5 Annotation Schema Update

Extend the `Annotation` interface in `annotationStore.ts`:

```typescript
export interface Annotation {
    id: string;
    startLine: number;
    endLine: number;
    textPreview: string;
    priority: Priority;
    status: Status;
    thread: Message[];
    deletedLine?: boolean;
    // Diff context — populated when comment is added during Diff Mode
    // on a line/block that intersects a diff hunk
    previousVersionContext?: string;
    currentVersionContext?: string;
}
```

**When populated**: Only when a comment is added while Diff Mode is active AND the commented line/block intersects a diff hunk. Comments on unchanged lines during diff mode omit these fields.

**Content**: The full diff hunk surrounding the commented line in unified diff format — a few lines of context with `+`/`-` prefixes. This gives AI assistants the "what changed" context alongside the comment.

### 1.6 Data Flow

**Extension → Webview messages** (new):
- `showDiff { hunks: DiffHunk[] }`: Sends structured diff data for rendering.
- `clearDiff`: Removes diff overlay, restores normal view.

**Webview → Extension messages** (new):
- `toggleDiffMode { enabled: boolean }`: User toggled diff on/off.
- `pinVersion { revision: number }`: User pinned a base version.

**Webview → Extension messages** (modified):
- `addNote`: Extended with optional `previousVersionContext` and `currentVersionContext` fields when diff is active and the line intersects a hunk.

### 1.7 Files Modified

| File | Changes |
|------|---------|
| `src/annotationStore.ts` | Add `previousVersionContext`, `currentVersionContext` to `Annotation` interface |
| `src/diffUtils.ts` | Add `computeDiffHunks(oldText, newText): DiffHunk[]` function; add hunk extraction for context capture |
| `src/reviewMode.ts` | Handle `toggleDiffMode` and `pinVersion` messages; read snapshot files and trigger diff computation; send `showDiff`/`clearDiff` to webview |
| `src/webviewPanel.ts` | Inject secondary toolbar HTML; handle diff rendering mode switch (raw vs rendered for Markdown); pass diff messages through |
| `media/review.js` | Toolbar toggle event handlers; diff rendering logic (line injection, gutter markers, comment anchoring); context extraction for `addNote` |
| `media/review.css` | Styles for secondary toolbar, added-line (green) background, deleted-line (red) background, gutter `+`/`-` markers, disabled toggle states |
| `package.json` | No changes needed — `diff` package already a dependency |

## Phase 2: Git History Diffs

### 2.1 Enable Git Toggle

- On initialization, the extension checks if the workspace is a valid Git repository.
- If yes: "Git" toggle becomes enabled with full functionality.
- If no: "Git" remains disabled with tooltip: *"Git diffs are only available when Git is enabled for the current repository."*

### 2.2 Git History Retrieval

- Use `git log --follow --format=...` to retrieve commits that touched the current file.
- Use `git show <commit-hash>:<path>` to retrieve file content at a specific commit.
- **Pagination**: Fetch 20 commits initially. "Load more" button fetches the next 20.

### 2.3 History Tab — Git Mode

Replaces the Local revision list entirely with Git commits:

```
(working copy)  Unsaved changes        just now      ← always target, no pin
a1b2c3f         Fix header alignment   3 days ago    📌 (default pin)
e4d5f6a         Add dark mode support  1 week ago
7g8h9i0         Initial commit         2 weeks ago
                [Load more...]
```

- **Working copy entry**: Always present as the top entry when the file has uncommitted changes (current content differs from HEAD). Shows "(working copy)" instead of a hash. If no uncommitted changes, this entry is omitted and the latest commit becomes the target.
- **Pin mechanics**: Same as Local mode — pin selects the base, default is the second entry.
- **Commit display**: Short hash, first line of commit message, relative date.

### 2.4 Diff Computation — Git Mode

Same pipeline as Local mode but reading from Git:
1. Pinned commit → `git show <hash>:<path>` → base content
2. Working copy (or latest commit) → current content
3. `diffLines(base, current)` → hunks → `showDiff`

### 2.5 Files Modified (Phase 2 additions)

| File | Changes |
|------|---------|
| `src/reviewMode.ts` | Git availability check; `git log` / `git show` execution; working copy detection; pagination state |
| `src/webviewPanel.ts` | Enable Git toggle based on availability flag; render Git commit entries in History tab |
| `media/review.js` | Handle `pinVersion` with `commitHash`; "Load more" button handler; working copy entry rendering |
| `media/review.css` | Styling for Git commit entries, working copy indicator, Load more button |

### 2.6 New Webview Messages (Phase 2)

**Webview → Extension**:
- `pinVersion { commitHash: string }`: Pin a Git commit as base.
- `loadMoreCommits`: Request next page of Git history.

**Extension → Webview**:
- `updateGitHistory { commits: GitCommit[], hasMore: boolean }`: Send Git commit list.

## Verification Plan

### Phase 1
1. Open a file in Review Mode.
2. Verify the secondary toolbar appears with "Diff Mode" (Off) and "Local / Git" (Git greyed out).
3. Toggle "Diff Mode" ON. Verify code pane switches to raw content (for Markdown files) and shows inline diff.
4. Verify history is in reverse chronological order (newest first).
5. Verify the second entry (previous revision) is pinned by default.
6. Pin a different older version. Verify the diff updates immediately.
7. Verify deleted lines appear with red background, no line number, `-` gutter marker.
8. Verify added lines appear with green background, line number, `+` gutter marker.
9. Add a comment on a deleted line. Verify it anchors to the nearest surviving line above.
10. Add a comment on a diffed line. Inspect the `.revX.json` to verify `previousVersionContext` and `currentVersionContext` contain the full diff hunk.
11. With only one revision (rev0): verify Diff Mode shows all lines as added, no pin icons visible.
12. Toggle Diff Mode OFF. Verify normal view resumes (Markdown rendered if applicable).

### Phase 2
1. Open a file in a Git-enabled workspace. Verify "Git" toggle becomes enabled.
2. Switch to Git mode. Verify Local revisions are replaced by Git commits.
3. Make uncommitted changes. Verify "(working copy)" entry appears at top.
4. Pin a Git commit. Verify diff is computed correctly against working copy.
5. Click "Load more". Verify additional commits appear.
6. Open a file in a non-Git workspace. Verify "Git" toggle remains disabled with appropriate tooltip.