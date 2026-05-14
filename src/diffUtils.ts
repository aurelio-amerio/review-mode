import { diffLines } from 'diff';
import { Annotation } from './annotationStore';

export interface DiffHunk {
    type: 'added' | 'removed' | 'unchanged';
    lines: string[];
}

export function computeDiffHunks(oldText: string, newText: string): DiffHunk[] {
    const changes = diffLines(oldText, newText);
    const hunks: DiffHunk[] = [];

    for (const change of changes) {
        const lines = change.value ? change.value.replace(/\n$/, '').split('\n') : [];
        if (change.added) {
            hunks.push({ type: 'added', lines });
        } else if (change.removed) {
            hunks.push({ type: 'removed', lines });
        } else {
            hunks.push({ type: 'unchanged', lines });
        }
    }

    return hunks;
}

export function extractDiffContext(
    hunks: DiffHunk[],
    currentLineStart: number,
    currentLineEnd: number,
): { previousVersionContext: string; currentVersionContext: string } | null {
    let currentLineNum = 0;
    const rows: Array<{ type: 'added' | 'removed' | 'unchanged'; text: string; currentLine: number | null }> = [];

    for (const hunk of hunks) {
        for (const line of hunk.lines) {
            if (hunk.type === 'removed') {
                rows.push({ type: 'removed', text: line, currentLine: null });
            } else {
                currentLineNum++;
                rows.push({ type: hunk.type, text: line, currentLine: currentLineNum });
            }
        }
    }

    let firstRowIdx = -1;
    let lastRowIdx = -1;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.currentLine !== null && row.currentLine >= currentLineStart && row.currentLine <= currentLineEnd) {
            if (firstRowIdx === -1) { firstRowIdx = i; }
            lastRowIdx = i;
        }
    }

    if (firstRowIdx === -1) { return null; }

    // Only generate context when the annotated line itself is part of a change
    const hasChange = rows.slice(firstRowIdx, lastRowIdx + 1).some(r => r.type !== 'unchanged');
    if (!hasChange) { return null; }

    // Expand to the full enclosing hunk boundary
    while (firstRowIdx > 0 && rows[firstRowIdx - 1].type !== 'unchanged') { firstRowIdx--; }
    while (lastRowIdx < rows.length - 1 && rows[lastRowIdx + 1].type !== 'unchanged') { lastRowIdx++; }

    const previousLines: string[] = [];
    const currentLines: string[] = [];

    for (let i = firstRowIdx; i <= lastRowIdx; i++) {
        const row = rows[i];
        if (row.type === 'removed') {
            previousLines.push(`-${row.text}`);
        } else if (row.type === 'added') {
            currentLines.push(`+${row.text}`);
        } else {
            previousLines.push(` ${row.text}`);
            currentLines.push(` ${row.text}`);
        }
    }

    return {
        previousVersionContext: previousLines.join('\n'),
        currentVersionContext: currentLines.join('\n'),
    };
}

/**
 * Build a line-number mapping from old line numbers to new line numbers.
 * Returns a Map<oldLine, newLine>. Deleted lines map to -1.
 */
export function buildLineMap(oldText: string, newText: string): Map<number, number> {
    const changes = diffLines(oldText, newText);
    const lineMap = new Map<number, number>();

    let oldLine = 1;
    let newLine = 1;

    for (const change of changes) {
        const lineCount = change.count ?? 0;

        if (change.added) {
            // Lines added in new text — only increment newLine
            newLine += lineCount;
        } else if (change.removed) {
            // Lines removed — map each old line to -1 (deleted)
            for (let i = 0; i < lineCount; i++) {
                lineMap.set(oldLine + i, -1);
            }
            oldLine += lineCount;
        } else {
            // Unchanged lines — one-to-one mapping
            for (let i = 0; i < lineCount; i++) {
                lineMap.set(oldLine + i, newLine + i);
            }
            oldLine += lineCount;
            newLine += lineCount;
        }
    }

    return lineMap;
}

/**
 * Migrate annotations from an old revision to a new revision.
 * - Shifts startLine/endLine using the line map.
 * - If both startLine and endLine map to -1 (fully deleted),
 *   anchor to the closest preceding non-deleted line.
 * - Skips annotations with status 'resolved' or 'wont-fix'.
 * - Returns deep copies; does not mutate originals.
 */
export function migrateAnnotations(
    annotations: Annotation[],
    oldText: string,
    newText: string,
): Annotation[] {
    const lineMap = buildLineMap(oldText, newText);
    const migrated: Annotation[] = [];

    for (const ann of annotations) {
        // Skip resolved/wont-fix annotations
        if (ann.status === 'resolved' || ann.status === 'wont-fix') {
            continue;
        }

        let newStart = lineMap.get(ann.startLine) ?? -1;
        let newEnd = lineMap.get(ann.endLine) ?? -1;

        const originalStartDeleted = (lineMap.get(ann.startLine) ?? -1) === -1;
        const originalEndDeleted = (lineMap.get(ann.endLine) ?? -1) === -1;

        if (newStart === -1 && newEnd === -1) {
            // Both lines deleted — scan backwards from startLine for nearest valid line
            let anchor = -1;
            for (let line = ann.startLine - 1; line >= 1; line--) {
                const mapped = lineMap.get(line);
                if (mapped !== undefined && mapped !== -1) {
                    anchor = mapped;
                    break;
                }
            }
            if (anchor === -1) {
                // Nothing found backwards, anchor to line 1
                anchor = 1;
            }
            newStart = anchor;
            newEnd = anchor;
        } else if (newStart === -1) {
            // Only start deleted — clamp to end
            newStart = newEnd;
        } else if (newEnd === -1) {
            // Only end deleted — clamp to start
            newEnd = newStart;
        }

        // Flag if any of the original lines were deleted
        const wasDeleted = originalStartDeleted || originalEndDeleted;

        // Deep copy the annotation with updated positions and new ID
        const migratedAnn: Annotation = {
            id: generateId(),
            startLine: newStart,
            endLine: newEnd,
            textPreview: ann.textPreview,
            priority: ann.priority,
            status: ann.status,
            thread: ann.thread.map(m => ({
                id: m.id,
                text: m.text,
                createdAt: m.createdAt,
            })),
            ...(wasDeleted ? { deletedLine: true } : {}),
        };
        migrated.push(migratedAnn);
    }

    return migrated.sort((a, b) => a.startLine - b.startLine);
}

function generateId(): string {
    return Math.random().toString(36).substring(2, 9);
}

/**
 * Returns the set of 1-based line numbers in the current (new) version that
 * are part of added hunks — i.e. lines that exist in `newText` but differ
 * from `oldText`. Used to detect whether pinned-diff annotations are at risk.
 */
export function getChangedCurrentLines(hunks: DiffHunk[]): Set<number> {
    const changed = new Set<number>();
    let currentLine = 0;
    for (const hunk of hunks) {
        if (hunk.type === 'removed') { continue; }
        for (const _ of hunk.lines) {
            currentLine++;
            if (hunk.type === 'added') {
                changed.add(currentLine);
            }
        }
    }
    return changed;
}
