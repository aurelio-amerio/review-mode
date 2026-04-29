import { diffLines } from 'diff';
import { Annotation } from './annotationStore';

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
