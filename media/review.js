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
    /** @type {{type: 'local', revision: number} | {type: 'git', hash: string} | null} */
    let pinnedRef = null;
    /** @type {number|null} */
    let activeDiffBase = null;
    /** @type {Array|null} */
    let lastRevisions = null;
    /** @type {number} */
    let lastCurrentRevision = -1;
    /** @type {'local'|'git'} */
    let historyMode = 'local';
    /** @type {Array<{hash: string, shortHash: string, message: string, relativeDate: string}>} */
    let gitHistory = [];
    /** @type {boolean} */
    let hasMoreGitCommits = false;
    /** @type {boolean} */
    let hasWorkingCopy = false;
    /** @type {boolean} */
    let isGitAvailable = false;

    // --- Tab switching & State ---
    function activateTab(tabId) {
        document.querySelectorAll('.pane-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const tab = document.querySelector(`.pane-tab[data-tab="${tabId}"]`);
        if (tab) { tab.classList.add('active'); }
        const target = document.getElementById(tabId + '-pane-content');
        if (target) { target.classList.add('active'); }

        const state = vscode.getState() || {};
        state.activeTab = tabId;
        vscode.setState(state);

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
        if (!diffModeEnabled) {
            activeDiffBase = null;
            // Force back to local mode (UI-only — persisted state preserved by extension)
            historyMode = 'local';
            const localBtn = document.getElementById('history-mode-local');
            const gitBtn = document.getElementById('history-mode-git');
            if (localBtn) { localBtn.classList.add('active'); }
            if (gitBtn) {
                gitBtn.classList.remove('active');
                gitBtn.disabled = true;
                gitBtn.classList.add('disabled');
            }
            vscode.postMessage({ type: 'switchHistoryMode', mode: 'local' });
        } else {
            // Re-enable Git button if available (actual mode restore handled by restoreDiffState message)
            const gitBtn = document.getElementById('history-mode-git');
            if (gitBtn && isGitAvailable) {
                gitBtn.disabled = false;
                gitBtn.classList.remove('disabled');
            }
        }
        toggle.setAttribute('aria-checked', String(diffModeEnabled));
        vscode.postMessage({ type: 'toggleDiffMode', enabled: diffModeEnabled });
        // Don't re-render here — the extension will send restoreDiffState (when ON) or updateHistory (when OFF)
    });

    // --- History mode (Local / Git) toggle ---
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('#history-mode-local, #history-mode-git');
        if (!btn || btn.disabled || btn.classList.contains('disabled')) { return; }
        const newMode = btn.id === 'history-mode-git' ? 'git' : 'local';
        if (newMode === historyMode) { return; }
        historyMode = newMode;

        document.getElementById('history-mode-local').classList.toggle('active', newMode === 'local');
        document.getElementById('history-mode-git').classList.toggle('active', newMode === 'git');

        if (newMode === 'git') {
            gitHistory = [];
            hasMoreGitCommits = false;
            hasWorkingCopy = false;
        }

        vscode.postMessage({ type: 'switchHistoryMode', mode: newMode });
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
                const message = {
                    type: 'addNote',
                    startLine: startLine,
                    endLine: endLine,
                    text: text,
                };

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

    function extractDiffContextFromHunks(hunks, lineStart, lineEnd) {
        const contextSize = 3;
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

        while (firstIdx > 0 && rows[firstIdx - 1].type === 'removed') { firstIdx--; }
        while (lastIdx < rows.length - 1 && rows[lastIdx + 1].type === 'removed') { lastIdx++; }

        let hasChange = false;
        for (let i = firstIdx; i <= lastIdx; i++) {
            if (rows[i].type !== 'unchanged') { hasChange = true; break; }
        }
        if (!hasChange) { return null; }

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

        document.body.classList.add('diff-mode');

        const addNoteIcon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9h-3.5L8 12.5 5.5 10H2V2h12v8z"/><path d="M7.25 4v2.25H5v1.5h2.25V10h1.5V7.75H11v-1.5H8.75V4z"/></svg>';
        let html = '';
        let currentLineNum = 0;

        for (const hunk of hunks) {
            for (let i = 0; i < hunk.lines.length; i++) {
                const line = hunk.lines[i];
                const lineHtml = (hunk.highlightedLines && hunk.highlightedLines[i]) || escapeHtml(line) || '&nbsp;';
                if (hunk.type === 'removed') {
                    const anchorLine = currentLineNum > 0 ? currentLineNum : 1;
                    html += `<div class="line-container diff-removed" data-diff-type="removed">
    <div class="line-gutter">
        <button class="add-note-btn" data-line="${anchorLine}" title="Add comment">${addNoteIcon}</button>
        <span class="line-number"></span>
        <span class="diff-gutter-marker removed">−</span>
    </div>
    <div class="line-content">${lineHtml}</div>
</div>\n`;
                } else if (hunk.type === 'added') {
                    currentLineNum++;
                    html += `<div class="line-container diff-added" data-line="${currentLineNum}" data-diff-type="added">
    <div class="line-gutter">
        <button class="add-note-btn" data-line="${currentLineNum}" title="Add comment">${addNoteIcon}</button>
        <span class="line-number">${currentLineNum}</span>
        <span class="diff-gutter-marker added">+</span>
    </div>
    <div class="line-content">${lineHtml}</div>
</div>\n`;
                } else {
                    currentLineNum++;
                    html += `<div class="line-container" data-line="${currentLineNum}">
    <div class="line-gutter">
        <button class="add-note-btn" data-line="${currentLineNum}" title="Add comment">${addNoteIcon}</button>
        <span class="line-number">${currentLineNum}</span>
    </div>
    <div class="line-content">${lineHtml}</div>
</div>\n`;
                }
            }
        }

        codePane.innerHTML = html;
    }

    function clearDiff() {
        currentDiffHunks = null;
        document.body.classList.remove('diff-mode');
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
            if (historyMode === 'local') {
                renderHistoryPane(msg.revisions, msg.currentRevision);
            }
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
            activeDiffBase = null;
            document.getElementById('diff-mode-toggle')?.setAttribute('aria-checked', 'false');
        }
        if (msg.type === 'setGitAvailable') {
            isGitAvailable = !!msg.available;
            const gitBtn = document.getElementById('history-mode-git');
            if (gitBtn && msg.available) {
                // Only enable when diff mode is on
                if (diffModeEnabled) {
                    gitBtn.disabled = false;
                    gitBtn.classList.remove('disabled');
                }
                gitBtn.title = 'Show Git commit history';
            }
        }
        if (msg.type === 'updateGitHistory') {
            gitHistory = msg.commits || [];
            hasMoreGitCommits = !!msg.hasMore;
            hasWorkingCopy = !!msg.hasWorkingCopy;
            if (msg.pinnedRef !== undefined) {
                pinnedRef = msg.pinnedRef;
            }
            renderGitHistoryPane();
        }
        if (msg.type === 'appendGitHistory') {
            gitHistory = gitHistory.concat(msg.commits || []);
            hasMoreGitCommits = !!msg.hasMore;
            renderGitHistoryPane();
        }
        if (msg.type === 'restoreDiffState') {
            historyMode = msg.mode || 'local';
            if (msg.pinnedRef !== undefined) {
                pinnedRef = msg.pinnedRef;
            }
            // Update segmented buttons
            const localBtn = document.getElementById('history-mode-local');
            const gitBtn = document.getElementById('history-mode-git');
            if (localBtn) { localBtn.classList.toggle('active', historyMode === 'local'); }
            if (gitBtn) {
                gitBtn.classList.toggle('active', historyMode === 'git');
                // Ensure git button is enabled if available and diff is on
                if (msg.isGitAvailable && diffModeEnabled) {
                    gitBtn.disabled = false;
                    gitBtn.classList.remove('disabled');
                }
            }
            // Render the correct history tab
            if (historyMode === 'local' && lastRevisions) {
                renderHistoryPane(lastRevisions, lastCurrentRevision);
            }
            // Git history is rendered via updateGitHistory message triggered by extension
        }
    });

    // --- History pane rendering ---
    function renderHistoryPane(revisions, currentRevision) {
        lastRevisions = revisions;
        lastCurrentRevision = currentRevision;
        const pane = document.getElementById('history-pane-content');
        if (!pane) { return; }
        if (!revisions || revisions.length === 0) {
            pane.innerHTML = '<div class="history-empty">No revisions yet.</div>';
            return;
        }

        // Reverse chronological: latest first
        const sorted = [...revisions].sort((a, b) => b.revision - a.revision);
        const latestRevision = sorted[0].revision;
        // Default pin to N-1 if no pin exists yet
        if (pinnedRef === null && sorted.length >= 2) {
            pinnedRef = { type: 'local', revision: sorted[1].revision };
        }

        pane.innerHTML = '';

        for (const rev of sorted) {
            const date = new Date(rev.createdAt);
            const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isLatest = rev.revision === latestRevision;
            const isPinned = pinnedRef?.type === 'local' && rev.revision === pinnedRef.revision;
            const item = document.createElement('div');
            let itemClass = 'history-item';
            if (diffModeEnabled) {
                if (isLatest) { itemClass += ' diff-current'; }
                const isDiffBase = activeDiffBase !== null ? (rev.revision === activeDiffBase) : isPinned;
                if (isDiffBase) { itemClass += ' diff-base'; }
            } else {
                if (rev.revision === currentRevision) { itemClass += ' active'; }
            }
            item.className = itemClass;
            item.dataset.revision = String(rev.revision);

            const countHtml = rev.totalCount === 0 ? '0' : `${rev.addressedCount}/${rev.totalCount}`;

            // Last column: CURRENT badge for latest, pin button for others (only in diff mode), empty otherwise
            let lastColHtml = '';
            if (isLatest) {
                lastColHtml = '<span class="history-current-badge">current</span>';
            } else if (diffModeEnabled) {
                lastColHtml = `<button class="pin-btn${isPinned ? ' pinned' : ''}" data-pin-revision="${rev.revision}" title="Set as diff base"><span class="codicon codicon-pin"></span></button>`;
            }

            item.innerHTML = `
                <span class="history-rev">rev${rev.revision}</span>
                <span class="history-date">${dateStr}</span>
                <span class="history-count${rev.totalCount > 0 && rev.addressedCount === rev.totalCount ? ' all-addressed' : ''}">${countHtml}</span>
                <span class="history-last-col">${lastColHtml}</span>
            `;
            pane.appendChild(item);
        }

        // Swap pane to remove stale click listeners, then add single delegated handler
        const freshPane = pane.cloneNode(false);
        while (pane.firstChild) { freshPane.appendChild(pane.firstChild); }
        pane.parentNode.replaceChild(freshPane, pane);
        freshPane.addEventListener('click', (e) => {
            // Pin button click
            const pinBtn = e.target.closest('.pin-btn');
            if (pinBtn) {
                const revision = parseInt(pinBtn.dataset.pinRevision, 10);
                if (pinnedRef?.type === 'local' && revision === pinnedRef.revision) { return; }
                pinnedRef = { type: 'local', revision };
                vscode.postMessage({ type: 'pinVersion', revision });
                renderHistoryPane(revisions, currentRevision);
                return;
            }

            // Row click
            const item = e.target.closest('.history-item');
            if (!item) { return; }
            const revision = parseInt(item.dataset.revision, 10);
            if (isNaN(revision)) { return; }

            if (diffModeEnabled) {
                if (revision === latestRevision) {
                    // Clicking "current" while in diff mode: no-op, keep current diff base
                    return;
                }
                // In diff mode: temporarily preview diff from this revision (without changing the pin)
                activeDiffBase = revision;
                vscode.postMessage({ type: 'previewDiffBase', revision });
                renderHistoryPane(revisions, currentRevision);
                return;
            } else {
                vscode.postMessage({ type: 'openRevision', revision });
            }
        });
    }

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
                <span class="history-last-col"><span class="history-current-badge">current</span></span>
            </div>`;
        } else if (gitHistory.length > 0) {
            // Latest commit is the target when there are no working copy changes
            const latest = gitHistory[0];
            html += `<div class="history-item git-item diff-current" data-commit-hash="${escapeHtml(latest.hash)}">
                <span class="git-hash">${escapeHtml(latest.shortHash)}</span>
                <span class="git-message" title="${escapeHtml(latest.message)}">${escapeHtml(latest.message)}</span>
                <span class="git-date">${escapeHtml(latest.relativeDate)}</span>
                <span class="history-last-col"><span class="history-current-badge">current</span></span>
            </div>`;
        }

        // Historical commit entries (all commits when hasWorkingCopy, skipping commit[0] otherwise)
        const startIdx = hasWorkingCopy ? 0 : 1;
        for (let i = startIdx; i < gitHistory.length; i++) {
            const commit = gitHistory[i];
            const isPinned = pinnedRef?.type === 'git' && commit.hash === pinnedRef.hash;
            const baseClass = diffModeEnabled && isPinned ? ' diff-base' : '';

            // Last column: pin button only in diff mode
            let lastColHtml = '';
            if (diffModeEnabled) {
                lastColHtml = `<button class="pin-btn${isPinned ? ' pinned' : ''}" data-pin-commit="${escapeHtml(commit.hash)}" title="Set as diff base">
                    <span class="codicon codicon-pin"></span>
                </button>`;
            }

            html += `<div class="history-item git-item${baseClass}" data-commit-hash="${escapeHtml(commit.hash)}">
                <span class="git-hash">${escapeHtml(commit.shortHash)}</span>
                <span class="git-message" title="${escapeHtml(commit.message)}">${escapeHtml(commit.message)}</span>
                <span class="git-date">${escapeHtml(commit.relativeDate)}</span>
                <span class="history-last-col">${lastColHtml}</span>
            </div>`;
        }

        if (hasMoreGitCommits) {
            html += `<button class="load-more-btn">Load more...</button>`;
        }

        pane.innerHTML = html;

        // Clone pane to drop any stale delegated listeners, then re-attach one
        const freshPane = pane.cloneNode(false);
        while (pane.firstChild) { freshPane.appendChild(pane.firstChild); }
        pane.parentNode.replaceChild(freshPane, pane);

        freshPane.addEventListener('click', (e) => {
            // Pin button
            const pinBtn = e.target.closest('[data-pin-commit]');
            if (pinBtn) {
                const commitHash = pinBtn.dataset.pinCommit;
                if (pinnedRef?.type === 'git' && commitHash === pinnedRef.hash) { return; }
                pinnedRef = { type: 'git', hash: commitHash };
                vscode.postMessage({ type: 'pinGitCommit', commitHash });
                renderGitHistoryPane();
                return;
            }

            // Row click — preview diff without pinning (like local mode)
            if (diffModeEnabled) {
                const item = e.target.closest('.history-item.git-item');
                if (item && !item.classList.contains('diff-current') && !e.target.closest('.load-more-btn')) {
                    const commitHash = item.dataset.commitHash;
                    if (commitHash) {
                        // Visually mark as temporary diff-base
                        freshPane.querySelectorAll('.history-item.git-item.diff-base').forEach(el => el.classList.remove('diff-base'));
                        item.classList.add('diff-base');
                        vscode.postMessage({ type: 'previewGitDiff', commitHash });
                        return;
                    }
                }
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

    // --- Resizable comments pane ---
    (function () {
        const handle = document.getElementById('panel-resize-handle');
        const commentsPane = document.querySelector('.comments-pane');
        if (!handle || !commentsPane) { return; }

        // Restore saved width from persistent state
        const savedState = vscode.getState();
        if (savedState && savedState.panelWidth) {
            commentsPane.style.width = savedState.panelWidth + 'px';
        }

        let startX = 0;
        let startWidth = 0;

        handle.addEventListener('mousedown', (e) => {
            startX = e.clientX;
            startWidth = commentsPane.getBoundingClientRect().width;
            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!handle.classList.contains('dragging')) { return; }
            const dx = startX - e.clientX; // dragging left = wider panel
            const newWidth = Math.max(220, Math.min(700, startWidth + dx));
            commentsPane.style.width = newWidth + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!handle.classList.contains('dragging')) { return; }
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';

            // Persist the new width
            const finalWidth = Math.round(commentsPane.getBoundingClientRect().width);
            const state = vscode.getState() || {};
            state.panelWidth = finalWidth;
            vscode.setState(state);
            // Also persist via extension globalState for cross-session survival
            vscode.postMessage({ type: 'savePanelWidth', width: finalWidth });
        });
    })();
})();
