import * as vscode from 'vscode';

/**
 * Registers the Review Mode chat participant.
 *
 * Users can invoke it in the chat panel with:
 *   @review-mode /review <optional path or prompt>
 *
 * The /review command opens the currently active file (or a specified file)
 * in Review Mode.
 */
export function registerChatParticipant(context: vscode.ExtensionContext): void {
    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ) => {
        if (request.command === 'review') {
            return handleReviewCommand(request, stream, token);
        }

        // Default: explain what this participant can do
        stream.markdown(
            'I can open files in **Review Mode** with threaded annotations.\n\n' +
            'Use `/review` to open the active editor file, or provide a file path:\n\n' +
            '```\n@review-mode /review path/to/file\n```',
        );
        return { metadata: { command: '' } };
    };

    const participant = vscode.chat.createChatParticipant(
        'review-mode.reviewer',
        handler,
    );

    participant.iconPath = new vscode.ThemeIcon('comment-discussion');

    context.subscriptions.push(participant);
}

// ── /review command handler ─────────────────────────────────────────

interface ReviewChatResult extends vscode.ChatResult {
    metadata: { command: string };
}

async function handleReviewCommand(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken,
): Promise<ReviewChatResult> {
    const prompt = request.prompt.trim();

    // If the user provided a file path in the prompt, try to resolve it
    if (prompt) {
        const uri = resolveFileUri(prompt);
        if (uri) {
            stream.progress('Opening file in Review Mode…');
            try {
                await vscode.commands.executeCommand('reviewMode.open', uri);
                stream.markdown(`✅ Opened **${vscode.workspace.asRelativePath(uri)}** in Review Mode.`);
            } catch (err: any) {
                stream.markdown(`❌ Failed to open file: ${err?.message ?? err}`);
            }
            return { metadata: { command: 'review' } };
        }
    }

    // No path provided — use the active editor
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        stream.markdown(
            '⚠️ No file is currently open in the editor.\n\n' +
            'Open a file first, or provide a path:\n' +
            '```\n@review-mode /review path/to/file\n```',
        );
        return { metadata: { command: 'review' } };
    }

    const fileUri = editor.document.uri;

    stream.progress('Opening in Review Mode…');
    try {
        await vscode.commands.executeCommand('reviewMode.open', fileUri);
        stream.markdown(`✅ Opened **${vscode.workspace.asRelativePath(fileUri)}** in Review Mode.`);
    } catch (err: any) {
        stream.markdown(`❌ Failed to open file: ${err?.message ?? err}`);
    }

    return { metadata: { command: 'review' } };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Try to resolve a user-supplied string to a file URI.
 * Supports absolute paths and workspace-relative paths.
 */
function resolveFileUri(input: string): vscode.Uri | undefined {
    // Strip surrounding quotes if present
    const cleaned = input.replace(/^["']|["']$/g, '');

    // Absolute path
    if (cleaned.match(/^[a-zA-Z]:[\\/]/) || cleaned.startsWith('/')) {
        return vscode.Uri.file(cleaned);
    }

    // Workspace-relative path
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        const candidate = vscode.Uri.joinPath(folders[0].uri, cleaned);
        return candidate;
    }

    return undefined;
}
