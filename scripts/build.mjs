import { run } from './lib/sources.mjs'

console.log('[build] verify sources')
run(process.execPath, ['scripts/fetch-sources.mjs', '--verify'])

console.log('[build] build harness')
run(process.execPath, ['scripts/build-harness.mjs'])

console.log('[build] build plugins')
run(process.execPath, ['scripts/build-plugins.mjs'])

console.log('[build] assemble seed')
run(process.execPath, ['scripts/assemble-seed.mjs'])

console.log('[build] complete. Next: runtime packaging (node, Tauri shell, installers).')
