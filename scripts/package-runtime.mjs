import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readJson, ROOT } from './lib/sources.mjs'

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
    console.error('run: npm run package:harness && npm run fetch:node')
    process.exit(1)
  }
}

rmSync(join(outRuntime, 'harness'), { recursive: true, force: true })
cpSync(harnessOut, join(outRuntime, 'harness'), { recursive: true })

const managerTarget = join(outRuntime, 'app')
rmSync(managerTarget, { recursive: true, force: true })
mkdirSync(managerTarget, { recursive: true })
cpSync(resolve(ROOT, 'runtime/app/manager.mjs'), join(managerTarget, 'manager.mjs'))

writeFileSync(join(outRuntime, 'manifest.json'), JSON.stringify({
  schemaVersion: 1,
  platform: `${process.platform}-${process.arch}`,
  node: nodeSource.version,
  harness: harnessSource.version,
  createdAt: new Date().toISOString(),
}, null, 2) + '\n')

console.log(`[package] runtime ready: ${outRuntime}`)
