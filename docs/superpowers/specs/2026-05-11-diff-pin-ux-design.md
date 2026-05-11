# Diff Mode UX Polish — Design Spec

**Date:** 2026-05-11  
**Scope:** Three related bugs in the diff mode: color inconsistency, fragmented pin state, and button styling mismatch.

---

## Context

The diff mode has three UX problems:

1. History item backgrounds use different opacity/values in Local vs Git mode, making the two modes look inconsistent and the Local mode look washed out.
2. The pin is conceptually tied to the history view mode, but it should be a global diff base independent of which history list is shown.
3. The Git button shows a different active style than the Local button due to a CSS specificity bug.

---

## Fix 1 — Color Unification

### Problem
`diff-current` (green) and `diff-base` (red) have separate CSS rules for local items and `.git-item` overrides. The git override uses `var(--vscode-diffEditor-removedLineBackground)` for red, which resolves to a vivid theme-dependent value. Local mode uses hardcoded `rgba(248, 113, 113, 0.18)` which appears washed out by comparison.

### Solution
Unify to a single set of hardcoded values used for both modes. Remove the git-item–specific overrides for these classes.

| Property | New value |
|---|---|
| Green background | `rgba(74, 222, 128, 0.12)` |
| Green font-weight | `600` |
| Red background | `rgba(248, 113, 113, 0.22)` |
| Border colors | unchanged (`#4ade80` / `#f87171`) |

**Files changed:** `media/review.css`  
- Update `.history-item.diff-current` (line ~290): set new green values + add `font-weight: 600`  
- Update `.history-item.diff-base` (line ~296): set new red value  
- Remove `.history-item.git-item.diff-current` override (line ~1228)  
- Remove `.history-item.git-item.diff-base` override (line ~1223)

---

## Fix 2 — Global Pin State (Option B: single `PinnedRef`)

### Mental Model

| Concept | What it controls |
|---|---|
| **Pin** | The permanent diff base. Owned globally. Determines what the diff shows in Comments view and what's highlighted when entering History. Only changes when the user explicitly clicks a pin button. |
| **Preview** | Temporary per-row highlight while browsing History. Already works correctly. Does not change the pin. |
| **Local/Git button** | Which history LIST is shown in the History pane. Does not affect the pin or the diff. |

**Key invariant:** `sendDiffToWebview` routes by `pinnedRef.type`, never by `historyMode`.

### Behavior spec

- **Switching Local ↔ Git in History view:** History list updates, pinned diff is resent (to clear any active preview), pin is unchanged.
- **Switching to Comments view:** Diff reverts to pinned version. Local/Git button snaps to `pinnedRef.type` (so it reflects the current diff base).
- **Switching back to History view:** History shown matches the current Local/Git button (which reflects pin type).
- **Auto-pin in git history:** Only fires when `pinnedRef === null` (no pin at all). If a local pin exists, git history shows nothing pinned.
- **Pinning in either mode:** Replaces the global `pinnedRef` entirely. Other mode's pin is gone.

### Data model changes

**`src/annotationStore.ts`**

```typescript
export type PinnedRef =
    | { type: 'local'; revision: number }
    | { type: 'git'; hash: string };

export interface DiffState {
    mode: 'local' | 'git';
    pinnedRef?: PinnedRef;          // replaces localPinnedRevision + gitPinnedCommitHash
}
```

`getDiffState()` migrates old on-disk format:
- `localPinnedRevision` → `{ type: 'local', revision }`
- `gitPinnedCommitHash` → `{ type: 'git', hash }`

### Backend changes (`src/reviewMode.ts`)

- Replace `pinnedRevision: number` + `pinnedCommitHash: string | null` → `pinnedRef: PinnedRef | null`
- `onPinVersion`: `this.pinnedRef = { type: 'local', revision }`
- `onPinGitCommit`: `this.pinnedRef = { type: 'git', hash: commitHash }`
- `sendDiffToWebview`: branch on `pinnedRef?.type === 'git'` (not `historyMode`)
- `sendGitHistory`: auto-pin only when `pinnedRef === null`; if `pinnedRef.type === 'local'`, send `pinnedCommitHash: null` to frontend
- `onSwitchHistoryMode`: update `historyMode`, send new history list, resend pinned diff (no pin change)
- `restoreDiffStateFromStore`: load `pinnedRef` from state; default when no state = `{ type: 'local', revision: N-2 }`
- `open()`: reset to `this.pinnedRef = null`
- All `restoreDiffState` / `updateGitHistory` messages carry `pinnedRef` instead of separate fields

### Frontend changes (`media/review.js`)

- Replace `pinnedRevision` + `pinnedGitCommitHash` → single `pinnedRef` (null or `{type, revision|hash}`)
- `renderHistoryPane`: `isPinned = pinnedRef?.type === 'local' && pinnedRef.revision === rev.revision`
- `renderGitHistoryPane`: `isPinned = pinnedRef?.type === 'git' && pinnedRef.hash === commit.hash`
- Default pin in `renderHistoryPane`: if `pinnedRef === null && sorted.length >= 2`, set `pinnedRef = { type: 'local', revision: sorted[1].revision }`
- Pin click (local): `pinnedRef = { type: 'local', revision }; postMessage({ type: 'pinVersion', revision })`
- Pin click (git): `pinnedRef = { type: 'git', hash }; postMessage({ type: 'pinGitCommit', commitHash: hash })`
- Mode switch to git: remove `pinnedGitCommitHash = null` (no longer needed — pin is not cleared on mode switch)
- `restoreDiffState` handler: set `pinnedRef` from `msg.pinnedRef`; Local/Git button update unchanged
- `updateGitHistory` handler: set `pinnedRef` from `msg.pinnedRef` (if provided)
- Tab switch away from History: update Local/Git button to `pinnedRef?.type ?? 'local'`; if `activeDiffBase !== null`, clear it and post `revertToPinnedDiff` to backend so the diff reverts to the pin

---

## Fix 3 — Button Style Mismatch

### Problem
Two CSS rules with equal specificity (120), the later one wins:

```css
/* line 1197 */ #history-mode-git.toolbar-seg-btn.active { color: var(--accent); }
/* line 1203 */ .toolbar-seg-btn#history-mode-git:not([disabled]) { color: var(--vscode-foreground); }  /* wins — overrides accent */
```

When the Git button is active and enabled, the foreground color overrides the accent color, making Git's active state look different from Local's.

### Solution
Add `:not(.active)` to line 1203's selector:

```css
.toolbar-seg-btn#history-mode-git:not([disabled]):not(.active) { color: var(--vscode-foreground); }
```

**Files changed:** `media/review.css` line ~1203.

---

## Verification

1. Toggle diff mode on → local history shows, N-1 revision pinned (green current, red base).
2. Pin a different local revision → red highlight moves, diff updates.
3. Switch to Git history → nothing pinned in git list (local pin is active). Diff still shows local pin diff.
4. Pin a git commit → git item highlighted red, diff updates. Switch back to Local history → nothing pinned in local list.
5. While previewing a git commit row (no pin), switch to Local mode → preview clears, pinned diff shown.
6. Switch to Comments tab → Local/Git button reflects pin type, diff shows pinned version.
7. Switch back to History → correct history shown for pin type.
8. Both modes: current item green (`font-weight: 600`, `rgba(74, 222, 128, 0.12)`), pinned item red (`rgba(248, 113, 113, 0.22)`).
9. Click Git button when active → accent color matches Local button active style.
