# Git History Diffs (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the "Git" toggle in the diff toolbar so users can compare the current working copy (or HEAD) against any historical Git commit, with pagination and a working-copy entry at the top.

**Architecture:** A new `src/gitUtils.ts` provides all git shell operations (pure async TS, no VSCode dependencies). `ReviewModeController` in `reviewMode.ts` gains git-specific state (`historyMode`, `pinnedCommitHash`, `gitPage`, `isGitAvailable`, `gitRepoRoot`, `gitRelPath`) and three new message handlers. `ReviewWebviewPanel` gets matching callbacks and routes three new message types. The webview JS renders a `renderGitHistoryPane()` function that replaces the local revisions list when Git mode is active.

**Tech Stack:** Node.js `child_process.execFile` (promisified), existing `diffLines` from the `diff` package, existing Shiki highlighter for syntax-highlighted diffs, VSCode Webview postMessage API.

---

## File Map

| File | Role |
|------|------|
| `src/gitUtils.ts` | **New.** `GitCommit` interface + shell helpers: `isGitRepo`, `getGitRepoRoot`, `getGitRelativePath`, `getGitHistory`, `getGitFileContent`, `hasUncommittedChanges` |
| `src/reviewMode.ts` | Import gitUtils; add git state fields; wire 3 new callbacks; `sendGitHistory()`, `appendGitHistory()`, `sendGitDiffToWebview()` methods; update `sendDiffToWebview` to branch on `historyMode` |
| `src/webviewPanel.ts` | 3 new callback properties; 3 new `handleMessage` cases; `sendHistoryUpdatePublic()` wrapper; no HTML changes |
| `media/review.js` | Git state vars; `setGitAvailable` handler; segmented button switching; `renderGitHistoryPane()`; pin + load-more handlers |
| `media/review.css` | Git commit grid, working-copy entry, Load More button, enabled Git toggle |

---

## Task 1: Create `src/gitUtils.ts`

**Files:**
- Create: `src/gitUtils.ts`

- [ ] **Step 1: Write `src/gitUtils.ts`**

```typescript
import * as cp from 'child_process';
import * as util from 'util';
import * as path from 'path';

const execFileAsync = util.promisify(cp.execFile);

export interface GitCommit {
    hash: string;         // full SHA
    shortHash: string;    // 7-char SHA
    message: string;      // first line of commit message
    relativeDate: string; // e.g. "3 days ago"
    timestamp: string;    // ISO 8601
}

async function execGit(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
}

/** Returns true if the file is inside a git repository. */
export async function isGitRepo(filePath: string): Promise<boolean> {
    try {
        const dir = path.dirname(filePath);
        const result = await execGit(['rev-parse', '--is-inside-work-tree'], dir);
        return result === 'true';
    } catch {
        return false;
    }
}

/** Returns the absolute path to the git repo root for the given file. */
export async function getGitRepoRoot(filePath: string): Promise<string> {
    const dir = path.dirname(filePath);
    return execGit(['rev-parse', '--show-toplevel'], dir);
}

/** Returns the path of the file relative to the git repo root. */
export async function getGitRelativePath(filePath: string, repoRoot: string): Promise<string> {
    const dir = path.dirname(filePath);
    const result = await execGit(['ls-files', '--full-name', filePath], dir);
    if (result) { return result; }
    return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

/**
 * Returns up to `limit` commits that touched the file, starting at `skip`.
 * Fields within each record are separated by \x1F (unit separator).
 */
export async function getGitHistory(
    filePath: string,
    skip: number,
    limit: number,
): Promise<GitCommit[]> {
    const dir = path.dirname(filePath);
    const raw = await execGit(
        [
            'log', '--follow',
            '--format=%H\x1F%h\x1F%s\x1F%ar\x1F%aI',
            `--max-count=${limit}`,
            `--skip=${skip}`,
            '--',
            filePath,
        ],
        dir,
    );
    if (!raw) { return []; }
    return raw.split('\n').filter(Boolean).map(line => {
        const [hash, shortHash, message, relativeDate, timestamp] = line.split('\x1F');
        return { hash, shortHash, message, relativeDate, timestamp };
    });
}

/** Returns the file content at a specific git commit. */
export async function getGitFileContent(
    repoRoot: string,
    commitHash: string,
    relPath: string,
): Promise<string> {
    return execGit(['show', `${commitHash}:${relPath}`], repoRoot);
}

/**
 * Returns true if the file has uncommitted changes relative to HEAD.
 * Also returns true when HEAD doesn't exist yet (fresh repo).
 */
export async function hasUncommittedChanges(filePath: string): Promise<boolean> {
    try {
        const dir = path.dirname(filePath);
        await execFileAsync('git', ['diff', '--quiet', 'HEAD', '--', filePath], { cwd: dir });
        return false; // exit 0 = clean
    } catch {
        return true;  // exit non-zero = dirty or no HEAD
    }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/aure/github/review-mode && npm run check-types
```

Expected output: no errors mentioning `gitUtils.ts`.

- [ ] **Step 3: Commit**

```bash
cd /home/aure/github/review-mode
git add src/gitUtils.ts
git commit -m "feat: add git utility functions for Phase 2 diff"
```

---

## Task 2: Add Git state + handlers to `ReviewModeController` (`src/reviewMode.ts`)

**Files:**
- Modify: `src/reviewMode.ts`

- [ ] **Step 1: Add gitUtils imports**

Replace the existing import block at the top of `src/reviewMode.ts` with:

```typescript
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AnnotationStore } from './annotationStore';
import { ReviewWebviewPanel } from './webviewPanel';
import { migrateAnnotations } from './diffUtils';
import {
    GitCommit,
    isGitRepo,
    getGitRepoRoot,
    getGitRelativePath,
    getGitHistory,
    getGitFileContent,
    hasUncommittedChanges,
} from './gitUtils';
```

- [ ] **Step 2: Add git state fields to the class**

Find the private state fields at the top of `ReviewModeController` (the block with `diffModeEnabled` and `pinnedRevision`). Add these new fields immediately after `pinnedRevision`:

```typescript
    private historyMode: 'local' | 'git' = 'local';
    private pinnedCommitHash: string | null = null;
    private gitPage: number = 0;
    private readonly gitPageSize: number = 20;
    private isGitAvailable: boolean = false;
    private gitRepoRoot: string = '';
    private gitRelPath: string = '';
```

- [ ] **Step 3: Wire three new callbacks in the constructor**

Add these three blocks inside the `constructor`, immediately after the existing `this.webview.onPreviewDiffBase = ...` block (before the closing `}`):

```typescript
        this.webview.onSwitchHistoryMode = async (originalPath: string, mode: 'local' | 'git') => {
            this.historyMode = mode;
            if (mode === 'git') {
                this.pinnedCommitHash = null;
                this.gitPage = 0;
                await this.sendGitHistory(originalPath);
            } else {
                this.webview.sendHistoryUpdatePublic(originalPath);
                if (this.diffModeEnabled) {
                    this.sendDiffToWebview(originalPath);
                }
            }
        };

        this.webview.onPinGitCommit = (originalPath: string, commitHash: string) => {
            this.pinnedCommitHash = commitHash;
            void this.sendGitDiffToWebview(originalPath);
        };

        this.webview.onLoadMoreCommits = (originalPath: string) => {
            this.gitPage++;
            void this.appendGitHistory(originalPath);
        };
```

- [ ] **Step 4: Update `onDiffModeToggled` to handle git mode**

Find the existing `this.webview.onDiffModeToggled = ...` block in the constructor. Replace it with:

```typescript
        this.webview.onDiffModeToggled = (originalPath: string, enabled: boolean) => {
            this.diffModeEnabled = enabled;
            if (enabled && this.historyMode === 'local') {
                const revisions = this.store.getRevisions();
                if (revisions.length >= 2 && this.pinnedRevision < 0) {
                    this.pinnedRevision = revisions.length - 2;
                }
            }
            this.sendDiffToWebview(originalPath);
        };
```

- [ ] **Step 5: Send git availability after `webview.show()` in `open()`**

Find the line `await this.webview.show(originalUri.fsPath, snapshotPath, revisionsPath, fileName);` and add these lines immediately after it:

```typescript
        // Reset git-mode state and detect git availability
        this.historyMode = 'local';
        this.pinnedCommitHash = null;
        this.gitPage = 0;
        this.isGitAvailable = await isGitRepo(originalUri.fsPath);
        if (this.isGitAvailable) {
            this.gitRepoRoot = await getGitRepoRoot(originalUri.fsPath);
            this.gitRelPath = await getGitRelativePath(originalUri.fsPath, this.gitRepoRoot);
        }
        this.webview.postMessageToPanel(originalUri.fsPath, {
            type: 'setGitAvailable',
            available: this.isGitAvailable,
        });
```

- [ ] **Step 6: Update `sendDiffToWebview` to branch on `historyMode`**

Find the existing `private sendDiffToWebview(...)` method and replace its entire body with:

```typescript
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
```

- [ ] **Step 7: Add `sendGitHistory()` private method**

Add this method after `sendDiffToWebview()`:

```typescript
    private async sendGitHistory(originalPath: string): Promise<void> {
        try {
            const commits = await getGitHistory(originalPath, 0, this.gitPageSize);
            const hasMore = commits.length === this.gitPageSize;
            const workingCopy = await hasUncommittedChanges(originalPath);

            // Default pin: second entry in the displayed list
            // With working copy → commits[0]; without → commits[1]
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

            // Auto-update diff if diff mode is already on
            if (this.diffModeEnabled && this.pinnedCommitHash) {
                void this.sendGitDiffToWebview(originalPath);
            }
        } catch (err) {
            console.error('Review Mode: failed to get git history', err);
        }
    }
```

- [ ] **Step 8: Add `appendGitHistory()` private method**

Add this method after `sendGitHistory()`:

```typescript
    private async appendGitHistory(originalPath: string): Promise<void> {
        try {
            const skip = this.gitPage * this.gitPageSize;
            const commits = await getGitHistory(originalPath, skip, this.gitPageSize);
            const hasMore = commits.length === this.gitPageSize;
            this.webview.postMessageToPanel(originalPath, {
                type: 'appendGitHistory',
                commits,
                hasMore,
            });
        } catch (err) {
            console.error('Review Mode: failed to append git history', err);
        }
    }
```

- [ ] **Step 9: Add `sendGitDiffToWebview()` private method**

Add this method after `appendGitHistory()`:

```typescript
    private async sendGitDiffToWebview(originalPath: string): Promise<void> {
        if (!this.diffModeEnabled || !this.pinnedCommitHash) { return; }
        try {
            const baseText = await getGitFileContent(
                this.gitRepoRoot, this.pinnedCommitHash, this.gitRelPath,
            );
            const currentText = fs.readFileSync(originalPath, 'utf-8');
            const ext = path.extname(originalPath).toLowerCase();
            this.webview.sendHighlightedDiff(originalPath, baseText, currentText, ext);
        } catch (err) {
            console.error('Review Mode: failed to compute git diff', err);
        }
    }
```

- [ ] **Step 10: Verify TypeScript compiles**

```bash
cd /home/aure/github/review-mode && npm run check-types
```

Expected: no errors.

- [ ] **Step 11: Commit**

```bash
cd /home/aure/github/review-mode
git add src/reviewMode.ts
git commit -m "feat: add git mode state and handlers to ReviewModeController"
```

---

## Task 3: Webview panel callbacks and message routing (`src/webviewPanel.ts`)

**Files:**
- Modify: `src/webviewPanel.ts`

- [ ] **Step 1: Add three new callback properties**

Find the block of `public on...` callback declarations (around line 32). Add after `public onPreviewDiffBase`:

```typescript
    public onSwitchHistoryMode?: (originalPath: string, mode: 'local' | 'git') => void;
    public onPinGitCommit?: (originalPath: string, commitHash: string) => void;
    public onLoadMoreCommits?: (originalPath: string) => void;
```

- [ ] **Step 2: Handle three new message types in `handleMessage()`**

Find the `switch (msg.type)` block inside `handleMessage()`. Add these cases before the closing `}` of the switch:

```typescript
            case 'switchHistoryMode': {
                this.onSwitchHistoryMode?.(originalPath, msg.mode);
                break;
            }
            case 'pinGitCommit': {
                this.onPinGitCommit?.(originalPath, msg.commitHash);
                break;
            }
            case 'loadMoreCommits': {
                this.onLoadMoreCommits?.(originalPath);
                break;
            }
```

- [ ] **Step 3: Add `sendHistoryUpdatePublic()` method**

The controller needs to trigger a local history update when switching back from git mode to local mode. Add this public wrapper after the private `sendHistoryUpdate()` method:

```typescript
    /** Public entry point for controller to trigger a local history update (e.g. on mode switch back to local). */
    sendHistoryUpdatePublic(originalPath: string): void {
        this.sendHistoryUpdate(originalPath);
    }
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /home/aure/github/review-mode && npm run check-types
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /home/aure/github/review-mode
git add src/webviewPanel.ts
git commit -m "feat: add git mode callbacks and message routing to webview panel"
```

---

## Task 4: Webview JS — git mode state, history rendering, and mode switching (`media/review.js`)

**Files:**
- Modify: `media/review.js`

- [ ] **Step 1: Add git mode state variables**

Find the top of the IIFE where `diffModeEnabled`, `currentDiffHunks`, `pinnedRevision`, etc. are declared (around lines 14–24). Add these variables after `lastCurrentRevision`:

```javascript
    /** @type {'local'|'git'} */
    let historyMode = 'local';
    /** @type {Array<{hash: string, shortHash: string, message: string, relativeDate: string}>} */
    let gitHistory = [];
    /** @type {boolean} */
    let hasMoreGitCommits = false;
    /** @type {string|null} */
    let pinnedGitCommitHash = null;
    /** @type {boolean} */
    let hasWorkingCopy = false;
```

- [ ] **Step 2: Handle git-related messages from the extension**

In the `window.addEventListener('message', ...)` handler, add these branches after the existing `if (msg.type === 'clearDiff')` block:

```javascript
        if (msg.type === 'setGitAvailable') {
            const gitBtn = document.getElementById('history-mode-git');
            if (gitBtn && msg.available) {
                gitBtn.disabled = false;
                gitBtn.classList.remove('disabled');
                gitBtn.title = 'Show Git commit history';
            }
        }
        if (msg.type === 'updateGitHistory') {
            gitHistory = msg.commits || [];
            hasMoreGitCommits = !!msg.hasMore;
            hasWorkingCopy = !!msg.hasWorkingCopy;
            pinnedGitCommitHash = msg.pinnedCommitHash || null;
            renderGitHistoryPane();
        }
        if (msg.type === 'appendGitHistory') {
            gitHistory = gitHistory.concat(msg.commits || []);
            hasMoreGitCommits = !!msg.hasMore;
            renderGitHistoryPane();
        }
```

- [ ] **Step 3: Update `updateHistory` message handler to ignore it in git mode**

Find the existing `if (msg.type === 'updateHistory')` branch and replace it with:

```javascript
        if (msg.type === 'updateHistory') {
            if (historyMode === 'local') {
                renderHistoryPane(msg.revisions, msg.currentRevision);
            }
        }
```

- [ ] **Step 4: Add segmented button click handler (Local / Git toggle)**

Find the `// --- Diff Mode toggle ---` click handler (around line 58). Add a new handler immediately after its closing `});`:

```javascript
    // --- History mode (Local / Git) toggle ---
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('#history-mode-local, #history-mode-git');
        if (!btn || btn.disabled || btn.classList.contains('disabled')) { return; }
        const newMode = btn.id === 'history-mode-git' ? 'git' : 'local';
        if (newMode === historyMode) { return; }
        historyMode = newMode;

        document.getElementById('history-mode-local').classList.toggle('active', newMode === 'local');
        document.getElementById('history-mode-git').classList.toggle('active', newMode === 'git');

        vscode.postMessage({ type: 'switchHistoryMode', mode: newMode });
    });
```

- [ ] **Step 5: Add `renderGitHistoryPane()` function**

Add this function after the existing `renderHistoryPane()` function (after line ~688):

```javascript
    function renderGitHistoryPane() {
        const pane = document.getElementById('history-pane-content');
        if (!pane) { return; }

        if (gitHistory.length === 0 && !hasWorkingCopy) {
            pane.innerHTML = '<div class="history-empty">No commits found for this file.</div>';
            return;
        }

        let html = '';

        // Working copy entry — always at top, always the target, no pin
        if (hasWorkingCopy) {
            html += `<div class="history-item git-item git-working-copy diff-current">
                <span class="git-hash">(changes)</span>
                <span class="git-message">Uncommitted changes</span>
                <span class="git-date">now</span>
                <span class="history-current-badge">now</span>
            </div>`;
        } else if (gitHistory.length > 0) {
            // Latest commit is the target when there are no working copy changes
            const latest = gitHistory[0];
            html += `<div class="history-item git-item diff-current" data-commit-hash="${escapeHtml(latest.hash)}">
                <span class="git-hash">${escapeHtml(latest.shortHash)}</span>
                <span class="git-message" title="${escapeHtml(latest.message)}">${escapeHtml(latest.message)}</span>
                <span class="git-date">${escapeHtml(latest.relativeDate)}</span>
                <span class="history-current-badge">now</span>
            </div>`;
        }

        // Historical commit entries (all commits when hasWorkingCopy, skipping commit[0] otherwise)
        const startIdx = hasWorkingCopy ? 0 : 1;
        for (let i = startIdx; i < gitHistory.length; i++) {
            const commit = gitHistory[i];
            const isPinned = commit.hash === pinnedGitCommitHash;
            const baseClass = diffModeEnabled && isPinned ? ' diff-base' : '';
            html += `<div class="history-item git-item${baseClass}" data-commit-hash="${escapeHtml(commit.hash)}">
                <span class="git-hash">${escapeHtml(commit.shortHash)}</span>
                <span class="git-message" title="${escapeHtml(commit.message)}">${escapeHtml(commit.message)}</span>
                <span class="git-date">${escapeHtml(commit.relativeDate)}</span>
                <button class="pin-btn${isPinned ? ' pinned' : ''}" data-pin-commit="${escapeHtml(commit.hash)}" title="Set as diff base">
                    <span class="codicon codicon-pin"></span>
                </button>
            </div>`;
        }

        if (hasMoreGitCommits) {
            html += `<button class="load-more-btn">Load more...</button>`;
        }

        pane.innerHTML = html;

        // Clone pane to drop any stale delegated listeners, then re-attach one
        const freshPane = pane.cloneNode(true);
        pane.parentNode.replaceChild(freshPane, pane);

        freshPane.addEventListener('click', (e) => {
            // Pin button
            const pinBtn = e.target.closest('[data-pin-commit]');
            if (pinBtn) {
                const commitHash = pinBtn.dataset.pinCommit;
                if (commitHash === pinnedGitCommitHash) { return; }
                pinnedGitCommitHash = commitHash;
                vscode.postMessage({ type: 'pinGitCommit', commitHash });
                renderGitHistoryPane();
                return;
            }

            // Load More button
            const loadMoreBtn = e.target.closest('.load-more-btn');
            if (loadMoreBtn && !loadMoreBtn.disabled) {
                vscode.postMessage({ type: 'loadMoreCommits' });
                loadMoreBtn.textContent = 'Loading...';
                loadMoreBtn.disabled = true;
                return;
            }
        });
    }
```

- [ ] **Step 6: Build the extension**

```bash
cd /home/aure/github/review-mode && npm run compile
```

Expected: build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
cd /home/aure/github/review-mode
git add media/review.js
git commit -m "feat: add git history mode state, rendering, and mode switching to webview"
```

---

## Task 5: CSS styles for Git mode (`media/review.css`)

**Files:**
- Modify: `media/review.css`

- [ ] **Step 1: Append Git mode styles to `media/review.css`**

Add the following block at the very end of `media/review.css`:

```css
/* ============================================================
   Git history mode styles
   ============================================================ */

/* Override disabled state for the Git toggle when it becomes available */
.toolbar-seg-btn#history-mode-git:not([disabled]) {
    opacity: 1;
    cursor: pointer;
    color: var(--vscode-foreground);
}

/* Git commit entry: 4-column grid (hash | message | date | pin/badge) */
.history-item.git-item {
    display: grid;
    grid-template-columns: 52px 1fr auto auto;
    gap: 0 6px;
    align-items: center;
    padding: 5px 8px;
    cursor: default;
    border-radius: 4px;
    margin-bottom: 2px;
    min-height: 32px;
}

.history-item.git-item.diff-base {
    background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 0, 0, 0.08));
}

.history-item.git-item.diff-current {
    font-weight: 600;
}

.git-hash {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.git-message {
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--vscode-foreground);
}

.git-date {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
}

/* Working copy entry — visually separated from historical commits */
.history-item.git-working-copy {
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
    margin-bottom: 6px;
    padding-bottom: 8px;
}

/* Load More button */
.load-more-btn {
    display: block;
    width: 100%;
    margin-top: 6px;
    padding: 6px 0;
    background: transparent;
    border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.35));
    color: var(--vscode-foreground);
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    text-align: center;
}

.load-more-btn:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground);
}

.load-more-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
```

- [ ] **Step 2: Build the extension**

```bash
cd /home/aure/github/review-mode && npm run compile
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /home/aure/github/review-mode
git add media/review.css
git commit -m "feat: add CSS styles for Git history mode"
```

---

## Task 6: Manual Verification

Follow the Phase 2 verification steps from the spec (`docs/superpowers/specs/2026-05-11-inline-diff-design.md`, section "Phase 2").

- [ ] **6.1 Git-enabled workspace — Git toggle becomes enabled**

Open a file in a Git repo using Review Mode. Verify the "Git" button in the secondary toolbar (next to "Local") is **enabled** (not greyed out) and its tooltip reads "Show Git commit history".

- [ ] **6.2 Switch to Git mode**

Click the "Git" button. Verify:
- The History tab switches to show Git commits (not local revisions).
- Each entry shows: short hash, message (truncated with ellipsis if long), relative date, pin icon.

- [ ] **6.3 Default pin is the second entry**

Verify the pin icon on the second row is highlighted by default.

- [ ] **6.4 Uncommitted changes — working copy entry**

Make a visible change to the file, close and reopen in Review Mode, switch to Git mode. Verify a "(changes) / Uncommitted changes / now" entry appears at the top (no pin icon on it).

- [ ] **6.5 Git diff renders correctly**

Turn Diff Mode ON. Verify the code pane shows inline diff between the working copy and the pinned commit. Verify:
- Added lines: green background, line number, `+` gutter marker.
- Removed lines: red background, no line number, `−` gutter marker.
- Unchanged lines: normal.

- [ ] **6.6 Pin a different commit**

Click the pin icon on a different (older) commit. Verify the diff updates immediately to compare against that commit.

- [ ] **6.7 Load More (if file has >20 commits)**

Verify "Load more..." button appears at the bottom of the list. Click it. Verify additional commits append below without re-rendering the top entries.

- [ ] **6.8 Switching back to Local mode**

Click "Local" in the segmented control. Verify the History tab reverts to local revisions. If Diff Mode is ON, verify the local diff (against the last-pinned local revision) is restored.

- [ ] **6.9 Non-Git workspace**

Open a file outside any git repo in Review Mode. Verify the "Git" button remains disabled and its tooltip reads "Git diffs will be available in a future update."

- [ ] **6.10 No regressions in Local mode diff**

Verify that all Phase 1 behaviors still work: local revision list, pin, diff rendering, deleted-line comments, Markdown raw view in diff mode.
