# Comment Edit & Trash Icons

**Date:** 2026-05-14  
**Status:** Approved

## Summary

Replace the plain `✕` text buttons in the comments pane with proper icons (trash for delete, edit/pen for edit), and add inline editing of individual comment messages.

## Scope

- `media/review.js` — UI rendering and event handling
- `media/review.css` — icon button styles
- `src/annotationStore.ts` — new `updateMessage` method
- `src/webviewPanel.ts` — new `editMessage` message handler

## UI Changes

### Thread-level delete button

The `✕` text in `.comment-thread-delete` (thread header) is replaced with `<span class="codicon codicon-trash"></span>`. Hover behavior (fade in, red) is unchanged.

### Per-message action buttons

Each `.comment-message` currently has one `comment-message-delete` button with `✕` text. This becomes two icon buttons:

1. **Edit button** (`comment-message-edit`) — `codicon-edit` icon, positioned `right: 26px` from the message bubble top-right corner. Turns accent-colored on hover.
2. **Trash button** (`comment-message-delete`) — `codicon-trash` icon, positioned `right: 6px`. Turns red on hover (unchanged from today).

Both fade in on `.comment-message:hover`, same as today.

### Inline edit mode

Clicking the edit button on a message:

1. Replaces the `.comment-message-text` div in-place with a `<textarea>` pre-filled with the current message text.
2. Adds Save and Cancel buttons below the textarea (same visual style as `.inline-comment-form-actions`).
3. Save: posts `editMessage` to the extension (`{ type: 'editMessage', annotationId, messageId, text }`), which triggers a re-render of the comments pane.
4. Cancel: restores the original `.comment-message-text` div without changes.
5. Keyboard: Enter (without Shift) submits; Escape cancels.

Only one message can be in edit mode at a time. Opening a second edit cancels the first.

## Backend Changes

### `annotationStore.ts`

New method:
```ts
updateMessage(annotationId: string, messageId: string, newText: string): void
```
Finds the annotation by `annotationId`, then finds the message by `messageId`, and sets `message.text = newText`. Calls `this.save()` and fires the change event.

### `webviewPanel.ts`

New case in the message switch:
```ts
case 'editMessage': {
    this.store.updateMessage(msg.annotationId, msg.messageId, msg.text);
    break;
}
```

## Out of Scope

- Editing the thread title / line range label
- Edit history / audit trail
- Editing the first message of a thread vs. replies (both are treated identically)
