import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AnnotationStore } from './annotationStore';
import { ReviewWebviewPanel } from './webviewPanel';
import { migrateAnnotations } from './diffUtils';
import {
    isGitRepo,
    getGitRepoRoot,
    getGitRelativePath,
    getGitHistory,
    getGitFileContent,
    hasUncommittedChanges,
} from './gitUtils';

export class ReviewModeController {
    private webview: ReviewWebviewPanel;
    private plansDir: string = '';
    private revisionsPath: string = '';
    private diffModeEnabled: boolean = false;
    private pinnedRevision: number = -1;
    private historyMode: 'local' | 'git' = 'local';
    private pinnedCommitHash: string | null = null;
    private gitPage: number = 0;
    private readonly gitPageSize: number = 20;
    private isGitAvailable: boolean = false;
    private gitRepoRoot: string = '';
    private gitRelPath: string = '';

    constructor(
        private store: AnnotationStore,
        private context: vscode.ExtensionContext,
    ) {
        this.webview = new ReviewWebviewPanel(context, store);
        this.webview.onRevisionRequested = (originalPath: string, revision: number) => this.openRevision(originalPath, revision);
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

        this.webview.onPinVersion = (originalPath: string, revision: number) => {
            this.pinnedRevision = revision;
            this.sendDiffToWebview(originalPath);
        };

        this.webview.onRevertToPinnedDiff = (originalPath: string) => {
            // Re-send diff using the actual pinned revision (not a temporary preview)
            this.sendDiffToWebview(originalPath);
        };

        this.webview.onPreviewDiffBase = (originalPath: string, revision: number) => {
            // Temporarily show diff from this revision without changing the actual pin
            this.sendDiffToWebview(originalPath, revision);
        };

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
    }

    /** Open a file in review mode.
     *  @param fileUri  Optional URI of the file to review. If omitted, the active
     *         text editor is used.
     *  @param workspaceRootOverride  Optional workspace root path (e.g. from an MCP directive)
     *         used when the file lives outside the current workspace folders.
     */
    async open(fileUri?: vscode.Uri, workspaceRootOverride?: string): Promise<void> {
        let originalUri: vscode.Uri;
        let openedEditorForReview = false;

        if (fileUri) {
            originalUri = fileUri;
        } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active file to review.');
                return;
            }
            originalUri = editor.document.uri;
            openedEditorForReview = true;
        }

        const originalDir = path.dirname(originalUri.fsPath);
        const fileName = path.basename(originalUri.fsPath);
        const baseName = path.basename(fileName, path.extname(fileName));

        // Determine workspace root:
        // 1. If the file belongs to a workspace folder, use that
        // 2. Else if a workspace root override was provided (from MCP directive), use that
        // 3. Else use the first workspace folder
        // 4. Else fall back to the file's directory (solo file, no workspace)
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(originalUri);
        let rootPath: string;
        let isExternal = false;

        if (workspaceFolder) {
            rootPath = workspaceFolder.uri.fsPath;
        } else if (workspaceRootOverride) {
            rootPath = workspaceRootOverride;
            isExternal = true;
        } else if (vscode.workspace.workspaceFolders?.length) {
            rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            isExternal = true;
        } else {
            rootPath = originalDir;
        }

        // Compute folder name for .revisions/ storage:
        // - External files: deterministic hash-based name to avoid ugly "../" artifacts
        // - Internal files: workspace-relative path (preserves current behaviour)
        let folderName: string;
        let relativePath: string;

        if (isExternal) {
            const normalized = originalUri.fsPath.replace(/\\/g, '/').toLowerCase();
            const shortHash = crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 8);
            folderName = `${baseName}_${shortHash}`;
            relativePath = originalUri.fsPath; // absolute path — stored as sourceFile
        } else {
            relativePath = path.relative(rootPath, originalUri.fsPath);
            folderName = relativePath.replace(/[\\/.]/g, '_');
        }

        const revisionsDirName = vscode.workspace.getConfiguration('reviewMode').get<string>('revisionsDirectory', '.revisions');
        const plansRoot = path.join(rootPath, revisionsDirName);
        const plansDir = path.join(plansRoot, folderName);
        const revisionsPath = path.join(plansDir, 'revisions.json');

        // Ensure directory exists
        if (!fs.existsSync(plansDir)) {
            fs.mkdirSync(plansDir, { recursive: true });
        }

        let snapshotPath: string;

        if (!fs.existsSync(revisionsPath)) {
            // --- First time: create rev0 ---
            const snapshotName = `${baseName}.rev0${path.extname(fileName)}`;
            snapshotPath = path.join(plansDir, snapshotName);
            fs.copyFileSync(originalUri.fsPath, snapshotPath);

            // sourceFile: absolute for external files, workspace-relative for internal
            const workspaceRelativeSource = isExternal
                ? originalUri.fsPath.replace(/\\/g, '/')
                : relativePath.replace(/\\/g, '/');
            this.store.initNew(workspaceRelativeSource, revisionsPath, snapshotName, plansDir);
        } else {
            // --- Reopening: check for changes ---
            this.store.load(revisionsPath);
            const revisions = this.store.getRevisions();
            const latest = revisions[revisions.length - 1];
            const latestSnapshotPath = path.join(plansDir, latest.snapshotFile);

            const currentText = fs.readFileSync(originalUri.fsPath, 'utf-8');
            const snapshotText = fs.readFileSync(latestSnapshotPath, 'utf-8');

            if (currentText !== snapshotText) {
                // File changed — create new revision
                const nextRev = latest.revision + 1;
                const snapshotName = `${baseName}.rev${nextRev}${path.extname(fileName)}`;
                snapshotPath = path.join(plansDir, snapshotName);
                fs.copyFileSync(originalUri.fsPath, snapshotPath);

                // store.load() already loaded the latest revision into getAnnotations()
                const migratedAnnotations = migrateAnnotations(
                    [...this.store.getAnnotations()],
                    snapshotText,
                    currentText,
                );

                this.store.createRevision(snapshotName, migratedAnnotations);
            } else {
                // No changes — use latest snapshot as-is
                snapshotPath = latestSnapshotPath;
            }
        }

        // Close the original text editor (only if we opened one — skip when
        // the file URI was provided directly, e.g. from an MCP directive)
        if (openedEditorForReview) {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }

        // Open the WebView with the latest snapshot
        await this.webview.show(originalUri.fsPath, snapshotPath, revisionsPath, fileName);

        // Reset diff state
        this.diffModeEnabled = false;
        this.pinnedRevision = -1;

        // Reset git-mode state and detect git availability
        this.historyMode = 'local';
        this.pinnedCommitHash = null;
        this.gitPage = 0;
        this.gitRepoRoot = '';
        this.gitRelPath = '';
        this.isGitAvailable = await isGitRepo(originalUri.fsPath);
        if (this.isGitAvailable) {
            this.gitRepoRoot = await getGitRepoRoot(originalUri.fsPath);
            this.gitRelPath = await getGitRelativePath(originalUri.fsPath, this.gitRepoRoot);
        }
        this.webview.postMessageToPanel(originalUri.fsPath, {
            type: 'setGitAvailable',
            available: this.isGitAvailable,
        });

        // Set context for when-clauses
        await vscode.commands.executeCommand('setContext', 'reviewMode.active', true);
    }

    /** Switch to a historical revision snapshot. */
    openRevision(originalPath: string, revision: number): void {
        const revisions = this.store.getRevisions();
        if (revision < 0 || revision >= revisions.length) { return; }

        this.store.loadRevision(revision);
        const plansDir = this.store.getPlansDir();

        const snapshotPath = path.join(plansDir, revisions[revision].snapshotFile);
        this.webview.refreshContent(originalPath, snapshotPath);
    }

    /** Close review mode. */
    async close(): Promise<void> {
        // If we want to close all:
        this.webview.close();
        this.store.clear();
        await vscode.commands.executeCommand('setContext', 'reviewMode.active', false);
        vscode.window.showInformationMessage('Review mode closed.');
    }

    /** Scroll the WebView to a specific line. */
    scrollToLine(line: number): void {
        // We need to scroll the active one. Wait, which one is active?
        // Since Sidebar commands don't tell us WHICH file, we just scroll the current store's source file's panel if needed.
        // Or we could track active originalPath.
        // Actually, store has getPlansDir() which implies we can track it.
        const sourcePath = this.store.getOriginalPath();
        if (sourcePath) {
            this.webview.scrollToLine(sourcePath, line);
        }
    }

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

    isActive(): boolean {
        // If any panel is open
        // Wait, webview.isOpen() requires tracking something...
        // Let's assume isActive means whether the current store file is open.
        // Actually, if we have active panels, then it's active.
        return this.store.getOriginalPath() !== '';
    }
}
