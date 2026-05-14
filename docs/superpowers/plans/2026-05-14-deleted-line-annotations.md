# Deleted-Line Annotation Redesign

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Properly support annotations on deleted diff lines by tracking old-file line numbers, showing side-by-side OLD|NEW line numbers in the gutter, moving annotation count badges into the gutter, and supporting multi-line selection across consecutive deleted lines.

**Architecture:** The `Annotation` interface gains optional `oldStartLine`/`oldEndLine` fields for deleted-line annotations. The diff renderer tracks both old- and new-file line counters, stamping `data-old-line` on removed line containers. Badge injection and highlight lookup use `data-old-line` for deleted annotations. A parallel `deletedSelStart`/`deletedSelEnd` state handles shift-click ranges on deleted lines. The gutter is widened in diff mode to show both OLD and NEW line number columns.

**Tech Stack:** TypeScript (VS Code extension), vanilla JS (webview), CSS custom properties

---

## File Map

| File | Change |
|------|--------|
| `src/annotationStore.ts` | Add `oldStartLine?`/`oldEndLine?` to `Annotation`; update `addAnnotation` |
| `src/webviewPanel.ts` | Use `msg.textPreview` when provided; store `oldStartLine`/`oldEndLine` |
| `media/review.js` | Track old-line counter in `renderDiff`; update `updateAnnotationHighlights`; new deleted-line selection state; pass old-line data in `addNote` |
| `media/review.css` | Widen diff-mode gutter; style badge in gutter |

---

### Task 1: Extend the Annotation data model

**Files:**
- Modify: `src/annotationStore.ts`

- [ ] **Step 1: Add optional old-line fields to `Annotation` interface**

In `src/annotationStore.ts`, update the `Annotation` interface (currently at line 16) and `addAnnotation` method (currently at line 231):

```typescript
export interface Annotation {
    id: string;
    startLine: number;
    endLine: number;
    oldStartLine?: number;   // old-file line for deleted-line annotations
    oldEndLine?: number;
    textPreview: string;
    priority: Priority;
    status: Status;
    thread: Message[];
    deletedLine?: boolean;
    previousVersionContext?: string;
    currentVersionContext?: string;
}
```

- [ ] **Step 2: Update `addAnnotation` to accept and store old-line fields**

Replace the existing `addAnnotation` signature and body:

```typescript
addAnnotation(
    startLine: number,
    endLine: number,
    textPreview: string,
    text: string,
    opts?: { oldStartLine?: number; oldEndLine?: number },
): Annotation {
    const existing = this.annotations.find(a => a.startLine === startLine && a.endLine === endLine);
    if (existing) { this.addMessage(existing.id, text); return existing; }

    const annotation: Annotation = {
        id: this.generateId(),
        startLine,
        endLine,
        textPreview,
        priority: 'none',
        status: 'open',
        thread: [{ id: this.generateId(), text, createdAt: new Date().toISOString() }],
    };
    if (opts?.oldStartLine !== undefined) { annotation.oldStartLine = opts.oldStartLine; }
    if (opts?.oldEndLine !== undefined) { annotation.oldEndLine = opts.oldEndLine; }
    this.annotations.push(annotation);
    this.annotations.sort((a, b) => a.startLine - b.startLine);
    this.saveCurrentRevision();
    this._onDidChange.fire();
    return annotation;
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/annotationStore.ts
git commit -m "feat: add oldStartLine/oldEndLine to Annotation for deleted-line support"
```

---

### Task 2: Update the addNote handler in webviewPanel.ts

**Files:**
- Modify: `src/webviewPanel.ts` (around line 611)

The client will now send `textPreview` and `oldStartLine`/`oldEndLine` in the `addNote` message for deleted-line annotations. The server should use them when present.

- [ ] **Step 1: Update the `addNote` case**

Replace the existing `case 'addNote':` block (currently lines 611–622):

```typescript
case 'addNote': {
    const content = fs.readFileSync(ctx.snapshotPath, 'utf-8');
    const lines = content.split('\n');
    // Client sends textPreview for deleted lines (old-file content); fall back to current file
    const previewLine = (msg.textPreview as string | undefined)
        ?? lines[msg.startLine - 1]?.trim()
        ?? '';
    const opts = (msg.oldStartLine !== undefined)
        ? { oldStartLine: msg.oldStartLine as number, oldEndLine: (msg.oldEndLine ?? msg.oldStartLine) as number }
        : undefined;
    const annotation = this.store.addAnnotation(msg.startLine, msg.endLine, previewLine, msg.text, opts);
    const isNewAnnotation = annotation.thread.length === 1;
    if (isNewAnnotation && msg.previousVersionContext && msg.currentVersionContext) {
        annotation.previousVersionContext = msg.previousVersionContext;
        annotation.currentVersionContext = msg.currentVersionContext;
        this.store.saveAfterContextUpdate();
    }
    break;
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/webviewPanel.ts
git commit -m "feat: use client-supplied textPreview and old-line fields in addNote handler"
```

---

### Task 3: Track old-line numbers in renderDiff and add data-old-line

**Files:**
- Modify: `media/review.js` — `renderDiff` function (currently around line 543)

- [ ] **Step 1: Replace `renderDiff` with old-line tracking and side-by-side gutter HTML**

Replace the entire `renderDiff` function:

```javascript
function renderDiff(hunks) {
    currentDiffHunks = hunks;
    const codePane = document.querySelector('.code-pane');
    if (!codePane) { return; }

    document.body.classList.add('diff-mode');

    const totalCurrentLines = hunks.reduce((sum, h) => h.type !== 'removed' ? sum + h.lines.length : sum, 0);
    const addNoteIcon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9h-3.5L8 12.5 5.5 10H2V2h12v8z"/><path d="M7.25 4v2.25H5v1.5h2.25V10h1.5V7.75H11v-1.5H8.75V4z"/></svg>';
    let html = '';
    let oldLineNum = 0;
    let currentLineNum = 0;

    for (const hunk of hunks) {
        for (let i = 0; i < hunk.lines.length; i++) {
            const line = hunk.lines[i];
            const lineHtml = (hunk.highlightedLines && hunk.highlightedLines[i]) || escapeHtml(line) || '&nbsp;';
            if (hunk.type === 'removed') {
                oldLineNum++;
                const anchorLine = Math.min(currentLineNum + 1, totalCurrentLines || 1);
                html += `<div class="line-container diff-removed" data-line="${anchorLine}" data-old-line="${oldLineNum}" data-diff-type="removed">
    <div class="line-gutter">
        <button class="add-note-btn" data-line="${anchorLine}" data-old-line="${oldLineNum}" title="Add comment">${addNoteIcon}</button>
        <span class="line-number old-line-number">${oldLineNum}</span>
        <span class="line-number new-line-number"></span>
        <span class="diff-gutter-marker removed">−</span>
    </div>
    <div class="line-content">${lineHtml}</div>
</div>\n`;
            } else if (hunk.type === 'added') {
                oldLineNum;  // old line counter does not advance for added lines
                currentLineNum++;
                html += `<div class="line-container diff-added" data-line="${currentLineNum}" data-diff-type="added">
    <div class="line-gutter">
        <button class="add-note-btn" data-line="${currentLineNum}" title="Add comment">${addNoteIcon}</button>
        <span class="line-number old-line-number"></span>
        <span class="line-number new-line-number">${currentLineNum}</span>
        <span class="diff-gutter-marker added">+</span>
    </div>
    <div class="line-content">${lineHtml}</div>
</div>\n`;
            } else {
                oldLineNum++;
                currentLineNum++;
                html += `<div class="line-container" data-line="${currentLineNum}">
    <div class="line-gutter">
        <button class="add-note-btn" data-line="${currentLineNum}" title="Add comment">${addNoteIcon}</button>
        <span class="line-number old-line-number">${oldLineNum}</span>
        <span class="line-number new-line-number">${currentLineNum}</span>
    </div>
    <div class="line-content">${lineHtml}</div>
</div>\n`;
            }
        }
    }

    codePane.innerHTML = html;
}
```

Note: the lone `oldLineNum;` statement on the added-line path is a no-op that makes the intent explicit — remove it if you prefer.

- [ ] **Step 2: Verify visually**

Load the extension in VS Code Extension Development Host, open the test project `hello.py`, enter diff mode. Confirm:
- Deleted lines show the old line number in the left column, blank in the right
- Added lines show blank in the left column, new line number in the right
- Unchanged lines show both numbers

- [ ] **Step 3: Commit**

```bash
git add media/review.js
git commit -m "feat: track old-line numbers in renderDiff, add data-old-line to removed containers"
```

---

### Task 4: CSS — widen diff-mode gutter and style badge in gutter

**Files:**
- Modify: `media/review.css`

- [ ] **Step 1: Widen gutter and code-pane for diff mode**

After the existing `body.diff-mode .line-number { display: block; }` rule (currently around line 431), add:

```css
/* Diff mode: wider gutter to fit old + new line number columns */
body.diff-mode .code-pane {
    padding-left: 104px;
}

body.diff-mode .line-gutter {
    left: -100px;
}
```

- [ ] **Step 2: Style old/new line-number columns**

After the `.line-number` rule block (currently around line 417), add:

```css
.old-line-number,
.new-line-number {
    min-width: 22px;
    text-align: right;
}
```

- [ ] **Step 3: Move badge into gutter**

Replace the existing `.annotation-badge` rule (currently around line 474):

```css
.annotation-badge {
    background: var(--accent);
    color: white;
    border-radius: 10px;
    padding: 0 5px;
    font-size: 0.7em;
    flex-shrink: 0;
    line-height: 1.6;
    min-width: 16px;
    text-align: center;
    cursor: default;
}
```

(Removes `margin-left: 8px` and `align-self: center` since the badge now lives inside the flex gutter, not appended to the line container.)

- [ ] **Step 4: Check gutter alignment visually**

Reload the extension, open diff mode. The two line-number columns should be visible and aligned.

- [ ] **Step 5: Commit**

```bash
git add media/review.css
git commit -m "feat: widen diff-mode gutter for old/new line columns, style badge for gutter placement"
```

---

### Task 5: Move annotation badges into the gutter

**Files:**
- Modify: `media/review.js` — `updateAnnotationHighlights` function (currently around line 907)

The badge must be injected into `.line-gutter` instead of appended to the container. For deleted-line annotations (`ann.oldStartLine` is set), look up by `data-old-line`; otherwise by `data-line`.

- [ ] **Step 1: Replace `updateAnnotationHighlights`**

```javascript
function updateAnnotationHighlights(annotations) {
    document.querySelectorAll('.line-container.annotated').forEach(el => {
        el.classList.remove('annotated');
    });
    document.querySelectorAll('.annotation-badge').forEach(el => el.remove());
    document.querySelectorAll('.annotation-indicator').forEach(el => el.remove());

    for (const ann of annotations) {
        // Determine the primary display container (deleted lines use old-line lookup)
        const isDeletedAnnotation = ann.oldStartLine !== undefined;
        const primaryContainer = isDeletedAnnotation
            ? document.querySelector(`.line-container[data-old-line="${ann.oldStartLine}"]`)
            : document.querySelector(`.line-container[data-line="${ann.startLine}"]`);

        if (primaryContainer) {
            // Inject badge into gutter (before the first line-number span)
            const gutter = primaryContainer.querySelector('.line-gutter');
            if (gutter) {
                const badge = document.createElement('span');
                badge.className = 'annotation-badge';
                badge.textContent = `${ann.threadCount}`;
                badge.title = `${ann.threadCount} comment(s)`;
                const firstLineNum = gutter.querySelector('.line-number');
                if (firstLineNum) {
                    gutter.insertBefore(badge, firstLineNum);
                } else {
                    gutter.appendChild(badge);
                }
            }
        }

        // Highlight all new-file lines in the annotation range
        for (let i = ann.startLine; i <= ann.endLine; i++) {
            const container = document.querySelector(`.line-container[data-line="${i}"]`);
            if (!container) { continue; }
            const isDiffLine = container.classList.contains('diff-added') || container.classList.contains('diff-removed');
            if (isDiffLine) {
                if (!container.nextElementSibling || !container.nextElementSibling.classList.contains('annotation-indicator')) {
                    const indicator = document.createElement('div');
                    indicator.className = 'annotation-indicator';
                    container.after(indicator);
                }
            } else {
                container.classList.add('annotated');
            }
        }

        // For deleted annotations: also highlight the deleted-line containers
        if (isDeletedAnnotation) {
            const oldStart = ann.oldStartLine;
            const oldEnd = ann.oldEndLine ?? ann.oldStartLine;
            for (let i = oldStart; i <= oldEnd; i++) {
                const container = document.querySelector(`.line-container[data-old-line="${i}"]`);
                if (container) {
                    if (!container.nextElementSibling || !container.nextElementSibling.classList.contains('annotation-indicator')) {
                        const indicator = document.createElement('div');
                        indicator.className = 'annotation-indicator';
                        container.after(indicator);
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 2: Verify badge placement**

Reload extension, open diff mode. Badges should appear in the gutter (left of line numbers), not appended to line content. For annotations on deleted lines, the badge should appear on the deleted (red) row.

- [ ] **Step 3: Commit**

```bash
git add media/review.js
git commit -m "feat: move annotation badges into gutter, support deleted-line badge lookup by data-old-line"
```

---

### Task 6: Multi-line deleted-line selection and correct addNote payload

**Files:**
- Modify: `media/review.js` — state variables, click handlers, `showInlineCommentForm`, `highlightSelection`

This task:
1. Adds `deletedSelStart`/`deletedSelEnd` state for tracking old-file line ranges on deleted lines
2. Updates the `+btn` click handler to detect deleted lines and pass old-line data
3. Updates `showInlineCommentForm` to accept and forward `oldStartLine`/`oldEndLine` and `textPreview`
4. Updates `highlightSelection` to also highlight deleted-line containers

- [ ] **Step 1: Add deleted-line selection state variables**

After the existing state declarations at the top of the IIFE (after `let selectionEnd = null;`), add:

```javascript
/** @type {number|null} */
let deletedSelStart = null;
/** @type {number|null} */
let deletedSelEnd = null;
/** @type {number|null} - shared new-file anchor for the deleted selection range */
let deletedSelAnchor = null;
```

- [ ] **Step 2: Update `highlightSelection` to include deleted-line containers**

Replace the existing `highlightSelection` function:

```javascript
function highlightSelection(start, end, oldStart, oldEnd) {
    clearSelection();
    // Highlight new-file lines
    if (start !== null && end !== null) {
        const minLine = Math.min(start, end);
        const maxLine = Math.max(start, end);
        for (let i = minLine; i <= maxLine; i++) {
            const el = document.querySelector(`.line-container[data-line="${i}"]:not([data-old-line])`);
            if (el) { el.classList.add('selected'); }
        }
    }
    // Highlight deleted (old-file) lines
    if (oldStart !== null && oldEnd !== null) {
        const minOld = Math.min(oldStart, oldEnd);
        const maxOld = Math.max(oldStart, oldEnd);
        for (let i = minOld; i <= maxOld; i++) {
            const el = document.querySelector(`.line-container[data-old-line="${i}"]`);
            if (el) { el.classList.add('selected'); }
        }
    }
}
```

- [ ] **Step 3: Update `clearSelection`**

Replace the existing `clearSelection`:

```javascript
function clearSelection() {
    document.querySelectorAll('.line-container.selected').forEach(el => {
        el.classList.remove('selected');
    });
}
```

(No change needed — it already clears by class, so deleted-line containers clear correctly.)

- [ ] **Step 4: Update `showInlineCommentForm` to accept old-line params and `textPreview`**

Replace the existing function signature and `addNote` message construction:

```javascript
/**
 * @param {number} startLine  new-file anchor line
 * @param {number} endLine    new-file anchor line
 * @param {{oldStartLine?: number, oldEndLine?: number, textPreview?: string, targetElement?: Element}} [opts]
 */
function showInlineCommentForm(startLine, endLine, opts) {
    if (activeForm) { activeForm.remove(); }

    const oldStartLine = opts?.oldStartLine;
    const oldEndLine = opts?.oldEndLine;
    const suppliedPreview = opts?.textPreview;

    // For deleted lines, insert form after the last selected deleted container;
    // otherwise after the endLine container.
    let targetContainer = opts?.targetElement
        || document.querySelector(`.line-container[data-line="${endLine}"]:not([data-old-line])`)
        || document.querySelector(`.line-container[data-line="${endLine}"]`);
    if (!targetContainer && endLine !== startLine) {
        targetContainer = document.querySelector(`.line-container[data-line="${startLine}"]`);
    }
    if (!targetContainer) { return; }

    highlightSelection(startLine, endLine, oldStartLine ?? null, oldEndLine ?? null);

    const rangeLabel = (oldStartLine !== undefined)
        ? (oldStartLine === oldEndLine ? `deleted line ${oldStartLine}` : `deleted lines ${oldStartLine}–${oldEndLine}`)
        : (startLine !== endLine ? `lines ${startLine}–${endLine}` : `line ${startLine}`);

    const form = document.createElement('div');
    form.className = 'inline-comment-form';
    form.innerHTML = `
        <input class="inline-comment-input" placeholder="Add a comment for ${rangeLabel}..." autofocus />
        <button class="inline-comment-submit">Add</button>
        <button class="inline-comment-cancel">Cancel</button>
    `;

    targetContainer.after(form);
    activeForm = form;

    const input = /** @type {HTMLInputElement} */ (form.querySelector('.inline-comment-input'));
    input.focus();

    const submit = () => {
        const text = input.value.trim();
        if (text) {
            const message = {
                type: 'addNote',
                startLine: startLine,
                endLine: endLine,
                text: text,
            };

            if (oldStartLine !== undefined) {
                message.oldStartLine = oldStartLine;
                message.oldEndLine = oldEndLine ?? oldStartLine;
                if (suppliedPreview !== undefined) { message.textPreview = suppliedPreview; }
            }

            if (diffModeEnabled && currentDiffHunks) {
                const context = extractDiffContextFromHunks(currentDiffHunks, startLine, endLine);
                if (context) {
                    message.previousVersionContext = context.previousVersionContext;
                    message.currentVersionContext = context.currentVersionContext;
                }
            }

            vscode.postMessage(message);
        }
        form.remove();
        activeForm = null;
        clearSelection();
        selectionStart = null;
        selectionEnd = null;
        deletedSelStart = null;
        deletedSelEnd = null;
        deletedSelAnchor = null;
    };
```

The rest of the `showInlineCommentForm` function (cancel button, keydown handler) remains unchanged — only the signature, field declarations, and `submit` body above change. Make sure the closing `}` of the function is still in place.

- [ ] **Step 5: Update the `+btn` click handler to detect deleted lines**

Replace the existing `+btn` click handler (currently around line 147):

```javascript
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.add-note-btn');
    if (!btn) { return; }

    const lineNum = parseInt(btn.dataset.line, 10);
    const oldLineAttr = btn.dataset.oldLine;
    const isDeletedLine = oldLineAttr !== undefined;

    // For markdown blocks, get the full block range from the container
    const container = btn.closest('.line-container');
    const blockEndLine = container && container.dataset.endLine
        ? parseInt(container.dataset.endLine, 10)
        : lineNum;

    // Check native text selection first (user dragged across lines)
    const nativeRange = getSelectionLineRange();
    if (nativeRange && (nativeRange.startLine !== nativeRange.endLine)) {
        showInlineCommentForm(nativeRange.startLine, nativeRange.endLine);
        return;
    }

    if (isDeletedLine) {
        const oldLine = parseInt(oldLineAttr, 10);
        // If there's an active deleted-line range selection, use it
        if (deletedSelStart !== null && deletedSelEnd !== null) {
            const oldStart = Math.min(deletedSelStart, deletedSelEnd);
            const oldEnd = Math.max(deletedSelStart, deletedSelEnd);
            const anchor = deletedSelAnchor ?? lineNum;
            // textPreview = text of the first deleted line in range
            const firstContainer = document.querySelector(`.line-container[data-old-line="${oldStart}"]`);
            const preview = firstContainer
                ? firstContainer.querySelector('.line-content')?.textContent?.trim() ?? ''
                : '';
            showInlineCommentForm(anchor, anchor, {
                oldStartLine: oldStart,
                oldEndLine: oldEnd,
                textPreview: preview,
                targetElement: document.querySelector(`.line-container[data-old-line="${oldEnd}"]`),
            });
        } else {
            // Single deleted line
            const lineText = container?.querySelector('.line-content')?.textContent?.trim() ?? '';
            showInlineCommentForm(lineNum, lineNum, {
                oldStartLine: oldLine,
                oldEndLine: oldLine,
                textPreview: lineText,
                targetElement: container,
            });
        }
        return;
    }

    // Regular (non-deleted) line
    if (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd) {
        const startLine = Math.min(selectionStart, selectionEnd);
        const endLine = Math.max(selectionStart, selectionEnd);
        showInlineCommentForm(startLine, endLine);
        return;
    }

    showInlineCommentForm(lineNum, blockEndLine);
});
```

- [ ] **Step 6: Update the line-container click handler for shift-click selection on deleted lines**

Replace the existing line-container click handler (currently around line 179):

```javascript
document.addEventListener('click', (e) => {
    const container = e.target.closest('.line-container');
    if (!container || e.target.closest('.add-note-btn') || e.target.closest('.inline-comment-form')) {
        return;
    }

    const isDeletedLine = container.dataset.oldLine !== undefined;

    if (isDeletedLine) {
        const oldLine = parseInt(container.dataset.oldLine, 10);
        const anchorLine = parseInt(container.dataset.line, 10);
        if (e.shiftKey && deletedSelStart !== null) {
            deletedSelEnd = oldLine;
            highlightSelection(null, null, deletedSelStart, deletedSelEnd);
        } else {
            clearSelection();
            // Clear any new-line selection when starting a deleted-line selection
            selectionStart = null;
            selectionEnd = null;
            deletedSelStart = oldLine;
            deletedSelEnd = oldLine;
            deletedSelAnchor = anchorLine;
            container.classList.add('selected');
        }
        return;
    }

    const lineNum = parseInt(container.dataset.line, 10);
    if (e.shiftKey && selectionStart !== null) {
        selectionEnd = lineNum;
        highlightSelection(selectionStart, selectionEnd, null, null);
    } else {
        clearSelection();
        // Clear any deleted-line selection when starting a new-line selection
        deletedSelStart = null;
        deletedSelEnd = null;
        deletedSelAnchor = null;
        selectionStart = lineNum;
        selectionEnd = lineNum;
        container.classList.add('selected');
    }
});
```

- [ ] **Step 7: Update existing `highlightSelection` call sites that use positional args**

Search `review.js` for all existing calls to `highlightSelection(start, end)` and update them to the new four-argument signature. The only other call site is inside `showInlineCommentForm` itself (already updated in Step 4). Confirm there are no other call sites:

```bash
grep -n "highlightSelection" /mnt/c/Users/Aure/Documents/GitHub/vscode-planner/media/review.js
```

Expected: only the two locations updated in this task.

- [ ] **Step 8: Verify end-to-end**

Load extension in Extension Development Host, open `hello.py` diff:

1. Click `+` on a deleted line (e.g. `print("xyzzy frobnicator 99999")`) → form appears after that line, placeholder says "deleted line N", annotation JSON saves with `oldStartLine`/`oldEndLine` and correct `textPreview`.
2. Click one deleted line, then shift-click another deleted line in the same removed block → both rows highlight, then click `+` → annotation spans `oldStartLine` to `oldEndLine`.
3. Click `+` on a regular added/unchanged line → behaves as before.
4. Badges appear in the gutter on the left of line numbers, not appended to line content.

- [ ] **Step 9: Commit**

```bash
git add media/review.js
git commit -m "feat: multi-line deleted-line selection, gutter badge placement, correct addNote payload for deleted lines"
```

---

## Self-Review

**Spec coverage:**
- ✅ Badges moved to gutter (Tasks 4 + 5)
- ✅ `oldStartLine`/`oldEndLine` in Annotation data model (Task 1)
- ✅ `webviewPanel.ts` stores old-line fields + uses client-supplied `textPreview` (Task 2)
- ✅ Side-by-side OLD|NEW line numbers in diff gutter (Tasks 3 + 4)
- ✅ `data-old-line` on removed containers (Task 3)
- ✅ Multi-line deleted-line selection via shift-click (Task 6)
- ✅ Single deleted-line annotation with correct `textPreview` (Task 6)

**Potential edge cases covered:**
- End-of-file deletions: `Math.min(currentLineNum + 1, totalCurrentLines || 1)` clamps anchor (Task 3)
- Deleted-line badge lookup uses `data-old-line` not `data-line` (Task 5)
- Mixed new-line / deleted-line selections are mutually exclusive — starting one clears the other (Task 6)
- `showInlineCommentForm` falls back to `data-line` container when `targetElement` is not supplied (Task 6)
