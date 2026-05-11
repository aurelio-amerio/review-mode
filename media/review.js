// @ts-check

(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    /** @type {HTMLElement|null} */
    let activeForm = null;
    /** @type {number|null} */
    let selectionStart = null;
    /** @type {number|null} */
    let selectionEnd = null;
    /** @type {boolean} */
    let diffModeEnabled = false;
    /** @type {Array<{type: string, lines: string[]}>|null} */
    let currentDiffHunks = null;
    /** @type {number} */
    let pinnedRevision = -1;

    // --- Tab switching & State ---
    function activateTab(tabId) {
        document.querySelectorAll('.pane-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const tab = document.querySelector(`.pane-tab[data-tab="${tabId}"]`);
        if (tab) { tab.classList.add('active'); }
        const target = document.getElementById(tabId + '-pane-content');
        if (target) { target.classList.add('active'); }

        vscode.setState({ activeTab: tabId });
    }

    const previousState = vscode.getState();
    if (previousState && previousState.activeTab) {
        activateTab(previousState.activeTab);
    }

    document.addEventListener('click', (e) => {
        const tab = e.target.closest('.pane-tab');
        if (!tab) { return; }
        activateTab(tab.dataset.tab);
    });

    // --- Diff Mode toggle ---
    document.addEventListener('click', (e) => {
        const toggle = e.target.closest('#diff-mode-toggle');
        if (!toggle) { return; }

        diffModeEnabled = !diffModeEnabled;
        toggle.dataset.enabled = String(diffModeEnabled);
        toggle.textContent = diffModeEnabled ? 'ON' : 'OFF';
        vscode.postMessage({ type: 'toggleDiffMode', enabled: diffModeEnabled });
    });

    // --- Helper: get line range from native text selection ---
    function getSelectionLineRange() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
            return null;
        }

        const range = sel.getRangeAt(0);

        // Find the line-container elements at start and end of selection
        let startNode = range.startContainer;
        let endNode = range.endContainer;

        // Walk up to find .line-container
        const findLineContainer = (node) => {
            while (node && node !== document.body) {
                if (node.nodeType === 1 && node.classList && node.classList.contains('line-container')) {
                    return node;
                }
                node = node.parentElement || node.parentNode;
            }
            return null;
        };

        const startContainer = findLineContainer(startNode);
        const endContainer = findLineContainer(endNode);

        if (!startContainer || !endContainer) {
            return null;
        }

        const startLine = parseInt(startContainer.dataset.line, 10);
        const endLine = parseInt(endContainer.dataset.line, 10);

        return {
            startLine: Math.min(startLine, endLine),
            endLine: Math.max(startLine, endLine),
        };
    }

    // --- "+" Button Click ---
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.add-note-btn');
        if (!btn) { return; }

        const lineNum = parseInt(btn.dataset.line, 10);

        // For markdown blocks, get the full block range from the container
        const container = btn.closest('.line-container');
        const blockEndLine = container && container.dataset.endLine
            ? parseInt(container.dataset.endLine, 10)
            : lineNum;

        // First, check native text selection (user dragged to select text)
        const nativeRange = getSelectionLineRange();
        if (nativeRange && (nativeRange.startLine !== nativeRange.endLine)) {
            showInlineCommentForm(nativeRange.startLine, nativeRange.endLine);
            return;
        }

        // Then, check our click/shift-click selection
        if (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd) {
            const startLine = Math.min(selectionStart, selectionEnd);
            const endLine = Math.max(selectionStart, selectionEnd);
            showInlineCommentForm(startLine, endLine);
            return;
        }

        // Single line or block
        showInlineCommentForm(lineNum, blockEndLine);
    });

    // --- Track line selection (click + shift-click for range) ---
    document.addEventListener('click', (e) => {
        const container = e.target.closest('.line-container');
        if (!container || e.target.closest('.add-note-btn') || e.target.closest('.inline-comment-form')) {
            return;
        }

        const lineNum = parseInt(container.dataset.line, 10);

        if (e.shiftKey && selectionStart !== null) {
            selectionEnd = lineNum;
            highlightSelection(selectionStart, selectionEnd);
        } else {
            clearSelection();
            selectionStart = lineNum;
            selectionEnd = lineNum;
            container.classList.add('selected');
        }
    });

    /**
     * @param {number} start
     * @param {number} end
     */
    function highlightSelection(start, end) {
        clearSelection();
        const minLine = Math.min(start, end);
        const maxLine = Math.max(start, end);
        for (let i = minLine; i <= maxLine; i++) {
            const el = document.querySelector(`.line-container[data-line="${i}"]`);
            if (el) { el.classList.add('selected'); }
        }
    }

    function clearSelection() {
        document.querySelectorAll('.line-container.selected').forEach(el => {
            el.classList.remove('selected');
        });
    }

    // --- Inline Comment Form (in code pane) ---
    /**
     * @param {number} startLine
     * @param {number} endLine
     */
    function showInlineCommentForm(startLine, endLine) {
        if (activeForm) { activeForm.remove(); }

        let targetContainer = document.querySelector(`.line-container[data-line="${endLine}"]`);
        // Fall back to the startLine container — needed when a multi-line block
        // (e.g. a fenced code block) is rendered as a single line-container
        if (!targetContainer && endLine !== startLine) {
            targetContainer = document.querySelector(`.line-container[data-line="${startLine}"]`);
        }
        if (!targetContainer) { return; }

        // Highlight the range being commented
        highlightSelection(startLine, endLine);

        const form = document.createElement('div');
        form.className = 'inline-comment-form';
        form.innerHTML = `
            <input class="inline-comment-input" placeholder="Add a comment for line${startLine !== endLine ? 's ' + startLine + '–' + endLine : ' ' + startLine}..." autofocus />
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
                vscode.postMessage({
                    type: 'addNote',
                    startLine: startLine,
                    endLine: endLine,
                    text: text,
                });
            }
            form.remove();
            activeForm = null;
            clearSelection();
            selectionStart = null;
            selectionEnd = null;
        };

        form.querySelector('.inline-comment-submit').addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { submit(); }
            if (e.key === 'Escape') { form.remove(); activeForm = null; clearSelection(); }
        });
        form.querySelector('.inline-comment-cancel').addEventListener('click', () => {
            form.remove();
            activeForm = null;
            clearSelection();
        });
    }

    // ================================
    // Right-side comments pane
    // ================================

    function renderCommentsPane(annotations) {
        const pane = document.getElementById('comments-pane-content');
        if (!pane) { return; }

        if (!annotations || annotations.length === 0) {
            pane.innerHTML = '<div class="comments-empty">No comments yet.<br>Click + on a line to add one.</div>';
            return;
        }

        pane.innerHTML = '';

        for (const ann of annotations) {
            const thread = document.createElement('div');
            thread.className = 'comment-thread' + (ann.deletedLine ? ' deleted-line-thread' : '');
            thread.dataset.annotationId = ann.id;

            const rangeText = ann.startLine === ann.endLine
                ? `Line ${ann.startLine}`
                : `Lines ${ann.startLine}–${ann.endLine}`;

            const priority = ann.priority || 'none';
            const status = ann.status || 'open';

            const statusIcons = {
                'open': '<span class="codicon codicon-pencil"></span>',
                'in-progress': '<span class="codicon codicon-output"></span>',
                'resolved': '<span class="codicon codicon-check"></span>',
                'wont-fix': '<span class="codicon codicon-close"></span>'
            };

            const statusLabels = {
                'open': 'Open',
                'in-progress': 'In Progress',
                'resolved': 'Resolved',
                'wont-fix': "Won't Fix"
            };

            const deletedBadge = ann.deletedLine ? ' <span class="deleted-line-badge">[deleted]</span>' : '';

            let headerHtml = `
                <div class="comment-thread-header${ann.deletedLine ? ' deleted-line-header' : ''}" data-scroll-line="${ann.startLine}">
                    <span class="comment-thread-line">${rangeText}${deletedBadge}</span>
                    <select class="priority-select priority-${priority}" data-priority-for="${ann.id}">
                        <option value="none"${priority === 'none' ? ' selected' : ''}>—</option>
                        <option value="low"${priority === 'low' ? ' selected' : ''}>Low</option>
                        <option value="medium"${priority === 'medium' ? ' selected' : ''}>Medium</option>
                        <option value="high"${priority === 'high' ? ' selected' : ''}>High</option>
                        <option value="urgent"${priority === 'urgent' ? ' selected' : ''}>Urgent</option>
                    </select>
                    <button class="comment-thread-delete" data-delete-thread="${ann.id}" title="Delete thread">✕</button>
                </div>
                <div class="comment-status-bar" data-annotation-id="${ann.id}">
                    ${Object.entries(statusIcons).map(([key, icon]) => `
                        <button class="status-btn${status === key ? ' active' : ''} status-${key}"
                                data-status="${key}" data-status-for="${ann.id}"
                                title="${statusLabels[key]}">${icon}</button>
                    `).join('')}
                </div>
            `;

            let messagesHtml = '';
            for (const msg of ann.thread) {
                const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                messagesHtml += `
                    <div class="comment-message">
                        <button class="comment-message-delete" data-delete-msg="${msg.id}" data-annotation-id="${ann.id}" title="Delete">✕</button>
                        <div class="comment-message-text">${escapeHtml(msg.text)}</div>
                        <div class="comment-message-time">${time}</div>
                    </div>
                `;
            }

            const replyHtml = `
                <div class="comment-reply-area">
                    <input class="comment-reply-input" placeholder="Reply..." data-reply-to="${ann.id}" />
                    <button class="comment-reply-btn" data-reply-submit="${ann.id}">↵</button>
                </div>
            `;

            thread.innerHTML = headerHtml + messagesHtml + replyHtml;
            pane.appendChild(thread);
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // --- Comment pane event delegation ---

    // Priority dropdown change
    document.addEventListener('change', (e) => {
        const select = e.target.closest('.priority-select');
        if (select) {
            const annotationId = select.dataset.priorityFor;
            const priority = select.value;
            select.className = 'priority-select priority-' + priority;
            vscode.postMessage({
                type: 'setPriority',
                annotationId: annotationId,
                priority: priority,
            });
        }
    });

    document.addEventListener('click', (e) => {
        // Ignore clicks on the priority dropdown
        if (e.target.closest('.priority-select')) { return; }

        // Status button click
        const statusBtn = e.target.closest('.status-btn');
        if (statusBtn) {
            const annotationId = statusBtn.dataset.statusFor;
            const newStatus = statusBtn.dataset.status;
            vscode.postMessage({
                type: 'setStatus',
                annotationId: annotationId,
                status: newStatus,
            });
            return;
        }

        // Thread header click → scroll to line
        const header = e.target.closest('.comment-thread-header');
        if (header && !e.target.closest('.comment-thread-delete')) {
            const line = parseInt(header.dataset.scrollLine, 10);
            const container = document.querySelector(`.line-container[data-line="${line}"]`);
            if (container) {
                container.scrollIntoView({ behavior: 'smooth', block: 'center' });
                container.classList.add('selected');
                setTimeout(() => container.classList.remove('selected'), 1500);
            }
            return;
        }

        // Delete thread
        const deleteThread = e.target.closest('.comment-thread-delete');
        if (deleteThread) {
            vscode.postMessage({
                type: 'deleteThread',
                annotationId: deleteThread.dataset.deleteThread,
            });
            return;
        }

        // Delete message
        const deleteMsg = e.target.closest('.comment-message-delete');
        if (deleteMsg) {
            vscode.postMessage({
                type: 'deleteMessage',
                annotationId: deleteMsg.dataset.annotationId,
                messageId: deleteMsg.dataset.deleteMsg,
            });
            return;
        }

        // Reply submit button
        const replyBtn = e.target.closest('.comment-reply-btn');
        if (replyBtn) {
            const annotationId = replyBtn.dataset.replySubmit;
            const input = document.querySelector(`.comment-reply-input[data-reply-to="${annotationId}"]`);
            if (input && input.value.trim()) {
                vscode.postMessage({
                    type: 'reply',
                    annotationId: annotationId,
                    text: input.value.trim(),
                });
                input.value = '';
            }
            return;
        }
    });

    // Reply on Enter key in reply input
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('comment-reply-input')) {
            const annotationId = e.target.dataset.replyTo;
            const text = e.target.value.trim();
            if (text) {
                vscode.postMessage({
                    type: 'reply',
                    annotationId: annotationId,
                    text: text,
                });
                e.target.value = '';
            }
        }
    });

    function renderDiff(hunks) {
        currentDiffHunks = hunks;
        const codePane = document.querySelector('.code-pane');
        if (!codePane) { return; }

        const addNoteIcon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9h-3.5L8 12.5 5.5 10H2V2h12v8z"/><path d="M7.25 4v2.25H5v1.5h2.25V10h1.5V7.75H11v-1.5H8.75V4z"/></svg>';
        let html = '';
        let currentLineNum = 0;

        for (const hunk of hunks) {
            for (const line of hunk.lines) {
                const escaped = escapeHtml(line) || '&nbsp;';
                if (hunk.type === 'removed') {
                    const anchorLine = currentLineNum > 0 ? currentLineNum : 1;
                    html += `<div class="line-container diff-removed" data-diff-type="removed">
    <div class="line-gutter">
        <span class="line-number"></span>
        <span class="diff-gutter-marker removed">−</span>
        <button class="add-note-btn" data-line="${anchorLine}" title="Add comment">${addNoteIcon}</button>
    </div>
    <div class="line-content">${escaped}</div>
</div>\n`;
                } else if (hunk.type === 'added') {
                    currentLineNum++;
                    html += `<div class="line-container diff-added" data-line="${currentLineNum}" data-diff-type="added">
    <div class="line-gutter">
        <span class="line-number">${currentLineNum}</span>
        <span class="diff-gutter-marker added">+</span>
        <button class="add-note-btn" data-line="${currentLineNum}" title="Add comment">${addNoteIcon}</button>
    </div>
    <div class="line-content">${escaped}</div>
</div>\n`;
                } else {
                    currentLineNum++;
                    html += `<div class="line-container" data-line="${currentLineNum}">
    <div class="line-gutter">
        <span class="line-number">${currentLineNum}</span>
        <button class="add-note-btn" data-line="${currentLineNum}" title="Add comment">${addNoteIcon}</button>
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
    }

    // --- Handle messages from extension ---
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'updateAnnotations') {
            updateAnnotationHighlights(msg.annotations);
            renderCommentsPane(msg.annotations);
        }
        if (msg.type === 'scrollToLine') {
            const container = document.querySelector(`.line-container[data-line="${msg.line}"]`);
            if (container) {
                container.scrollIntoView({ behavior: 'smooth', block: 'center' });
                container.classList.add('selected');
                setTimeout(() => container.classList.remove('selected'), 1500);
            }
        }
        if (msg.type === 'updateHistory') {
            renderHistoryPane(msg.revisions, msg.currentRevision);
        }
        if (msg.type === 'replaceContent') {
            const codePane = document.querySelector('.code-pane');
            if (codePane) {
                codePane.innerHTML = msg.html;
            }
        }
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
    });

    // --- History pane rendering ---
    function renderHistoryPane(revisions, currentRevision) {
        const pane = document.getElementById('history-pane-content');
        if (!pane) { return; }
        if (!revisions || revisions.length === 0) {
            pane.innerHTML = '<div class="history-empty">No revisions yet.</div>';
            return;
        }

        // Reverse chronological: latest first
        const sorted = [...revisions].sort((a, b) => b.revision - a.revision);
        const latestRevision = sorted[0].revision;
        // Default pin to N-1 if not yet set
        if (pinnedRevision < 0 && sorted.length >= 2) {
            pinnedRevision = sorted[1].revision;
        }

        pane.innerHTML = '';

        for (const rev of sorted) {
            const date = new Date(rev.createdAt);
            const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isLatest = rev.revision === latestRevision;
            const isPinned = rev.revision === pinnedRevision;
            const item = document.createElement('div');
            item.className = 'history-item' + (rev.revision === currentRevision ? ' active' : '');
            item.dataset.revision = String(rev.revision);

            let pinHtml = '';
            if (!isLatest) {
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
            pane.appendChild(item);
        }

        // Swap pane to remove stale click listeners, then add pin handler once
        const freshPane = pane.cloneNode(false);
        while (pane.firstChild) { freshPane.appendChild(pane.firstChild); }
        pane.parentNode.replaceChild(freshPane, pane);
        freshPane.addEventListener('click', (e) => {
            const pinBtn = e.target.closest('.pin-btn');
            if (pinBtn) {
                const revision = parseInt(pinBtn.dataset.pinRevision, 10);
                if (revision === pinnedRevision) {
                    const defaultPin = sorted.length >= 2 ? sorted[1].revision : -1;
                    if (revision === defaultPin) { return; }
                    pinnedRevision = defaultPin;
                } else {
                    pinnedRevision = revision;
                }
                vscode.postMessage({ type: 'pinVersion', revision: pinnedRevision });
                renderHistoryPane(revisions, currentRevision);
                return;
            }

            const item = e.target.closest('.history-item');
            if (item) {
                const revision = parseInt(item.dataset.revision, 10);
                if (!isNaN(revision)) {
                    vscode.postMessage({ type: 'openRevision', revision });
                }
            }
        });
    }

    function updateAnnotationHighlights(annotations) {
        document.querySelectorAll('.line-container.annotated').forEach(el => {
            el.classList.remove('annotated');
        });
        document.querySelectorAll('.annotation-badge').forEach(el => el.remove());

        for (const ann of annotations) {
            for (let i = ann.startLine; i <= ann.endLine; i++) {
                const container = document.querySelector(`.line-container[data-line="${i}"]`);
                if (container) {
                    container.classList.add('annotated');
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
})();
