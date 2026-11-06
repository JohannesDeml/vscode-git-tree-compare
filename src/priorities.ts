import * as path from 'path'

import { Uri, workspace, ConfigurationTarget, WorkspaceFolder } from 'vscode'
import { NAMESPACE } from './constants'

export type Priority = 'veryHigh' | 'high' | 'default' | 'low';

/** All priorities, from most to least important. */
export const PRIORITIES: readonly Priority[] = ['veryHigh', 'high', 'default', 'low'];

export const PRIORITY_LABELS: { readonly [P in Priority]: string } = {
    veryHigh: 'Very High',
    high: 'High',
    default: 'Default',
    low: 'Low',
};

export const PRIORITIES_SETTING = 'priorities';
export const VISIBLE_PRIORITIES_SETTING = 'visiblePriorities';

export type PriorityMap = { [pattern: string]: Priority };

export function isPriority(value: unknown): value is Priority {
    return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

interface PathRule {
    path: string;
    depth: number;
    priority: Priority;
}

interface GlobRule {
    regex: RegExp;
    matchBasename: boolean;
    priority: Priority;
}

/**
 * Resolves the priority of repository-relative paths from a {@link PriorityMap}.
 *
 * The most specific rule wins:
 * 1. a path that names the file itself,
 * 2. a glob pattern (containing `*`, `?` or `{}`), the first matching one;
 *    a glob without a `/` is matched against the file name,
 * 3. a folder path containing the file, the deepest one.
 * This lets globs like `**\/*.generated.cs` win over folder assignments, while
 * a file can still be assigned individually.
 */
export class PriorityRules {
    private readonly pathRules: PathRule[] = [];
    private readonly globRules: GlobRule[] = [];

    constructor(readonly map: PriorityMap) {
        for (const [rawPattern, priority] of Object.entries(map)) {
            if (!isPriority(priority)) {
                continue;
            }
            const pattern = normalizePattern(rawPattern);
            if (!pattern) {
                continue;
            }
            if (/[*?{}]/.test(pattern)) {
                this.globRules.push({
                    regex: globToRegExp(pattern),
                    matchBasename: !pattern.includes('/'),
                    priority,
                });
            } else {
                this.pathRules.push({ path: pattern, depth: pattern.split('/').length, priority });
            }
        }
    }

    get isEmpty(): boolean {
        return this.pathRules.length === 0 && this.globRules.length === 0;
    }

    getPriority(relPath: string): Priority {
        relPath = normalizePattern(relPath);
        const exact = this.pathRules.find(rule => rule.path === relPath);
        if (exact) {
            return exact.priority;
        }
        const basename = relPath.substring(relPath.lastIndexOf('/') + 1);
        for (const rule of this.globRules) {
            if (rule.regex.test(rule.matchBasename ? basename : relPath)) {
                return rule.priority;
            }
        }
        let folder: PathRule | undefined;
        for (const rule of this.pathRules) {
            if (relPath.startsWith(rule.path + '/') && (!folder || rule.depth > folder.depth)) {
                folder = rule;
            }
        }
        return folder ? folder.priority : 'default';
    }

    /** Returns a copy of the map with `relPath` assigned to `priority`, keeping the map minimal. */
    withAssignment(relPath: string, priority: Priority): PriorityMap {
        const key = normalizePattern(relPath);
        const map: PriorityMap = { ...this.map };
        for (const existing of Object.keys(map)) {
            if (normalizePattern(existing) === key) {
                delete map[existing];
            }
        }
        // Only store the assignment if it is not already implied by another rule
        // (e.g. "default" for a file that no rule applies to).
        if (new PriorityRules(map).getPriority(key) !== priority) {
            map[key] = priority;
        }
        return map;
    }
}

/** Converts an absolute path into the repository-relative form used by priority rules. */
export function toPriorityPath(repoRoot: string, absPath: string): string {
    return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

function normalizePattern(pattern: string): string {
    return pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function globToRegExp(glob: string): RegExp {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                i++;
                if (glob[i + 1] === '/') {
                    i++;
                    re += '(?:.*/)?';
                } else {
                    re += '.*';
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '{') {
            re += '(?:';
        } else if (c === '}') {
            re += ')';
        } else if (c === ',' && re.lastIndexOf('(?:') > re.lastIndexOf(')')) {
            re += '|';
        } else {
            re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
        }
    }
    // A glob also covers everything inside the folders it matches.
    return new RegExp(`^${re}(?:/.*)?$`);
}

/**
 * Finds the workspace folder whose settings hold the priorities of a repository:
 * the folder containing the repository, or else the first folder inside it.
 */
export function getPriorityWorkspaceFolder(repoRoot: string): WorkspaceFolder | undefined {
    const containing = workspace.getWorkspaceFolder(Uri.file(repoRoot));
    if (containing) {
        return containing;
    }
    const prefix = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
    return workspace.workspaceFolders?.find(folder => folder.uri.fsPath.startsWith(prefix));
}

export function readPriorityRules(repoRoot: string): PriorityRules {
    const folder = getPriorityWorkspaceFolder(repoRoot);
    const config = workspace.getConfiguration(NAMESPACE, folder?.uri);
    return new PriorityRules(config.get<PriorityMap>(PRIORITIES_SETTING, {}) ?? {});
}

/**
 * Updates the priority assignments of a repository. They are stored in the
 * settings of the workspace folder the repository belongs to (its
 * `.vscode/settings.json`), or in the workspace settings otherwise.
 */
export async function writePriorityAssignments(repoRoot: string,
        assignments: { relPath: string, priority: Priority }[]): Promise<void> {
    const folder = getPriorityWorkspaceFolder(repoRoot);
    const config = workspace.getConfiguration(NAMESPACE, folder?.uri);
    const inspected = config.inspect<PriorityMap>(PRIORITIES_SETTING);
    const target = folder ? ConfigurationTarget.WorkspaceFolder : ConfigurationTarget.Workspace;
    const current = (folder ? inspected?.workspaceFolderValue : inspected?.workspaceValue) ?? {};

    let rules = new PriorityRules(current);
    for (const { relPath, priority } of assignments) {
        rules = new PriorityRules(rules.withAssignment(relPath, priority));
    }
    const map = rules.map;
    await config.update(PRIORITIES_SETTING, Object.keys(map).length > 0 ? map : undefined, target);
}

export function readVisiblePriorities(): Set<Priority> {
    const value = workspace.getConfiguration(NAMESPACE).get<unknown[]>(VISIBLE_PRIORITIES_SETTING, [...PRIORITIES]);
    const visible = new Set((Array.isArray(value) ? value : []).filter(isPriority));
    return visible.size > 0 ? visible : new Set(PRIORITIES);
}

export async function writeVisiblePriorities(visible: Priority[]): Promise<void> {
    const config = workspace.getConfiguration(NAMESPACE);
    const showAll = PRIORITIES.every(p => visible.includes(p));
    // Ordered from most to least important for readability in settings.json.
    const value = showAll ? undefined : PRIORITIES.filter(p => visible.includes(p));
    await config.update(VISIBLE_PRIORITIES_SETTING, value, ConfigurationTarget.Workspace);
}
