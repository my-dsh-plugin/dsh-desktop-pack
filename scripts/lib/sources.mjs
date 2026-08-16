import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const CACHE_DIR = resolve(ROOT, '.cache/sources')
export const LOCK_FILE = resolve(ROOT, 'sources.lock.json')

export function readJson(file) {
  return JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'))
}

export function loadSourceEntries() {
  const harness = readJson('harness-source.json')
  const builtin = readJson('builtin-sources.json')
  const entries = []
  entries.push(normalizeEntry({
    id: 'harness',
    kind: harness.source.kind,
    repo: harness.source.repo,
    ref: harness.source.ref,
    commit: harness.source.commit,
    path: harness.source.path ?? '.',
    checkout: harness.source.checkout,
  }))

  const modes = builtin.modes
  entries.push(normalizeEntry({
    id: 'modes',
    kind: modes.kind,
    repo: modes.repo,
    ref: modes.ref,
    commit: modes.commit,
    path: modes.path ?? '.',
  }))

  for (const plugin of builtin.plugins ?? []) {
    entries.push(normalizeEntry({
      id: plugin.id,
      kind: plugin.kind,
      repo: plugin.repo,
      ref: plugin.ref,
      commit: plugin.commit,
      path: plugin.path ?? '.',
    }))
  }
  return entries
}

export function normalizeEntry(entry) {
  const id = entry.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('source entry requires id')
  const kind = entry.kind ?? 'git'
  const checkout = typeof entry.checkout === 'string'
    ? (isAbsolute(entry.checkout) ? entry.checkout : resolve(CACHE_DIR, entry.checkout))
    : resolve(CACHE_DIR, id)
  if (kind === 'git') {
    if (typeof entry.repo !== 'string' || entry.repo.length === 0) throw new Error(`${id}: git source requires repo`)
    if (typeof entry.ref !== 'string' || entry.ref.length === 0) throw new Error(`${id}: git source requires ref`)
    if (typeof entry.commit !== 'string' || entry.commit.length === 0) throw new Error(`${id}: git source requires commit`)
    return { ...entry, kind, checkout }
  }
  if (kind === 'local') {
    if (typeof entry.path !== 'string' || !isAbsolute(entry.path)) {
      throw new Error(`${id}: local source requires an absolute path`)
    }
    return { ...entry, kind, checkout: resolve(entry.path) }
  }
  if (kind === 'npm') {
    if (typeof entry.package !== 'string' || typeof entry.version !== 'string') {
      throw new Error(`${id}: npm source requires package and version`)
    }
    return { ...entry, kind, checkout: resolve(CACHE_DIR, id) }
  }
  throw new Error(`${id}: unsupported source kind ${JSON.stringify(kind)}`)
}

function windowsCommandLine(command, args) {
  const quote = (value) => {
    const text = String(value)
    if (/[\s"&|<>^%!]/.test(text)) return `"${text.replaceAll('"', '\\"')}"`
    return text
  }
  return [command, ...args].map(quote).join(' ')
}

export function copyTree(source, destination, options = {}) {
  const info = lstatSync(source)
  const filter = options.filter ?? (() => true)
  if (filter(source) === false) return
  if (info.isSymbolicLink()) {
    mkdirSync(dirname(destination), { recursive: true })
    const target = readlinkSync(source)
    if (process.platform === 'win32') {
      let type = 'file'
      try {
        type = statSync(join(dirname(source), target)).isDirectory() ? 'junction' : 'file'
      } catch {
        type = 'file'
      }
      symlinkSync(target, destination, type)
    } else {
      symlinkSync(target, destination)
    }
    return
  }
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      copyTree(join(source, entry.name), join(destination, entry.name), options)
    }
    return
  }
  if (info.isFile()) {
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
    return
  }
  throw new Error(`copyTree does not support ${source}`)
}

export function run(command, args, options = {}) {
  const { cwd = ROOT, stdio = 'inherit', env = process.env } = options
  const childEnv = ['pnpm', 'npm', 'npx'].includes(command)
    ? { ...env, npm_config_auto_install_peers: env.npm_config_auto_install_peers ?? 'true' }
    : env
  let executable = command
  let spawnArgs = args
  let shell = false
  if (process.platform === 'win32' && ['pnpm', 'npm', 'npx'].includes(command)) {
    executable = windowsCommandLine(command, args)
    spawnArgs = []
    shell = true
  }
  const result = spawnSync(executable, spawnArgs, { cwd, stdio, env: childEnv, shell })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed with exit code ${String(result.status)}`)
  }
  return result
}

export function git(args, options = {}) {
  return run('git', args, options)
}

export function ensureCacheDir() {
  mkdirSync(CACHE_DIR, { recursive: true })
}

export function resolveCheckout(checkout) {
  return isAbsolute(checkout) ? checkout : resolve(ROOT, checkout)
}

export function readLock() {
  return existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, 'utf8')) : { schemaVersion: 1, sources: {} }
}

export function writeLock(lock) {
  writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + '\n')
}
