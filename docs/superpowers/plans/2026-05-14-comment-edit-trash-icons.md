# Comment Edit & Trash Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `✕` text buttons in the comments pane with codicon trash icons, and add a per-message edit button that enables inline editing.

**Architecture:** All UI changes are in `media/review.js` (rendering + event delegation) and `media/review.css` (styles). The extension backend gains a single new `updateMessage` store method and a matching webview message handler.

**Tech Stack:** Vanilla JS webview, VS Code codicon font (already loaded), TypeScript extension host.

---

## File Map

| File | Change |
|---|---|
| `media/review.js` | Add edit button to message HTML; handle edit/cancel/save in click handler |
| `media/review.css` | New `.comment-message-edit` style; shift delete button; add edit textarea styles |
| `src/annotationStore.ts` | Add `updateMessage(annotationId, messageId, newText)` method |
| `src/webviewPanel.ts` | Add `case 'editMessage'` to message switch |

---

## Task 1: Add `updateMessage` to `annotationStore.ts`

**Files:**
- Modify: `src/annotationStore.ts` (after `deleteMessage`, around line 283)

- [ ] **Step 1: Add the method**

  Open `src/annotationStore.ts`. After the closing `}` of `deleteMessage` (line ~283), insert:

  ```ts
  /** Update the text of a single message. */
  updateMessage(annotationId: string, messageId: string, newText: string): void {
      const annotation = this.annotations.find(a => a.id === annotationId);
      if (!annotation) { return; }
      const message = annotation.thread.find(m => m.id === messageId);
      if (!message) { return; }
      message.text = newText;
      this.saveCurrentRevision();
      this._onDidChange.fire();
  }
  ```

- [ ] **Step 2: Build to verify no TypeScript errors**

  ```bash
  cd /mnt/c/Users/Aure/Documents/GitHub/vscode-planner && npm run compile 2>&1 | tail -20
  ```

  Expected: no errors (exit 0 or only warnings unrelated to this change).

- [ ] **Step 3: Commit**

  ```bash
  git add src/annotationStore.ts
  git commit -m "feat: add updateMessage to annotationStore"
  ```

---

## Task 2: Wire `editMessage` handler in `webviewPanel.ts`

**Files:**
- Modify: `src/webviewPanel.ts` (the `switch` statement that handles `deleteMessage`, around line 621)

- [ ] **Step 1: Add the case**

  In the `switch` block in `webviewPanel.ts`, directly after the `case 'deleteMessage'` block (which ends around line 623), add:

  ```ts
  case 'editMessage': {
      this.store.updateMessage(msg.annotationId, msg.messageId, msg.text);
      break;
  }
  ```

- [ ] **Step 2: Build**

  ```bash
  npm run compile 2>&1 | tail -20
  ```

  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add src/webviewPanel.ts
  git commit -m "feat: handle editMessage webview message"
  ```

---

## Task 3: Update CSS — trash icon for thread-level delete, edit + trash icons for messages

**Files:**
- Modify: `media/review.css`

- [ ] **Step 1: Update `.comment-thread-delete`**

  The existing rule starts at line ~921. The `font-size: 14px` is set for the `✕` character; codicons render at 16px naturally. Update just the `font-size`:

  ```css
  .comment-thread-delete {
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground, #888);
      cursor: pointer;
      font-size: 16px;
      padding: 0 2px;
      opacity: 0;
      transition: opacity 0.15s;
  }
  ```

- [ ] **Step 2: Update `.comment-message-delete` to shift right position**

  The delete button was at `right: 6px`. Now it shares space with the new edit button, so shift it to `right: 6px` (keep) but change the `font-size` to `16px` to match codicons:

  ```css
  .comment-message-delete {
      position: absolute;
      top: 6px;
      right: 6px;
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground, #888);
      cursor: pointer;
      font-size: 16px;
      opacity: 0;
      transition: opacity 0.15s;
  }
  ```

- [ ] **Step 3: Add `.comment-message-edit` rule**

  Add this block immediately after `.comment-message-delete:hover` (around line 1095):

  ```css
  .comment-message-edit {
      position: absolute;
      top: 6px;
      right: 26px;
      background: none;
      border: none;
      color: var(--vscode-descriptionForeground, #888);
      cursor: pointer;
      font-size: 16px;
      opacity: 0;
      transition: opacity 0.15s;
  }

  .comment-message:hover .comment-message-edit {
      opacity: 0.6;
  }

  .comment-message-edit:hover {
      opacity: 1 !important;
      color: var(--accent, #3b82f6);
  }
  ```

- [ ] **Step 4: Add inline-edit textarea styles**

  Add after the `.comment-message-edit:hover` block:

  ```css
  .comment-message-edit-area {
      width: 100%;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #444);
      border-radius: 3px;
      font-family: inherit;
      font-size: 1em;
      padding: 4px 8px;
      outline: none;
      resize: vertical;
      min-height: 56px;
  }

  .comment-message-edit-area:focus {
      border-color: var(--accent);
  }

  .comment-message-edit-actions {
      display: flex;
      gap: 6px;
      margin-top: 4px;
  }
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add media/review.css
  git commit -m "feat: add trash/edit icon styles to comments pane"
  ```

---

## Task 4: Update `renderCommentsPane` in `review.js` to use codicons

**Files:**
- Modify: `media/review.js` (lines ~479 and ~494–496)

- [ ] **Step 1: Replace thread-level delete button content**

  Find line ~479:
  ```js
  <button class="comment-thread-delete" data-delete-thread="${ann.id}" title="Delete thread">✕</button>
  ```

  Replace with:
  ```js
  <button class="comment-thread-delete" data-delete-thread="${ann.id}" title="Delete thread"><span class="codicon codicon-trash"></span></button>
  ```

- [ ] **Step 2: Replace per-message delete button and add edit button**

  Find lines ~493–498 (the `messagesHtml +=` template literal):

  ```js
  messagesHtml += `
      <div class="comment-message">
          <button class="comment-message-delete" data-delete-msg="${msg.id}" data-annotation-id="${ann.id}" title="Delete">✕</button>
          <div class="comment-message-text">${escapeHtml(msg.text)}</div>
          <div class="comment-message-time">${time}</div>
      </div>
  `;
  ```

  Replace with:

  ```js
  messagesHtml += `
      <div class="comment-message" data-msg-id="${msg.id}" data-annotation-id="${ann.id}">
          <button class="comment-message-edit" data-edit-msg="${msg.id}" data-annotation-id="${ann.id}" title="Edit"><span class="codicon codicon-edit"></span></button>
          <button class="comment-message-delete" data-delete-msg="${msg.id}" data-annotation-id="${ann.id}" title="Delete"><span class="codicon codicon-trash"></span></button>
          <div class="comment-message-text">${escapeHtml(msg.text)}</div>
          <div class="comment-message-time">${time}</div>
      </div>
  `;
  ```

  Note: `data-msg-id` and `data-annotation-id` are added to the `.comment-message` div itself so the edit handler can locate the message.

- [ ] **Step 3: Commit**

  ```bash
  git add media/review.js
  git commit -m "feat: use codicon trash/edit icons in comments pane HTML"
  ```

---

## Task 5: Add edit click handler and inline-edit logic in `review.js`

**Files:**
- Modify: `media/review.js` (the delegated click handler, around line 648)

- [ ] **Step 1: Add the edit message handler**

  In the click handler, after the `// Delete message` block (which ends around line 657), add:

  ```js
  // Edit message
  const editBtn = e.target.closest('.comment-message-edit');
  if (editBtn) {
      const annotationId = editBtn.dataset.annotationId;
      const messageId = editBtn.dataset.editMsg;
      const msgDiv = editBtn.closest('.comment-message');
      if (!msgDiv) { return; }

      // Only one edit at a time — cancel any existing edit
      const existing = document.querySelector('.comment-message-edit-area');
      if (existing) {
          const existingMsg = existing.closest('.comment-message');
          if (existingMsg) { cancelEdit(existingMsg); }
      }

      const textDiv = msgDiv.querySelector('.comment-message-text');
      const originalText = textDiv.textContent;

      textDiv.style.display = 'none';
      const textarea = document.createElement('textarea');
      textarea.className = 'comment-message-edit-area';
      textarea.value = originalText;
      msgDiv.insertBefore(textarea, textDiv);
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);

      const actions = document.createElement('div');
      actions.className = 'comment-message-edit-actions';
      actions.innerHTML = `
          <button class="inline-comment-cancel comment-message-edit-cancel">Cancel</button>
          <button class="inline-comment-submit comment-message-edit-save">Save</button>
      `;
      msgDiv.insertBefore(actions, textDiv);

      function cancelEdit(div) {
          const ta = div.querySelector('.comment-message-edit-area');
          const ac = div.querySelector('.comment-message-edit-actions');
          const td = div.querySelector('.comment-message-text');
          if (ta) { ta.remove(); }
          if (ac) { ac.remove(); }
          if (td) { td.style.display = ''; }
      }

      actions.querySelector('.comment-message-edit-cancel').addEventListener('click', () => {
          cancelEdit(msgDiv);
      });

      actions.querySelector('.comment-message-edit-save').addEventListener('click', () => {
          const newText = textarea.value.trim();
          if (!newText) { return; }
          vscode.postMessage({
              type: 'editMessage',
              annotationId,
              messageId,
              text: newText,
          });
          cancelEdit(msgDiv);
      });

      textarea.addEventListener('keydown', (ev) => {
          if (ev.key === 'Escape') { cancelEdit(msgDiv); }
          if (ev.key === 'Enter' && !ev.shiftKey) {
              ev.preventDefault();
              actions.querySelector('.comment-message-edit-save').click();
          }
      });

      return;
  }
  ```

- [ ] **Step 2: Build**

  ```bash
  npm run compile 2>&1 | tail -20
  ```

  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add media/review.js
  git commit -m "feat: inline message editing in comments pane"
  ```

---

## Task 6: Manual verification

- [ ] **Step 1: Run the extension**

  Press `F5` in VS Code to launch the Extension Development Host. Open a file that has annotations, or add a comment via the review pane.

- [ ] **Step 2: Verify trash icons**

  - Hover over a comment thread header — should see a trash icon (not `✕`) fade in.
  - Hover over an individual message bubble — should see a trash icon (not `✕`) fade in at top-right.
  - Click the trash icon on a message — message should be deleted (same behavior as before).
  - Click the trash icon on a thread — thread should be deleted.

- [ ] **Step 3: Verify edit icon**

  - Hover over a message bubble — should see both a pencil/edit icon (left of trash, at ~`right: 26px`) and the trash icon.
  - Edit icon should be blue/accent on hover; trash should be red on hover.

- [ ] **Step 4: Verify inline edit flow**

  - Click the edit icon on a message — message text should be replaced by a textarea pre-filled with the text, plus Save and Cancel buttons.
  - Edit the text and click **Save** — pane re-renders with the updated text.
  - Click edit again, change text, press **Enter** (not Shift+Enter) — saves.
  - Click edit, press **Escape** — restores original text without saving.
  - Click edit on message A, then click edit on message B — message A's edit should be cancelled automatically.

- [ ] **Step 5: Commit if any minor fixes were made during verification**

  ```bash
  git add -p
  git commit -m "fix: <describe what was fixed>"
  ```
