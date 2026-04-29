import * as vscode from 'vscode';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Security: strict allowlist of commands that can be triggered via directives
// ---------------------------------------------------------------------------

const ALLOWED_COMMANDS = new Set(['reviewMode.open']);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How often (ms) the polling fallback scans for missed directive files. */
const POLL_INTERVAL_MS = 2_000;

/** Relative path from a workspace folder root to the directives directory. */
const DIRECTIVES_REL = '.revisions/.directives';

/** Glob for directive files relative to a workspace folder root. */
const DIRECTIVES_GLOB = `${DIRECTIVES_REL}/*.json`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UiDirective {
    _ui_directive: true;
    command_id: string;
    args: unknown[];
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

let _channel: vscode.OutputChannel | undefined;

function log(msg: string): void {
    if (!_channel) {
        _channel = vscode.window.createOutputChannel('Review Mode');
    }
    _channel.appendLine(`[DirectiveWatcher] ${msg}`);
}

// ---------------------------------------------------------------------------
// Deduplication — prevents double-processing when both the native watcher
// and the polling fallback pick up the same file.
// ---------------------------------------------------------------------------

const _processing = new Set<string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start watching all workspace folders for MCP directive files written to
 * `.revisions/.directives/*.json` by the review-mode-mcp server.
 *
 * The implementation uses two complementary strategies:
 *   1. **Native watcher** — one `RelativePattern`-based `FileSystemWatcher`
 *      per workspace folder, anchored to the correct remote filesystem.
 *   2. **Polling fallback** — a lightweight `setInterval` scan that catches
 *      directives missed by `inotify` (WSL edge cases, handle exhaustion…).
 *
 * When a directive file appears the watcher:
 *   1. Reads and validates the JSON payload
 *   2. Checks the command against the allowlist
 *   3. Executes the VS Code command via the native API
 *   4. Deletes the directive file (always, even on error)
 *
 * Returns a Disposable that tears down all watchers, timers, and listeners.
 */
export function startDirectiveWatcher(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];

    // --- Per-folder native watchers ---
    const folderWatchers = new Map<string, vscode.Disposable>();

    function addFolderWatcher(folder: vscode.WorkspaceFolder): void {
        const pattern = new vscode.RelativePattern(folder, DIRECTIVES_GLOB);
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);
        log(`Registered native watcher for folder: ${folder.uri.fsPath} (pattern: ${DIRECTIVES_GLOB})`);

        watcher.onDidCreate(async (uri) => {
            log(`onDidCreate fired: ${uri.fsPath}`);
            await safeProcessAndDelete(uri);
        });

        folderWatchers.set(folder.uri.toString(), watcher);
    }

    function removeFolderWatcher(folder: vscode.WorkspaceFolder): void {
        const key = folder.uri.toString();
        const watcher = folderWatchers.get(key);
        if (watcher) {
            watcher.dispose();
            folderWatchers.delete(key);
            log(`Removed native watcher for folder: ${folder.uri.fsPath}`);
        }
    }

    // Register watchers for all current workspace folders
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        addFolderWatcher(folder);
    }

    // React to workspace folders being added / removed at runtime
    const folderListener = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        for (const added of e.added) { addFolderWatcher(added); }
        for (const removed of e.removed) { removeFolderWatcher(removed); }
    });
    disposables.push(folderListener);

    // --- Initial scan (catch files created before the watcher was ready) ---
    scanAndProcessAll();

    // --- Polling fallback ---
    const timer = setInterval(() => { scanAndProcessAll(); }, POLL_INTERVAL_MS);
    disposables.push({ dispose: () => clearInterval(timer) });

    // --- Composite disposable ---
    return {
        dispose() {
            for (const d of disposables) { d.dispose(); }
            for (const w of folderWatchers.values()) { w.dispose(); }
            folderWatchers.clear();
            log('Directive watcher disposed.');
        },
    };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Scan all workspace folders for leftover directive files and process them.
 * Used both for the initial catch-up scan and as the polling fallback.
 */
async function scanAndProcessAll(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const pattern = new vscode.RelativePattern(folder, DIRECTIVES_GLOB);
        let uris: vscode.Uri[];
        try {
            uris = await vscode.workspace.findFiles(pattern);
        } catch {
            // findFiles can throw if the folder disappeared between iterations
            continue;
        }
        for (const uri of uris) {
            await safeProcessAndDelete(uri);
        }
    }
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

/**
 * Process a single directive file and delete it afterwards.
 * Guarded by the deduplication set so concurrent calls for the same URI
 * (native watcher + poll) don't double-fire.
 */
async function safeProcessAndDelete(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (_processing.has(key)) { return; }
    _processing.add(key);

    try {
        await processDirective(uri);
    } catch (err: any) {
        vscode.window.showErrorMessage(
            `Review Mode directive error: ${err?.message ?? String(err)}`,
        );
        log(`Error processing ${uri.fsPath}: ${err?.message ?? String(err)}`);
    } finally {
        // Always delete the directive file to prevent reprocessing
        try {
            await vscode.workspace.fs.delete(uri);
            log(`Deleted directive file: ${uri.fsPath}`);
        } catch {
            // Best-effort — file may have already been deleted
        }
        _processing.delete(key);
    }
}

async function processDirective(uri: vscode.Uri): Promise<void> {
    // --- Read (using VS Code's remote-aware filesystem API) ---
    let raw: string;
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        raw = new TextDecoder('utf-8').decode(bytes);
    } catch (err: any) {
        vscode.window.showErrorMessage(
            `Review Mode: could not read directive file — ${err?.message}`,
        );
        return;
    }

    // --- Parse ---
    let directive: UiDirective;
    try {
        directive = JSON.parse(raw);
    } catch {
        vscode.window.showErrorMessage(
            'Review Mode: malformed directive file (invalid JSON).',
        );
        return;
    }

    // --- Validate schema ---
    if (
        directive._ui_directive !== true ||
        typeof directive.command_id !== 'string' ||
        !directive.command_id ||
        !Array.isArray(directive.args)
    ) {
        vscode.window.showErrorMessage('Review Mode: invalid directive schema.');
        return;
    }

    // --- Allowlist check ---
    if (!ALLOWED_COMMANDS.has(directive.command_id)) {
        vscode.window.showErrorMessage(
            `Review Mode: command "${directive.command_id}" is not in the allowed command list.`,
        );
        return;
    }

    log(`Processing directive: ${directive.command_id} with args: ${JSON.stringify(directive.args)}`);

    // --- Execute: reviewMode.open ---
    if (directive.command_id === 'reviewMode.open') {
        await executeOpenReview(directive.args);
    }
}

// ---------------------------------------------------------------------------
// Command executors
// ---------------------------------------------------------------------------

async function executeOpenReview(args: unknown[]): Promise<void> {
    const rawPath = args[0];

    if (typeof rawPath !== 'string' || !rawPath) {
        vscode.window.showErrorMessage(
            'Review Mode: directive missing file path argument.',
        );
        return;
    }

    // Resolve absolute or workspace-relative path
    const resolved = path.isAbsolute(rawPath)
        ? rawPath.replace(/\//g, path.sep) // normalise separators on Windows
        : resolveRelative(rawPath);

    if (!resolved) {
        vscode.window.showErrorMessage(
            `Review Mode: cannot resolve path "${rawPath}". Open a workspace first or use an absolute path.`,
        );
        return;
    }

    // Check existence using the remote-aware VS Code filesystem API
    const fileUri = vscode.Uri.file(resolved);
    try {
        await vscode.workspace.fs.stat(fileUri);
    } catch {
        vscode.window.showErrorMessage(
            `Review Mode: file not found — ${resolved}`,
        );
        return;
    }

    if (path.extname(resolved).toLowerCase() !== '.md') {
        vscode.window.showErrorMessage(
            `Review Mode: only Markdown (.md) files are supported (got "${path.extname(resolved)}").`,
        );
        return;
    }

    try {
        await vscode.commands.executeCommand('reviewMode.open', fileUri);
        log(`Opened file in Review Mode: ${resolved}`);
    } catch (err: any) {
        vscode.window.showErrorMessage(
            `Review Mode: failed to open file in Review Mode — ${err?.message ?? String(err)}`,
        );
    }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function resolveRelative(rawPath: string): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    return path.resolve(folders[0].uri.fsPath, rawPath);
}
