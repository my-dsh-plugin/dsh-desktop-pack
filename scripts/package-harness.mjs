import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readJson, readLock, resolveCheckout, run, ROOT } from './lib/sources.mjs'

const manifest = readJson('harness-source.json')
const lock = readLock()
const source = lock.sources.harness
if (!source) {
  console.error('harness source not fetched yet; run: pnpm run sources:fetch')
  process.exit(1)
}
const checkout = resolveCheckout(source.checkout)
if (!existsSync(checkout)) {
  console.error(`harness checkout missing: ${checkout}`)
  process.exit(1)
}
const version = manifest.version
if (typeof version !== 'string' || !/^\d{8}\.\d+$/.test(version)) {
  console.error(`harness-source.json requires a valid yyyyMMdd.n version, got ${JSON.stringify(version)}`)
  process.exit(1)
}

const outRoot = resolve(ROOT, 'out/harness')
const target = join(outRoot, 'versions', version)
const workspaceTarballs = join(outRoot, 'workspace-tarballs')

console.log(`[package] harness ${version} -> ${target}`)
rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })
mkdirSync(target, { recursive: true })
mkdirSync(workspaceTarballs, { recursive: true })

// The pinned fork carries local core patches (settings namespace exposure and
// workspace unarchive/delete APIs). Pack every public fork package and install
// the dsh production closure from those tarballs; otherwise pnpm resolves the
// peer dependency graph from the public registry and loses the patched builds.
function packWorkspacePackages() {
  console.log('[package] list fork workspace packages')
  const listResult = run('pnpm', ['-r', 'list', '--depth', '-1', '--json'], {
    cwd: checkout,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const packages = JSON.parse(String(listResult.stdout ?? '[]'))
    .filter((entry) => {
      if (Boolean(entry.private) === true || String(entry.name).startsWith('@deepseek-ai/') === false) return false
      const manifestPath = join(entry.path, 'package.json')
      if (existsSync(manifestPath) === false) return true
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const compatible = (field) => {
        const allowed = manifest[field]
        return Array.isArray(allowed) === false || allowed.length === 0
          || allowed.includes(field === 'os' ? process.platform : process.arch)
      }
      if (compatible('os') && compatible('cpu')) return true
      console.log(`[package] skip ${entry.name} (os=${JSON.stringify(manifest.os)} cpu=${JSON.stringify(manifest.cpu)}, host=${process.platform}-${process.arch})`)
      return false
    })
  const byName = new Map()
  let index = 0
  for (const entry of packages) {
    const name = String(entry.name)
    const file = `${String(index).padStart(4, '0')}-${name.replace(/[^a-zA-Z0-9._-]/g, '-')}.tgz`
    index += 1
    console.log(`[package] pack ${name} -> ${file}`)
    run('pnpm', ['--filter', name, 'pack', '--out', join(workspaceTarballs, file)], { cwd: checkout })
    byName.set(name, file)
  }
  writeFileSync(join(workspaceTarballs, 'packages.json'), JSON.stringify(Object.fromEntries(byName), null, 2) + '\n')
  return { packages, files: byName }
}

function collectWorkspaceClosure(packages, rootName) {
  const byName = new Map(packages.map((entry) => [String(entry.name), entry]))
  const closure = new Set()
  const queue = [rootName]
  while (queue.length > 0) {
    const name = queue.shift()
    if (byName.has(name) === false || closure.has(name)) continue
    closure.add(name)
    const manifestPath = join(byName.get(name).path, 'package.json')
    if (existsSync(manifestPath) === false) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const section of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
      if (section === undefined) continue
      for (const dependency of Object.keys(section)) {
        if (byName.has(dependency) && closure.has(dependency) === false) queue.push(dependency)
      }
    }
  }
  return closure
}

const { packages: workspacePackages, files: workspacePackageFiles } = packWorkspacePackages()
const workspaceClosure = collectWorkspaceClosure(workspacePackages, '@deepseek-ai/dsh')

const installRoot = target
const builtin = readJson('builtin-sources.json')
const dshTarball = workspacePackageFiles.get('@deepseek-ai/dsh')
if (!dshTarball) throw new Error('@deepseek-ai/dsh was not found in fork workspace package list')
const dependencies = {}
for (const name of workspaceClosure) {
  const file = workspacePackageFiles.get(name)
  if (file === undefined) continue
  dependencies[name] = `file:../../workspace-tarballs/${file}`
}
for (const plugin of builtin.plugins ?? []) {
  const packageName = plugin.packageName
  if (!packageName) {
    console.warn(`[package] plugin ${plugin.id} has no packageName; skipped from harness runtime`)
    continue
  }
  const pluginTarball = join(ROOT, 'out/plugins', `${plugin.id}.tgz`)
  if (!existsSync(pluginTarball)) {
    console.error(`plugin tarball missing: ${pluginTarball}; run npm run build:plugins first`)
    process.exit(1)
  }
  dependencies[packageName] = `file:../../../plugins/${plugin.id}.tgz`
}
const manifestPath = join(installRoot, 'package.json')
writeFileSync(manifestPath, JSON.stringify({
  name: `harness-runtime-${version}`,
  private: true,
  dependencies,
}, null, 2) + '\n')

const overrideLines = []
for (const [name, file] of workspacePackageFiles) {
  if (name === '@deepseek-ai/dsh') continue
  overrideLines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(`file:../../workspace-tarballs/${file}`)}`)
}
const subprocessLocalFile = workspacePackageFiles.get('@deepseek-ai/dsh-subprocess-local')
const subprocessLocalBuildLine = subprocessLocalFile === undefined ? '' : `  ${JSON.stringify(`@deepseek-ai/dsh-subprocess-local@file:../../workspace-tarballs/${subprocessLocalFile}`)}: true\n`
writeFileSync(join(installRoot, 'pnpm-workspace.yaml'), `packages:
  - .

autoInstallPeers: true
nodeLinker: hoisted

overrides:
${overrideLines.join('\n')}

allowBuilds:
  esbuild: true
  node-pty: true
  koffi: true
  '@deepseek-ai/dsh-subprocess-local': true
${subprocessLocalBuildLine}  '@google/genai': false
  protobufjs: false
  node-addon-require-builtin: false
`)

console.log('[package] install production closure')
run('pnpm', ['install', '--prod', '--registry=https://registry.npmjs.org/'], {
  cwd: installRoot,
  env: { ...process.env, npm_config_registry: 'https://registry.npmjs.org/' },
})

const bin = join(installRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
if (!existsSync(bin)) {
  throw new Error(`expected harness bin not found: ${bin}`)
}

console.log('[package] smoke: dsh web --dump-config')
const smokeHome = mkdtempSync(join(tmpdir(), 'dsh-pack-smoke-'))
try {
  run(process.execPath, [bin, 'web', '--dump-config'], {
    cwd: installRoot,
    env: { ...process.env, DSH_HOME: smokeHome },
  })
} finally {
  rmSync(smokeHome, { recursive: true, force: true })
}

writeFileSync(join(outRoot, 'current.json'), JSON.stringify({ version }, null, 2) + '\n')
console.log(`[package] harness ready: ${target}`)
