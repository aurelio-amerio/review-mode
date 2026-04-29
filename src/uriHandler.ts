import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Handles URIs of the form:
 *   vscode://review-mode/open?path=<absolute-or-relative-path>
 *
 * Relative paths are resolved against the first open workspace folder.
 */
export class ReviewModeUriHandler implements vscode.UriHandler {
    async handleUri(uri: vscode.Uri): Promise<void> {
        // Only handle /open
        if (uri.path !== '/open') {
            vscode.window.showErrorMessage(
                `Review Mode: unknown URI path "${uri.path}". Expected /open.`,
            );
            return;
        }

        const params = new URLSearchParams(uri.query);
        const rawPath = params.get('path');

        if (!rawPath) {
            vscode.window.showErrorMessage(
                'Review Mode: missing "path" query parameter.',
            );
            return;
        }

        // Resolve the file path (support both absolute and relative)
        const filePath = resolveFilePath(rawPath);
        if (!filePath) {
            vscode.window.showErrorMessage(
                `Review Mode: could not resolve relative path "${rawPath}". Open a workspace first or use an absolute path.`,
            );
            return;
        }

        // Validate file exists
        if (!fs.existsSync(filePath)) {
            vscode.window.showErrorMessage(
                `Review Mode: file not found — ${filePath}`,
            );
            return;
        }

        // Validate it's a markdown file
        if (path.extname(filePath).toLowerCase() !== '.md') {
            vscode.window.showErrorMessage(
                'Review Mode: only Markdown (.md) files are supported.',
            );
            return;
        }

        // Open the file, then trigger review mode
        const fileUri = vscode.Uri.file(filePath);
        await vscode.commands.executeCommand('reviewMode.open', fileUri);
    }
}

/**
 * Resolve a raw path string to an absolute path.
 * If the path is already absolute, returns it directly.
 * If relative, resolves against the first workspace folder.
 * Returns undefined if the path is relative and no workspace is open.
 */
function resolveFilePath(rawPath: string): string | undefined {
    // Normalise forward/back slashes
    const normalised = rawPath.replace(/\//g, path.sep);

    if (path.isAbsolute(normalised)) {
        return normalised;
    }

    // Relative path — resolve against workspace root
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }

    return path.resolve(folders[0].uri.fsPath, normalised);
}
