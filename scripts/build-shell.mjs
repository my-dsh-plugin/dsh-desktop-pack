import { run } from './lib/sources.mjs'

const bundles = process.platform === 'win32' ? ['nsis'] : ['app']
console.log(`[shell] tauri build --bundles ${bundles.join(',')}`)
run('pnpm', ['exec', 'tauri', 'build', '--bundles', ...bundles], { cwd: process.cwd() })
console.log('[shell] build done')
