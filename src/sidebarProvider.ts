import * as vscode from 'vscode';
import { AnnotationStore, Annotation, Message, Status } from './annotationStore';

class AnnotationItem extends vscode.TreeItem {
    constructor(public readonly annotation: Annotation) {
        super(
            `Lines ${annotation.startLine}-${annotation.endLine}`,
            vscode.TreeItemCollapsibleState.Expanded,
        );
        this.description = annotation.textPreview.substring(0, 50);
        this.contextValue = 'annotation';

        // Status-based icon
        const statusIcons: Record<Status, string> = {
            'open': 'comment',
            'in-progress': 'sync',
            'resolved': 'pass',
            'wont-fix': 'circle-slash',
        };
        const status = annotation.status || 'open';
        this.iconPath = new vscode.ThemeIcon(statusIcons[status] || 'comment');

        this.command = {
            command: 'reviewMode.scrollToLine',
            title: 'Go to line',
            arguments: [annotation.startLine],
        };
    }
}

class MessageItem extends vscode.TreeItem {
    constructor(
        public readonly message: Message,
        public readonly annotationId: string,
    ) {
        super(message.text, vscode.TreeItemCollapsibleState.None);
        const date = new Date(message.createdAt);
        this.description = date.toLocaleString();
        this.contextValue = 'message';
        this.iconPath = new vscode.ThemeIcon('comment');
    }
}

export class SidebarProvider implements vscode.TreeDataProvider<AnnotationItem | MessageItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private store: AnnotationStore) {
        store.onDidChange(() => this._onDidChangeTreeData.fire());
    }

    getTreeItem(element: AnnotationItem | MessageItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: AnnotationItem | MessageItem): (AnnotationItem | MessageItem)[] {
        if (!element) {
            return this.store.getAnnotations().map(a => new AnnotationItem(a));
        }
        if (element instanceof AnnotationItem) {
            return element.annotation.thread.map(
                m => new MessageItem(m, element.annotation.id)
            );
        }
        return [];
    }
}
