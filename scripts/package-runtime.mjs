import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { copyTree, readJson, ROOT } from './lib/sources.mjs'

const outRuntime = resolve(ROOT, 'out/runtime')
const harnessOut = resolve(ROOT, 'out/harness')
const nodeOut = join(outRuntime, 'node')
const harnessSource = readJson('harness-source.json')
const nodeSource = readJson('node-source.json')

for (const [label, path] of [
  ['harness package', join(harnessOut, 'current.json')],
  ['node runtime', process.platform === 'win32' ? join(nodeOut, 'node.exe') : join(nodeOut, 'bin/node')],
]) {
  if (!existsSync(path)) {
    console.error(`${label} missing: ${path}`)
    console.error('run: pnpm run package:harness && pnpm run fetch:node')
    process.exit(1)
  }
}

const outRuntimeHarness = join(outRuntime, 'harness')
rmSync(outRuntimeHarness, { recursive: true, force: true })
mkdirSync(outRuntimeHarness, { recursive: true })
copyTree(join(harnessOut, 'current.json'), join(outRuntimeHarness, 'current.json'))
copyTree(join(harnessOut, 'versions'), join(outRuntimeHarness, 'versions'))

const managerTarget = join(outRuntime, 'app')
rmSync(managerTarget, { recursive: true, force: true })
mkdirSync(managerTarget, { recursive: true })
copyTree(resolve(ROOT, 'runtime/app/manager.mjs'), join(managerTarget, 'manager.mjs'))

writeFileSync(join(outRuntime, 'manifest.json'), JSON.stringify({
  schemaVersion: 1,
  platform: `${process.platform}-${process.arch}`,
  node: nodeSource.version,
  harness: harnessSource.version,
  createdAt: new Date().toISOString(),
}, null, 2) + '\n')

console.log(`[package] runtime ready: ${outRuntime}`)
