import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readJson, readLock, resolveCheckout, run, ROOT } from './lib/sources.mjs'

const manifest = readJson('harness-source.json')
const lock = readLock()
const source = lock.sources.harness
if (!source) {
  console.error('harness source not fetched yet; run: npm run sources:fetch')
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
const tarball = join(outRoot, `dsh-${version}.tgz`)

console.log(`[package] harness ${version} -> ${target}`)
rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })
mkdirSync(target, { recursive: true })

console.log('[package] pack @deepseek-ai/dsh')
run('pnpm', ['--filter', '@deepseek-ai/dsh', 'pack', '--out', tarball], { cwd: checkout })

const installRoot = target
const builtin = readJson('builtin-sources.json')
const dependencies = {
  '@deepseek-ai/dsh': `file:../../dsh-${version}.tgz`,
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

writeFileSync(join(installRoot, 'pnpm-workspace.yaml'), `packages:
  - .

autoInstallPeers: true

allowBuilds:
  esbuild: true
  node-pty: true
  koffi: true
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': false
  protobufjs: false
  node-addon-require-builtin: false
`)

console.log('[package] install production closure')
run('pnpm', ['install', '--prod'], { cwd: installRoot })

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
