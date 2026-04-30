#!/usr/bin/env node
/**
 * resolve-annotations.js — Review Mode CLI helper
 *
 * Updates annotation statuses in the latest revision for a given file.
 * Uses the same path normalization as the VS Code extension.
 *
 * Usage:
 *   node resolve-annotations.js <relative-path-to-file> --ids <id1,id2,...> [options]
 *
 * Options:
 *   --ids <id1,id2,...>       Comma-separated annotation IDs to update (required)
 *   --status <status>        New status: resolved (default), wont-fix, in-progress, open
 *   --message <text>         Optional [AGENT] reply to add to each annotation's thread
 *   --all                    Update ALL annotations (ignores --ids)
 *   --revisions-dir <dir>    Revisions directory name (default: .revisions)
 *   --cwd <path>             Workspace root (default: cwd)
 *
 * Examples:
 *   # Resolve specific annotations
 *   node resolve-annotations.js plans/my-plan.md --ids cc1rclk,abc1234
 *
 *   # Resolve all open annotations
 *   node resolve-annotations.js plans/my-plan.md --all
 *
 *   # Mark as wont-fix with explanation
 *   node resolve-annotations.js plans/my-plan.md --ids cc1rclk --status wont-fix --message "Not feasible due to API limitations"
 *
 *   # Add an agent reply without changing status
 *   node resolve-annotations.js plans/my-plan.md --ids cc1rclk --status in-progress --message "Working on this now"
 *
 * Exit codes:
 *   0 — success
 *   1 — no revisions found or no matching annotations
 *   2 — usage error
 */

const fs = require('fs');
const path = require('path');

// --- Parse arguments ---
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.error('Usage: node resolve-annotations.js <relative-path-to-file> --ids <id1,id2,...> [options]');
    console.error('');
    console.error('Updates annotation statuses in the latest revision.');
    console.error('');
    console.error('Options:');
    console.error('  --ids <id1,id2,...>       Annotation IDs to update (comma-separated)');
    console.error('  --status <status>        resolved (default), wont-fix, in-progress, open');
    console.error('  --message <text>         [AGENT] reply to add to each thread');
    console.error('  --all                    Update ALL open/in-progress annotations');
    console.error('  --revisions-dir <dir>    Revisions directory name (default: .revisions)');
    console.error('  --cwd <path>             Workspace root (default: cwd)');
    process.exit(2);
}

let filePath = null;
let ids = [];
let status = 'resolved';
let message = null;
let all = false;
let revisionsDir = '.revisions';
let workspaceRoot = process.cwd();

const validStatuses = ['resolved', 'wont-fix', 'in-progress', 'open'];

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ids' && i + 1 < args.length) {
        ids = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (args[i] === '--status' && i + 1 < args.length) {
        status = args[++i];
        if (!validStatuses.includes(status)) {
            console.error(`Error: Invalid status "${status}". Must be one of: ${validStatuses.join(', ')}`);
            process.exit(2);
        }
    } else if (args[i] === '--message' && i + 1 < args.length) {
        message = args[++i];
    } else if (args[i] === '--all') {
        all = true;
    } else if (args[i] === '--revisions-dir' && i + 1 < args.length) {
        revisionsDir = args[++i];
    } else if (args[i] === '--cwd' && i + 1 < args.length) {
        workspaceRoot = args[++i];
    } else if (!args[i].startsWith('--')) {
        filePath = args[i];
    }
}

if (!filePath) {
    console.error('Error: No file path provided.');
    process.exit(2);
}

if (!all && ids.length === 0) {
    console.error('Error: Provide --ids <id1,id2,...> or --all.');
    process.exit(2);
}

// --- Normalize path (same as VS Code extension) ---
const relativePath = path.relative(workspaceRoot, path.resolve(workspaceRoot, filePath));
const folderName = relativePath.replace(/[\\/\.]/g, '_');

const revisionsDirPath = path.join(workspaceRoot, revisionsDir, folderName);
const revisionsJsonPath = path.join(revisionsDirPath, 'revisions.json');

// --- Read revisions ---
if (!fs.existsSync(revisionsJsonPath)) {
    console.error(`No revisions found for "${filePath}".`);
    console.error(`Expected: ${revisionsJsonPath}`);
    process.exit(1);
}

let revisionsData;
try {
    revisionsData = JSON.parse(fs.readFileSync(revisionsJsonPath, 'utf-8'));
} catch (err) {
    console.error(`Error reading ${revisionsJsonPath}: ${err.message}`);
    process.exit(1);
}

if (!revisionsData.revisions || revisionsData.revisions.length === 0) {
    console.error(`No revisions in ${revisionsJsonPath}.`);
    process.exit(1);
}

// --- Read latest annotations ---
const latest = revisionsData.revisions[revisionsData.revisions.length - 1];
const annotationsPath = path.join(revisionsDirPath, latest.annotationsFile);

let annotations = [];
if (fs.existsSync(annotationsPath)) {
    try {
        annotations = JSON.parse(fs.readFileSync(annotationsPath, 'utf-8'));
    } catch (err) {
        console.error(`Error reading ${annotationsPath}: ${err.message}`);
        process.exit(1);
    }
}

// --- Determine which annotations to update ---
let targetIds;
if (all) {
    // Only update open or in-progress annotations
    targetIds = annotations
        .filter(a => a.status === 'open' || a.status === 'in-progress')
        .map(a => a.id);
} else {
    targetIds = ids;
}

if (targetIds.length === 0) {
    console.error('No matching annotations to update.');
    process.exit(1);
}

// --- Generate a random ID for thread messages ---
function randomId() {
    return Math.random().toString(36).substring(2, 9);
}

// --- Update annotations ---
let updated = 0;
const notFound = [];

for (const targetId of targetIds) {
    const ann = annotations.find(a => a.id === targetId);
    if (!ann) {
        notFound.push(targetId);
        continue;
    }

    ann.status = status;

    if (message) {
        if (!ann.thread) { ann.thread = []; }
        ann.thread.push({
            id: randomId(),
            text: `[AGENT] ${message}`,
            createdAt: new Date().toISOString(),
        });
    }

    updated++;
}

// --- Write back ---
try {
    fs.writeFileSync(annotationsPath, JSON.stringify(annotations, null, 2), 'utf-8');
} catch (err) {
    console.error(`Error writing ${annotationsPath}: ${err.message}`);
    process.exit(1);
}

// --- Output result ---
const result = {
    annotationsPath: path.relative(workspaceRoot, annotationsPath),
    revision: latest.revision,
    status: status,
    updated: updated,
    notFound: notFound,
    totalAnnotations: annotations.length,
    message: message || null,
};

console.log(JSON.stringify(result, null, 2));

if (notFound.length > 0) {
    console.error(`Warning: ${notFound.length} ID(s) not found: ${notFound.join(', ')}`);
}
