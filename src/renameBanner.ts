import * as path from 'path'

import { Uri, Disposable, Range, MarkdownString, CommentController, CommentThread,
         CommentMode, CommentThreadCollapsibleState, TabInputTextDiff, comments, window } from 'vscode'
import { NAMESPACE } from './constants'

/**
 * Formats a rename in git's compact notation, keeping the path segments that
 * both paths share and only spelling out the part that changed,
 * e.g. `src/{components → widgets}/Button.tsx`.
 */
export function formatRenamedPath(srcRelPath: string, dstRelPath: string): string {
    const src = srcRelPath.split(/[\\/]/);
    const dst = dstRelPath.split(/[\\/]/);
    const maxCommon = Math.min(src.length, dst.length);

    let prefix = 0;
    while (prefix < maxCommon && src[prefix] === dst[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (suffix < maxCommon - prefix && src[src.length - 1 - suffix] === dst[dst.length - 1 - suffix]) {
        suffix++;
    }

    const srcMiddle = src.slice(prefix, src.length - suffix).join('/');
    const dstMiddle = dst.slice(prefix, dst.length - suffix).join('/');
    return [
        ...src.slice(0, prefix),
        `{${srcMiddle} → ${dstMiddle}}`,
        ...src.slice(src.length - suffix),
    ].join('/');
}

/**
 * Shows a read-only banner at the top of a diff editor that displays a renamed
 * file, so that the old and new location are visible without hovering the tree.
 * The banner is implemented as a non-replyable comment thread on the modified
 * side and is removed again once the last diff editor showing it is closed.
 */
export class RenameBanner implements Disposable {
    private readonly controller: CommentController;
    private readonly threads = new Map<string, CommentThread>();
    private readonly disposables: Disposable[] = [];

    constructor() {
        this.controller = comments.createCommentController(NAMESPACE + '.renames', 'Git Tree Compare');
        this.disposables.push(this.controller);
        this.disposables.push(window.tabGroups.onDidChangeTabs(() => this.removeClosedBanners()));
    }

    show(modifiedUri: Uri, repoRoot: string, srcAbsPath: string, dstAbsPath: string, isPureRename: boolean) {
        const srcRelPath = toDisplayPath(path.relative(repoRoot, srcAbsPath));
        const dstRelPath = toDisplayPath(path.relative(repoRoot, dstAbsPath));

        const body = new MarkdownString();
        body.appendMarkdown(isPureRename ? '**Renamed** (content unchanged): ' : '**Renamed and modified**: ');
        body.appendText(formatRenamedPath(srcRelPath, dstRelPath));
        body.appendCodeblock(`- ${srcRelPath}\n+ ${dstRelPath}`, 'diff');

        const key = modifiedUri.toString();
        this.threads.get(key)?.dispose();
        const thread = this.controller.createCommentThread(modifiedUri, new Range(0, 0, 0, 0), [{
            body,
            mode: CommentMode.Preview,
            author: { name: 'Git Tree Compare' },
        }]);
        thread.label = 'Renamed';
        thread.canReply = false;
        thread.collapsibleState = CommentThreadCollapsibleState.Expanded;
        this.threads.set(key, thread);
    }

    private removeClosedBanners() {
        const openModifiedUris = new Set<string>();
        for (const group of window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof TabInputTextDiff) {
                    openModifiedUris.add(tab.input.modified.toString());
                }
            }
        }
        for (const [key, thread] of this.threads) {
            if (!openModifiedUris.has(key)) {
                thread.dispose();
                this.threads.delete(key);
            }
        }
    }

    dispose() {
        this.threads.forEach(thread => thread.dispose());
        this.threads.clear();
        this.disposables.forEach(d => d.dispose());
    }
}

function toDisplayPath(relPath: string): string {
    return relPath.split(path.sep).join('/');
}
