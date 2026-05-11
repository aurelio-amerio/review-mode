# Diff-Mode Annotation Visibility Fixes

> **For Antigravity:** REQUIRED SUB-SKILL: Load executing-plans to implement this plan task-by-task.

**Goal:** Fix three visual/UX issues with annotations in diff mode: persistence across toggles, non-overlapping highlight strategy, and gutter element ordering.

**Architecture:** All three fixes are CSS + JS changes in the webview layer (`media/review.js`, `media/review.css`), plus a small extension-side fix in `webviewPanel.ts` to send annotations after diff renders. No schema or data changes needed.

**Tech Stack:** Vanilla JS (webview), CSS, VS Code Webview API message passing

---

## Issue Analysis

### Issue 1: Annotations vanish when re-enabling diff mode

**Root cause:** When diff mode is toggled ON, the extension calls `sendHighlightedDiff()` ([webviewPanel.ts:221](file:///c:/Users/Aure/Documents/GitHub/vscode-planner/src/webviewPanel.ts#L221)) which sends a `showDiff` message. In the webview, `renderDiff()` ([review.js:500](file:///c:/Users/Aure/Documents/GitHub/vscode-planner/media/review.js#L500)) replaces the entire `codePane.innerHTML` (line 548), destroying all `.annotated` classes and `.annotation-badge` elements. **No `sendAnnotationUpdate()` is called after `sendHighlightedDiff()`**, so annotation highlights are never re-applied to the freshly rendered DOM.

When a new comment is added, the store's `onDidChange` fires → `sendAnnotationUpdate()` runs → highlights re-appear. That's why adding a comment "fixes" it.

**Fix:** After `sendHighlightedDiff()`, call `sendAnnotationUpdate()` so the webview receives both messages in sequence: first the new DOM, then the annotation data to highlight on it.

### Issue 2: Blue annotation background overlaying diff green/red

**Current behavior:** `.annotated` applies `border-left-color: var(--accent)` and `background: var(--highlight)` (blue tint). On diff lines that are `.diff-added` (green) or `.diff-removed` (red), the blue background overwrites the diff color.

**Desired behavior:** Diff colors (green/red) must remain untouched. Instead of coloring the diff line itself, add a thin **annotation indicator bar below** the annotated line — a separate `<div>` element appended after the line-container, styled as a narrow blue strip.

**Fix:** Modify `updateAnnotationHighlights()` in review.js to, when in diff mode, insert a thin indicator `<div>` after the line-container instead of applying the `.annotated` class background. The `.annotated` class still applies the blue `border-left` for unchanged lines, but diff-typed lines get the indicator-bar treatment.

### Issue 3: Comment button position in gutter

**Current layout** (from screenshot): `[line-number] [diff-marker] [add-note-btn] | content`
The add-note-btn sits between the line number and the content, competing for space with the diff gutter marker.

**Desired layout:** `[add-note-btn] [line-number] [diff-marker] | content`
Move the comment button to the far left of the gutter so it's always clearly visible and doesn't conflict with diff markers.

**Fix:** Reorder the elements in the gutter HTML templates (both in `lineTemplate()` in webviewPanel.ts and in `renderDiff()` in review.js), and adjust CSS to accommodate the new order.

---

## Proposed Changes

### Task 1: Fix annotation persistence across diff toggles

**Files:**
- Modify: `src/webviewPanel.ts:186-225`

**Step 1: Add `sendAnnotationUpdate()` after each `showDiff` post**

In `sendHighlightedDiff()`, add `this.sendAnnotationUpdate(originalPath)` after each `postMessage({ type: 'showDiff' ... })` call:

```diff
             this.panels.get(originalPath)?.panel.webview.postMessage({ type: 'showDiff', hunks: highlightedHunks });
+            this.sendAnnotationUpdate(originalPath);
         } else {
             this.panels.get(originalPath)?.panel.webview.postMessage({ type: 'showDiff', hunks });
+            this.sendAnnotationUpdate(originalPath);
         }
```

This ensures the webview message queue receives `showDiff` → `updateAnnotations` in sequence, so `updateAnnotationHighlights()` runs on the already-rebuilt DOM.

**Step 2: Build and verify**

Run: `npm run compile`
Expected: clean build, no errors.

---

### Task 2: Non-overlapping annotation indicator in diff mode

**Files:**
- Modify: `media/review.js:664-685` — `updateAnnotationHighlights()`
- Modify: `media/review.css` — new `.annotation-indicator` style

**Step 1: Update `updateAnnotationHighlights()` in review.js**

Replace the function to handle diff lines differently:

```javascript
function updateAnnotationHighlights(annotations) {
    // Clear previous highlights
    document.querySelectorAll('.line-container.annotated').forEach(el => {
        el.classList.remove('annotated');
    });
    document.querySelectorAll('.annotation-badge').forEach(el => el.remove());
    document.querySelectorAll('.annotation-indicator').forEach(el => el.remove());

    for (const ann of annotations) {
        for (let i = ann.startLine; i <= ann.endLine; i++) {
            const container = document.querySelector(`.line-container[data-line="${i}"]`);
            if (container) {
                const isDiffLine = container.classList.contains('diff-added') || container.classList.contains('diff-removed');

                if (isDiffLine) {
                    // For diff lines: add a thin blue indicator bar below instead of overlaying background
                    // Only add one indicator per line (check if already present)
                    if (!container.nextElementSibling || !container.nextElementSibling.classList.contains('annotation-indicator')) {
                        const indicator = document.createElement('div');
                        indicator.className = 'annotation-indicator';
                        container.after(indicator);
                    }
                } else {
                    // For unchanged lines: use the normal annotated highlight
                    container.classList.add('annotated');
                }

                // Badge on the start line (works for both diff and non-diff lines)
                if (i === ann.startLine) {
                    const badge = document.createElement('span');
                    badge.className = 'annotation-badge';
                    badge.textContent = `${ann.threadCount}`;
                    badge.title = `${ann.threadCount} comment(s)`;
                    container.appendChild(badge);
                }
            }
        }
    }
}
```

**Step 2: Add `.annotation-indicator` CSS**

In `media/review.css`, after the `.annotation-badge` rules (around line 457), add:

```css
/* --- Annotation indicator bar (for diff lines where blue bg would conflict) --- */
.annotation-indicator {
    height: 2px;
    background: var(--accent);
    margin: 0;
    border-left: 3px solid var(--accent);
    opacity: 0.6;
}
```

**Step 3: Build and verify**

Run: `npm run compile`
Expected: clean build, no errors.

---

### Task 3: Move comment button to far-left of gutter

**Files:**
- Modify: `media/review.js:500-548` — `renderDiff()` gutter HTML
- Modify: `src/webviewPanel.ts:549-558` — `lineTemplate()`
- Modify: `src/webviewPanel.ts:402-547` — markdown renderer gutter HTML (all `line-gutter` blocks)
- Modify: `media/review.css:380-437` — gutter layout adjustments

**Step 1: Reorder `lineTemplate()` in webviewPanel.ts**

```diff
     private lineTemplate(lineNum: number, content: string): string {
         return `<div class="line-container" data-line="${lineNum}">
     <div class="line-gutter">
-        <span class="line-number">${lineNum}</span>
         <button class="add-note-btn" data-line="${lineNum}" title="Add comment">...</button>
+        <span class="line-number">${lineNum}</span>
     </div>
     <div class="line-content">${content}</div>
 </div>\n`;
     }
```

**Step 2: Reorder all markdown renderer gutter blocks in webviewPanel.ts**

Apply the same `add-note-btn` before `line-number` swap to every `line-gutter` block in:
- `renderMarkdownDocument()` — empty-line template (~line 506-512), list-item template (~line 521-527), block template (~line 531-537)
- `renderTodosSection()` — todo item template (~line 424-427)

**Step 3: Reorder `renderDiff()` gutter blocks in review.js**

For each hunk type, move button before line-number and diff-marker:

```diff
 // Removed lines:
     <div class="line-gutter">
+        <button class="add-note-btn" ...>${addNoteIcon}</button>
         <span class="line-number"></span>
         <span class="diff-gutter-marker removed">−</span>
-        <button class="add-note-btn" ...>${addNoteIcon}</button>
     </div>

 // Added lines:
     <div class="line-gutter">
+        <button class="add-note-btn" ...>${addNoteIcon}</button>
         <span class="line-number">${currentLineNum}</span>
         <span class="diff-gutter-marker added">+</span>
-        <button class="add-note-btn" ...>${addNoteIcon}</button>
     </div>

 // Unchanged lines:
     <div class="line-gutter">
+        <button class="add-note-btn" ...>${addNoteIcon}</button>
         <span class="line-number">${currentLineNum}</span>
-        <button class="add-note-btn" ...>${addNoteIcon}</button>
     </div>
```

**Step 4: Adjust CSS gutter layout**

Widen the gutter offset and code-pane padding to accommodate the button now being first:

```diff
 .line-gutter {
     position: absolute;
-    left: -44px;
+    left: -64px;
     top: 2px;
     ...
 }

 .code-pane {
     ...
-    padding-left: 48px;
+    padding-left: 68px;
 }
```

**Step 5: Build and verify**

Run: `npm run compile`
Expected: clean build, no errors.

---

## Verification Plan

### Build Verification

```bash
npm run compile
```
Expected: clean compilation, no errors.

```bash
npx @vscode/vsce package --no-dependencies
```
Expected: VSIX built successfully.

### Manual Verification

1. **Toggle persistence (Issue 1):**
   - Open a file with multiple revisions and existing annotations
   - Enable diff mode → annotations should show
   - Disable diff mode → annotations should show
   - Re-enable diff mode → annotations **must** still show (this is the bug)

2. **Non-overlapping highlights (Issue 2):**
   - Create annotations on diff-added (green) and diff-removed (red) lines
   - Green/red backgrounds must remain untouched
   - A thin blue bar appears below annotated diff lines
   - Unchanged lines in diff still show the normal blue highlight

3. **Gutter ordering (Issue 3):**
   - In both normal and diff mode, the comment button (💬+) appears to the **left** of line numbers
   - In diff mode, the diff markers (+/−) appear to the **right** of line numbers
   - No visual overlap or cropping
