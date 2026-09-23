/**
 * @module project-helper
 * Utilities for automatic project scope resolution and worktree freshness checks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

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

  // 2. Try git top-level directory
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 1000
    }).trim();
    if (gitRoot) {
      return path.basename(gitRoot);
    }
  } catch (_) {}

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
 * Checks the git working tree for uncommitted or unstaged changes.
 * @param {string} [cwd=process.cwd()]
 * @returns {{isDirty: boolean, modifiedCount: number, message: string|null}}
 */
export function getWorktreeStatus(cwd = process.cwd()) {
  try {
    const output = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 2000
    }).trim();

    if (!output) {
      return { isDirty: false, modifiedCount: 0, message: null };
    }

    const lines = output.split('\n').filter(Boolean);
    const count = lines.length;
    return {
      isDirty: true,
      modifiedCount: count,
      message: `⚠️ ${count} uncommitted or modified file(s) in working tree.`
    };
  } catch (_) {
    return { isDirty: false, modifiedCount: 0, message: null };
  }
}
