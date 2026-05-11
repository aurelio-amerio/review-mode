# Diff UX Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four diff-mode UX issues: missing border on git history items, broken preview routing, global active-selection state, and a pin-change warning when annotations reference diffed lines.

**Architecture:** Task 1 is a pure CSS one-liner. Task 2 is a two-line backend routing fix. Task 3 replaces the frontend `activeDiffBase: number | null` with a global `activeRef: PinnedRef | null` (mirrors the pin refactor from the previous plan). Task 4 adds an async warning in `reviewMode.ts` that computes diff line overlap with annotations before allowing a pin change.

**Tech Stack:** TypeScript (extension host), vanilla JS (webview), CSS. Diff computation uses `computeDiffHunks` from `src/diffUtils.ts` (which wraps the `diff` npm package). Type check: `npm run check-types`. Full build: `npm run compile`.

---

## File Map

| File | Change |
|---|---|
| `media/review.css` | Task 1: fix `.history-item.git-item` border shorthand |
| `src/reviewMode.ts` | Task 2: fix preview routing; Task 4: async pin warning + suppression state |
| `src/diffUtils.ts` | Task 4: add `getChangedCurrentLines` helper |
| `media/review.js` | Task 3: replace `activeDiffBase` with global `activeRef` |

---

## Task 1: CSS — Git Item Border Fix

**Files:**
- Modify: `media/review.css` (~line 1219)

**Problem:** `.history-item.git-item` uses the `border-left` shorthand (`border-left: 3px solid transparent`), which resets all three sub-properties including `border-left-color`. Because this rule appears at line 1219 — after `.history-item.diff-base` (line 297) and `.history-item.diff-current` (line 290), which both use only `border-left-color` — the shorthand wins at equal specificity, so git items never show the colored left border.

**Fix:** Break the shorthand into three individual declarations.

- [ ] **Step 1: Replace shorthand with individual properties**

In `media/review.css`, find the `.history-item.git-item` rule (~line 1211–1222). The current block looks like:
```css
.history-item.git-item {
    display: grid;
    grid-template-columns: 52px 1fr auto 58px;
    gap: 0 6px;
    align-items: center;
    padding: 5px 8px;
    cursor: default;
    border-radius: 4px;
    border-left: 3px solid transparent;
    margin-bottom: 2px;
    min-height: 32px;
}
```

Replace with:
```css
.history-item.git-item {
    display: grid;
    grid-template-columns: 52px 1fr auto 58px;
    gap: 0 6px;
    align-items: center;
    padding: 5px 8px;
    cursor: default;
    border-radius: 4px;
    border-left-width: 3px;
    border-left-style: solid;
    border-left-color: transparent;
    margin-bottom: 2px;
    min-height: 32px;
}
```

- [ ] **Step 2: Commit**

```bash
git add media/review.css
git commit -m "fix: use individual border-left properties in git-item to allow color override"
```

---

## Task 2: Backend — Fix Preview Routing When Pin Type Is Git

**Files:**
- Modify: `src/reviewMode.ts` (lines ~296–300)

**Problem:** `sendDiffToWebview` currently has an early return for git-type pins that ignores the `overrideRevision` parameter entirely:

```typescript
// Route by pin type, not history view mode
if (this.pinnedRef?.type === 'git') {
    void this.sendGitDiffToWebview(originalPath);
    return;
}
```

This means `onPreviewDiffBase(path, revision)` — which calls `sendDiffToWebview(path, revision)` — silently shows the git diff instead of the requested local revision preview whenever the active pin is a git commit.

**Fix:** Only route to the git diff when no override is provided (i.e., when showing the persisted pin, not a temporary preview).

- [ ] **Step 1: Add the `overrideRevision === undefined` guard**

In `src/reviewMode.ts`, in `sendDiffToWebview`, replace:
```typescript
        // Route by pin type, not history view mode
        if (this.pinnedRef?.type === 'git') {
            void this.sendGitDiffToWebview(originalPath);
            return;
        }
```

With:
```typescript
        // Route by pin type only when showing the persisted pin (no override = not a preview)
        if (overrideRevision === undefined && this.pinnedRef?.type === 'git') {
            void this.sendGitDiffToWebview(originalPath);
            return;
        }
```

- [ ] **Step 2: Type check**

```bash
npm run check-types
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/reviewMode.ts
git commit -m "fix: respect overrideRevision in sendDiffToWebview when pinnedRef is git type"
```

---

## Task 3: Frontend — Global `activeRef` State

**Files:**
- Modify: `media/review.js`

**Problem:** The "currently previewing" selection is tracked as `activeDiffBase: number | null` (local-revision-only) plus ad-hoc DOM class manipulation for git items. This means:
- Switching between local/git history loses the selection
- Git-mode preview state is not stored in JS — it lives only in the DOM and is lost on re-render
- There is no single source of truth for "what are we currently diffing against"

**Fix:** Replace `activeDiffBase` with `activeRef: { type: 'local', revision: number } | { type: 'git', hash: string } | null`. Mirror the `pinnedRef` discriminated union. Always re-render instead of mutating the DOM directly.

**Behavior after fix:**
- History tab: diff shows `activeRef` if set, otherwise `pinnedRef` (the pinned version)
- Switching local↔git in history: `activeRef` clears (backend already resends pinned diff on mode switch)
- Switching away from history tab (to comments etc.): `activeRef` clears
- Comments tab: always diffs against `pinnedRef`

- [ ] **Step 1: Replace `activeDiffBase` declaration (~line 20)**

Find:
```javascript
    let activeDiffBase = null;
```

Replace with:
```javascript
    /** @type {{type: 'local', revision: number} | {type: 'git', hash: string} | null} */
    let activeRef = null;
```

- [ ] **Step 2: Update `activateTab` — clear `activeRef` on tab switch (~line 58)**

Find:
```javascript
            activeDiffBase = null;
            vscode.postMessage({ type: 'revertToPinnedDiff' });
```

Replace with:
```javascript
            activeRef = null;
            vscode.postMessage({ type: 'revertToPinnedDiff' });
```

- [ ] **Step 3: Update diff-mode toggle off (~line 81)**

Find:
```javascript
            activeDiffBase = null;
```

Replace with:
```javascript
            activeRef = null;
```

- [ ] **Step 4: Update `clearDiff` message handler (~line 653)**

Find:
```javascript
            activeDiffBase = null;
```

Replace with:
```javascript
            activeRef = null;
```

- [ ] **Step 5: Update mode-switch handler — clear `activeRef` on mode change (~line 117–123)**

Find the mode-switch handler block:
```javascript
        if (newMode === 'git') {
            gitHistory = [];
            hasMoreGitCommits = false;
            hasWorkingCopy = false;
        }

        vscode.postMessage({ type: 'switchHistoryMode', mode: newMode });
```

Replace with:
```javascript
        if (newMode === 'git') {
            gitHistory = [];
            hasMoreGitCommits = false;
            hasWorkingCopy = false;
        }
        activeRef = null;

        vscode.postMessage({ type: 'switchHistoryMode', mode: newMode });
```

- [ ] **Step 6: Update `renderHistoryPane` — `isDiffBase` check (~line 737)**

Find:
```javascript
                const isDiffBase = activeDiffBase !== null ? (rev.revision === activeDiffBase) : isPinned;
```

Replace with:
```javascript
                const isDiffBase = activeRef?.type === 'local' ? activeRef.revision === rev.revision : isPinned;
```

- [ ] **Step 7: Update local history row click handler (~lines 791–795)**

Find:
```javascript
                activeDiffBase = revision;
                vscode.postMessage({ type: 'previewDiffBase', revision });
                renderHistoryPane(revisions, currentRevision);
```

Replace with:
```javascript
                activeRef = { type: 'local', revision };
                vscode.postMessage({ type: 'previewDiffBase', revision });
                renderHistoryPane(revisions, currentRevision);
```

- [ ] **Step 8: Update `renderGitHistoryPane` — use `activeRef` for `baseClass` (~line 836–837)**

Find:
```javascript
            const isPinned = pinnedRef?.type === 'git' && commit.hash === pinnedRef.hash;
            const baseClass = diffModeEnabled && isPinned ? ' diff-base' : '';
```

Replace with:
```javascript
            const isPinned = pinnedRef?.type === 'git' && commit.hash === pinnedRef.hash;
            const isActive = activeRef?.type === 'git' && commit.hash === activeRef.hash;
            const baseClass = diffModeEnabled && (isActive || (!activeRef && isPinned)) ? ' diff-base' : '';
```

- [ ] **Step 9: Update git history row click handler — replace DOM mutation with state update (~lines 884–890)**

Find:
```javascript
                    if (commitHash) {
                        // Visually mark as temporary diff-base
                        freshPane.querySelectorAll('.history-item.git-item.diff-base').forEach(el => el.classList.remove('diff-base'));
                        item.classList.add('diff-base');
                        vscode.postMessage({ type: 'previewGitDiff', commitHash });
                        return;
                    }
```

Replace with:
```javascript
                    if (commitHash) {
                        activeRef = { type: 'git', hash: commitHash };
                        vscode.postMessage({ type: 'previewGitDiff', commitHash });
                        renderGitHistoryPane();
                        return;
                    }
```

- [ ] **Step 10: Build**

```bash
npm run compile
```

Expected: exits 0.

- [ ] **Step 11: Commit**

```bash
git add media/review.js
git commit -m "refactor: replace activeDiffBase with global activeRef for cross-tab preview state"
```

---

## Task 4: Pin-Change Warning When Annotations Overlap Diff Lines

**Files:**
- Modify: `src/diffUtils.ts` — add `getChangedCurrentLines` helper
- Modify: `src/reviewMode.ts` — add suppression state, async warning in `onPinVersion` and `onPinGitCommit`

**Behavior:** When the user clicks a pin button, before applying the new pin, check whether any existing annotation's line range (`startLine..endLine`) intersects with lines that are currently changed in the diff (i.e., lines in the current version that differ from the existing pin base). If they do and the warning is not suppressed, show a VSCode warning dialog with four options:

- **"Change base"** — apply the new pin
- **"Cancel"** — keep current pin
- **"Skip for this target"** — apply the pin AND don't warn again if the user tries to pin the same target revision/commit this session
- **"Skip for session"** — apply the pin AND suppress all pin-change warnings for the rest of the session

### Step-by-step

- [ ] **Step 1: Add `getChangedCurrentLines` to `src/diffUtils.ts`**

Append to `src/diffUtils.ts`:
```typescript
/**
 * Returns the set of 1-based line numbers in the current (new) version that
 * are part of added hunks — i.e. lines that exist in `newText` but differ
 * from `oldText`. Used to detect whether pinned-diff annotations are at risk.
 */
export function getChangedCurrentLines(hunks: DiffHunk[]): Set<number> {
    const changed = new Set<number>();
    let currentLine = 0;
    for (const hunk of hunks) {
        if (hunk.type === 'removed') { continue; }
        for (const _ of hunk.lines) {
            currentLine++;
            if (hunk.type === 'added') {
                changed.add(currentLine);
            }
        }
    }
    return changed;
}
```

- [ ] **Step 2: Add suppression state fields to the `ReviewModeController` class in `src/reviewMode.ts`**

Add after the existing `private historyMode: 'local' | 'git' = 'local';` field:
```typescript
private suppressPinWarningForSession: boolean = false;
private suppressedPinTargets: Set<string> = new Set();
```

- [ ] **Step 3: Add `getChangedCurrentLines` to the import in `src/reviewMode.ts`**

Find:
```typescript
import { computeDiffHunks, DiffHunk } from './diffUtils';
```

Replace with:
```typescript
import { computeDiffHunks, DiffHunk, getChangedCurrentLines } from './diffUtils';
```

(If this import doesn't exist yet, add it; `computeDiffHunks` is imported in `webviewPanel.ts` — check whether `reviewMode.ts` already imports from `diffUtils`.)

Actually, `reviewMode.ts` may not currently import from `diffUtils` at all. Add this import near the top of `src/reviewMode.ts`:
```typescript
import { computeDiffHunks, getChangedCurrentLines } from './diffUtils';
```

- [ ] **Step 4: Add `checkPinWarning` helper method to the class**

Add this private method to `ReviewModeController` (e.g., before `sendDiffToWebview`):

```typescript
/**
 * Returns true if the user confirms the pin change (or if no warning is needed).
 * Shows a VS Code warning dialog if annotations overlap changed diff lines.
 * Handles per-target and per-session suppression.
 */
private async checkPinWarning(originalPath: string, targetKey: string): Promise<boolean> {
    if (this.suppressPinWarningForSession) { return true; }
    if (this.suppressedPinTargets.has(targetKey)) { return true; }

    const annotations = [...this.store.getAnnotations()];
    if (annotations.length === 0) { return true; }

    // Compute current diff relative to the existing pin
    const revisions = this.store.getRevisions();
    if (revisions.length === 0) { return true; }

    const plansDir = this.store.getPlansDir();
    const currentText = fs.readFileSync(
        path.join(plansDir, revisions[revisions.length - 1].snapshotFile), 'utf-8'
    );

    let baseText = '';
    if (this.pinnedRef?.type === 'local') {
        const idx = this.pinnedRef.revision;
        if (idx >= 0 && idx < revisions.length) {
            baseText = fs.readFileSync(path.join(plansDir, revisions[idx].snapshotFile), 'utf-8');
        }
    } else if (this.pinnedRef?.type === 'git') {
        // For git pins we skip the check — git base text would require a git show call
        return true;
    } else {
        return true;
    }

    const hunks = computeDiffHunks(baseText, currentText);
    const changedLines = getChangedCurrentLines(hunks);
    if (changedLines.size === 0) { return true; }

    const overlapping = annotations.filter(a => {
        for (let l = a.startLine; l <= a.endLine; l++) {
            if (changedLines.has(l)) { return true; }
        }
        return false;
    });
    if (overlapping.length === 0) { return true; }

    const lineList = [...new Set(overlapping.flatMap(a =>
        Array.from({ length: a.endLine - a.startLine + 1 }, (_, i) => a.startLine + i)
            .filter(l => changedLines.has(l))
    ))].sort((a, b) => a - b).slice(0, 10).join(', ');

    const choice = await vscode.window.showWarningMessage(
        `Changing the diff base may affect ${overlapping.length} comment(s) on lines ${lineList}. Continue?`,
        'Change base',
        'Skip for this target',
        'Skip for session',
        'Cancel',
    );

    if (!choice || choice === 'Cancel') { return false; }
    if (choice === 'Skip for this target') { this.suppressedPinTargets.add(targetKey); }
    if (choice === 'Skip for session') { this.suppressPinWarningForSession = true; }
    return true;
}
```

- [ ] **Step 5: Update `onPinVersion` to be async and call `checkPinWarning`**

Find:
```typescript
        this.webview.onPinVersion = (originalPath: string, revision: number) => {
            this.pinnedRef = { type: 'local', revision };
            this.store.setDiffState({ mode: 'local', pinnedRef: this.pinnedRef });
            this.sendDiffToWebview(originalPath);
        };
```

Replace with:
```typescript
        this.webview.onPinVersion = (originalPath: string, revision: number) => {
            void (async () => {
                const targetKey = `local:${revision}`;
                if (!await this.checkPinWarning(originalPath, targetKey)) { return; }
                this.pinnedRef = { type: 'local', revision };
                this.store.setDiffState({ mode: 'local', pinnedRef: this.pinnedRef });
                this.sendDiffToWebview(originalPath);
            })();
        };
```

- [ ] **Step 6: Update `onPinGitCommit` to be async and call `checkPinWarning`**

Find:
```typescript
        this.webview.onPinGitCommit = (originalPath: string, commitHash: string) => {
            this.pinnedRef = { type: 'git', hash: commitHash };
            this.store.setDiffState({ mode: 'git', pinnedRef: this.pinnedRef });
            void this.sendGitDiffToWebview(originalPath);
        };
```

Replace with:
```typescript
        this.webview.onPinGitCommit = (originalPath: string, commitHash: string) => {
            void (async () => {
                const targetKey = `git:${commitHash}`;
                if (!await this.checkPinWarning(originalPath, targetKey)) { return; }
                this.pinnedRef = { type: 'git', hash: commitHash };
                this.store.setDiffState({ mode: 'git', pinnedRef: this.pinnedRef });
                void this.sendGitDiffToWebview(originalPath);
            })();
        };
```

- [ ] **Step 7: Reset suppression state in `open()`**

In the `open()` reset block, add after `this.pinnedRef = null;`:
```typescript
        this.suppressPinWarningForSession = false;
        this.suppressedPinTargets = new Set();
```

- [ ] **Step 8: Type check**

```bash
npm run check-types
```

Expected: no errors. Fix any type errors surfaced (e.g. missing `fs`/`path` imports in `reviewMode.ts` if they weren't already there — they are, since `sendDiffToWebview` uses them).

- [ ] **Step 9: Commit**

```bash
git add src/diffUtils.ts src/reviewMode.ts
git commit -m "feat: warn before pin change when annotations overlap current diff lines"
```

---

## Task 5: Manual Verification

Reload the Extension Development Host (`F5` or `Developer: Reload Window`).

- [ ] **Test 1 — Git item border:** Enable diff mode, switch to Git history. The pinned git commit should show a red left border (`#f87171`) matching local mode's red border.

- [ ] **Test 2 — Local preview click:** Enable diff mode (local pin). Click a non-pinned revision in local history → diff panel updates to show that revision's diff. The clicked row shows `diff-base` styling. Clicking a different row updates both the diff and the highlight.

- [ ] **Test 3 — Git preview click:** Switch to git history. Click a non-pinned commit → diff panel updates to show that commit's diff. The clicked row shows `diff-base` styling.

- [ ] **Test 4 — Preview clears on tab switch:** While a preview row is highlighted in history, switch to Comments tab → diff reverts to pinned version. Local/Git button reflects pin type.

- [ ] **Test 5 — Preview clears on mode switch:** While a preview row is highlighted in local history, switch to git history → preview clears, diff shows pinned version.

- [ ] **Test 6 — Git preview survives re-render:** Click a git commit to preview. Load more commits (if available) or switch tabs and back → the same commit remains highlighted.

- [ ] **Test 7 — Git-pin + local preview:** Pin a git commit. Switch to local history. Click a local revision to preview → diff panel shows the LOCAL revision diff (not the git diff). This verifies Task 2's fix.

- [ ] **Test 8 — Pin warning:** Add a comment on a line that is part of the current diff. Click a pin button on a different revision → warning dialog appears listing the affected lines. "Cancel" keeps the old pin. "Change base" changes it. "Skip for this target" suppresses the warning only for that same target revision. "Skip for session" suppresses all future warnings.

- [ ] **Test 9 — No spurious warning:** Add a comment on a line that is NOT part of the current diff. Click a pin button → no warning appears.
