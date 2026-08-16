import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { copyTree, readJson, run, ROOT } from './lib/sources.mjs'

const harness = readJson('harness-source.json')
const tauriConfig = readJson('src-tauri/tauri.conf.json')
const appName = tauriConfig.productName ?? 'dsh-desktop'
const version = harness.version
const platformName = process.platform === 'darwin' ? 'macos' : (process.platform === 'win32' ? 'windows' : process.platform)
const platform = `${platformName}-${process.arch}`
const packageStem = appName.replace(/\s+/g, '-')
const distName = `${packageStem}-${version}-${platform}`
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

copyTree(runtimeDir, join(distDir, 'runtime'))
copyTree(seedDir, join(distDir, 'seed-dsh-home'))
copyTree(seedDir, join(distDir, 'data/dsh-home'))
writeFileSync(join(distDir, 'data/dsh-home/.home-init-done'), `${new Date().toISOString()}\n`)
mkdirSync(join(distDir, 'data/logs'), { recursive: true })
copyTree(resolve(ROOT, 'README.md'), join(distDir, 'README.md'))
copyTree(resolve(ROOT, 'LICENSE'), join(distDir, 'LICENSE'))

const shellApp = resolve(ROOT, `src-tauri/target/release/bundle/macos/${appName}.app`)
if (process.platform === 'darwin' && existsSync(shellApp)) {
  copyTree(shellApp, join(distDir, `${appName}.app`))
  console.log(`[package] shell app bundled from ${shellApp}`)
} else if (process.platform === 'darwin') {
  console.warn(`[package] warning: ${appName}.app not found; run npm run shell:build before package:dist`)
}

if (process.platform === 'win32') {
  const shellExe = resolve(ROOT, 'src-tauri/target/release/dsh-desktop.exe')
  if (existsSync(shellExe)) {
    copyTree(shellExe, join(distDir, 'dsh-desktop.exe'))
    console.log(`[package] shell exe bundled from ${shellExe}`)
  } else {
    console.warn('[package] warning: dsh-desktop.exe not found; run npm run shell:build before package:dist')
  }
  const nsisDir = resolve(ROOT, 'src-tauri/target/release/bundle/nsis')
  if (existsSync(nsisDir)) {
    const installer = readdirSync(nsisDir).find((name) => name.endsWith('-setup.exe'))
    if (installer) {
      mkdirSync(join(distDir, 'installer'), { recursive: true })
      copyTree(join(nsisDir, installer), join(distDir, 'installer', installer))
      console.log(`[package] NSIS installer bundled: ${installer}`)
    }
  }
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

  const dmgName = `${distName}.dmg`
  const dmgPath = resolve(ROOT, 'out', dmgName)
  const dmgStage = resolve(ROOT, 'out', `.dmg-stage-${distName}`)
  rmSync(dmgPath, { force: true })
  rmSync(dmgStage, { recursive: true, force: true })
  mkdirSync(dmgStage, { recursive: true })
  const appInStage = join(dmgStage, `${appName}.app`)
  copyTree(join(distDir, `${appName}.app`), appInStage)
  mkdirSync(join(appInStage, 'Contents/Resources'), { recursive: true })
  copyTree(join(distDir, 'runtime'), join(appInStage, 'Contents/Resources/runtime'))
  copyTree(join(distDir, 'seed-dsh-home'), join(appInStage, 'Contents/Resources/seed-dsh-home'))
  symlinkSync('/Applications', join(dmgStage, 'Applications'))
  console.log('[package] create dmg via hdiutil')
  try {
    run('hdiutil', ['create', '-volname', 'DSH Desktop', '-srcfolder', dmgStage, '-ov', '-format', 'UDZO', dmgPath])
  } catch (error) {
    console.warn(`[package] warning: hdiutil DMG creation failed (${error instanceof Error ? error.message : String(error)}); continuing with zip only`)
  }
  rmSync(dmgStage, { recursive: true, force: true })
} else if (process.platform === 'win32') {
  archive = `${distName}.zip`
  const archivePath = resolve(ROOT, 'out', archive)
  rmSync(archivePath, { force: true })
  try {
    run('tar', ['-a', '-c', '-f', archivePath, '-C', resolve(ROOT, 'out'), distName])
  } catch (error) {
    rmSync(archivePath, { force: true })
    console.warn(`[package] warning: tar zip failed (${error instanceof Error ? error.message : String(error)}); falling back to Compress-Archive`)
    run('powershell', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${distDir}' -DestinationPath '${archivePath}' -Force`])
  }
} else {
  archive = `${distName}.tar.gz`
  rmSync(resolve(ROOT, 'out', archive), { force: true })
  run('tar', ['-czf', resolve(ROOT, 'out', archive), '-C', resolve(ROOT, 'out'), distName])
}

console.log(`[package] dist ready: ${distDir}`)
console.log(`[package] archive ready: ${resolve(ROOT, 'out', archive)}`)
if (process.platform === 'darwin') {
  const dmgPath = resolve(ROOT, 'out', `${distName}.dmg`)
  if (existsSync(dmgPath)) {
    console.log(`[package] dmg ready: ${dmgPath}`)
  }
}
