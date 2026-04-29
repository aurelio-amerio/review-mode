import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AnnotationStore } from './annotationStore';
import { ReviewWebviewPanel } from './webviewPanel';
import { migrateAnnotations } from './diffUtils';

export class ReviewModeController {
    private webview: ReviewWebviewPanel;
    private plansDir: string = '';
    private revisionsPath: string = '';

    constructor(
        private store: AnnotationStore,
        private context: vscode.ExtensionContext,
    ) {
        this.webview = new ReviewWebviewPanel(context, store);
        this.webview.onRevisionRequested = (originalPath: string, revision: number) => this.openRevision(originalPath, revision);
    }

    /** Open the active file in review mode. */
    async open(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active file to review.');
            return;
        }

        const originalUri = editor.document.uri;
        const originalDir = path.dirname(originalUri.fsPath);
        const fileName = path.basename(originalUri.fsPath);
        const baseName = path.basename(fileName, path.extname(fileName));

        // Determine workspace root (fallback to file director if not in a workspace)
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(originalUri);
        const rootPath = workspaceFolder ? workspaceFolder.uri.fsPath : originalDir;

        // Generate a flat folder name from the relative path: src/utils/test.md -> src_utils_test_md
        const relativePath = path.relative(rootPath, originalUri.fsPath);
        const folderName = relativePath.replace(/[\\/.]/g, '_');

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

            // Save sourceFile as a workspace-relative path instead of plansDir-relative
            const workspaceRelativeSource = relativePath.replace(/\\/g, '/');
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

        // Close the original editor
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

        // Open the WebView with the latest snapshot
        await this.webview.show(originalUri.fsPath, snapshotPath, revisionsPath, fileName);

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

    isActive(): boolean {
        // If any panel is open
        // Wait, webview.isOpen() requires tracking something...
        // Let's assume isActive means whether the current store file is open.
        // Actually, if we have active panels, then it's active.
        return this.store.getOriginalPath() !== '';
    }
}
