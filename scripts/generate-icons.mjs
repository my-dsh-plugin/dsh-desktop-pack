import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { run, ROOT } from './lib/sources.mjs'

const input = resolve(ROOT, process.argv[2] ?? 'app-icon.png')
if (!existsSync(input)) {
  console.error(`icon source not found: ${input}`)
  console.error('请把 1024x1024 PNG 放到仓库根目录 app-icon.png，或传入路径：pnpm run icon:generate -- /path/to/icon.png')
  process.exit(1)
}
run('pnpm', ['exec', 'tauri', 'icon', input], { cwd: resolve(ROOT, 'src-tauri') })
console.log(`[icon] generated from ${input}`)
