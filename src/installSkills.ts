/**
 * Unified agent skill installation for Review Mode.
 *
 * Provides a single `reviewMode.installSkills` QuickPick entry point that lets
 * users choose their editor (Cline, Cursor, VS Code Copilot) and then runs the
 * appropriate install flow.  Per-editor commands are also registered directly
 * for power users / keybinding.
 *
 * Cursor and VS Code flows require `uv` on PATH to install / upgrade the
 * external `review-mode-mcp` Python package.  Cline only copies workspace
 * files and has no external dependency.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';

const INSTALLED_VERSION_KEY = 'lastInstalledSkillsVersion';

type EditorTarget = 'cline' | 'cursor' | 'vscode' | 'antigravity' | 'claude' | 'codex';

// ─────────────────────────────────────────────────────────────────────────────
//  Public registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerInstallCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('reviewMode.installSkills', () =>
            installSkillsUnified(context),
        ),
        vscode.commands.registerCommand('reviewMode.installClineSkills', () =>
            installForEditor(context, 'cline'),
        ),
        vscode.commands.registerCommand('reviewMode.installCursorSkills', () =>
            installForEditor(context, 'cursor'),
        ),
        vscode.commands.registerCommand('reviewMode.installVscodeSkills', () =>
            installForEditor(context, 'vscode'),
        ),
        vscode.commands.registerCommand('reviewMode.installAntigravitySkills', () =>
            installForEditor(context, 'antigravity'),
        ),
        vscode.commands.registerCommand('reviewMode.installClaudeSkills', () =>
            installForEditor(context, 'claude'),
        ),
        vscode.commands.registerCommand('reviewMode.installCodexSkills', () =>
            installForEditor(context, 'codex'),
        ),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Unified QuickPick entry point
// ─────────────────────────────────────────────────────────────────────────────

async function installSkillsUnified(context: vscode.ExtensionContext): Promise<void> {
    const items: vscode.QuickPickItem[] = [
        {
            label: 'Claude Code',
            description: 'Install the review-mode plugin via the Claude Code CLI',
            detail: 'Requires claude CLI on PATH',
            iconPath: {
                light: vscode.Uri.file(context.asAbsolutePath('media/logos/claude_light.svg')),
                dark: vscode.Uri.file(context.asAbsolutePath('media/logos/claude_dark.svg'))
            }
        },
        {
            label: 'Cline',
            description: 'Install review-mode-mcp via uv and copy workflows & skills into workspace',
            detail: 'Requires uv on PATH',
            iconPath: {
                light: vscode.Uri.file(context.asAbsolutePath('media/logos/cline_light.svg')),
                dark: vscode.Uri.file(context.asAbsolutePath('media/logos/cline_dark.svg'))
            }
        },
        {
            label: 'Cursor',
            description: 'Install review-mode-mcp via uv and register Cursor plugin',
            detail: 'Requires uv on PATH',
            iconPath: {
                light: vscode.Uri.file(context.asAbsolutePath('media/logos/cursor_light.svg')),
                dark: vscode.Uri.file(context.asAbsolutePath('media/logos/cursor_dark.svg'))
            }
        },
        {
            label: 'Codex',
            description: 'Show instructions to install the review-mode plugin for Codex',
            iconPath: {
                light: vscode.Uri.file(context.asAbsolutePath('media/logos/codex_light.svg')),
                dark: vscode.Uri.file(context.asAbsolutePath('media/logos/codex_dark.svg'))
            }
        },
        {
            label: 'VS Code (Copilot)',
            description: 'Install review-mode-mcp via uv and register MCP server',
            detail: 'Requires uv on PATH',
            iconPath: {
                light: vscode.Uri.file(context.asAbsolutePath('media/logos/copilot_light.svg')),
                dark: vscode.Uri.file(context.asAbsolutePath('media/logos/copilot_dark.svg'))
            }
        },
        {
            label: 'Antigravity',
            description: 'Install review-mode-mcp via uv and copy workflows & skills for Antigravity',
            detail: 'Requires uv on PATH',
            iconPath: {
                light: vscode.Uri.file(context.asAbsolutePath('media/logos/antigravity_light.svg')),
                dark: vscode.Uri.file(context.asAbsolutePath('media/logos/antigravity_dark.svg'))
            }
        },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Review Mode: Install Skills',
        placeHolder: 'Select your editor to install Review Mode agent skills',
        ignoreFocusOut: true,
    });

    if (!picked) { return; }

    const editorMap: Record<string, EditorTarget> = {
        'Cline': 'cline',
        'Cursor': 'cursor',
        'VS Code (Copilot)': 'vscode',
        'Antigravity': 'antigravity',
        'Claude Code': 'claude',
        'Codex': 'codex',
    };

    const target = editorMap[picked.label];
    if (target) {
        await installForEditor(context, target);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Per-editor install dispatch
// ─────────────────────────────────────────────────────────────────────────────

async function installForEditor(
    context: vscode.ExtensionContext,
    target: EditorTarget,
): Promise<void> {
    switch (target) {
        case 'cline':
            await installCline(context);
            break;
        case 'cursor':
            await installCursor(context);
            break;
        case 'vscode':
            await installVscode(context);
            break;
        case 'antigravity':
            await installAntigravity(context);
            break;
        case 'claude':
            await installClaude(context);
            break;
        case 'codex':
            await showCodexInstructions();
            break;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cline install
// ─────────────────────────────────────────────────────────────────────────────

async function installCline(context: vscode.ExtensionContext): Promise<void> {
    // 1. Check uv
    if (!await checkUvInstalled()) { return; }

    // 2. Install / upgrade review-mode-mcp
    const mcpOk = await installOrUpgradeMcpServer();
    if (!mcpOk) { return; }

    // 3. Pick workspace root and copy files
    const destRoot = await pickWorkspaceRoot('Cline');
    if (!destRoot) { return; }

    const sourceRoot = path.join(context.extensionPath, 'data', 'agents', 'cline');
    if (!fs.existsSync(sourceRoot)) {
        vscode.window.showErrorMessage(
            "Review Mode: Cline agent data not found. The extension may be corrupted.",
        );
        return;
    }

    try {
        copyDirRecursive(sourceRoot, destRoot);
        await updateClineMcpSettings(context);
        await saveInstalledVersion(context);
        vscode.window.showInformationMessage(
            'Review Mode: MCP server and Cline workflows installed successfully.',
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`Review Mode: Failed to install Cline skills — ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cline MCP Settings
// ─────────────────────────────────────────────────────────────────────────────

async function updateClineMcpSettings(context: vscode.ExtensionContext): Promise<void> {
    // context.globalStorageUri points to our extension's global storage directory
    // e.g., .../globalStorage/aurelio-amerio.vscode-planner
    // We can get the root globalStorage folder by taking the dirname
    const globalStorageDir = path.dirname(context.globalStorageUri.fsPath);
    
    // Check both standard Cline and Roo Code forks
    const extensionDirs = [
        'saoudrizwan.claude-dev',
        'rooveterinaryinc.roo-cline'
    ];

    for (const extDir of extensionDirs) {
        const extPath = path.join(globalStorageDir, extDir);
        if (!fs.existsSync(extPath)) {
            continue; // Extension not installed or never initialized
        }

        const settingsDir = path.join(extPath, 'settings');
        if (!fs.existsSync(settingsDir)) {
            fs.mkdirSync(settingsDir, { recursive: true });
        }

        const settingsPath = path.join(settingsDir, 'cline_mcp_settings.json');
        let settings: any = { mcpServers: {} };

        if (fs.existsSync(settingsPath)) {
            try {
                const content = fs.readFileSync(settingsPath, 'utf8');
                settings = JSON.parse(content);
                if (!settings.mcpServers) {
                    settings.mcpServers = {};
                }
            } catch (err) {
                console.warn(`Review Mode: Failed to parse ${settingsPath}, initializing empty settings`);
                settings = { mcpServers: {} };
            }
        }

        // Only add if it's not already there
        if (!settings.mcpServers['review-mode-mcp']) {
            settings.mcpServers['review-mode-mcp'] = {
                command: "review-mode-mcp",
                args: []
            };

            try {
                fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
            } catch (err) {
                console.error(`Review Mode: Failed to update ${settingsPath}`, err);
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cursor install
// ─────────────────────────────────────────────────────────────────────────────

async function installCursor(context: vscode.ExtensionContext): Promise<void> {
    // 1. Check uv
    if (!await checkUvInstalled()) { return; }

    // 2. Install / upgrade review-mode-mcp
    const mcpOk = await installOrUpgradeMcpServer();
    if (!mcpOk) { return; }

    // 3. Copy plugin to ~/.cursor/plugins/local/review-mode/
    //    This is the most reliable approach — the Cursor extension API for
    //    registering plugin paths is currently unstable / changing.
    const sourcePluginDir = path.join(context.extensionPath, 'data', 'agents', 'cursor', 'review-mode');
    const localPluginsDir = path.join(os.homedir(), '.cursor', 'plugins', 'local', 'review-mode');

    try {
        fs.mkdirSync(localPluginsDir, { recursive: true });
        copyDirRecursive(sourcePluginDir, localPluginsDir);
        await saveInstalledVersion(context);
        vscode.window.showInformationMessage(
            `Review Mode: Cursor skills installed to ~/.cursor/plugins/local/review-mode/. Restart Cursor to activate.`,
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`Review Mode: Failed to copy Cursor plugin — ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  VS Code (Copilot) install
// ─────────────────────────────────────────────────────────────────────────────

async function installVscode(context: vscode.ExtensionContext): Promise<void> {
    // 1. Check uv
    if (!await checkUvInstalled()) { return; }

    // 2. Install / upgrade review-mode-mcp
    const mcpOk = await installOrUpgradeMcpServer();
    if (!mcpOk) { return; }

    // The VS Code MCP provider (mcpProvider.ts) is always registered at activation
    // and references review-mode-mcp directly — nothing more to do here.
    await saveInstalledVersion(context);
    vscode.window.showInformationMessage(
        'Review Mode: VS Code Copilot skills installed. The MCP server is available in Copilot Agent Mode.',
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Claude Code install
// ─────────────────────────────────────────────────────────────────────────────

async function installClaude(context: vscode.ExtensionContext): Promise<void> {
    if (!await checkClaudeInstalled()) { return; }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Review Mode',
            cancellable: false,
        },
        async (progress) => {
            // All three commands are idempotent — safe to run on both fresh install and update.
            progress.report({ message: 'Adding plugin marketplace…' });
            const marketplaceOk = await runCommand('claude', [
                'plugin', 'marketplace', 'add',
                'https://github.com/aurelio-amerio/review-mode-plugin',
            ]);
            if (!marketplaceOk) {
                vscode.window.showErrorMessage(
                    'Review Mode: Failed to add plugin marketplace. Make sure the Claude Code CLI is up to date.',
                );
                return;
            }

            progress.report({ message: 'Installing plugin…' });
            const installOk = await runCommand('claude', ['plugin', 'install', 'review-mode@review-mode-plugin']);
            if (!installOk) {
                vscode.window.showErrorMessage('Review Mode: Failed to install the Claude Code plugin.');
                return;
            }

            progress.report({ message: 'Checking for updates…' });
            await runCommand('claude', ['plugin', 'update', 'review-mode@review-mode-plugin']);

            await saveInstalledVersion(context);
            vscode.window.showInformationMessage('Review Mode: Claude Code plugin installed/updated successfully.');
        },
    );
}

async function checkClaudeInstalled(): Promise<boolean> {
    return new Promise(resolve => {
        cp.execFile('claude', ['--version'], { timeout: 5000 }, (err) => {
            if (!err) { resolve(true); return; }
            vscode.window.showErrorMessage(
                'Review Mode: `claude` CLI is not installed or not on PATH.',
                'Install Claude Code',
            ).then(choice => {
                if (choice === 'Install Claude Code') {
                    vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/download'));
                }
            });
            resolve(false);
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Codex instructions
// ─────────────────────────────────────────────────────────────────────────────

async function showCodexInstructions(): Promise<void> {
    const command = 'codex plugin marketplace add aurelio-amerio/review-mode-plugin';
    const choice = await vscode.window.showInformationMessage(
        'Install Review Mode for Codex',
        {
            modal: true,
            detail: 'Run this command in your terminal, then browse the Codex plugin directory to install:\n\n' + command,
        },
        'Copy Command',
    );
    if (choice === 'Copy Command') {
        await vscode.env.clipboard.writeText(command);
        vscode.window.showInformationMessage('Review Mode: Codex command copied to clipboard.');
    }
}

/** Run an arbitrary CLI command. Returns true on exit code 0. */
function runCommand(cmd: string, args: string[]): Promise<boolean> {
    return new Promise(resolve => {
        const proc = cp.spawn(cmd, args, { stdio: 'pipe' });
        proc.on('close', code => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  uv helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if `uv` is found on PATH, otherwise shows an error message
 * with an install link and returns false.
 */
async function checkUvInstalled(): Promise<boolean> {
    return new Promise(resolve => {
        cp.execFile('uv', ['--version'], { timeout: 5000 }, (err) => {
            if (!err) {
                resolve(true);
                return;
            }
            vscode.window.showErrorMessage(
                'Review Mode: `uv` is not installed or not on PATH. uv is required to install the review-mode-mcp server.',
                'Install uv',
            ).then(choice => {
                if (choice === 'Install uv') {
                    vscode.env.openExternal(vscode.Uri.parse('https://docs.astral.sh/uv/getting-started/installation/'));
                }
            });
            resolve(false);
        });
    });
}

/**
 * Installs or upgrades `review-mode-mcp` via `uv tool`.
 * Returns true on success, false on failure.
 */
async function installOrUpgradeMcpServer(): Promise<boolean> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Review Mode',
            cancellable: false,
        },
        async (progress) => {
            // Check if already installed
            progress.report({ message: 'Checking review-mode-mcp…' });
            const isInstalled = await uvToolIsInstalled('review-mode-mcp');

            if (isInstalled) {
                progress.report({ message: 'Upgrading review-mode-mcp…' });
                const ok = await runUvTool(['tool', 'upgrade', 'review-mode-mcp']);
                if (!ok) {
                    vscode.window.showErrorMessage(
                        'Review Mode: Failed to upgrade review-mode-mcp. Check the Output panel for details.',
                    );
                    return false;
                }
            } else {
                progress.report({ message: 'Installing review-mode-mcp…' });
                const ok = await runUvTool(['tool', 'install', 'review-mode-mcp']);
                if (!ok) {
                    vscode.window.showErrorMessage(
                        'Review Mode: Failed to install review-mode-mcp. Check the Output panel for details.',
                    );
                    return false;
                }
            }

            return true;
        },
    );
}

/** Check if a uv tool is already installed by scanning `uv tool list` output. */
function uvToolIsInstalled(toolName: string): Promise<boolean> {
    return new Promise(resolve => {
        cp.execFile('uv', ['tool', 'list'], { timeout: 10000 }, (err, stdout) => {
            if (err) { resolve(false); return; }
            resolve(stdout.includes(toolName));
        });
    });
}

/** Run a uv command. Returns true on exit code 0. */
function runUvTool(args: string[]): Promise<boolean> {
    return new Promise(resolve => {
        const proc = cp.spawn('uv', args, { stdio: 'pipe' });
        proc.on('close', code => resolve(code === 0));
        proc.on('error', () => resolve(false));
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Workspace & file utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt user to pick a workspace root (or returns automatically if only one). */
async function pickWorkspaceRoot(agentLabel: string): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage(
            'Review Mode: No workspace folder is open. Please open a folder first.',
        );
        return undefined;
    }
    if (folders.length === 1) {
        return folders[0].uri.fsPath;
    }
    const picked = await vscode.window.showWorkspaceFolderPick({
        placeHolder: `Select workspace folder to install ${agentLabel} skills into`,
    });
    return picked?.uri.fsPath;
}

/** Recursively copy all files from src to dest, overwriting existing files. */
function copyDirRecursive(src: string, dest: string): void {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/** Save the current extension version to globalState after a successful install. */
async function saveInstalledVersion(context: vscode.ExtensionContext): Promise<void> {
    const version: string = context.extension.packageJSON.version;
    await context.globalState.update(INSTALLED_VERSION_KEY, version);
}

/** Read the last installed version from globalState. */
export function getInstalledVersion(context: vscode.ExtensionContext): string | undefined {
    return context.globalState.get<string>(INSTALLED_VERSION_KEY);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Antigravity install
// ─────────────────────────────────────────────────────────────────────────────

async function installAntigravity(context: vscode.ExtensionContext): Promise<void> {
    // 1. Check uv
    if (!await checkUvInstalled()) { return; }

    // 2. Install / upgrade review-mode-mcp
    const mcpOk = await installOrUpgradeMcpServer();
    if (!mcpOk) { return; }

    // 3. Pick workspace root and copy files
    const destRoot = await pickWorkspaceRoot('Antigravity');
    if (!destRoot) { return; }

    const sourceRoot = path.join(context.extensionPath, 'data', 'agents', 'antigravity');
    if (!fs.existsSync(sourceRoot)) {
        vscode.window.showErrorMessage(
            "Review Mode: Antigravity agent data not found. The extension may be corrupted.",
        );
        return;
    }

    try {
        copyDirRecursive(sourceRoot, destRoot);
        await updateAntigravityMcpSettings();
        await saveInstalledVersion(context);
        vscode.window.showInformationMessage(
            'Review Mode: MCP server and Antigravity workflows installed successfully.',
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`Review Mode: Failed to install Antigravity skills — ${err.message}`);
    }
}

async function updateAntigravityMcpSettings(): Promise<void> {
    const configPath = path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
    const configDir = path.dirname(configPath);

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    let settings: any = { mcpServers: {} };
    if (fs.existsSync(configPath)) {
        try {
            const content = fs.readFileSync(configPath, 'utf8');
            settings = JSON.parse(content);
            if (!settings.mcpServers) {
                settings.mcpServers = {};
            }
        } catch (err) {
            console.warn(`Review Mode: Failed to parse ${configPath}, initializing empty settings`);
            settings = { mcpServers: {} };
        }
    }

    if (!settings.mcpServers['review-mode-mcp']) {
        settings.mcpServers['review-mode-mcp'] = {
            command: "review-mode-mcp",
            args: []
        };

        try {
            fs.writeFileSync(configPath, JSON.stringify(settings, null, 2), 'utf8');
        } catch (err) {
            console.error(`Review Mode: Failed to update ${configPath}`, err);
        }
    }
}
