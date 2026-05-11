# Inline Diff (Phase 1: Local) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline diff rendering to Review Mode so users can see what changed between local revision snapshots, with diff context captured in annotations for AI consumption.

**Architecture:** Extension-side diff computation via the existing `diff` package, sending structured hunk data to the webview via `postMessage`. The webview renders a visual diff overlay (red/green lines) on top of the current revision. A secondary toolbar houses Diff Mode and Local/Git toggles. The Git toggle is scaffolded but disabled in Phase 1.

**Tech Stack:** TypeScript (VS Code extension API), `diff` npm package (already installed), Shiki (syntax highlighting), vanilla JS/CSS (webview)

---

### Task 1: Extend Annotation Interface with Diff Context Fields

**Files:**
- Modify: `src/annotationStore.ts:16-25`

- [ ] **Step 1: Add diff context fields to the Annotation interface**

In `src/annotationStore.ts`, add two optional fields after the `deletedLine` field:

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
    previousVersionContext?: string;
    currentVersionContext?: string;
}
```

- [ ] **Step 2: Verify the extension compiles**

Run: `npm run compile`
Expected: No errors. The new fields are optional so no call sites need updating.

- [ ] **Step 3: Commit**

```bash
git add src/annotationStore.ts
git commit -m "feat: add diff context fields to Annotation interface"
```

---

### Task 2: Add `computeDiffHunks` Function to diffUtils.ts

**Files:**
- Modify: `src/diffUtils.ts:1-3` (add export)

- [ ] **Step 1: Define the DiffHunk interface and computeDiffHunks function**

Add the following at the top of `src/diffUtils.ts`, after the existing import:

```typescript
export interface DiffHunk {
    type: 'added' | 'removed' | 'unchanged';
    lines: string[];
}

export function computeDiffHunks(oldText: string, newText: string): DiffHunk[] {
    const changes = diffLines(oldText, newText);
    const hunks: DiffHunk[] = [];

    for (const change of changes) {
        const lines = (change.value ?? '').replace(/\n$/, '').split('\n');
        if (change.added) {
            hunks.push({ type: 'added', lines });
        } else if (change.removed) {
            hunks.push({ type: 'removed', lines });
        } else {
            hunks.push({ type: 'unchanged', lines });
        }
    }

    return hunks;
}
```

- [ ] **Step 2: Add `extractDiffContext` helper for annotation context capture**

This function extracts the unified-diff-style context around a given current-file line number from a hunks array. Add it below `computeDiffHunks`:

```typescript
export function extractDiffContext(
    hunks: DiffHunk[],
    currentLineStart: number,
    currentLineEnd: number,
    contextLines: number = 3,
): { previousVersionContext: string; currentVersionContext: string } | null {
    // Build a flat list mapping each display row to its hunk entry
    // currentLineNum tracks the line number in the current (new) file
    let currentLineNum = 0;
    const rows: Array<{ type: 'added' | 'removed' | 'unchanged'; text: string; currentLine: number | null }> = [];

    for (const hunk of hunks) {
        for (const line of hunk.lines) {
            if (hunk.type === 'removed') {
                rows.push({ type: 'removed', text: line, currentLine: null });
            } else {
                currentLineNum++;
                rows.push({ type: hunk.type, text: line, currentLine: currentLineNum });
            }
        }
    }

    // Find the row range that overlaps with [currentLineStart, currentLineEnd]
    // We want any row where currentLine is in range, OR any adjacent 'removed' rows
    let firstRowIdx = -1;
    let lastRowIdx = -1;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.currentLine !== null && row.currentLine >= currentLineStart && row.currentLine <= currentLineEnd) {
            if (firstRowIdx === -1) { firstRowIdx = i; }
            lastRowIdx = i;
        }
    }

    // Also include adjacent removed rows (deleted lines shown near the commented line)
    if (firstRowIdx === -1) {
        // The comment might be on a deleted line anchored to a surviving line
        // Find the nearest row matching currentLineStart
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].currentLine === currentLineStart) {
                firstRowIdx = i;
                lastRowIdx = i;
                break;
            }
        }
    }

    if (firstRowIdx === -1) { return null; }

    // Expand to include adjacent removed blocks
    while (firstRowIdx > 0 && rows[firstRowIdx - 1].type === 'removed') { firstRowIdx--; }
    while (lastRowIdx < rows.length - 1 && rows[lastRowIdx + 1].type === 'removed') { lastRowIdx++; }

    // Check if any row in the range is actually a diff (not all unchanged)
    const hasChange = rows.slice(firstRowIdx, lastRowIdx + 1).some(r => r.type !== 'unchanged');
    if (!hasChange) { return null; }

    // Expand context
    const contextStart = Math.max(0, firstRowIdx - contextLines);
    const contextEnd = Math.min(rows.length - 1, lastRowIdx + contextLines);

    const previousLines: string[] = [];
    const currentLines: string[] = [];

    for (let i = contextStart; i <= contextEnd; i++) {
        const row = rows[i];
        if (row.type === 'removed') {
            previousLines.push(`-${row.text}`);
        } else if (row.type === 'added') {
            currentLines.push(`+${row.text}`);
        } else {
            previousLines.push(` ${row.text}`);
            currentLines.push(` ${row.text}`);
        }
    }

    return {
        previousVersionContext: previousLines.join('\n'),
        currentVersionContext: currentLines.join('\n'),
    };
}
```

- [ ] **Step 3: Verify the extension compiles**

Run: `npm run compile`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/diffUtils.ts
git commit -m "feat: add computeDiffHunks and extractDiffContext to diffUtils"
```

---

### Task 3: Add Diff State and Message Handling to ReviewModeController

**Files:**
- Modify: `src/reviewMode.ts:1-192`

- [ ] **Step 1: Add diff state tracking and imports**

At the top of `src/reviewMode.ts`, add the import for the new diff function:

```typescript
import { migrateAnnotations } from './diffUtils';
```

Change to:

```typescript
import { migrateAnnotations, computeDiffHunks } from './diffUtils';
```

Add private state fields to `ReviewModeController` after the existing `private revisionsPath` field (line 12):

```typescript
    private diffModeEnabled: boolean = false;
    private pinnedRevision: number = -1;
```

- [ ] **Step 2: Add method to compute and send diff to webview**

Add the following method to the `ReviewModeController` class, before the `isActive()` method:

```typescript
    private sendDiffToWebview(originalPath: string): void {
        if (!this.diffModeEnabled) {
            this.webview.postMessageToPanel(originalPath, { type: 'clearDiff' });
            return;
        }

        const revisions = this.store.getRevisions();
        if (revisions.length === 0) { return; }

        const plansDir = this.store.getPlansDir();
        const latestRevision = revisions[revisions.length - 1];
        const latestSnapshotPath = path.join(plansDir, latestRevision.snapshotFile);
        const currentText = fs.readFileSync(latestSnapshotPath, 'utf-8');

        let baseText = '';
        if (this.pinnedRevision >= 0 && this.pinnedRevision < revisions.length) {
            const baseSnapshotPath = path.join(plansDir, revisions[this.pinnedRevision].snapshotFile);
            baseText = fs.readFileSync(baseSnapshotPath, 'utf-8');
        }
        // If pinnedRevision is -1 (single revision), base is empty string → all lines show as added

        const hunks = computeDiffHunks(baseText, currentText);
        this.webview.postMessageToPanel(originalPath, { type: 'showDiff', hunks });
    }
```

- [ ] **Step 3: Handle new messages from the webview**

In the constructor, after the existing `this.webview.onRevisionRequested` assignment, add two new callback assignments:

```typescript
        this.webview.onDiffModeToggled = (originalPath: string, enabled: boolean) => {
            this.diffModeEnabled = enabled;
            if (enabled) {
                // Default pin to N-1 if not already set
                const revisions = this.store.getRevisions();
                if (revisions.length >= 2 && this.pinnedRevision < 0) {
                    this.pinnedRevision = revisions.length - 2;
                }
            }
            this.sendDiffToWebview(originalPath);
        };

        this.webview.onPinVersion = (originalPath: string, revision: number) => {
            this.pinnedRevision = revision;
            this.sendDiffToWebview(originalPath);
        };
```

- [ ] **Step 4: Reset diff state when opening a new file**

At the end of the `open()` method, just before `await vscode.commands.executeCommand('setContext', 'reviewMode.active', true);`, add:

```typescript
        // Reset diff state for the newly opened file
        this.diffModeEnabled = false;
        this.pinnedRevision = -1;
```

- [ ] **Step 5: Verify the extension compiles**

Run: `npm run compile`
Expected: Compile error — `postMessageToPanel`, `onDiffModeToggled`, `onPinVersion` don't exist on `ReviewWebviewPanel` yet. That's expected; we'll add them in Task 4.

- [ ] **Step 6: Commit**

```bash
git add src/reviewMode.ts
git commit -m "feat: add diff state management and message handling to ReviewModeController"
```

---

### Task 4: Add Webview Panel Support for Diff Messages

**Files:**
- Modify: `src/webviewPanel.ts:21-618`

- [ ] **Step 1: Add public callbacks and postMessageToPanel method**

After the existing `public onRevisionRequested?` declaration (line 31), add:

```typescript
    public onDiffModeToggled?: (originalPath: string, enabled: boolean) => void;
    public onPinVersion?: (originalPath: string, revision: number) => void;
```

Add a new public method after `scrollToLine()`:

```typescript
    postMessageToPanel(originalPath: string, message: any): void {
        this.panels.get(originalPath)?.panel.webview.postMessage(message);
    }
```

- [ ] **Step 2: Handle new message types from the webview**

In the `handleMessage()` method (line 531), add two new cases inside the switch statement, before the closing `}`:

```typescript
            case 'toggleDiffMode': {
                this.onDiffModeToggled?.(originalPath, msg.enabled);
                break;
            }
            case 'pinVersion': {
                this.onPinVersion?.(originalPath, msg.revision);
                break;
            }
```

- [ ] **Step 3: Pass diff context through addNote handler**

Modify the existing `addNote` case in `handleMessage()` to accept and pass through diff context. Change the `addNote` case (lines 538-543) to:

```typescript
            case 'addNote': {
                const content = fs.readFileSync(ctx.snapshotPath, 'utf-8');
                const lines = content.split('\n');
                const previewLine = lines[msg.startLine - 1]?.trim() || '';
                const annotation = this.store.addAnnotation(msg.startLine, msg.endLine, previewLine, msg.text);
                if (msg.previousVersionContext && msg.currentVersionContext) {
                    annotation.previousVersionContext = msg.previousVersionContext;
                    annotation.currentVersionContext = msg.currentVersionContext;
                    this.store.saveAfterContextUpdate();
                }
                break;
            }
```

- [ ] **Step 4: Add `saveAfterContextUpdate` method to AnnotationStore**

In `src/annotationStore.ts`, add a new public method after `getAnnotations()` (line 254):

```typescript
    saveAfterContextUpdate(): void {
        this.saveCurrentRevision();
    }
```

- [ ] **Step 5: Inject secondary toolbar HTML into the webview**

In the `getHtml()` method, find the comments-pane div (around line 238). Replace the `<div class="comments-pane">` block (lines 238-249) with:

```typescript
        <div class="comments-pane">
            <div class="pane-tabs">
                <button class="pane-tab active" data-tab="comments">Comments</button>
                <button class="pane-tab" data-tab="history">History</button>
            </div>
            <div class="secondary-toolbar">
                <div class="toolbar-group">
                    <label class="toolbar-label">Diff</label>
                    <button class="toolbar-toggle" id="diff-mode-toggle" data-enabled="false">OFF</button>
                </div>
                <div class="toolbar-group">
                    <div class="toolbar-segmented">
                        <button class="toolbar-seg-btn active" id="history-mode-local">Local</button>
                        <button class="toolbar-seg-btn disabled" id="history-mode-git" title="Git diffs will be available in a future update." disabled>Git</button>
                    </div>
                </div>
            </div>
            <div id="comments-pane-content" class="tab-content active">
                <div class="comments-empty">No comments yet.<br>Click + on a line to add one.</div>
            </div>
            <div id="history-pane-content" class="tab-content">
                <!-- Populated by JS -->
            </div>
        </div>
```

- [ ] **Step 6: Verify the extension compiles**

Run: `npm run compile`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/webviewPanel.ts src/annotationStore.ts
git commit -m "feat: add diff message handling and secondary toolbar to webview panel"
```

---

### Task 5: Add Secondary Toolbar CSS Styles

**Files:**
- Modify: `media/review.css`

- [ ] **Step 1: Add secondary toolbar styles**

Add the following CSS after the `.tab-content.active` rule (after line 99):

```css
/* --- Secondary Toolbar (Diff Mode + History Mode) --- */
.secondary-toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 14px;
    border-bottom: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.02);
}

.toolbar-group {
    display: flex;
    align-items: center;
    gap: 6px;
}

.toolbar-label {
    font-size: 0.75em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground, #888);
}

.toolbar-toggle {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 0.75em;
    font-weight: 600;
    padding: 2px 10px;
    cursor: pointer;
    transition: all 0.15s;
    text-transform: uppercase;
    letter-spacing: 0.03em;
}

.toolbar-toggle:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.25);
}

.toolbar-toggle[data-enabled="true"] {
    background: rgba(74, 222, 128, 0.15);
    border-color: rgba(74, 222, 128, 0.4);
    color: #4ade80;
}

.toolbar-segmented {
    display: flex;
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.12);
}

.toolbar-seg-btn {
    background: rgba(255, 255, 255, 0.04);
    border: none;
    color: var(--vscode-descriptionForeground, #888);
    font-size: 0.75em;
    font-weight: 600;
    padding: 2px 10px;
    cursor: pointer;
    transition: all 0.15s;
}

.toolbar-seg-btn + .toolbar-seg-btn {
    border-left: 1px solid rgba(255, 255, 255, 0.12);
}

.toolbar-seg-btn:hover:not(.disabled) {
    background: rgba(255, 255, 255, 0.1);
}

.toolbar-seg-btn.active {
    background: rgba(37, 99, 235, 0.15);
    color: var(--accent);
}

.toolbar-seg-btn.disabled {
    opacity: 0.4;
    cursor: not-allowed;
}
```

- [ ] **Step 2: Add diff line styles for the code pane**

Add the following CSS after the secondary toolbar styles:

```css
/* --- Diff line highlighting --- */
.line-container.diff-added {
    background: rgba(74, 222, 128, 0.08);
    border-left-color: #4ade80;
}

.line-container.diff-added:hover {
    background: rgba(74, 222, 128, 0.14);
}

.line-container.diff-removed {
    background: rgba(248, 113, 113, 0.08);
    border-left-color: #f87171;
}

.line-container.diff-removed:hover {
    background: rgba(248, 113, 113, 0.14);
}

.diff-gutter-marker {
    font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
    font-size: 0.8em;
    font-weight: 700;
    min-width: 12px;
    text-align: center;
}

.diff-gutter-marker.added {
    color: #4ade80;
}

.diff-gutter-marker.removed {
    color: #f87171;
}
```

- [ ] **Step 3: Verify the styles load (manual)**

Run: `npm run compile` then launch the extension (F5 in VS Code), open a file in Review Mode, and verify the secondary toolbar appears below the Comments/History tabs.

- [ ] **Step 4: Commit**

```bash
git add media/review.css
git commit -m "feat: add CSS for secondary toolbar and diff line highlighting"
```

---

### Task 6: Implement Toolbar Interaction and Diff Rendering in review.js

**Files:**
- Modify: `media/review.js:1-480`

- [ ] **Step 1: Add diff state variables**

At the top of the IIFE, after the existing `selectionEnd` variable (line 12), add:

```javascript
    /** @type {boolean} */
    let diffModeEnabled = false;
    /** @type {Array<{type: string, lines: string[]}>|null} */
    let currentDiffHunks = null;
```

- [ ] **Step 2: Add toolbar event handlers**

After the tab switching event listener (line 35), add the diff toggle and history mode toggle handlers:

```javascript
    // --- Diff Mode toggle ---
    document.addEventListener('click', (e) => {
        const toggle = e.target.closest('#diff-mode-toggle');
        if (!toggle) { return; }

        diffModeEnabled = !diffModeEnabled;
        toggle.dataset.enabled = String(diffModeEnabled);
        toggle.textContent = diffModeEnabled ? 'ON' : 'OFF';
        vscode.postMessage({ type: 'toggleDiffMode', enabled: diffModeEnabled });
    });
```

- [ ] **Step 3: Add diff rendering function**

Add the following function before the `window.addEventListener('message', ...)` block:

```javascript
    function renderDiff(hunks) {
        currentDiffHunks = hunks;
        const codePane = document.querySelector('.code-pane');
        if (!codePane) { return; }

        // Build new HTML from hunks
        let html = '';
        let currentLineNum = 0;

        for (const hunk of hunks) {
            for (const line of hunk.lines) {
                const escaped = escapeHtml(line) || '&nbsp;';
                if (hunk.type === 'removed') {
                    // Deleted line: red bg, no line number, "-" marker
                    html += `<div class="line-container diff-removed" data-diff-type="removed">
    <div class="line-gutter">
        <span class="line-number"></span>
        <span class="diff-gutter-marker removed">−</span>
        <button class="add-note-btn" data-line="${currentLineNum > 0 ? currentLineNum : 1}" title="Add comment"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9h-3.5L8 12.5 5.5 10H2V2h12v8z"/><path d="M7.25 4v2.25H5v1.5h2.25V10h1.5V7.75H11v-1.5H8.75V4z"/></svg></button>
    </div>
    <div class="line-content">${escaped}</div>
</div>\n`;
                } else if (hunk.type === 'added') {
                    currentLineNum++;
                    html += `<div class="line-container diff-added" data-line="${currentLineNum}" data-diff-type="added">
    <div class="line-gutter">
        <span class="line-number">${currentLineNum}</span>
        <span class="diff-gutter-marker added">+</span>
        <button class="add-note-btn" data-line="${currentLineNum}" title="Add comment"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9h-3.5L8 12.5 5.5 10H2V2h12v8z"/><path d="M7.25 4v2.25H5v1.5h2.25V10h1.5V7.75H11v-1.5H8.75V4z"/></svg></button>
    </div>
    <div class="line-content">${escaped}</div>
</div>\n`;
                } else {
                    currentLineNum++;
                    html += `<div class="line-container" data-line="${currentLineNum}">
    <div class="line-gutter">
        <span class="line-number">${currentLineNum}</span>
        <button class="add-note-btn" data-line="${currentLineNum}" title="Add comment"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9h-3.5L8 12.5 5.5 10H2V2h12v8z"/><path d="M7.25 4v2.25H5v1.5h2.25V10h1.5V7.75H11v-1.5H8.75V4z"/></svg></button>
    </div>
    <div class="line-content">${escaped}</div>
</div>\n`;
                }
            }
        }

        codePane.innerHTML = html;
    }

    function clearDiff() {
        currentDiffHunks = null;
        // Request a full content refresh from the extension
        // The extension will send replaceContent with the normal rendering
    }
```

- [ ] **Step 4: Handle diff messages from the extension**

In the existing `window.addEventListener('message', ...)` block, add handlers for the new message types. After the `replaceContent` handler (around line 429), add:

```javascript
        if (msg.type === 'showDiff') {
            renderDiff(msg.hunks);
        }
        if (msg.type === 'clearDiff') {
            clearDiff();
            diffModeEnabled = false;
            const toggle = document.getElementById('diff-mode-toggle');
            if (toggle) {
                toggle.dataset.enabled = 'false';
                toggle.textContent = 'OFF';
            }
        }
```

- [ ] **Step 5: Verify the extension compiles and diff rendering works**

Run: `npm run compile` then launch the extension (F5). Open a file in Review Mode that has at least 2 revisions. Toggle Diff Mode ON. Verify:
- The code pane updates to show diff lines
- Added lines have green background and `+` marker
- Deleted lines have red background, `−` marker, and no line number
- Unchanged lines render normally

- [ ] **Step 6: Commit**

```bash
git add media/review.js
git commit -m "feat: add diff mode toggle and inline diff rendering in webview"
```

---

### Task 7: Add History Tab Pin Mechanics and Reverse Chronological Order

**Files:**
- Modify: `media/review.js` (renderHistoryPane function, lines 433-456)
- Modify: `media/review.css`

- [ ] **Step 1: Update renderHistoryPane to show reverse chronological order with pin icons**

Replace the existing `renderHistoryPane` function in `media/review.js` with:

```javascript
    /** @type {number} */
    let pinnedRevision = -1;

    function renderHistoryPane(revisions, currentRevision) {
        const pane = document.getElementById('history-pane-content');
        if (!pane) { return; }
        if (!revisions || revisions.length === 0) {
            pane.innerHTML = '<div class="history-empty">No revisions yet.</div>';
            return;
        }
        pane.innerHTML = '';

        // Reverse chronological: latest first
        const sorted = [...revisions].sort((a, b) => b.revision - a.revision);
        const latestRevision = sorted[0].revision;
        const hasPinnableVersions = sorted.length >= 2;

        // Default pin to N-1 if not yet set
        if (pinnedRevision < 0 && sorted.length >= 2) {
            pinnedRevision = sorted[1].revision;
        }

        for (const rev of sorted) {
            const date = new Date(rev.createdAt);
            const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isLatest = rev.revision === latestRevision;
            const isPinned = rev.revision === pinnedRevision;
            const item = document.createElement('div');
            item.className = 'history-item' + (rev.revision === currentRevision ? ' active' : '');

            let pinHtml = '';
            if (!isLatest && hasPinnableVersions) {
                pinHtml = `<button class="pin-btn${isPinned ? ' pinned' : ''}" data-pin-revision="${rev.revision}" title="${isPinned ? 'Unpin (revert to default)' : 'Set as diff base'}">
                    <span class="codicon codicon-pin"></span>
                </button>`;
            }

            item.innerHTML = `
                ${pinHtml}
                <span class="history-rev">rev${rev.revision}${isLatest ? ' (current)' : ''}</span>
                <span class="history-date">${dateStr}</span>
                <span class="history-count${rev.totalCount > 0 && rev.addressedCount === rev.totalCount ? ' all-addressed' : ''}">${rev.totalCount === 0 ? '0 comments' : rev.addressedCount + '/' + rev.totalCount + ' comment' + (rev.totalCount !== 1 ? 's' : '')}</span>
            `;
            item.addEventListener('click', (e) => {
                if (e.target.closest('.pin-btn')) { return; }
                vscode.postMessage({ type: 'openRevision', revision: rev.revision });
            });
            pane.appendChild(item);
        }

        // Pin button click delegation
        pane.addEventListener('click', (e) => {
            const pinBtn = e.target.closest('.pin-btn');
            if (!pinBtn) { return; }
            const revision = parseInt(pinBtn.dataset.pinRevision, 10);

            if (revision === pinnedRevision) {
                // Clicking the pinned entry: revert to default (N-1)
                const defaultPin = sorted.length >= 2 ? sorted[1].revision : -1;
                if (revision === defaultPin) { return; } // no-op if already default
                pinnedRevision = defaultPin;
            } else {
                pinnedRevision = revision;
            }

            vscode.postMessage({ type: 'pinVersion', revision: pinnedRevision });
            renderHistoryPane(revisions, currentRevision);
        });
    }
```

- [ ] **Step 2: Add pin button CSS**

Add the following CSS to `media/review.css` after the history styles (after line 154):

```css
/* --- Pin button in history items --- */
.pin-btn {
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--vscode-descriptionForeground, #666);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 4px;
    opacity: 0.4;
    transition: all 0.15s;
    flex-shrink: 0;
}

.pin-btn:hover {
    opacity: 0.8;
    background: rgba(255, 255, 255, 0.06);
}

.pin-btn.pinned {
    opacity: 1;
    color: var(--accent);
    border-color: rgba(37, 99, 235, 0.3);
    background: rgba(37, 99, 235, 0.08);
}
```

- [ ] **Step 3: Verify the history tab works**

Run: `npm run compile` then launch the extension. Open a file with multiple revisions. Verify:
- History is shown newest-first
- The latest revision shows "(current)" and has no pin
- The second entry is pinned by default
- Clicking another entry's pin updates the diff
- Clicking the pinned entry reverts to default

- [ ] **Step 4: Commit**

```bash
git add media/review.js media/review.css
git commit -m "feat: add reverse-chronological history with pin-based diff selection"
```

---

### Task 8: Add Diff Context to addNote Messages

**Files:**
- Modify: `media/review.js` (submit function inside showInlineCommentForm)

- [ ] **Step 1: Update the submit function to include diff context**

In the `showInlineCommentForm` function in `media/review.js`, find the `submit` function (around line 182). Replace the `vscode.postMessage` call with one that conditionally includes diff context:

Replace this block inside the `submit` closure:

```javascript
            const text = input.value.trim();
            if (text) {
                vscode.postMessage({
                    type: 'addNote',
                    startLine: startLine,
                    endLine: endLine,
                    text: text,
                });
            }
```

With:

```javascript
            const text = input.value.trim();
            if (text) {
                const message = {
                    type: 'addNote',
                    startLine: startLine,
                    endLine: endLine,
                    text: text,
                };

                // If diff mode is active, extract context from the current hunks
                if (diffModeEnabled && currentDiffHunks) {
                    const context = extractDiffContextFromHunks(currentDiffHunks, startLine, endLine);
                    if (context) {
                        message.previousVersionContext = context.previousVersionContext;
                        message.currentVersionContext = context.currentVersionContext;
                    }
                }

                vscode.postMessage(message);
            }
```

- [ ] **Step 2: Add the client-side extractDiffContextFromHunks function**

Add this function in `media/review.js`, near the other utility functions (after `escapeHtml`):

```javascript
    function extractDiffContextFromHunks(hunks, lineStart, lineEnd) {
        const contextSize = 3;
        // Build flat row list with current-file line tracking
        let currentLine = 0;
        const rows = [];

        for (const hunk of hunks) {
            for (const line of hunk.lines) {
                if (hunk.type === 'removed') {
                    rows.push({ type: 'removed', text: line, currentLine: null });
                } else {
                    currentLine++;
                    rows.push({ type: hunk.type, text: line, currentLine: currentLine });
                }
            }
        }

        // Find rows overlapping with [lineStart, lineEnd]
        let firstIdx = -1;
        let lastIdx = -1;
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (r.currentLine !== null && r.currentLine >= lineStart && r.currentLine <= lineEnd) {
                if (firstIdx === -1) { firstIdx = i; }
                lastIdx = i;
            }
        }

        if (firstIdx === -1) { return null; }

        // Expand to include adjacent removed blocks
        while (firstIdx > 0 && rows[firstIdx - 1].type === 'removed') { firstIdx--; }
        while (lastIdx < rows.length - 1 && rows[lastIdx + 1].type === 'removed') { lastIdx++; }

        // Check if any row in range is a diff
        let hasChange = false;
        for (let i = firstIdx; i <= lastIdx; i++) {
            if (rows[i].type !== 'unchanged') { hasChange = true; break; }
        }
        if (!hasChange) { return null; }

        // Expand for context
        const start = Math.max(0, firstIdx - contextSize);
        const end = Math.min(rows.length - 1, lastIdx + contextSize);

        const prevLines = [];
        const currLines = [];
        for (let i = start; i <= end; i++) {
            const r = rows[i];
            if (r.type === 'removed') {
                prevLines.push('-' + r.text);
            } else if (r.type === 'added') {
                currLines.push('+' + r.text);
            } else {
                prevLines.push(' ' + r.text);
                currLines.push(' ' + r.text);
            }
        }

        return {
            previousVersionContext: prevLines.join('\n'),
            currentVersionContext: currLines.join('\n'),
        };
    }
```

- [ ] **Step 3: Verify diff context is captured in annotations**

Run: `npm run compile` then launch the extension. Open a file with 2+ revisions, toggle Diff Mode ON, add a comment on a line that has a diff change. Then open the corresponding `revN.json` file in the `.revisions` directory and verify that the annotation has `previousVersionContext` and `currentVersionContext` fields populated with diff hunk content.

- [ ] **Step 4: Commit**

```bash
git add media/review.js
git commit -m "feat: capture diff context in annotations when commenting in diff mode"
```

---

### Task 9: Handle Markdown Raw Mode in Diff View

**Files:**
- Modify: `src/webviewPanel.ts` (refreshContent method and handling)

- [ ] **Step 1: Add a method to render raw content (non-Markdown-rendered) for diff mode**

In `src/webviewPanel.ts`, add a new method after `refreshContent()`:

```typescript
    refreshContentRaw(originalPath: string, snapshotPath: string): void {
        const ctx = this.panels.get(originalPath);
        if (!ctx) { return; }
        ctx.snapshotPath = snapshotPath;

        const content = fs.readFileSync(snapshotPath, 'utf-8');
        const lines = content.split('\n');
        const ext = path.extname(snapshotPath).toLowerCase();
        const lang = EXT_TO_LANG[ext] ?? 'markdown';

        let bodyContent = '';
        if (this.highlighter) {
            const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
                ? 'light-plus' : 'dark-plus';
            try {
                const tokens = this.highlighter.codeToTokensBase(content, { lang: lang as BundledLanguage, theme });
                for (let i = 0; i < tokens.length; i++) {
                    const lineNum = i + 1;
                    const lineTokens = tokens[i];
                    const highlightedLine = lineTokens.map(token => {
                        const escaped = this.escapeHtml(token.content);
                        return token.color
                            ? `<span style="color:${token.color}">${escaped}</span>`
                            : escaped;
                    }).join('');
                    bodyContent += this.lineTemplate(lineNum, highlightedLine || '&nbsp;');
                }
            } catch {
                for (let i = 0; i < lines.length; i++) {
                    bodyContent += this.lineTemplate(i + 1, this.escapeHtml(lines[i]) || '&nbsp;');
                }
            }
        } else {
            for (let i = 0; i < lines.length; i++) {
                bodyContent += this.lineTemplate(i + 1, this.escapeHtml(lines[i]) || '&nbsp;');
            }
        }

        this.ensureStoreContext(originalPath);
        ctx.panel.webview.postMessage({ type: 'replaceContent', html: bodyContent });
        this.sendAnnotationUpdate(originalPath);
    }
```

- [ ] **Step 2: Update ReviewModeController to use raw mode when diff is active on Markdown files**

In `src/reviewMode.ts`, update the `sendDiffToWebview` method. Before computing hunks, check if the file is Markdown and switch to raw rendering. Add at the start of `sendDiffToWebview`, before the `if (!this.diffModeEnabled)` check:

Replace the entire `sendDiffToWebview` method with:

```typescript
    private sendDiffToWebview(originalPath: string): void {
        if (!this.diffModeEnabled) {
            this.webview.postMessageToPanel(originalPath, { type: 'clearDiff' });
            // If markdown, restore rendered view
            const ext = path.extname(originalPath).toLowerCase();
            if (ext === '.md' || ext === '.markdown') {
                const revisions = this.store.getRevisions();
                if (revisions.length > 0) {
                    const plansDir = this.store.getPlansDir();
                    const latest = revisions[revisions.length - 1];
                    this.webview.refreshContent(originalPath, path.join(plansDir, latest.snapshotFile));
                }
            }
            return;
        }

        const revisions = this.store.getRevisions();
        if (revisions.length === 0) { return; }

        const plansDir = this.store.getPlansDir();
        const latestRevision = revisions[revisions.length - 1];
        const latestSnapshotPath = path.join(plansDir, latestRevision.snapshotFile);
        const currentText = fs.readFileSync(latestSnapshotPath, 'utf-8');

        let baseText = '';
        if (this.pinnedRevision >= 0 && this.pinnedRevision < revisions.length) {
            const baseSnapshotPath = path.join(plansDir, revisions[this.pinnedRevision].snapshotFile);
            baseText = fs.readFileSync(baseSnapshotPath, 'utf-8');
        }

        const hunks = computeDiffHunks(baseText, currentText);
        this.webview.postMessageToPanel(originalPath, { type: 'showDiff', hunks });
    }
```

Note: The raw rendering for Markdown in diff mode is handled by the `showDiff` message — the webview's `renderDiff` function always renders raw text (using `escapeHtml` on line content from the hunks). The extension sends the diff hunks which contain raw text, so no Markdown rendering happens. When diff mode is turned OFF, `clearDiff` triggers and `refreshContent` is called, which re-renders Markdown normally.

- [ ] **Step 3: Verify Markdown files show raw in diff mode**

Run: `npm run compile`, launch extension, open a `.md` file in Review Mode with 2+ revisions. Toggle Diff Mode ON and verify:
- Content shows as raw Markdown text (not rendered headings/links)
- Diff highlighting (red/green) is visible
- Toggle Diff Mode OFF: content returns to rendered Markdown

- [ ] **Step 4: Commit**

```bash
git add src/webviewPanel.ts src/reviewMode.ts
git commit -m "feat: render Markdown as raw text during diff mode"
```

---

### Task 10: Handle Single Revision Edge Case

**Files:**
- Modify: `media/review.js` (renderHistoryPane)
- Already handled in: `src/reviewMode.ts` (sendDiffToWebview uses empty baseText when pinnedRevision is -1)

- [ ] **Step 1: Verify single revision behavior**

The architecture already handles this:
- When there's only one revision, `pinnedRevision` stays at `-1`
- `sendDiffToWebview` uses `baseText = ''` (empty string) when `pinnedRevision < 0`
- `computeDiffHunks('', currentText)` returns all lines as `added` hunks
- `renderHistoryPane` already hides pins when `sorted.length < 2` (`hasPinnableVersions = false`)

Run: `npm run compile`, launch extension, open a file in Review Mode for the first time (only rev0 exists). Toggle Diff Mode ON and verify:
- All lines show as added (green background)
- No pin icons appear in the History tab
- Comments work normally

- [ ] **Step 2: Commit (skip if no changes needed)**

If verification passes with no code changes, skip this commit.

---

### Task 11: Integration Testing and Polish

**Files:**
- All modified files from previous tasks

- [ ] **Step 1: Run full verification checklist**

Launch the extension and run through the Phase 1 verification plan from the design spec:

1. Open a file in Review Mode
2. Verify the secondary toolbar appears with "Diff Mode" (Off) and "Local / Git" (Git greyed out)
3. Toggle "Diff Mode" ON — verify code pane shows inline diff (raw content for Markdown)
4. Verify history is in reverse chronological order (newest first)
5. Verify the second entry (previous revision) is pinned by default
6. Pin a different older version — verify the diff updates immediately
7. Verify deleted lines: red background, no line number, `−` gutter marker
8. Verify added lines: green background, line number, `+` gutter marker
9. Add a comment on a deleted line — verify it anchors to the nearest surviving line above
10. Add a comment on a diffed line — inspect `.revX.json` for `previousVersionContext` / `currentVersionContext`
11. Single revision (rev0 only): verify Diff Mode shows all lines as added, no pin icons
12. Toggle Diff Mode OFF — verify normal view resumes (Markdown rendered if applicable)

- [ ] **Step 2: Fix any issues found during verification**

Address any bugs or visual issues found during the checklist.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: inline diff mode for Review Mode (Phase 1 - Local history)"
```
