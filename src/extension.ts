import * as vscode from 'vscode';
import { AnnotationStore } from './annotationStore';
import { registerChatParticipant } from './chatParticipant';
import { ReviewModeController } from './reviewMode';
import { SidebarProvider } from './sidebarProvider';
import { ReviewModeUriHandler } from './uriHandler';
import { ReviewedFilesProvider, ReviewedFileItem } from './reviewedFilesProvider';
import { startDirectiveWatcher } from './directiveWatcher';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
            const directivesPath = vscode.Uri.joinPath(folder.uri, '.revisions', '.directives').fsPath;
            if (!fs.existsSync(directivesPath)) {
                try {
                    fs.mkdirSync(directivesPath, { recursive: true });
                } catch (err) {
                    console.error(`Failed to create directives directory: ${err}`);
                }
            }
        }
    }

    const store = new AnnotationStore();
    const controller = new ReviewModeController(store, context);

    // --- URI handler (vscode://review-mode/open?path=...) ---
    context.subscriptions.push(
        vscode.window.registerUriHandler(new ReviewModeUriHandler()),
    );

    // --- Chat participant (@review-mode /review) ---
    registerChatParticipant(context);

    // --- Core commands ---
    context.subscriptions.push(
        vscode.commands.registerCommand('reviewMode.open', async (uri?: vscode.Uri) => {
            if (uri) {
                await vscode.window.showTextDocument(uri);
            }
            await controller.open();
        }),
        vscode.commands.registerCommand('reviewMode.close', () => controller.close()),
    );

    // --- Sidebar ---
    const sidebarProvider = new SidebarProvider(store);
    const treeView = vscode.window.createTreeView('reviewModeAnnotations', {
        treeDataProvider: sidebarProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // --- Scroll to line (from sidebar click) ---
    context.subscriptions.push(
        vscode.commands.registerCommand('reviewMode.scrollToLine', (line: number) => {
            controller.scrollToLine(line);
        }),
    );

    // --- Reply command ---
    context.subscriptions.push(
        vscode.commands.registerCommand('reviewMode.reply', async (item: any) => {
            const annotationId = item?.annotation?.id || item;
            const text = await vscode.window.showInputBox({
                prompt: 'Reply to this thread',
                placeHolder: 'Type your reply...',
            });
            if (!text) { return; }
            store.addMessage(annotationId, text);
        }),
    );

    // --- Delete message ---
    context.subscriptions.push(
        vscode.commands.registerCommand('reviewMode.deleteMessage', (item: any) => {
            store.deleteMessage(item.annotationId, item.message.id);
        }),
    );

    // --- Delete thread ---
    context.subscriptions.push(
        vscode.commands.registerCommand('reviewMode.deleteThread', (item: any) => {
            store.deleteAnnotation(item.annotation.id);
        }),
    );

    // --- Activity Bar Review Files ---
    const reviewedFilesProvider = new ReviewedFilesProvider();
    const reviewModeFilesView = vscode.window.createTreeView('reviewModeFiles', {
        treeDataProvider: reviewedFilesProvider,
        showCollapseAll: false,
    });
    context.subscriptions.push(reviewModeFilesView);

    context.subscriptions.push(
        vscode.commands.registerCommand('reviewMode.refreshFiles', () => {
            reviewedFilesProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('reviewMode.deleteReviews', async (item: ReviewedFileItem) => {
            if (!item || !item.revisionsDirPath) { return; }
            const answer = await vscode.window.showWarningMessage(
                `Are you sure you want to delete all reviews for ${item.label}?`,
                { modal: true },
                'Yes'
            );
            if (answer !== 'Yes') { return; }

            try {
                fs.rmSync(item.revisionsDirPath, { recursive: true, force: true });
                vscode.window.showInformationMessage(`Deleted all reviews for ${item.label}.`);
                reviewedFilesProvider.refresh();

                // Also close review mode if currently active and deleting this file
                if (controller.isActive() && store.getSourceFile() === item.sourcePath) {
                    controller.close();
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to delete reviews: ${err.message}`);
            }
        })
    );

    // --- Add Note (from command palette, uses active editor selection) ---
    context.subscriptions.push(
        vscode.commands.registerCommand('reviewMode.addNote', async () => {
            if (!controller.isActive()) { return; }
            const text = await vscode.window.showInputBox({
                prompt: 'Add a review note',
                placeHolder: 'Type your comment...',
            });
            if (!text) { return; }
            // This is a fallback; primary path is via WebView "+" button
            vscode.window.showInformationMessage('Use the + button in the review panel to add notes to specific lines.');
        }),
    );

    // --- MCP directive watcher (remote-safe UI triggers from review-mode-mcp) ---
    context.subscriptions.push(startDirectiveWatcher());
}

export function deactivate() { }
