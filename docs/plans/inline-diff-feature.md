# Goal Description

The goal is to enhance the Review Mode with inline diff capabilities. This includes:
1. **UI Controls**: Adding a secondary toolbar below the main "Comments" and "History" tabs to house context-sensitive diff controls.
2. **Version Selection**: Allowing users to select any two specific versions of the file from the History tab to compute and display an inline diff in the code pane. The user can only diff within the same history mode (Git vs Git, or Review vs Review).
3. **Standard Diff Presentation**: Using standard red/green background highlighting for added and deleted lines within the existing code view.
4. **Contextual JSON Storage**: When a user adds a comment while diff mode is active, if the comment targets a line/block containing a diff, we will capture and store the `previousVersionContext` and `currentVersionContext` of that text within the JSON annotation structure. This provides invaluable context to AI assistants interpreting the comments later.

## Proposed Changes

### 1. Update Annotation Schema
Update `src/annotationStore.ts` to include the two new fields for diff context.

#### [MODIFY] src/annotationStore.ts
Update the `Annotation` interface to store the diff contexts:
```typescript
export interface Annotation {
    id: string;
    startLine: number;
    endLine: number;
    textPreview: string;
    priority: Priority;
    status: Status;
    thread: Message[];
    deletedLine?: boolean;
    // New fields for diff context
    previousVersionContext?: string;
    currentVersionContext?: string;
}
```

### 2. Update Webview UI
Update `src/webviewPanel.ts` and associated media files (`review.html` / `review.js` / `review.css`) to handle the new toolbar and diff features.

#### [MODIFY] src/webviewPanel.ts
- **Git Availability Check**: The backend must check if the workspace is a valid Git repository and pass this boolean flag to the Webview on initialization.
- **Secondary Toolbar**: Inject a new row of controls directly below the `[COMMENTS | HISTORY]` tabs. The contents of this toolbar will dynamically switch based on the active tab.
  - **In "Comments" Tab**: 
    - A "Diff Mode" toggle (On/Off).
    - A "Local / Git" toggle to select the source of the history. This toggle is disabled/greyed-out until "Diff Mode" is turned ON. **Furthermore, the "Git" option is permanently disabled if Git is not available in the workspace.** A tooltip will be added stating: *"Git diffs are only available when Git is enabled for the current repository."*
  - **In "History" Tab**:
    - The same "Local / Git" history toggle (with the same Git availability restrictions and tooltip).
- **Version Selection UX (History Tab)**: 
  - Every history item will have a **Pin icon** representing the "Base" version for diffs.
  - **Default Behavior**: The pin will be ON by default for the *previous* version of the file (the second-to-latest item in the history list, whether in Git or Review mode).
  - Pinning another version explicitly will "unpin" the previously pinned version and set the newly clicked one as the Base.
  - The currently clicked/highlighted history item serves as the "Target" (new version).
- **Diff Presentation**: Update `renderMarkdownDocument` and the code highlighter logic to support rendering deleted lines (red background) and added lines (green background) using standard diff presentation based on the diff data provided to the webview.
- **Note Context**: Update the `addNote` message payload to include the diff context from the frontend if a diff is present on the selected line.

### 3. Diff Computation Logic
We will use the standard `diff` npm package to compute the differences between the selected versions.

#### [MODIFY] package.json
- Run `npm install diff` and `npm install --save-dev @types/diff` to add the dependency.

#### [MODIFY] src/reviewMode.ts
- Implement logic to fetch the specific base and compare file contents based on the user's selection:
  - **Git History**: Retrieve Git history for the file using `git log` and use `git show <commit-hash>:path/to/file` to get the contents.
  - **Review Mode History**: Read the corresponding `.revX.md` snapshot files.
- Compute the differences using the `diff` package (`diffLines`).
- Pass the structured diff data down to the `ReviewWebviewPanel` to be overlaid on the source text in the UI.

## Verification Plan

### Automated/Manual Verification
1. Open a file in Review Mode.
2. In the Comments tab, verify the presence of the secondary toolbar with "Diff Mode" (Off) and "Local / Git" (disabled).
3. Toggle "Diff Mode" ON. Verify "Local / Git" becomes enabled (if Git is available).
4. Verify the tooltip on the "Git" toggle explicitly states the Git requirement.
5. Navigate to the History tab.
6. Verify that the second-to-latest version is pinned by default.
7. Pin a different older version using the pin icon. Select a newer version as target.
8. Verify that the code pane updates to show the inline diff with standard red/green highlighting.
9. Add a comment on a line that has a diff.
10. Inspect the `revX.json` file in the `.revisions` directory to verify that `previousVersionContext` and `currentVersionContext` are populated correctly with the diff text.
