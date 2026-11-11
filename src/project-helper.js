/**
 * @module project-helper
 * Utilities for automatic project scope resolution and worktree freshness checks.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Walks up parent directories from startDir to locate the nearest .git root.
 * Pure node:fs implementation (zero child_process / shell invocations).
 * @param {string} [startDir=process.cwd()]
 * @returns {string|null}
 */
export function findGitRoot(startDir = process.cwd()) {
  try {
    let curr = path.resolve(startDir);
    while (true) {
      if (fs.existsSync(path.join(curr, '.git'))) {
        return curr;
      }
      const parent = path.dirname(curr);
      if (parent === curr) {
        return null;
      }
      curr = parent;
    }
  } catch (_) {
    return null;
  }
}

/**
 * Resolves the actual git metadata directory (handling both standard .git dirs and worktree .git files).
 * @param {string} gitRoot
 * @returns {string|null}
 */
function resolveGitDir(gitRoot) {
  try {
    const gitPath = path.join(gitRoot, '.git');
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) {
      return gitPath;
    }
    if (stat.isFile()) {
      const content = fs.readFileSync(gitPath, 'utf8').trim();
      if (content.startsWith('gitdir:')) {
        return path.resolve(gitRoot, content.slice(7).trim());
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Automatically detects the active project name from environment, package.json, or git root.
 * @param {string} [cwd=process.cwd()]
 * @returns {string|null} Detected project name
 */
export function detectCurrentProject(cwd = process.cwd()) {
  if (process.env.ACTIVE_PROJECT && process.env.ACTIVE_PROJECT.trim()) {
    return process.env.ACTIVE_PROJECT.trim();
  }
  if (process.env.KRUSCH_PROJECT && process.env.KRUSCH_PROJECT.trim()) {
    return process.env.KRUSCH_PROJECT.trim();
  }

  // 1. Try package.json in cwd
  try {
    const pkgPath = path.resolve(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const raw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      if (pkg && pkg.name) {
        return pkg.name.replace(/^@[^/]+\//, '');
      }
    }
  } catch (_) {}

  // 2. Try git top-level directory via pure-fs traversal
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    return path.basename(gitRoot);
  }

  // 3. Fallback to folder basename
  try {
    const base = path.basename(path.resolve(cwd));
    if (base && base !== '.' && base !== '/') {
      return base;
    }
  } catch (_) {}

  return null;
}

/**
 * Checks the git working tree for uncommitted or modified tracked files by inspecting
 * the binary .git/index header/entries directly via node:fs (zero shell / child_process calls).
 * @param {string} [cwd=process.cwd()]
 * @returns {{isDirty: boolean, modifiedCount: number, message: string|null}}
 */
export function getWorktreeStatus(cwd = process.cwd()) {
  try {
    const gitRoot = findGitRoot(cwd);
    if (!gitRoot) {
      return { isDirty: false, modifiedCount: 0, message: null };
    }
    const gitDir = resolveGitDir(gitRoot);
    if (!gitDir) {
      return { isDirty: false, modifiedCount: 0, message: null };
    }
    const indexPath = path.join(gitDir, 'index');
    if (!fs.existsSync(indexPath)) {
      return { isDirty: false, modifiedCount: 0, message: null };
    }

    const buf = fs.readFileSync(indexPath);
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'DIRC') {
      return { isDirty: false, modifiedCount: 0, message: null };
    }

    const version = buf.readUInt32BE(4);
    const entryCount = buf.readUInt32BE(8);
    let offset = 12;
    let count = 0;

    for (let i = 0; i < entryCount && offset + 62 <= buf.length; i++) {
      const entryStart = offset;
      const mtimeSec = buf.readUInt32BE(offset + 8);
      const size = buf.readUInt32BE(offset + 36);
      const flags = buf.readUInt16BE(offset + 60);
      const extended = version >= 3 && (flags & 0x4000) !== 0;
      const nameStart = offset + (extended ? 64 : 62);
      let nameEnd = nameStart;
      while (nameEnd < buf.length && buf[nameEnd] !== 0) {
        nameEnd++;
      }
      const relPath = buf.toString('utf8', nameStart, nameEnd);
      const fullPath = path.join(gitRoot, relPath);
      try {
        const fstat = fs.lstatSync(fullPath);
        if (!fstat.isSymbolicLink()) {
          if ((fstat.size >>> 0) !== size || Math.floor(fstat.mtimeMs / 1000) !== mtimeSec) {
            count++;
          }
        }
      } catch (_) {
        count++;
      }
      const entryLen = (nameEnd - entryStart + 8) & ~7;
      offset = entryStart + entryLen;
    }

    if (count === 0) {
      return { isDirty: false, modifiedCount: 0, message: null };
    }

    return {
      isDirty: true,
      modifiedCount: count,
      message: `⚠️ ${count} uncommitted or modified file(s) in working tree.`
    };
  } catch (_) {
    return { isDirty: false, modifiedCount: 0, message: null };
  }
}
