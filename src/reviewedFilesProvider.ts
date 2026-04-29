import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Annotation, RevisionsFile } from './annotationStore';

export class ReviewedFileItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly tooltip: string | vscode.MarkdownString,
        public readonly sourcePath: string,
        public readonly revisionsDirPath: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        // This command acts when clicking the item
        this.command = {
            command: 'reviewMode.open',
            title: 'Open in Review Mode',
            arguments: [vscode.Uri.file(this.sourcePath)]
        };

        // We set context value for context menu assignments
        this.contextValue = 'reviewedFile';
        this.iconPath = new vscode.ThemeIcon('markdown');
    }
}

export class ReviewedFilesProvider implements vscode.TreeDataProvider<ReviewedFileItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ReviewedFileItem | undefined | void> = new vscode.EventEmitter<ReviewedFileItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<ReviewedFileItem | undefined | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ReviewedFileItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ReviewedFileItem): Promise<ReviewedFileItem[]> {
        if (element) {
            return []; // no children for these items
        }

        const revisionsDirName = vscode.workspace.getConfiguration('reviewMode').get<string>('revisionsDirectory', '.revisions');

        // Find all revisions.json files exactly inside the configured directory
        const files = await vscode.workspace.findFiles(`**/${revisionsDirName}/**/revisions.json`);

        const items: ReviewedFileItem[] = [];

        for (const file of files) {
            try {
                const revisionsPath = file.fsPath;
                const plansDir = path.dirname(revisionsPath);
                const raw = fs.readFileSync(revisionsPath, 'utf-8');
                const revisionsData = JSON.parse(raw) as RevisionsFile;

                if (!revisionsData.revisions || revisionsData.revisions.length === 0) {
                    continue;
                }

                const workspaceRoot = path.dirname(path.dirname(plansDir));
                const sourcePath = path.resolve(workspaceRoot, revisionsData.sourceFile);
                const baseName = path.basename(sourcePath);

                const latest = revisionsData.revisions[revisionsData.revisions.length - 1];
                const date = new Date(latest.createdAt);

                // Get number of comments
                let commentCount = 0;
                let addressedCount = 0;
                const annotationsFile = path.join(plansDir, latest.annotationsFile);
                if (fs.existsSync(annotationsFile)) {
                    const annRaw = fs.readFileSync(annotationsFile, 'utf-8');
                    const annotations = JSON.parse(annRaw) as Annotation[];
                    commentCount = annotations.length; // total comments
                    addressedCount = annotations.filter(a => a.status === 'resolved' || a.status === 'wont-fix').length;
                }

                // Read snapshot for preview
                let preview = '';
                const snapshotFile = path.join(plansDir, latest.snapshotFile);
                if (fs.existsSync(snapshotFile)) {
                    const snapRaw = fs.readFileSync(snapshotFile, 'utf-8');
                    const lines = snapRaw.split('\n').filter(l => l.trim().length > 0).slice(0, 5);
                    preview = lines.join('\n');
                }

                const commentLabel = commentCount === 0
                    ? '0 comments'
                    : `${addressedCount}/${commentCount} comment${commentCount === 1 ? '' : 's'}`;
                const desc = `Rev ${latest.revision} (${date.toLocaleDateString()}) • ${commentLabel}`;
                const tooltipText = `**${baseName}**\n\n${desc}\n\n---\n\n${preview}`;
                const tooltip = new vscode.MarkdownString(tooltipText);

                items.push(new ReviewedFileItem(baseName, desc, tooltip, sourcePath, plansDir));
            } catch (err) {
                console.error(`Error parsing ${file.fsPath}:`, err);
            }
        }

        // Sort alphabetically
        return items.sort((a, b) => a.label.localeCompare(b.label));
    }
}
