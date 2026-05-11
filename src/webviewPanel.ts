import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { marked } from 'marked';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
import { parse as parseYaml } from 'yaml';
import { AnnotationStore } from './annotationStore';

// Map file extensions to Shiki language IDs
const EXT_TO_LANG: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
    '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java',
    '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
    '.css': 'css', '.html': 'html', '.json': 'json', '.yaml': 'yaml',
    '.yml': 'yaml', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
    '.sql': 'sql', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
    '.kt': 'kotlin', '.lua': 'lua', '.r': 'r', '.toml': 'toml',
    '.xml': 'xml', '.svg': 'xml',
};

export class ReviewWebviewPanel {
    private panels = new Map<string, {
        panel: vscode.WebviewPanel,
        snapshotPath: string,
        revisionsPath: string
    }>();
    private activeRevisionsPath: string = '';
    private highlighter: Highlighter | undefined;

    /** Callback invoked when the user clicks a history entry to open a revision. */
    public onRevisionRequested?: (originalPath: string, revision: number) => void;
    public onDiffModeToggled?: (originalPath: string, enabled: boolean) => void;
    public onPinVersion?: (originalPath: string, revision: number) => void;

    constructor(
        private context: vscode.ExtensionContext,
        private store: AnnotationStore,
    ) {
        // When annotations change, update the webview highlights + history
        store.onDidChange(() => {
            this.sendAnnotationUpdate();
            this.sendHistoryUpdate();
        });
    }

    /** Open the file in a WebView review panel. */
    async show(originalPath: string, snapshotPath: string, revisionsPath: string, title?: string): Promise<void> {

        const existing = this.panels.get(originalPath);
        if (existing) {
            existing.snapshotPath = snapshotPath;
            // Focus and update
            existing.panel.reveal(vscode.ViewColumn.Active);
            this.refreshContent(originalPath, snapshotPath);
            return;
        }

        const ext = path.extname(snapshotPath).toLowerCase();
        const lang = EXT_TO_LANG[ext];

        // Initialize Shiki highlighter (lazy, once) — only if we need it
        if (lang && !this.highlighter) {
            this.highlighter = await createHighlighter({
                themes: ['dark-plus', 'light-plus'],
                langs: Object.values(EXT_TO_LANG),
            });
        }

        const panel = vscode.window.createWebviewPanel(
            'reviewMode',
            title ? `Review: ${title}` : `Review: ${path.basename(snapshotPath)}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(this.context.extensionPath, 'media')),
                ],
            },
        );

        this.panels.set(originalPath, { panel, snapshotPath, revisionsPath });

        panel.webview.html = this.getHtml(snapshotPath, panel);

        // Handle messages from the WebView
        panel.webview.onDidReceiveMessage(
            msg => this.handleMessage(msg, originalPath),
            undefined,
            this.context.subscriptions,
        );

        // Keep AnnotationStore synced with the active tab
        panel.onDidChangeViewState(e => {
            if (e.webviewPanel.active) {
                this.ensureStoreContext(originalPath);
            }
        });

        panel.onDidDispose(() => {
            this.panels.delete(originalPath);
        });

        // Make this the active context before sending updates
        this.ensureStoreContext(originalPath);

        // Send initial annotation highlights + history
        this.sendAnnotationUpdate(originalPath);
        this.sendHistoryUpdate(originalPath);
    }

    /** Refresh the webview content with a different snapshot file (for history navigation). */
    refreshContent(originalPath: string, snapshotPath: string): void {
        const ctx = this.panels.get(originalPath);
        if (!ctx) { return; }
        ctx.snapshotPath = snapshotPath;

        const content = fs.readFileSync(snapshotPath, 'utf-8');
        const lines = content.split('\n');
        const ext = path.extname(snapshotPath).toLowerCase();
        const isMarkdown = ext === '.md' || ext === '.markdown';
        const lang = EXT_TO_LANG[ext];

        let bodyContent = '';
        if (isMarkdown) {
            bodyContent = this.renderMarkdownDocument(content, lines);
        } else if (lang && this.highlighter) {
            const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
                ? 'light-plus' : 'dark-plus';
            const tokens = this.highlighter.codeToTokensBase(content, { lang: lang as BundledLanguage, theme });
            for (let i = 0; i < tokens.length; i++) {
                const lineNum = i + 1;
                const lineTokens = tokens[i];
                const highlightedLine = lineTokens.map(token => {
                    const escaped = this.escapeHtml(token.content);
                    return token.color
                        ? `<span style="color:${token.color}">${escaped}</span>`
                        : escaped;
                }).join('');
                bodyContent += this.lineTemplate(lineNum, highlightedLine || '&nbsp;');
            }
        } else {
            for (let i = 0; i < lines.length; i++) {
                const lineNum = i + 1;
                const escaped = this.escapeHtml(lines[i]) || '&nbsp;';
                bodyContent += this.lineTemplate(lineNum, escaped);
            }
        }

        // Make sure we update the specific panel
        this.ensureStoreContext(originalPath);
        ctx.panel.webview.postMessage({ type: 'replaceContent', html: bodyContent });
        this.sendAnnotationUpdate(originalPath);
        this.sendHistoryUpdate(originalPath);
    }

    /** Close a given panel or all if not specified. */
    close(originalPath?: string): void {
        if (originalPath) {
            this.panels.get(originalPath)?.panel.dispose();
            this.panels.delete(originalPath);
        } else {
            for (const ctx of this.panels.values()) {
                ctx.panel.dispose();
            }
            this.panels.clear();
        }
    }

    isOpen(originalPath: string): boolean {
        return this.panels.has(originalPath);
    }

    /** Scroll the WebView to a specific line. */
    scrollToLine(originalPath: string, line: number): void {
        this.panels.get(originalPath)?.panel.webview.postMessage({ type: 'scrollToLine', line });
    }

    postMessageToPanel(originalPath: string, message: any): void {
        this.panels.get(originalPath)?.panel.webview.postMessage(message);
    }

    /** Generate the full HTML for the WebView. */
    private getHtml(snapshotPath: string, panel: vscode.WebviewPanel): string {
        const content = fs.readFileSync(snapshotPath, 'utf-8');
        const lines = content.split('\n');
        const ext = path.extname(snapshotPath).toLowerCase();
        const isMarkdown = ext === '.md' || ext === '.markdown';
        const lang = EXT_TO_LANG[ext];

        // Resolve media URIs for the WebView
        const cssUri = panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'review.css'))
        );
        const codiconCssUri = panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'codicon.css'))
        );
        const jsUri = panel.webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'review.js'))
        );

        let bodyContent = '';
        if (isMarkdown) {
            bodyContent = this.renderMarkdownDocument(content, lines);
        } else if (lang && this.highlighter) {
            // Syntax-highlighted code using Shiki (VS Code TextMate grammars)
            const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
                ? 'light-plus' : 'dark-plus';
            const tokens = this.highlighter.codeToTokensBase(content, { lang: lang as BundledLanguage, theme });
            for (let i = 0; i < tokens.length; i++) {
                const lineNum = i + 1;
                const lineTokens = tokens[i];
                const highlightedLine = lineTokens.map(token => {
                    const escaped = this.escapeHtml(token.content);
                    return token.color
                        ? `<span style="color:${token.color}">${escaped}</span>`
                        : escaped;
                }).join('');
                bodyContent += this.lineTemplate(lineNum, highlightedLine || '&nbsp;');
            }
        } else {
            // Plain text fallback
            for (let i = 0; i < lines.length; i++) {
                const lineNum = i + 1;
                const escaped = this.escapeHtml(lines[i]) || '&nbsp;';
                bodyContent += this.lineTemplate(lineNum, escaped);
            }
        }

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${codiconCssUri}">
    <link rel="stylesheet" href="${cssUri}">
    <title>Review Mode</title>
</head>
<body class="${isMarkdown ? 'markdown-content' : 'plaintext-content'}">
    <div class="review-layout">
        <div class="code-pane">
            ${bodyContent}
        </div>
        <div class="comments-pane">
            <div class="pane-tabs">
                <button class="pane-tab active" data-tab="comments">Comments</button>
                <button class="pane-tab" data-tab="history">History</button>
            </div>
            <div class="secondary-toolbar">
                <div class="toolbar-group">
                    <label class="toolbar-label">Diff</label>
                    <button class="toolbar-toggle" id="diff-mode-toggle" data-enabled="false">OFF</button>
                </div>
                <div class="toolbar-group">
                    <div class="toolbar-segmented">
                        <button class="toolbar-seg-btn active" id="history-mode-local">Local</button>
                        <button class="toolbar-seg-btn disabled" id="history-mode-git" title="Git diffs will be available in a future update." disabled>Git</button>
                    </div>
                </div>
            </div>
            <div id="comments-pane-content" class="tab-content active">
                <div class="comments-empty">No comments yet.<br>Click + on a line to add one.</div>
            </div>
            <div id="history-pane-content" class="tab-content">
                <!-- Populated by JS -->
            </div>
        </div>
    </div>
    <script src="${jsUri}"></script>
</body>
</html>`;
    }

    /** Detect YAML frontmatter (--- delimited) and return parsed data + body start line + todo line mappings. */
    private parseFrontmatter(sourceLines: string[]): {
        frontmatter: any | null;
        bodyStartIndex: number;
        todoLineRanges: Array<{ startLine: number; endLine: number }>;
    } {
        if (sourceLines.length === 0 || sourceLines[0].trim() !== '---') {
            return { frontmatter: null, bodyStartIndex: 0, todoLineRanges: [] };
        }

        // Find closing ---
        let closingIndex = -1;
        for (let i = 1; i < sourceLines.length; i++) {
            if (sourceLines[i].trim() === '---') {
                closingIndex = i;
                break;
            }
        }

        if (closingIndex === -1) {
            return { frontmatter: null, bodyStartIndex: 0, todoLineRanges: [] };
        }

        const yamlContent = sourceLines.slice(1, closingIndex).join('\n');
        try {
            const parsed = parseYaml(yamlContent);

            // Find line ranges for each todo entry within the frontmatter.
            // Todo list items start with `  - ` (a YAML sequence entry under `todos:`).
            const todoLineRanges: Array<{ startLine: number; endLine: number }> = [];
            if (parsed?.todos && Array.isArray(parsed.todos)) {
                // Scan frontmatter lines (between the --- delimiters) for list entries
                // under the todos key. Each `  - ` at the todos indent level starts a new todo.
                const fmStart = 1; // first line after opening ---
                let inTodos = false;
                let todosIndent = -1;
                let currentTodoStart = -1;

                for (let li = fmStart; li < closingIndex; li++) {
                    const line = sourceLines[li];
                    const trimmed = line.trimStart();
                    const indent = line.length - trimmed.length;

                    // Detect the `todos:` key
                    if (trimmed.startsWith('todos:')) {
                        inTodos = true;
                        todosIndent = indent;
                        continue;
                    }

                    // If we're past the todos block (another top-level key)
                    if (inTodos && indent <= todosIndent && trimmed.length > 0 && !trimmed.startsWith('-')) {
                        // Close last open todo
                        if (currentTodoStart !== -1) {
                            todoLineRanges.push({ startLine: currentTodoStart + 1, endLine: li });
                            currentTodoStart = -1;
                        }
                        inTodos = false;
                        continue;
                    }

                    if (inTodos && trimmed.startsWith('- ')) {
                        // Close previous todo entry
                        if (currentTodoStart !== -1) {
                            todoLineRanges.push({ startLine: currentTodoStart + 1, endLine: li });
                        }
                        currentTodoStart = li;
                    }
                }
                // Close final todo entry
                if (currentTodoStart !== -1) {
                    todoLineRanges.push({ startLine: currentTodoStart + 1, endLine: closingIndex });
                }
            }

            return { frontmatter: parsed, bodyStartIndex: closingIndex + 1, todoLineRanges };
        } catch {
            return { frontmatter: null, bodyStartIndex: 0, todoLineRanges: [] };
        }
    }

    /** Render the interactive todos section from frontmatter data with annotatable line containers. */
    private renderTodosSection(
        todos: Array<{ id?: string; content: string; status?: string }>,
        todoLineRanges: Array<{ startLine: number; endLine: number }>,
    ): string {
        const count = todos.length;
        let html = `<div class="todos-section">
    <div class="todos-header">
        <span class="todos-count">${count} To-do${count !== 1 ? 's' : ''}</span>
    </div>
    <div class="todos-list">\n`;

        for (let ti = 0; ti < todos.length; ti++) {
            const todo = todos[ti];
            const isDone = todo.status === 'done' || todo.status === 'completed';
            const escapedContent = this.escapeHtml(todo.content);
            // Map to source line if available
            const lineRange = todoLineRanges[ti];
            const dataLine = lineRange ? lineRange.startLine : 0;
            const dataEndLine = lineRange ? lineRange.endLine : dataLine;

            html += `<div class="line-container todo-item${isDone ? ' todo-done' : ''}" data-line="${dataLine}" data-end-line="${dataEndLine}">
    <div class="line-gutter">
        <span class="line-number">${dataLine}</span>
        <button class="add-note-btn" data-line="${dataLine}" title="Add comment"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9h-3.5L8 12.5 5.5 10H2V2h12v8z"/><path d="M7.25 4v2.25H5v1.5h2.25V10h1.5V7.75H11v-1.5H8.75V4z"/></svg></button>
    </div>
    <div class="line-content todo-content">
        <span class="todo-checkbox${isDone ? ' checked' : ''}"></span>
        <span class="todo-text">${escapedContent}</span>
    </div>
</div>\n`;
        }

        html += `    </div>\n</div>\n`;
        return html;
    }

    /** Render full markdown as a document, grouping source lines into blocks with annotation anchors. */
    private renderMarkdownDocument(content: string, sourceLines: string[]): string {
        // Detect and parse YAML frontmatter
        const { frontmatter, bodyStartIndex, todoLineRanges } = this.parseFrontmatter(sourceLines);
        const todos: Array<{ id?: string; content: string; status?: string }> | null =
            frontmatter?.todos && Array.isArray(frontmatter.todos) ? frontmatter.todos : null;

        // Build a mapping: for each source line, determine if it starts a block.
        // We wrap each source-line-range in a line-container for annotation + "+" button.
        // Lines that should be their own block: headings, list items, empty lines.
        // Lines that group: table rows, continuation paragraphs.
        const isListItem = (line: string) => /^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line);
        const isHeading = (line: string) => /^#{1,6}\s/.test(line);

        const blocks: { startLine: number; endLine: number; isFrontmatter: boolean }[] = [];
        let i = 0;

        // If we have frontmatter, group all frontmatter lines as hidden blocks
        if (bodyStartIndex > 0) {
            // Each frontmatter line gets its own hidden block (preserving line numbers for annotations)
            for (let fi = 0; fi < bodyStartIndex; fi++) {
                blocks.push({ startLine: fi + 1, endLine: fi + 1, isFrontmatter: true });
            }
            i = bodyStartIndex;
        }

        while (i < sourceLines.length) {
            const line = sourceLines[i];
            if (line.trim() === '') {
                // Empty line gets its own (collapsed) block
                blocks.push({ startLine: i + 1, endLine: i + 1, isFrontmatter: false });
                i++;
            } else if (isHeading(line) || isListItem(line)) {
                // Headings and list items are always their own block (individually annotatable)
                blocks.push({ startLine: i + 1, endLine: i + 1, isFrontmatter: false });
                i++;
            } else {
                // Non-empty, non-heading, non-list: accumulate consecutive lines as one block
                // (paragraphs, table rows, etc.)
                const start = i;
                i++;
                while (i < sourceLines.length && sourceLines[i].trim() !== '' && !isHeading(sourceLines[i]) && !isListItem(sourceLines[i])) {
                    i++;
                }
                blocks.push({ startLine: start + 1, endLine: i, isFrontmatter: false });
            }
        }

        // Now render each block: parse the block's source lines as markdown
        let result = '';
        for (const block of blocks) {
            // Frontmatter lines are rendered as hidden containers (still carry data-line for annotations)
            if (block.isFrontmatter) {
                result += `<div class="line-container frontmatter-line" data-line="${block.startLine}" style="display:none;">
    <div class="line-gutter">
        <span class="line-number">${block.startLine}</span>
    </div>
    <div class="line-content">&nbsp;</div>
</div>\n`;
                continue;
            }

            const blockLines = sourceLines.slice(block.startLine - 1, block.endLine);
            const blockText = blockLines.join('\n');

            if (blockText.trim() === '') {
                // Empty block — collapsed spacer
                result += `<div class="line-container empty-line" data-line="${block.startLine}">
    <div class="line-gutter">
        <span class="line-number">${block.startLine}</span>
        <button class="add-note-btn" data-line="${block.startLine}" title="Add comment"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9h-3.5L8 12.5 5.5 10H2V2h12v8z"/><path d="M7.25 4v2.25H5v1.5h2.25V10h1.5V7.75H11v-1.5H8.75V4z"/></svg></button>
    </div>
    <div class="line-content">&nbsp;</div>
</div>\n`;
            } else if (isListItem(blockText)) {
                // List item — render as proper <li> but strip the wrapping <ul>/<ol>
                // so spacing is controlled by our line-container, not list margins
                let renderedBlock = (marked.parse(blockText) as string).trim();
                // Strip outer <ul>...</ul> or <ol>...</ol> wrapper
                renderedBlock = renderedBlock
                    .replace(/^<[uo]l[^>]*>\n?/, '')
                    .replace(/\n?<\/[uo]l>$/, '');
                result += `<div class="line-container md-block md-list-item" data-line="${block.startLine}" data-end-line="${block.endLine}">
    <div class="line-gutter">
        <span class="line-number">${block.startLine}</span>
        <button class="add-note-btn" data-line="${block.startLine}" title="Add comment"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9h-3.5L8 12.5 5.5 10H2V2h12v8z"/><path d="M7.25 4v2.25H5v1.5h2.25V10h1.5V7.75H11v-1.5H8.75V4z"/></svg></button>
    </div>
    <div class="line-content">${renderedBlock}</div>
</div>\n`;
            } else {
                // Render this block as markdown
                let renderedBlock = (marked.parse(blockText) as string).trim();
                result += `<div class="line-container md-block" data-line="${block.startLine}" data-end-line="${block.endLine}">
    <div class="line-gutter">
        <span class="line-number">${block.startLine}</span>
        <button class="add-note-btn" data-line="${block.startLine}" title="Add comment"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9h-3.5L8 12.5 5.5 10H2V2h12v8z"/><path d="M7.25 4v2.25H5v1.5h2.25V10h1.5V7.75H11v-1.5H8.75V4z"/></svg></button>
    </div>
    <div class="line-content">${renderedBlock}</div>
</div>\n`;
            }
        }

        // Append todos section at the end if present in frontmatter
        if (todos && todos.length > 0) {
            result += this.renderTodosSection(todos, todoLineRanges);
        }

        return result;
    }

    /** Template for a single line with gutter and "+" button. */
    private lineTemplate(lineNum: number, content: string): string {
        return `<div class="line-container" data-line="${lineNum}">
    <div class="line-gutter">
        <span class="line-number">${lineNum}</span>
        <button class="add-note-btn" data-line="${lineNum}" title="Add comment"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 1H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3l3 3 3-3h3a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1zm0 9h-3.5L8 12.5 5.5 10H2V2h12v8z"/><path d="M7.25 4v2.25H5v1.5h2.25V10h1.5V7.75H11v-1.5H8.75V4z"/></svg></button>
    </div>
    <div class="line-content">${content}</div>
</div>\n`;
    }

    /** Send current annotations to the WebView for highlighting (includes full thread data for comments pane). */
    private sendAnnotationUpdate(originalPath?: string): void {
        // If no originalPath provided, broadcast to all panels (triggered by store change)
        if (!originalPath) {
            for (const key of this.panels.keys()) {
                this.sendAnnotationUpdate(key);
            }
            return;
        }

        const ctx = this.panels.get(originalPath);
        if (!ctx) { return; }

        // Ensure store actually matches before updating the panel UI
        if (this.activeRevisionsPath !== ctx.revisionsPath) { return; }

        ctx.panel.webview.postMessage({
            type: 'updateAnnotations',
            annotations: this.store.getAnnotations().map(a => ({
                id: a.id,
                startLine: a.startLine,
                endLine: a.endLine,
                priority: a.priority || 'none',
                status: a.status || 'open',
                deletedLine: a.deletedLine || false,
                threadCount: a.thread.length,
                thread: a.thread.map(m => ({
                    id: m.id,
                    text: m.text,
                    createdAt: m.createdAt,
                })),
            })),
        });
    }

    /** Handle messages received from the WebView. */
    private handleMessage(msg: any, originalPath: string): void {
        const ctx = this.panels.get(originalPath);
        if (!ctx) return;

        this.ensureStoreContext(originalPath);

        switch (msg.type) {
            case 'addNote': {
                const content = fs.readFileSync(ctx.snapshotPath, 'utf-8');
                const lines = content.split('\n');
                const previewLine = lines[msg.startLine - 1]?.trim() || '';
                const annotation = this.store.addAnnotation(msg.startLine, msg.endLine, previewLine, msg.text);
                const isNewAnnotation = annotation.thread.length === 1;
                if (isNewAnnotation && msg.previousVersionContext && msg.currentVersionContext) {
                    annotation.previousVersionContext = msg.previousVersionContext;
                    annotation.currentVersionContext = msg.currentVersionContext;
                    this.store.saveAfterContextUpdate();
                }
                break;
            }
            case 'reply': {
                this.store.addMessage(msg.annotationId, msg.text);
                break;
            }
            case 'deleteThread': {
                this.store.deleteAnnotation(msg.annotationId);
                break;
            }
            case 'deleteMessage': {
                this.store.deleteMessage(msg.annotationId, msg.messageId);
                break;
            }
            case 'setPriority': {
                this.store.setPriority(msg.annotationId, msg.priority);
                break;
            }
            case 'setStatus': {
                this.store.setStatus(msg.annotationId, msg.status);
                break;
            }
            case 'openRevision': {
                this.onRevisionRequested?.(originalPath, msg.revision);
                break;
            }
            case 'toggleDiffMode': {
                this.onDiffModeToggled?.(originalPath, !!msg.enabled);
                break;
            }
            case 'pinVersion': {
                this.onPinVersion?.(originalPath, msg.revision);
                break;
            }
        }
    }

    /** Send history revision list to the webview. */
    private sendHistoryUpdate(originalPath?: string): void {
        if (!originalPath) {
            for (const key of this.panels.keys()) {
                this.sendHistoryUpdate(key);
            }
            return;
        }

        const ctx = this.panels.get(originalPath);
        if (!ctx) { return; }

        // Ensure store actually matches
        if (this.activeRevisionsPath !== ctx.revisionsPath) { return; }

        ctx.panel.webview.postMessage({
            type: 'updateHistory',
            revisions: this.store.getRevisions().map(r => ({
                revision: r.revision,
                createdAt: r.createdAt,
                annotationCount: this.store.getAnnotationCountForRevision(r.revision),
                addressedCount: this.store.getAddressedAnnotationCountForRevision(r.revision),
                totalCount: this.store.getTotalAnnotationCountForRevision(r.revision),
            })),
            currentRevision: this.store.getCurrentRevision(),
        });
    }

    /** Make sure AnnotationStore is loaded with the data for the given file. */
    private ensureStoreContext(originalPath: string): void {
        const ctx = this.panels.get(originalPath);
        if (!ctx) return;

        if (this.activeRevisionsPath !== ctx.revisionsPath) {
            this.activeRevisionsPath = ctx.revisionsPath;
            this.store.load(ctx.revisionsPath);
        }
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}
