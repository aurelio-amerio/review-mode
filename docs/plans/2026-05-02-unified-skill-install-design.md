# Unified Skill Installation & External Python MCP Server

## Summary

Replace the bundled JS MCP server with the existing external Python MCP server (`review-mode-mcp` via `uv tool install`), and consolidate all agent setup into a single user-driven install flow. No auto-registration at activation — users explicitly choose their editor through a unified command.

## Motivation

- The bundled JS MCP server creates path-dependent `mcp.json` configs that break across extension updates
- Maintaining two MCP server implementations (JS + Python) is unnecessary
- The current install flow is fragmented: separate commands, auto-registration, first-run prompts with different behaviors per platform
- Users need a clear, discoverable way to install and update agent skills

## Architecture Decision: External Python MCP Server

The MCP server lives in the separate `review-mode-mcp` PyPI package, managed via `uv tool install/upgrade`. This gives:

- **Static config**: `mcp.json` uses `{"command": "review-mode-mcp"}` — no path patching needed
- **Independent versioning**: MCP server and extension can be updated separately
- **Single implementation**: One Python MCP server serves Cursor, Cline, and VS Code Copilot
- **Stable binary**: `uv tool install` pins the version until explicitly upgraded (faster startup than `uvx`)
- **Trade-off**: Requires user to have `uv` installed (checked at install time, not activation)

## Activation Flow

On extension activation:

1. Core review features load unconditionally (annotations, sidebar, webview)
2. Read `globalState["lastInstalledSkillsVersion"]` and compare to current extension version
3. If versions differ (or first install):
   - First install: *"Review Mode can integrate with AI agents (Cursor, Cline, VS Code Copilot). Set up skills and MCP tools for your editor?"*
   - Update: *"Review Mode has been updated to vX.Y.Z. Update your agent skills to get the latest features."*
   - Buttons: `[Set Up / Update]` and `[Skip This Version]`
   - "Set Up/Update" triggers `reviewMode.installSkills` command
   - "Skip This Version" saves current version to globalState (won't nag again until next update)
4. If versions match: nothing

There is no "Don't Show Again" option — the prompt re-appears once per extension version change to ensure users get skill updates.

## Unified Install Command

**Command**: `Review Mode: Install Skills` (`reviewMode.installSkills`)

Accessible via:
- Command Palette
- The activation prompt button
- A `$(cloud-download)` button in the Review Mode sidebar (`reviewModeFiles` view title)

### Flow

1. Show QuickPick dropdown: "Select your editor" → Cline, Cursor, VS Code (Copilot) (alphabetical)
2. Per-platform logic:

### Cline
- Copy `data/agents/cline/` into workspace root (`.cline/`, `.clinerules/`)
- No `uv` check needed (MCP configured separately by user in Cline settings)

### Cursor
1. Check if `uv` is on PATH → if missing, show error with `[Install uv]` button (opens docs)
2. Run `uv tool list` → check if `review-mode-mcp` is installed
   - Not installed → `uv tool install review-mode-mcp`
   - Installed → `uv tool upgrade review-mode-mcp`
3. Call `cursor.plugins.registerPath(pluginDir)` where pluginDir = `data/agents/cursor/review-mode/`
   - This registers rules, skills, AND the MCP server (via the static `mcp.json` in the plugin dir)
4. Save version to globalState

### VS Code (Copilot)
1. Check if `uv` is on PATH → same error handling as Cursor
2. Run `uv tool install/upgrade` (same as Cursor)
3. Register `McpStdioServerDefinition('Review Mode', 'review-mode-mcp', [])` via the proposed API
4. Save version to globalState

All `uv` operations are wrapped in `vscode.window.withProgress` for user feedback.

## Cursor Plugin Structure

```
data/agents/cursor/review-mode/
├── .cursor-plugin/
│   └── plugin.json
├── rules/
│   └── *.mdc
├── skills/
│   └── review-mode/
│       └── SKILL.md
└── mcp.json          ← static, references installed binary
```

### mcp.json
```json
{
  "mcpServers": {
    "review-mode": {
      "command": "review-mode-mcp",
      "args": [],
      "type": "stdio"
    }
  }
}
```

### plugin.json
```json
{
  "name": "review-mode",
  "description": "Review Mode — threaded annotations, revision tracking, and AI agent tools for Markdown files.",
  "version": "0.0.18",
  "author": { "name": "aurelio-amerio" },
  "repository": "https://github.com/aurelio-amerio/review-mode.git",
  "keywords": ["review", "annotations", "mcp", "markdown", "collaboration"]
}
```

## Sidebar Button

An "Install Skills" button in the `reviewModeFiles` view title bar:
- Icon: `$(cloud-download)`
- Triggers `reviewMode.installSkills`
- Visible always in the Review Mode activity bar

## What Gets Removed

- `src/mcp/` directory (server.ts, revisions.ts, utils.ts) — no more bundled JS MCP server
- `@modelcontextprotocol/sdk` and `zod` from package.json dependencies
- `cursor.mcp.registerServer` / `cursor.mcp.unregisterServer` calls
- `reRegisterCursorMcp` export
- Old first-run prompt logic (`mcpServerPromptDismissed` globalState key)
- `reviewMode.setupMcpServer` command
- `reviewMode.mcpServer.enabled` setting (MCP is now external)
- MCP server entry point from `esbuild.js`

## What Gets Kept / Modified

- `cursor.plugins.registerPath` — still used for Cursor plugin registration
- `registerMcpServerDefinitionProvider` — still used for VS Code, but with `review-mode-mcp` command
- `installSkills.ts` — rewritten as the unified entry point with `uv tool` management
- `mcpProvider.ts` — simplified to just the VS Code Copilot registration function
- `esbuild.js` — simplified to single extension entry point

## Commands (final)

| Command | Title | Purpose |
|---------|-------|---------|
| `reviewMode.installSkills` | Review Mode: Install Skills | Unified dropdown entry point |
| `reviewMode.installClineSkills` | Review Mode: Install Cline Skills | Direct Cline install |
| `reviewMode.installCursorSkills` | Review Mode: Install Cursor Skills | Direct Cursor install |
| `reviewMode.installVscodeSkills` | Review Mode: Install VS Code Skills | Direct VS Code install |

## Implementation Tasks

1. Create static `mcp.json` in `data/agents/cursor/review-mode/`
2. Enhance `plugin.json` with repository and keywords
3. Rewrite `installSkills.ts` with unified install command and `uv tool` management
4. Simplify `mcpProvider.ts` to VS Code Copilot only
5. Update `package.json` (commands, sidebar button, remove MCP deps)
6. Remove JS MCP server (`src/mcp/`) and simplify `esbuild.js`
7. Update `extension.ts` activation flow with version-aware prompt

See the detailed implementation plan in the Antigravity artifact for step-by-step code.
