import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { readJson, run, ROOT } from './lib/sources.mjs'

const manifest = readJson('node-source.json')
const key = `${process.platform}-${process.arch}`
const variant = manifest.variants[key]
if (!variant) {
  console.error(`node-source.json has no variant for ${key}`)
  process.exit(1)
}

const cacheRoot = resolve(ROOT, '.cache/runtime')
const archive = join(cacheRoot, variant.url.split('/').pop())
const target = resolve(ROOT, 'out/runtime/node')

async function ensureArchive() {
  if (existsSync(archive)) {
    const actual = await sha256File(archive)
    if (actual === variant.sha256) return archive
    console.warn(`[node] cached archive checksum mismatch; redownloading ${archive}`)
    rmSync(archive, { force: true })
  }
  mkdirSync(dirname(archive), { recursive: true })
  console.log(`[node] download ${variant.url}`)
  const response = await fetch(variant.url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`download failed: ${response.status} ${response.statusText}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive))
  const actual = await sha256File(archive)
  if (actual !== variant.sha256) {
    throw new Error(`node archive checksum mismatch: expected ${variant.sha256}, got ${actual}`)
  }
  return archive
}

async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const file = await ensureArchive()
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
console.log(`[node] extract ${file} -> ${target}`)
if (process.platform === 'win32') {
  run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${file}' -DestinationPath '${target}' -Force`])
  // Expand-Archive keeps the top-level node-v...-win-x64 directory; move its children up.
  const inner = join(target, `node-v${manifest.version}-win-x64`)
  const move = `Get-ChildItem -LiteralPath '${inner}' | Move-Item -Destination '${target}' -Force; Remove-Item -LiteralPath '${inner}'`
  run('powershell', ['-NoProfile', '-Command', move])
} else {
  run('tar', ['-xzf', file, '-C', target, '--strip-components=1'])
}

const nodeBin = process.platform === 'win32' ? join(target, 'node.exe') : join(target, 'bin/node')
if (!existsSync(nodeBin)) throw new Error(`node binary not found after extraction: ${nodeBin}`)
console.log(`[node] ready: ${nodeBin} (${String(statSync(nodeBin).size)} bytes)`)
