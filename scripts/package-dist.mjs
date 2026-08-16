import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readJson, run, ROOT } from './lib/sources.mjs'

const harness = readJson('harness-source.json')
const version = harness.version
const platform = `${process.platform}-${process.arch}`
const distName = `dsh-desktop-${version}-${platform}`
const distDir = resolve(ROOT, 'out', distName)

const runtimeDir = resolve(ROOT, 'out/runtime')
const seedDir = resolve(ROOT, 'out/seed-dsh-home')
for (const [label, path] of [
  ['runtime', join(runtimeDir, 'manifest.json')],
  ['seed', join(seedDir, '.agent-presets')],
]) {
  if (!existsSync(path)) {
    console.error(`${label} missing: ${path}; run npm run build first`)
    process.exit(1)
  }
}

rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

cpSync(runtimeDir, join(distDir, 'runtime'), { recursive: true })
cpSync(seedDir, join(distDir, 'data/dsh-home'), { recursive: true })
mkdirSync(join(distDir, 'data/logs'), { recursive: true })
cpSync(resolve(ROOT, 'README.md'), join(distDir, 'README.md'))
cpSync(resolve(ROOT, 'LICENSE'), join(distDir, 'LICENSE'))

const shellApp = resolve(ROOT, 'src-tauri/target/release/bundle/macos/dsh-desktop.app')
if (process.platform === 'darwin' && existsSync(shellApp)) {
  cpSync(shellApp, join(distDir, 'dsh-desktop.app'), { recursive: true })
  console.log(`[package] shell app bundled from ${shellApp}`)
} else if (process.platform === 'darwin') {
  console.warn('[package] warning: dsh-desktop.app not found; run npm run shell:build before package:dist')
}

const binDir = join(distDir, 'bin')
mkdirSync(binDir, { recursive: true })
const sh = `#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec "$ROOT/runtime/node/bin/node" "$ROOT/runtime/app/manager.mjs" "$@"
`
const shPath = join(binDir, 'dsh')
writeFileSync(shPath, sh)
chmodSync(shPath, 0o755)
writeFileSync(join(binDir, 'dsh.cmd'), `@echo off\r\nset "ROOT=%~dp0.."\r\n"%ROOT%\\runtime\\node\\node.exe" "%ROOT%\\runtime\\app\\manager.mjs" %*\r\n`)

writeFileSync(join(distDir, 'manifest.json'), JSON.stringify({
  schemaVersion: 1,
  name: distName,
  version,
  platform,
  createdAt: new Date().toISOString(),
}, null, 2) + '\n')

let archive
if (process.platform === 'darwin') {
  archive = `${distName}.zip`
  rmSync(resolve(ROOT, 'out', archive), { force: true })
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', distDir, resolve(ROOT, 'out', archive)])
} else if (process.platform === 'win32') {
  archive = `${distName}.zip`
  const archivePath = resolve(ROOT, 'out', archive)
  rmSync(archivePath, { force: true })
  run('powershell', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${distDir}' -DestinationPath '${archivePath}' -Force`])
} else {
  archive = `${distName}.tar.gz`
  rmSync(resolve(ROOT, 'out', archive), { force: true })
  run('tar', ['-czf', resolve(ROOT, 'out', archive), '-C', resolve(ROOT, 'out'), distName])
}

console.log(`[package] dist ready: ${distDir}`)
console.log(`[package] archive ready: ${resolve(ROOT, 'out', archive)}`)
