import { existsSync } from 'node:fs'
import { readJson, readLock, resolveCheckout, run } from './lib/sources.mjs'

const manifest = readJson('harness-source.json')
const lock = readLock()
const source = lock.sources.harness
if (!source) {
  console.error('harness source not fetched yet; run: npm run sources:fetch')
  process.exit(1)
}
if (source.commit !== manifest.source.commit) {
  console.error(`harness commit mismatch: lock=${source.commit} manifest=${manifest.source.commit}`)
  process.exit(1)
}
const checkout = resolveCheckout(source.checkout)
if (!existsSync(checkout)) {
  console.error(`harness checkout missing: ${checkout}`)
  process.exit(1)
}

const build = manifest.build ?? {}
console.log(`[build] harness install @ ${checkout}`)
if (build.install?.length) {
  run(build.install[0], build.install.slice(1), { cwd: checkout })
}
console.log('[build] harness build')
if (build.command?.length) {
  run(build.command[0], build.command.slice(1), { cwd: checkout })
}
console.log('[build] harness done')
