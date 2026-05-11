import * as cp from 'child_process';
import * as util from 'util';
import * as path from 'path';

const execFileAsync = util.promisify(cp.execFile);

export interface GitCommit {
    hash: string;         // full SHA
    shortHash: string;    // 7-char SHA
    message: string;      // first line of commit message
    relativeDate: string; // e.g. "3 days ago"
    timestamp: string;    // ISO 8601
}

async function execGit(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
}

/** Returns true if the file is inside a git repository. */
export async function isGitRepo(filePath: string): Promise<boolean> {
    try {
        const dir = path.dirname(filePath);
        const result = await execGit(['rev-parse', '--is-inside-work-tree'], dir);
        return result === 'true';
    } catch {
        return false;
    }
}

/** Returns the absolute path to the git repo root for the given file. */
export async function getGitRepoRoot(filePath: string): Promise<string> {
    const dir = path.dirname(filePath);
    return execGit(['rev-parse', '--show-toplevel'], dir);
}

/** Returns the path of the file relative to the git repo root. */
export async function getGitRelativePath(filePath: string, repoRoot: string): Promise<string> {
    const dir = path.dirname(filePath);
    const result = await execGit(['ls-files', '--full-name', filePath], dir);
    if (result) { return result; }
    return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

/**
 * Returns up to `limit` commits that touched the file, starting at `skip`.
 * Fields within each record are separated by \x1F (unit separator).
 */
export async function getGitHistory(
    filePath: string,
    skip: number,
    limit: number,
): Promise<GitCommit[]> {
    const dir = path.dirname(filePath);
    const raw = await execGit(
        [
            'log', '--follow',
            '--format=%H\x1F%h\x1F%s\x1F%ar\x1F%aI',
            `--max-count=${limit}`,
            `--skip=${skip}`,
            '--',
            filePath,
        ],
        dir,
    );
    if (!raw) { return []; }
    return raw.split('\n').filter(Boolean).map(line => {
        const [hash, shortHash, message, relativeDate, timestamp] = line.split('\x1F');
        return { hash, shortHash, message, relativeDate, timestamp };
    });
}

/** Returns the file content at a specific git commit. */
export async function getGitFileContent(
    repoRoot: string,
    commitHash: string,
    relPath: string,
): Promise<string> {
    return execGit(['show', `${commitHash}:${relPath}`], repoRoot);
}

/**
 * Returns true if the file has uncommitted changes relative to HEAD.
 * Also returns true when HEAD doesn't exist yet (fresh repo).
 */
export async function hasUncommittedChanges(filePath: string): Promise<boolean> {
    try {
        const dir = path.dirname(filePath);
        await execFileAsync('git', ['diff', '--quiet', 'HEAD', '--', filePath], { cwd: dir });
        return false; // exit 0 = clean
    } catch {
        return true;  // exit non-zero = dirty or no HEAD
    }
}
