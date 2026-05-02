/**
 * VS Code Copilot MCP Server registration for Review Mode.
 *
 * Registers the external `review-mode-mcp` Python binary (installed via
 * `uv tool install review-mode-mcp`) as an MCP server for VS Code Copilot
 * Agent Mode using the proposed `vscode.lm.registerMcpServerDefinitionProvider`
 * API.
 *
 * Cursor users have the MCP server configured through the static mcp.json
 * bundled inside the Cursor plugin directory — no registration needed here.
 */

import * as vscode from 'vscode';

const PROVIDER_ID = 'reviewModeMcp';

/**
 * Register the external `review-mode-mcp` binary as an MCP server for
 * VS Code Copilot Agent Mode.  Returns a Disposable that unregisters the
 * provider when the extension is deactivated.
 */
export function registerVscodeMcpProvider(context: vscode.ExtensionContext): vscode.Disposable {
    const didChangeEmitter = new vscode.EventEmitter<void>();

    const provider = vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
        onDidChangeMcpServerDefinitions: didChangeEmitter.event,

        provideMcpServerDefinitions: async () => {
            return [
                new vscode.McpStdioServerDefinition(
                    'Review Mode',
                    'review-mode-mcp',
                    [],
                ),
            ];
        },
    });

    return vscode.Disposable.from(didChangeEmitter, provider);
}
