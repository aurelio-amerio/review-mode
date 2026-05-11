# Diff Mode UX Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three diff-mode bugs: unified history background colors, a global single-pin model (replacing the fragmented dual-pin state), and the Git button active-state CSS specificity bug.

**Architecture:** Task 1 is pure CSS (safe, isolated). Task 2 updates the data model in `annotationStore.ts`. Task 3 replaces two backend controller variables with a single `pinnedRef: PinnedRef | null` in `reviewMode.ts`. Task 4 mirrors that change in the frontend `review.js`. Each task is independently compilable; do them in order.

**Tech Stack:** TypeScript (backend/extension host), vanilla JS (webview), CSS. Build: `npm run check-types` for type checking, `npm run compile` for full build.

---

## File Map

| File | Change |
|---|---|
| `media/review.css` | 5 edits: colors + button selector |
| `src/annotationStore.ts` | Add `PinnedRef` type, update `DiffState`, add migration in `getDiffState()` |
| `src/reviewMode.ts` | Replace `pinnedRevision` + `pinnedCommitHash` with `pinnedRef: PinnedRef | null` throughout |
| `media/review.js` | Replace `pinnedRevision` + `pinnedGitCommitHash` with `pinnedRef` throughout |

---

## Task 1: CSS — Color Unification + Button Fix

**Files:**
- Modify: `media/review.css`

These are pure visual changes with no logic impact. Reload the Extension Development Host after applying.

- [ ] **Step 1: Update `.history-item.diff-current` (green, ~line 290)**

Replace:
```css
.history-item.diff-current {
    border-left-color: #4ade80;
    background: rgba(74, 222, 128, 0.18);
}
```
With:
```css
.history-item.diff-current {
    border-left-color: #4ade80;
    background: rgba(74, 222, 128, 0.12);
    font-weight: 600;
}
```

- [ ] **Step 2: Update `.history-item.diff-base` (red, ~line 296)**

Replace:
```css
.history-item.diff-base {
    border-left-color: #f87171;
    background: rgba(248, 113, 113, 0.18);
}
```
With:
```css
.history-item.diff-base {
    border-left-color: #f87171;
    background: rgba(248, 113, 113, 0.22);
}
```

- [ ] **Step 3: Remove `.history-item.git-item.diff-base` override (~line 1223)**

Delete these lines entirely (the base rule now applies to both local and git items):
```css
.history-item.git-item.diff-base {
    border-left-color: #f87171;
    background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.08));
}
```

- [ ] **Step 4: Remove `.history-item.git-item.diff-current` override (~line 1228)**

Delete these lines entirely:
```css
.history-item.git-item.diff-current {
    border-left-color: #4ade80;
    background: rgba(74, 222, 128, 0.1);
    font-weight: 600;
}
```

- [ ] **Step 5: Fix Git button active-state CSS specificity (~line 1203)**

Replace:
```css
.toolbar-seg-btn#history-mode-git:not([disabled]) {
    opacity: 1;
    cursor: pointer;
    color: var(--vscode-foreground);
}
```
With:
```css
.toolbar-seg-btn#history-mode-git:not([disabled]):not(.active) {
    opacity: 1;
    cursor: pointer;
    color: var(--vscode-foreground);
}
```

- [ ] **Step 6: Commit**

```bash
git add media/review.css
git commit -m "fix: unify diff history colors and fix Git button active state"
```

---

## Task 2: Data Model — `PinnedRef` Type in `annotationStore.ts`

**Files:**
- Modify: `src/annotationStore.ts`

- [ ] **Step 1: Add `PinnedRef` type and update `DiffState` interface**

In `src/annotationStore.ts`, replace the `DiffState` interface block (lines 36-40):

```typescript
// REMOVE this:
export interface DiffState {
    mode: 'local' | 'git';                // which history mode was active
    localPinnedRevision?: number;          // pinned revision index (local mode)
    gitPinnedCommitHash?: string;          // pinned commit SHA (git mode)
}
```

With:
```typescript
export type PinnedRef =
    | { type: 'local'; revision: number }
    | { type: 'git'; hash: string };

export interface DiffState {
    mode: 'local' | 'git';
    pinnedRef?: PinnedRef;
}
```

- [ ] **Step 2: Add migration to `getDiffState()`**

Replace the current `getDiffState()` implementation (lines 137-139):

```typescript
// REMOVE this:
getDiffState(): DiffState | undefined {
    return this.revisionsData?.diffState;
}
```

With:
```typescript
getDiffState(): DiffState | undefined {
    const raw = this.revisionsData?.diffState as any;
    if (!raw) { return undefined; }
    // Migrate old on-disk format (pre-PinnedRef)
    if (!raw.pinnedRef) {
        if (raw.localPinnedRevision !== undefined) {
            return { mode: raw.mode, pinnedRef: { type: 'local', revision: raw.localPinnedRevision } };
        }
        if (raw.gitPinnedCommitHash) {
            return { mode: raw.mode, pinnedRef: { type: 'git', hash: raw.gitPinnedCommitHash } };
        }
        return { mode: raw.mode };
    }
    return raw as DiffState;
}
```

- [ ] **Step 3: Run type check**

```bash
npm run check-types
```

Expected: no errors (only `annotationStore.ts` changed so far; `reviewMode.ts` will fail until Task 3).

Actually, skip the type check until after Task 3 — `reviewMode.ts` still references the old fields and will produce errors. Move on to Task 3 immediately.

- [ ] **Step 4: Commit (after Task 3 type check passes)**

Hold this commit — do it together with Task 3.

---

## Task 3: Backend Refactor — `reviewMode.ts`

**Files:**
- Modify: `src/reviewMode.ts`

Replace both `pinnedRevision: number` and `pinnedCommitHash: string | null` controller fields with a single `pinnedRef: PinnedRef | null`. Apply every change below before running the type check.

- [ ] **Step 1: Update imports**

At the top of `src/reviewMode.ts`, add `PinnedRef` to the import from `annotationStore`:

```typescript
// BEFORE:
import { AnnotationStore } from './annotationStore';

// AFTER:
import { AnnotationStore, PinnedRef } from './annotationStore';
```

- [ ] **Step 2: Replace class fields (lines 22-24)**

```typescript
// REMOVE:
private diffModeEnabled: boolean = false;
private pinnedRevision: number = -1;
private historyMode: 'local' | 'git' = 'local';
private pinnedCommitHash: string | null = null;

// REPLACE WITH:
private diffModeEnabled: boolean = false;
private pinnedRef: PinnedRef | null = null;
private historyMode: 'local' | 'git' = 'local';
```

- [ ] **Step 3: Update `onPinVersion` handler (lines 49-57)**

```typescript
// REMOVE:
this.webview.onPinVersion = (originalPath: string, revision: number) => {
    this.pinnedRevision = revision;
    this.pinnedCommitHash = null;  // single-pin: clear the other mode's pin
    this.store.setDiffState({
        mode: 'local',
        localPinnedRevision: revision,
    });
    this.sendDiffToWebview(originalPath);
};

// REPLACE WITH:
this.webview.onPinVersion = (originalPath: string, revision: number) => {
    this.pinnedRef = { type: 'local', revision };
    this.store.setDiffState({ mode: 'local', pinnedRef: this.pinnedRef });
    this.sendDiffToWebview(originalPath);
};
```

- [ ] **Step 4: Update `onPinGitCommit` handler (lines 88-96)**

```typescript
// REMOVE:
this.webview.onPinGitCommit = (originalPath: string, commitHash: string) => {
    this.pinnedCommitHash = commitHash;
    this.pinnedRevision = -1;  // single-pin: clear the other mode's pin
    this.store.setDiffState({
        mode: 'git',
        gitPinnedCommitHash: commitHash,
    });
    void this.sendGitDiffToWebview(originalPath);
};

// REPLACE WITH:
this.webview.onPinGitCommit = (originalPath: string, commitHash: string) => {
    this.pinnedRef = { type: 'git', hash: commitHash };
    this.store.setDiffState({ mode: 'git', pinnedRef: this.pinnedRef });
    void this.sendGitDiffToWebview(originalPath);
};
```

- [ ] **Step 5: Update `onSwitchHistoryMode` handler (lines 69-86)**

```typescript
// REMOVE:
this.webview.onSwitchHistoryMode = async (originalPath: string, mode: 'local' | 'git') => {
    this.historyMode = mode;
    // Persist mode switch — pin references are unchanged (single-pin model)
    this.store.setDiffState({
        mode,
        localPinnedRevision: this.pinnedRevision >= 0 ? this.pinnedRevision : undefined,
        gitPinnedCommitHash: this.pinnedCommitHash ?? undefined,
    });
    if (mode === 'git') {
        this.gitPage = 0;
        await this.sendGitHistory(originalPath);
    } else {
        this.webview.sendHistoryUpdatePublic(originalPath);
        if (this.diffModeEnabled) {
            this.sendDiffToWebview(originalPath);
        }
    }
};

// REPLACE WITH:
this.webview.onSwitchHistoryMode = async (originalPath: string, mode: 'local' | 'git') => {
    this.historyMode = mode;
    this.store.setDiffState({ mode, pinnedRef: this.pinnedRef ?? undefined });
    if (mode === 'git') {
        this.gitPage = 0;
        await this.sendGitHistory(originalPath);
    } else {
        this.webview.sendHistoryUpdatePublic(originalPath);
    }
    // Resend pinned diff after mode switch to clear any active preview
    if (this.diffModeEnabled) {
        this.sendDiffToWebview(originalPath);
    }
};
```

- [ ] **Step 6: Update the `open()` reset block (lines 236-241)**

```typescript
// REMOVE:
// Reset diff state
this.diffModeEnabled = false;
this.pinnedRevision = -1;

// Reset git-mode state and detect git availability
this.historyMode = 'local';
this.pinnedCommitHash = null;

// REPLACE WITH:
// Reset diff state
this.diffModeEnabled = false;
this.pinnedRef = null;

// Reset git-mode state and detect git availability
this.historyMode = 'local';
```

- [ ] **Step 7: Update the pre-load block in `open()` (lines 256-265)**

```typescript
// REMOVE:
const savedDiffState = this.store.getDiffState();
if (savedDiffState) {
    if (savedDiffState.localPinnedRevision !== undefined) {
        this.pinnedRevision = savedDiffState.localPinnedRevision;
    }
    if (savedDiffState.gitPinnedCommitHash !== undefined) {
        this.pinnedCommitHash = savedDiffState.gitPinnedCommitHash;
    }
    // historyMode stays 'local' — it will be restored when diff is toggled on via restoreDiffStateFromStore()
}

// REPLACE WITH:
const savedDiffState = this.store.getDiffState();
if (savedDiffState?.pinnedRef) {
    this.pinnedRef = savedDiffState.pinnedRef;
}
```

- [ ] **Step 8: Update `sendDiffToWebview` (lines 304-340)**

```typescript
// REMOVE:
private sendDiffToWebview(originalPath: string, overrideRevision?: number): void {
    if (!this.diffModeEnabled) {
        this.webview.postMessageToPanel(originalPath, { type: 'clearDiff' });
        const revisions = this.store.getRevisions();
        if (revisions.length > 0) {
            const plansDir = this.store.getPlansDir();
            const latest = revisions[revisions.length - 1];
            this.webview.refreshContent(originalPath, path.join(plansDir, latest.snapshotFile));
        }
        return;
    }

    if (this.historyMode === 'git') {
        void this.sendGitDiffToWebview(originalPath);
        return;
    }

    const revisions = this.store.getRevisions();
    if (revisions.length === 0) { return; }

    const plansDir = this.store.getPlansDir();
    const latestRevision = revisions[revisions.length - 1];
    const latestSnapshotPath = path.join(plansDir, latestRevision.snapshotFile);
    const currentText = fs.readFileSync(latestSnapshotPath, 'utf-8');

    const baseRevIdx = overrideRevision !== undefined ? overrideRevision : this.pinnedRevision;
    let baseText = '';
    if (baseRevIdx >= 0 && baseRevIdx < revisions.length) {
        const baseSnapshotPath = path.join(plansDir, revisions[baseRevIdx].snapshotFile);
        baseText = fs.readFileSync(baseSnapshotPath, 'utf-8');
    }

    this.webview.sendHighlightedDiff(
        originalPath, baseText, currentText,
        path.extname(originalPath).toLowerCase(),
    );
}

// REPLACE WITH:
private sendDiffToWebview(originalPath: string, overrideRevision?: number): void {
    if (!this.diffModeEnabled) {
        this.webview.postMessageToPanel(originalPath, { type: 'clearDiff' });
        const revisions = this.store.getRevisions();
        if (revisions.length > 0) {
            const plansDir = this.store.getPlansDir();
            const latest = revisions[revisions.length - 1];
            this.webview.refreshContent(originalPath, path.join(plansDir, latest.snapshotFile));
        }
        return;
    }

    // Route by pin type, not history view mode
    if (this.pinnedRef?.type === 'git') {
        void this.sendGitDiffToWebview(originalPath);
        return;
    }

    const revisions = this.store.getRevisions();
    if (revisions.length === 0) { return; }

    const plansDir = this.store.getPlansDir();
    const latestRevision = revisions[revisions.length - 1];
    const latestSnapshotPath = path.join(plansDir, latestRevision.snapshotFile);
    const currentText = fs.readFileSync(latestSnapshotPath, 'utf-8');

    const baseRevIdx = overrideRevision !== undefined
        ? overrideRevision
        : (this.pinnedRef?.type === 'local' ? this.pinnedRef.revision : -1);
    let baseText = '';
    if (baseRevIdx >= 0 && baseRevIdx < revisions.length) {
        const baseSnapshotPath = path.join(plansDir, revisions[baseRevIdx].snapshotFile);
        baseText = fs.readFileSync(baseSnapshotPath, 'utf-8');
    }

    this.webview.sendHighlightedDiff(
        originalPath, baseText, currentText,
        path.extname(originalPath).toLowerCase(),
    );
}
```

- [ ] **Step 9: Update `sendGitDiffToWebview` (lines 387-400)**

```typescript
// REMOVE:
private async sendGitDiffToWebview(originalPath: string, overrideCommitHash?: string): Promise<void> {
    const commitHash = overrideCommitHash ?? this.pinnedCommitHash;

// REPLACE WITH:
private async sendGitDiffToWebview(originalPath: string, overrideCommitHash?: string): Promise<void> {
    const commitHash = overrideCommitHash ?? (this.pinnedRef?.type === 'git' ? this.pinnedRef.hash : null);
```
(Leave the rest of the method body unchanged.)

- [ ] **Step 10: Update `sendGitHistory` auto-pin logic (lines 342-370)**

```typescript
// REMOVE:
private async sendGitHistory(originalPath: string): Promise<void> {
    try {
        const commits = await getGitHistory(originalPath, 0, this.gitPageSize);
        const hasMore = commits.length === this.gitPageSize;
        const workingCopy = await hasUncommittedChanges(originalPath);

        if (this.pinnedCommitHash === null) {
            if (workingCopy && commits.length >= 1) {
                this.pinnedCommitHash = commits[0].hash;
            } else if (!workingCopy && commits.length >= 2) {
                this.pinnedCommitHash = commits[1].hash;
            }
        }

        this.webview.postMessageToPanel(originalPath, {
            type: 'updateGitHistory',
            commits,
            hasMore,
            hasWorkingCopy: workingCopy,
            pinnedCommitHash: this.pinnedCommitHash,
        });

        if (this.diffModeEnabled && this.pinnedCommitHash) {
            void this.sendGitDiffToWebview(originalPath);
        }
    } catch (err) {
        console.error('Review Mode: failed to get git history', err);
    }
}

// REPLACE WITH:
private async sendGitHistory(originalPath: string): Promise<void> {
    try {
        const commits = await getGitHistory(originalPath, 0, this.gitPageSize);
        const hasMore = commits.length === this.gitPageSize;
        const workingCopy = await hasUncommittedChanges(originalPath);

        // Auto-pin only when there is no pin at all; preserve existing local pins
        if (this.pinnedRef === null) {
            if (workingCopy && commits.length >= 1) {
                this.pinnedRef = { type: 'git', hash: commits[0].hash };
            } else if (!workingCopy && commits.length >= 2) {
                this.pinnedRef = { type: 'git', hash: commits[1].hash };
            }
        }

        this.webview.postMessageToPanel(originalPath, {
            type: 'updateGitHistory',
            commits,
            hasMore,
            hasWorkingCopy: workingCopy,
            pinnedRef: this.pinnedRef,
        });

        if (this.diffModeEnabled && this.pinnedRef?.type === 'git') {
            void this.sendGitDiffToWebview(originalPath);
        }
    } catch (err) {
        console.error('Review Mode: failed to get git history', err);
    }
}
```

- [ ] **Step 11: Update `restoreDiffStateFromStore` (lines 402-436)**

```typescript
// REMOVE:
private restoreDiffStateFromStore(originalPath: string): void {
    const savedState = this.store.getDiffState();
    if (savedState) {
        this.historyMode = savedState.mode;
        if (savedState.localPinnedRevision !== undefined) {
            this.pinnedRevision = savedState.localPinnedRevision;
        }
        if (savedState.gitPinnedCommitHash !== undefined) {
            this.pinnedCommitHash = savedState.gitPinnedCommitHash;
        }
    } else {
        // No persisted state: default to local with N-1 pin
        this.historyMode = 'local';
        const revisions = this.store.getRevisions();
        if (revisions.length >= 2 && this.pinnedRevision < 0) {
            this.pinnedRevision = revisions.length - 2;
        }
    }

    // Notify webview to update UI (segmented button, history tab)
    this.webview.postMessageToPanel(originalPath, {
        type: 'restoreDiffState',
        mode: this.historyMode,
        pinnedRevision: this.pinnedRevision,
        pinnedGitCommitHash: this.pinnedCommitHash,
        isGitAvailable: this.isGitAvailable,
    });

    // If restoring to git mode, fetch git history
    if (this.historyMode === 'git') {
        this.gitPage = 0;
        void this.sendGitHistory(originalPath);
    }
}

// REPLACE WITH:
private restoreDiffStateFromStore(originalPath: string): void {
    const savedState = this.store.getDiffState();
    if (savedState) {
        this.historyMode = savedState.mode;
        if (savedState.pinnedRef) {
            this.pinnedRef = savedState.pinnedRef;
        }
    } else {
        // No persisted state: default to local with N-1 pin
        this.historyMode = 'local';
        const revisions = this.store.getRevisions();
        if (revisions.length >= 2 && this.pinnedRef === null) {
            this.pinnedRef = { type: 'local', revision: revisions.length - 2 };
        }
    }

    this.webview.postMessageToPanel(originalPath, {
        type: 'restoreDiffState',
        mode: this.historyMode,
        pinnedRef: this.pinnedRef,
        isGitAvailable: this.isGitAvailable,
    });

    if (this.historyMode === 'git') {
        this.gitPage = 0;
        void this.sendGitHistory(originalPath);
    }
}
```

- [ ] **Step 12: Type check**

```bash
npm run check-types
```

Expected: no errors. Fix any remaining references to `pinnedRevision` or `pinnedCommitHash` that the check surfaces.

- [ ] **Step 13: Commit**

```bash
git add src/annotationStore.ts src/reviewMode.ts
git commit -m "refactor: replace dual pin state with global PinnedRef in backend"
```

---

## Task 4: Frontend Refactor — `review.js`

**Files:**
- Modify: `media/review.js`

All changes are in a single file. Apply all steps, then reload to test.

- [ ] **Step 1: Replace variable declarations (lines 18-32)**

```javascript
// REMOVE these two lines:
/** @type {number} */
let pinnedRevision = -1;
...
/** @type {string|null} */
let pinnedGitCommitHash = null;

// REPLACE WITH a single declaration (insert where pinnedRevision was, delete pinnedGitCommitHash):
/** @type {{type: 'local', revision: number} | {type: 'git', hash: string} | null} */
let pinnedRef = null;
```

- [ ] **Step 2: Update `activateTab` — add Local/Git button sync on tab switch (lines 53-55)**

```javascript
// REMOVE:
// When switching away from history tab with diff mode on,
// revert to showing the pinned version diff (not a temporary preview)
if (tabId === 'comments' && diffModeEnabled) {
    vscode.postMessage({ type: 'revertToPinnedDiff' });
}

// REPLACE WITH:
// When switching away from history, sync Local/Git button to pin type
// and revert any active preview back to the pinned diff
if (tabId !== 'history' && diffModeEnabled) {
    const pinType = pinnedRef?.type ?? 'local';
    const localBtn = document.getElementById('history-mode-local');
    const gitBtn = document.getElementById('history-mode-git');
    if (localBtn) { localBtn.classList.toggle('active', pinType === 'local'); }
    if (gitBtn) { gitBtn.classList.toggle('active', pinType === 'git'); }
    historyMode = pinType;
    activeDiffBase = null;
    vscode.postMessage({ type: 'revertToPinnedDiff' });
}
```

- [ ] **Step 3: Update mode switch handler — remove `pinnedGitCommitHash = null` (lines 112-117)**

```javascript
// REMOVE:
if (newMode === 'git') {
    gitHistory = [];
    hasMoreGitCommits = false;
    pinnedGitCommitHash = null;
    hasWorkingCopy = false;
}

// REPLACE WITH:
if (newMode === 'git') {
    gitHistory = [];
    hasMoreGitCommits = false;
    hasWorkingCopy = false;
}
```

- [ ] **Step 4: Update `renderHistoryPane` — default pin and `isPinned` check (lines 719-730)**

```javascript
// REMOVE:
// Default pin to N-1 if not yet set
if (pinnedRevision < 0 && sorted.length >= 2) {
    pinnedRevision = sorted[1].revision;
}
...
const isPinned = rev.revision === pinnedRevision;

// REPLACE WITH:
// Default pin to N-1 if no pin exists yet
if (pinnedRef === null && sorted.length >= 2) {
    pinnedRef = { type: 'local', revision: sorted[1].revision };
}
...
const isPinned = pinnedRef?.type === 'local' && rev.revision === pinnedRef.revision;
```

- [ ] **Step 5: Update local pin button rendering (line ~750)**

```javascript
// REMOVE:
lastColHtml = `<button class="pin-btn${isPinned ? ' pinned' : ''}" data-pin-revision="${rev.revision}" title="Set as diff base"><span class="codicon codicon-pin"></span></button>`;

// REPLACE WITH (unchanged — just verify isPinned now reflects the new check above):
lastColHtml = `<button class="pin-btn${isPinned ? ' pinned' : ''}" data-pin-revision="${rev.revision}" title="Set as diff base"><span class="codicon codicon-pin"></span></button>`;
```
(No change needed — the pin button HTML is the same; `isPinned` was fixed in Step 4.)

- [ ] **Step 6: Update local pin click handler (lines 768-776)**

```javascript
// REMOVE:
const pinBtn = e.target.closest('.pin-btn');
if (pinBtn) {
    const revision = parseInt(pinBtn.dataset.pinRevision, 10);
    if (revision === pinnedRevision) { return; } // already pinned, no-op
    pinnedRevision = revision;
    pinnedGitCommitHash = null;  // single-pin: clear the other mode's pin
    vscode.postMessage({ type: 'pinVersion', revision: pinnedRevision });
    renderHistoryPane(revisions, currentRevision);
    return;
}

// REPLACE WITH:
const pinBtn = e.target.closest('.pin-btn');
if (pinBtn) {
    const revision = parseInt(pinBtn.dataset.pinRevision, 10);
    if (pinnedRef?.type === 'local' && revision === pinnedRef.revision) { return; }
    pinnedRef = { type: 'local', revision };
    vscode.postMessage({ type: 'pinVersion', revision });
    renderHistoryPane(revisions, currentRevision);
    return;
}
```

- [ ] **Step 7: Update `renderGitHistoryPane` — `isPinned` check (line ~835)**

```javascript
// REMOVE:
const isPinned = commit.hash === pinnedGitCommitHash;

// REPLACE WITH:
const isPinned = pinnedRef?.type === 'git' && commit.hash === pinnedRef.hash;
```

- [ ] **Step 8: Update git pin click handler (lines 866-875)**

```javascript
// REMOVE:
const pinBtn = e.target.closest('[data-pin-commit]');
if (pinBtn) {
    const commitHash = pinBtn.dataset.pinCommit;
    if (commitHash === pinnedGitCommitHash) { return; }
    pinnedGitCommitHash = commitHash;
    pinnedRevision = -1;  // single-pin: clear the other mode's pin
    vscode.postMessage({ type: 'pinGitCommit', commitHash });
    renderGitHistoryPane();
    return;
}

// REPLACE WITH:
const pinBtn = e.target.closest('[data-pin-commit]');
if (pinBtn) {
    const commitHash = pinBtn.dataset.pinCommit;
    if (pinnedRef?.type === 'git' && commitHash === pinnedRef.hash) { return; }
    pinnedRef = { type: 'git', hash: commitHash };
    vscode.postMessage({ type: 'pinGitCommit', commitHash });
    renderGitHistoryPane();
    return;
}
```

- [ ] **Step 9: Update `updateGitHistory` message handler (lines 664-670)**

```javascript
// REMOVE:
if (msg.type === 'updateGitHistory') {
    gitHistory = msg.commits || [];
    hasMoreGitCommits = !!msg.hasMore;
    hasWorkingCopy = !!msg.hasWorkingCopy;
    pinnedGitCommitHash = msg.pinnedCommitHash || null;
    renderGitHistoryPane();
}

// REPLACE WITH:
if (msg.type === 'updateGitHistory') {
    gitHistory = msg.commits || [];
    hasMoreGitCommits = !!msg.hasMore;
    hasWorkingCopy = !!msg.hasWorkingCopy;
    if (msg.pinnedRef !== undefined) {
        pinnedRef = msg.pinnedRef;
    }
    renderGitHistoryPane();
}
```

- [ ] **Step 10: Update `restoreDiffState` message handler (lines 676-701)**

```javascript
// REMOVE:
if (msg.type === 'restoreDiffState') {
    // Extension tells us to restore mode + pin state when diff is toggled on
    historyMode = msg.mode || 'local';
    if (msg.pinnedRevision !== undefined && msg.pinnedRevision !== null) {
        pinnedRevision = msg.pinnedRevision;
    }
    if (msg.pinnedGitCommitHash !== undefined) {
        pinnedGitCommitHash = msg.pinnedGitCommitHash;
    }
    ...

// REPLACE the first part (up through the pinnedGitCommitHash assignment) with:
if (msg.type === 'restoreDiffState') {
    historyMode = msg.mode || 'local';
    if (msg.pinnedRef !== undefined) {
        pinnedRef = msg.pinnedRef;
    }
    // (leave the button-update and render logic unchanged from here)
```

- [ ] **Step 11: Build**

```bash
npm run compile
```

Expected: exits 0. The TypeScript check also covers the webview JS file structure indirectly — if any referenced message fields were renamed, they'll surface at runtime rather than compile time. Proceed to manual verification.

- [ ] **Step 12: Commit**

```bash
git add media/review.js
git commit -m "refactor: replace dual pin state with global pinnedRef in frontend"
```

---

## Task 5: Manual Verification

Reload the Extension Development Host (press `F5` in the extension project, or run `Developer: Reload Window` in a host that already has it loaded).

- [ ] **Test 1 — Colors:** Enable diff mode. Both Local and Git history modes should show the same green (`rgba(74, 222, 128, 0.12)`, bold) for the current item and the same red (`rgba(248, 113, 113, 0.22)`) for the pinned item.

- [ ] **Test 2 — Local pin survives mode switch:** Enable diff mode in Local mode. Pin a non-latest revision. Switch to Git mode → git list shows nothing pinned. Switch back to Local → the local revision is still pinned and the diff is the same.

- [ ] **Test 3 — Git pin clears local pin:** In Local mode, pin a revision. Switch to Git mode, pin a commit. Switch back to Local → nothing pinned in local.

- [ ] **Test 4 — Diff routes by pin type, not view:** Enable diff mode. Pin a local revision. Switch to Git history view → diff panel still shows the local revision diff (not a git diff).

- [ ] **Test 5 — Preview still works:** In Git history, hover/click a non-pinned commit row → diff preview shows without changing the pin. Switch history mode → preview clears, pinned diff returns.

- [ ] **Test 6 — Comments tab syncs button:** In Git history mode with a local pin, switch to the Comments tab → Local/Git button should switch to "Local" to reflect the pin type.

- [ ] **Test 7 — Git button active style:** Enable git history (switch to Git mode) → the Git button active style (blue accent color) should match the Local button's active style.

- [ ] **Final commit (if any fixups were made)**

```bash
git add -p
git commit -m "fix: address manual verification fixups"
```
