import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import { ensureCacheDir, git, loadSourceEntries, readLock, ROOT, writeLock } from './lib/sources.mjs'

const verifyOnly = process.argv.includes('--verify')

function gitStatus(cwd) {
  try {
    const out = git(['status', '--porcelain=v1'], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
    return String(out.stdout ?? '').trim()
  } catch {
    return ''
  }
}

function fetchGit(entry) {
  const { id, repo, ref, commit, checkout } = entry
  ensureCacheDir()
  if (!existsSync(checkout)) {
    console.log(`[sources] clone ${id}: ${repo}`)
    git(['clone', '--filter=blob:none', '--no-checkout', repo, checkout])
  }
  console.log(`[sources] fetch ${id}: ${commit}`)
  const fetchedCommit = (() => {
    try {
      return git(['fetch', '--depth', '1', 'origin', commit], { cwd: checkout, stdio: 'ignore' }) ?? null
    } catch {
      return null
    }
  })()
  if (fetchedCommit === null) {
    git(['fetch', '--depth', '1', 'origin', ref], { cwd: checkout })
  }
  git(['checkout', '--detach', '--force', commit], { cwd: checkout })
  const actual = String(git(['rev-parse', 'HEAD'], { cwd: checkout, stdio: ['ignore', 'pipe', 'inherit'] }).stdout).trim()
  if (actual !== commit) {
    throw new Error(`${id}: resolved HEAD ${actual} does not match pinned commit ${commit}`)
  }
  const dirty = gitStatus(checkout)
  if (dirty !== '') {
    console.warn(`[sources] warning: ${id} checkout is not clean (${dirty.split('\n').length} path(s))`)
  }
  return actual
}

function fetchLocal(entry) {
  if (!existsSync(entry.checkout)) throw new Error(`${entry.id}: local source path does not exist: ${entry.checkout}`)
  return null
}

function fetchNpm(entry) {
  throw new Error(`${entry.id}: npm source kind is reserved; materialize it through the package manager before build`)
}

export function fetchEntry(entry) {
  if (entry.kind === 'git') return fetchGit(entry)
  if (entry.kind === 'local') return fetchLocal(entry)
  if (entry.kind === 'npm') return fetchNpm(entry)
  throw new Error(`${entry.id}: unsupported source kind ${entry.kind}`)
}

const entries = loadSourceEntries()
const lock = readLock()

if (verifyOnly) {
  let failed = false
  for (const entry of entries) {
    const recorded = lock.sources?.[entry.id]?.commit
    if (entry.kind === 'local') continue
    if (recorded !== entry.commit) {
      console.error(`[sources] mismatch ${entry.id}: lock=${String(recorded)} manifest=${entry.commit}`)
      failed = true
    }
  }
  if (failed) process.exit(1)
  console.log('[sources] verify OK')
  process.exit(0)
}

for (const entry of entries) {
  const commit = fetchEntry(entry)
  lock.sources[entry.id] = {
    kind: entry.kind,
    repo: entry.repo ?? null,
    ref: entry.ref ?? null,
    commit: commit ?? entry.commit ?? null,
    checkout: entry.kind === 'local' ? entry.checkout : relative(ROOT, entry.checkout),
  }
}
delete lock.updatedAt
writeLock(lock)
console.log('[sources] fetch complete -> sources.lock.json')
