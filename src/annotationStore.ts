import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// --- Types ---

export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export type Status = 'open' | 'in-progress' | 'resolved' | 'wont-fix';

export interface Message {
    id: string;
    text: string;
    createdAt: string;
}

export interface Annotation {
    id: string;
    startLine: number;
    endLine: number;
    textPreview: string;
    priority: Priority;
    status: Status;
    thread: Message[];
    deletedLine?: boolean;
}

export interface RevisionEntry {
    revision: number;          // 0, 1, 2, …
    snapshotFile: string;      // e.g. "myplan.rev0.md"
    annotationsFile: string;   // e.g. "rev0.json"
    createdAt: string;         // ISO 8601
}

export interface RevisionsFile {
    version: 3;
    sourceFile: string;        // relative path back to original .md
    revisions: RevisionEntry[];
}

// --- Store ---

export class AnnotationStore {
    private annotations: Annotation[] = [];
    private revisionsPath: string = '';
    private plansDir: string = '';
    private revisionsData: RevisionsFile | null = null;
    private currentRevisionIndex: number = -1;
    private annotationsCache = new Map<number, Annotation[]>();

    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    /** Load revisions.json. Sets active annotations to the latest revision. */
    load(revisionsPath: string): void {
        this.revisionsPath = revisionsPath;
        this.plansDir = path.dirname(revisionsPath);
        this.annotationsCache.clear();

        if (fs.existsSync(revisionsPath)) {
            const raw = fs.readFileSync(revisionsPath, 'utf-8');
            this.revisionsData = JSON.parse(raw) as RevisionsFile;

            if (this.revisionsData.revisions.length > 0) {
                this.currentRevisionIndex = this.revisionsData.revisions.length - 1;
                this.annotations = this.loadAnnotationsForRevision(this.currentRevisionIndex);
            } else {
                this.currentRevisionIndex = -1;
                this.annotations = [];
            }
        } else {
            this.revisionsData = null;
            this.currentRevisionIndex = -1;
            this.annotations = [];
        }
        this._onDidChange.fire();
    }

    /** Initialize a brand-new RevisionsFile. Call this for first-time review of a file. */
    initNew(sourceFile: string, revisionsPath: string, snapshotFile: string, plansDir: string): void {
        this.revisionsPath = revisionsPath;
        this.plansDir = plansDir;
        this.annotationsCache.clear();

        this.revisionsData = {
            version: 3,
            sourceFile,
            revisions: [{
                revision: 0,
                snapshotFile,
                annotationsFile: 'rev0.json',
                createdAt: new Date().toISOString(),
            }],
        };
        this.currentRevisionIndex = 0;
        this.annotations = [];
        this.annotationsCache.set(0, this.annotations);

        this.saveRevisionFile(0, []);
        this.saveRevisionsIndex();
        this._onDidChange.fire();
    }

    /** Switch to a historical revision's annotations (lazy-load from disk). */
    loadRevision(revisionIndex: number): void {
        if (!this.revisionsData || revisionIndex < 0 || revisionIndex >= this.revisionsData.revisions.length) {
            return;
        }
        this.currentRevisionIndex = revisionIndex;
        this.annotations = this.loadAnnotationsForRevision(revisionIndex);
        this._onDidChange.fire();
    }

    /** Return the full revision list (for the History panel). */
    getRevisions(): readonly RevisionEntry[] {
        return this.revisionsData?.revisions ?? [];
    }

    /** Return the active revision index. */
    getCurrentRevision(): number {
        return this.currentRevisionIndex;
    }

    /** Get the source file relative path. */
    getSourceFile(): string {
        return this.revisionsData?.sourceFile ?? '';
    }

    /** Get the absolute directory where all plans/revisions are stored. */
    getPlansDir(): string {
        return this.plansDir;
    }

    /** Reconstruct original fs path, usually resolving against the workspace root. */
    getOriginalPath(): string | undefined {
        const sourceFile = this.getSourceFile();
        if (!sourceFile) return undefined;
        // Since sourceFile is workspace-relative, and plansDir is <workspace>/.revisions/<folder>,
        // the workspace root is two levels up from plansDir.
        const workspaceRoot = path.dirname(path.dirname(this.plansDir));
        return path.resolve(workspaceRoot, sourceFile);
    }

    /** Append a new revision with migrated annotations. Returns the new entry. */
    createRevision(snapshotFile: string, migratedAnnotations: Annotation[]): RevisionEntry {
        if (!this.revisionsData) {
            throw new Error('Cannot create revision: no revisions data loaded');
        }
        const nextRev = this.revisionsData.revisions.length;
        const annotationsFile = `rev${nextRev}.json`;
        const entry: RevisionEntry = {
            revision: nextRev,
            snapshotFile,
            annotationsFile,
            createdAt: new Date().toISOString(),
        };
        this.revisionsData.revisions.push(entry);
        this.currentRevisionIndex = nextRev;
        this.annotations = migratedAnnotations;
        this.annotationsCache.set(nextRev, this.annotations);

        this.saveRevisionFile(nextRev, migratedAnnotations);
        this.saveRevisionsIndex();
        this._onDidChange.fire();
        return entry;
    }

    /** Active (non-resolved/wont-fix) annotation count for a revision — used by History panel. */
    getAnnotationCountForRevision(revisionIndex: number): number {
        return this.loadAnnotationsForRevision(revisionIndex)
            .filter(a => a.status !== 'resolved' && a.status !== 'wont-fix').length;
    }

    /** Total annotation count for a revision. */
    getTotalAnnotationCountForRevision(revisionIndex: number): number {
        return this.loadAnnotationsForRevision(revisionIndex).length;
    }

    /** Addressed (resolved or wont-fix) annotation count for a revision. */
    getAddressedAnnotationCountForRevision(revisionIndex: number): number {
        return this.loadAnnotationsForRevision(revisionIndex)
            .filter(a => a.status === 'resolved' || a.status === 'wont-fix').length;
    }

    /** Add a new annotation (new thread) at the given line range. */
    addAnnotation(startLine: number, endLine: number, textPreview: string, text: string): Annotation {
        const existing = this.annotations.find(a => a.startLine === startLine && a.endLine === endLine);
        if (existing) { this.addMessage(existing.id, text); return existing; }

        const annotation: Annotation = {
            id: this.generateId(),
            startLine,
            endLine,
            textPreview,
            priority: 'none',
            status: 'open',
            thread: [{ id: this.generateId(), text, createdAt: new Date().toISOString() }],
        };
        this.annotations.push(annotation);
        this.annotations.sort((a, b) => a.startLine - b.startLine);
        this.saveCurrentRevision();
        this._onDidChange.fire();
        return annotation;
    }

    /** Add a reply message to an existing annotation thread. */
    addMessage(annotationId: string, text: string): Message | undefined {
        const annotation = this.annotations.find(a => a.id === annotationId);
        if (!annotation) { return undefined; }
        const message: Message = { id: this.generateId(), text, createdAt: new Date().toISOString() };
        annotation.thread.push(message);
        this.saveCurrentRevision();
        this._onDidChange.fire();
        return message;
    }

    /** Delete a single message. If it's the last message, delete the whole annotation. */
    deleteMessage(annotationId: string, messageId: string): void {
        const annotation = this.annotations.find(a => a.id === annotationId);
        if (!annotation) { return; }
        annotation.thread = annotation.thread.filter(m => m.id !== messageId);
        if (annotation.thread.length === 0) { this.deleteAnnotation(annotationId); return; }
        this.saveCurrentRevision();
        this._onDidChange.fire();
    }

    /** Delete an entire annotation thread. */
    deleteAnnotation(annotationId: string): void {
        this.annotations = this.annotations.filter(a => a.id !== annotationId);
        this.annotationsCache.set(this.currentRevisionIndex, this.annotations);
        this.saveCurrentRevision();
        this._onDidChange.fire();
    }

    /** Set the priority of an annotation. */
    setPriority(annotationId: string, priority: Priority): void {
        const annotation = this.annotations.find(a => a.id === annotationId);
        if (!annotation) { return; }
        annotation.priority = priority;
        this.saveCurrentRevision();
        this._onDidChange.fire();
    }

    /** Set the status of an annotation. */
    setStatus(annotationId: string, status: Status): void {
        const annotation = this.annotations.find(a => a.id === annotationId);
        if (!annotation) { return; }
        annotation.status = status;
        this.saveCurrentRevision();
        this._onDidChange.fire();
    }

    /** Get all annotations for the active revision, sorted by start line. */
    getAnnotations(): readonly Annotation[] {
        return this.annotations;
    }

    /** Clear all state (used when closing review mode). */
    clear(): void {
        this.annotations = [];
        this.revisionsPath = '';
        this.plansDir = '';
        this.revisionsData = null;
        this.currentRevisionIndex = -1;
        this.annotationsCache.clear();
        this._onDidChange.fire();
    }

    // --- Private helpers ---

    private loadAnnotationsForRevision(revisionIndex: number): Annotation[] {
        if (this.annotationsCache.has(revisionIndex)) {
            return this.annotationsCache.get(revisionIndex)!;
        }
        if (!this.revisionsData) { return []; }
        const entry = this.revisionsData.revisions[revisionIndex];
        const filePath = path.join(this.plansDir, entry.annotationsFile);
        if (!fs.existsSync(filePath)) { return []; }
        const annotations: Annotation[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        this.annotationsCache.set(revisionIndex, annotations);
        return annotations;
    }

    private saveCurrentRevision(): void {
        if (this.currentRevisionIndex < 0) { return; }
        this.saveRevisionFile(this.currentRevisionIndex, this.annotations);
    }

    private saveRevisionFile(revisionIndex: number, annotations: Annotation[]): void {
        if (!this.revisionsData) { return; }
        const entry = this.revisionsData.revisions[revisionIndex];
        fs.writeFileSync(
            path.join(this.plansDir, entry.annotationsFile),
            JSON.stringify(annotations, null, 2),
            'utf-8',
        );
    }

    private saveRevisionsIndex(): void {
        if (!this.revisionsData) { return; }
        fs.writeFileSync(this.revisionsPath, JSON.stringify(this.revisionsData, null, 2), 'utf-8');
    }

    private generateId(): string {
        return Math.random().toString(36).substring(2, 9);
    }
}
