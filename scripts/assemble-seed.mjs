import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readJson, readLock, resolveCheckout, ROOT } from './lib/sources.mjs'

const builtin = readJson('builtin-sources.json')
const lock = readLock()
const seedRoot = resolve(ROOT, 'out/seed-dsh-home')
rmSync(seedRoot, { recursive: true, force: true })

// 1. Modes from dsh-presets.
const modesSource = lock.sources.modes
if (!modesSource?.checkout) {
  console.error('modes source not fetched yet; run: pnpm run sources:fetch')
  process.exit(1)
}
const modesCheckout = resolveCheckout(modesSource.checkout)
if (!existsSync(modesCheckout)) {
  console.error(`modes checkout missing: ${modesCheckout}`)
  process.exit(1)
}
const presetsDir = join(seedRoot, '.agent-presets')
for (const mode of builtin.modes.include ?? []) {
  const from = join(modesCheckout, mode)
  if (!existsSync(from)) {
    console.error(`mode ${mode} not found in ${modesCheckout}`)
    process.exit(1)
  }
  const to = join(presetsDir, mode)
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true, filter: (src) => !src.includes('/.git/') })
  console.log(`[seed] mode ${mode} -> ${to}`)
}

// 2. Web profile with bundled plugin bundles.
const profileDir = join(seedRoot, 'profiles/web')
mkdirSync(profileDir, { recursive: true })

const coreBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const pluginBundles = (builtin.plugins ?? []).map((plugin) => plugin.bundleName ?? plugin.packageName ?? plugin.id)
const profileManifest = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: [...coreBundles, ...pluginBundles],
    },
  },
}
writeFileSync(join(profileDir, 'package.json'), JSON.stringify(profileManifest, null, 2) + '\n')
writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

const profileModules = join(profileDir, 'node_modules')
mkdirSync(profileModules, { recursive: true })
for (const plugin of builtin.plugins ?? []) {
  const packageName = plugin.packageName
  if (!packageName) continue
  const built = join(ROOT, 'out/plugins', plugin.id, packageName)
  if (!existsSync(built)) {
    console.error(`plugin ${plugin.id} not built yet; run: pnpm run build:plugins`)
    process.exit(1)
  }
  const to = join(profileModules, packageName)
  rmSync(to, { recursive: true, force: true })
  cpSync(built, to, { recursive: true })
  console.log(`[seed] plugin ${packageName} -> ${to}`)
}

// The bundled plugins' runtime dependencies (tar, https-proxy-agent, ...) are
// NOT part of the dsh app closure, so DSH's boot-time flat module fallback
// ($DSH_HOME/profiles/node_modules) never links them, and the profile plugins
// fail to boot on every platform ("Cannot find package 'tar'"). Copy each
// plugin's non-closure runtime-dependency surface from the harness runtime
// (already --prod-installed with the plugins, so versions match what package
// resolution picked) into the profile's own node_modules — exactly where pnpm
// would hoist them for an out-of-tree plugin. Names in the dsh closure are
// deliberately left to the flat fallback: @deepseek-ai/dsh-* peers and the
// vendored @deepseek-ai/cordis / schemastery must keep resolving to the bundled
// harness copies (single cordis instance, fork patches intact).
function packageDirFromAnchor(anchor, packageName) {
  for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** Plain dependency names of a manifest: dependencies + optionalDependencies, peers excluded. */
function plainDependencyNames(manifest) {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]
}

/** The flat-fallback name set: the dsh app's dependency+peer BFS closure. */
function harnessClosure(harnessRoot) {
  const anchor = join(harnessRoot, 'node_modules/@deepseek-ai/dsh/package.json')
  if (!existsSync(anchor)) {
    throw new Error(`harness runtime missing @deepseek-ai/dsh: ${anchor}`)
  }
  const closure = new Set()
  const queue = [{ anchor, manifest: JSON.parse(readFileSync(anchor, 'utf8')) }]
  while (queue.length > 0) {
    const { anchor: currentAnchor, manifest } = queue.shift()
    closure.add(manifest.name)
    for (const dep of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]) {
      if (closure.has(dep)) continue
      const dir = packageDirFromAnchor(currentAnchor, dep)
      if (dir === undefined) continue
      const manifestPath = join(dir, 'package.json')
      closure.add(dep)
      queue.push({ anchor: manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) })
    }
  }
  return closure
}

function copyPluginRuntimeDependencies() {
  const harnessCurrentPath = join(ROOT, 'out/harness/current.json')
  if (!existsSync(harnessCurrentPath)) {
    console.warn('[seed] warn: out/harness/current.json missing; plugin runtime deps not bundled (run package:harness first)')
    return
  }
  const harnessCurrent = JSON.parse(readFileSync(harnessCurrentPath, 'utf8'))
  if (typeof harnessCurrent.version !== 'string') {
    console.warn(`[seed] warn: harness current.json has no version (${JSON.stringify(harnessCurrent)}); plugin runtime deps not bundled`)
    return
  }
  const harnessRoot = join(ROOT, 'out/harness/versions', harnessCurrent.version)
  let closure
  try {
    closure = harnessClosure(harnessRoot)
  } catch (error) {
    console.warn(`[seed] warn: ${error.message}; plugin runtime deps not bundled`)
    return
  }
  const anchor = join(harnessRoot, 'node_modules/@deepseek-ai/dsh/package.json')
  const pending = []
  for (const plugin of builtin.plugins ?? []) {
    if (!plugin.packageName) continue
    const built = join(ROOT, 'out/plugins', plugin.id, plugin.packageName)
    if (!existsSync(join(built, 'package.json'))) continue
    const manifest = JSON.parse(readFileSync(join(built, 'package.json'), 'utf8'))
    for (const dep of plainDependencyNames(manifest)) {
      if (!closure.has(dep)) pending.push(dep)
    }
  }
  const copies = new Map()
  const visited = new Set()
  while (pending.length > 0) {
    const name = pending.shift()
    if (closure.has(name) || visited.has(name)) continue
    visited.add(name)
    const dir = packageDirFromAnchor(anchor, name)
    if (dir === undefined) {
      console.warn(`[seed] warn: plugin runtime dep ${name} not found in harness runtime; skipped`)
      continue
    }
    copies.set(name, dir)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    for (const dep of plainDependencyNames(manifest)) {
      if (!closure.has(dep) && !visited.has(dep)) pending.push(dep)
    }
  }
  for (const [name, dir] of copies) {
    const to = join(profileModules, name)
    rmSync(to, { recursive: true, force: true })
    mkdirSync(join(to, '..'), { recursive: true })
    cpSync(dir, to, { recursive: true })
    console.log(`[seed] plugin runtime dep ${name} -> ${to}`)
  }
  if (copies.size > 0) {
    console.log('[seed] plugin runtime deps bundled in the profile; dsh-* peers still resolve through the flat module fallback')
  }
}
copyPluginRuntimeDependencies()

console.log(`[seed] assembled -> ${seedRoot}`)
console.log('[seed] plugin runtime dependencies resolve through DSH profile module fallback to the harness closure')
