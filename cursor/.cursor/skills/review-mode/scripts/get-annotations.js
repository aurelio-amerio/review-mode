#!/usr/bin/env node
/**
 * get-annotations.js — Review Mode CLI helper
 *
 * Returns the latest revision's annotations for a given file.
 * Uses the same path normalization as the VS Code extension.
 *
 * Usage:
 *   node get-annotations.js <relative-path-to-file> [--revisions-dir <dir>]
 *
 * Examples:
 *   node get-annotations.js plans/my-plan.md
 *   node get-annotations.js plans/my-plan.md --revisions-dir .revisions
 *
 * Output (JSON):
 *   {
 *     "sourceFile": "plans/my-plan.md",
 *     "revisionsDir": ".revisions/plans_my-plan_md",
 *     "revision": 0,
 *     "annotationsFile": "rev0.json",
 *     "annotationsPath": ".revisions/plans_my-plan_md/rev0.json",
 *     "totalAnnotations": 3,
 *     "openCount": 2,
 *     "inProgressCount": 0,
 *     "resolvedCount": 1,
 *     "wontFixCount": 0,
 *     "annotations": [ ... ]
 *   }
 *
 * Exit codes:
 *   0 — success
 *   1 — no revisions found (file has not been reviewed yet)
 *   2 — usage error
 */

const fs = require('fs');
const path = require('path');

// --- Parse arguments ---
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.error('Usage: node get-annotations.js <relative-path-to-file> [--revisions-dir <dir>]');
    console.error('');
    console.error('Returns the latest revision annotations for a file as JSON.');
    console.error('');
    console.error('Options:');
    console.error('  --revisions-dir <dir>  Revisions directory name (default: .revisions)');
    console.error('  --cwd <path>           Working directory / workspace root (default: cwd)');
    process.exit(2);
}

let filePath = null;
let revisionsDir = '.revisions';
let workspaceRoot = process.cwd();

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--revisions-dir' && i + 1 < args.length) {
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

// --- Normalize path (same logic as the VS Code extension) ---
// Replace all \, /, and . with _
const relativePath = path.relative(workspaceRoot, path.resolve(workspaceRoot, filePath));
const folderName = relativePath.replace(/[\\/\.]/g, '_');

const revisionsDirPath = path.join(workspaceRoot, revisionsDir, folderName);
const revisionsJsonPath = path.join(revisionsDirPath, 'revisions.json');

// --- Check if revisions exist ---
if (!fs.existsSync(revisionsJsonPath)) {
    console.error(`No revisions found for "${filePath}".`);
    console.error(`Expected: ${revisionsJsonPath}`);
    console.error('The file has not been reviewed yet, or the revisions directory is different.');
    process.exit(1);
}

// --- Read revisions.json ---
let revisionsData;
try {
    revisionsData = JSON.parse(fs.readFileSync(revisionsJsonPath, 'utf-8'));
} catch (err) {
    console.error(`Error reading ${revisionsJsonPath}: ${err.message}`);
    process.exit(1);
}

if (!revisionsData.revisions || revisionsData.revisions.length === 0) {
    console.error(`No revisions found in ${revisionsJsonPath}.`);
    process.exit(1);
}

// --- Read latest revision's annotations ---
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

// --- Count by status ---
const counts = { open: 0, 'in-progress': 0, resolved: 0, 'wont-fix': 0 };
for (const ann of annotations) {
    const status = ann.status || 'open';
    if (status in counts) {
        counts[status]++;
    }
}

// --- Output ---
const result = {
    sourceFile: filePath,
    revisionsDir: path.relative(workspaceRoot, revisionsDirPath),
    revision: latest.revision,
    annotationsFile: latest.annotationsFile,
    annotationsPath: path.relative(workspaceRoot, annotationsPath),
    totalAnnotations: annotations.length,
    openCount: counts.open,
    inProgressCount: counts['in-progress'],
    resolvedCount: counts.resolved,
    wontFixCount: counts['wont-fix'],
    annotations: annotations,
};

console.log(JSON.stringify(result, null, 2));
