import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readJson, readLock, resolveCheckout, run, ROOT } from './lib/sources.mjs'

const builtin = readJson('builtin-sources.json')
const lock = readLock()
const outRoot = resolve(ROOT, 'out/plugins')

for (const plugin of builtin.plugins ?? []) {
  const source = lock.sources[plugin.id]
  if (!source) {
    console.error(`plugin ${plugin.id} not fetched yet; run: npm run sources:fetch`)
    process.exit(1)
  }
  if (source.commit !== plugin.commit) {
    console.error(`plugin ${plugin.id} commit mismatch: lock=${source.commit} manifest=${plugin.commit}`)
    process.exit(1)
  }
  const checkout = resolveCheckout(source.checkout)
  if (!existsSync(checkout)) {
    console.error(`plugin ${plugin.id} checkout missing: ${checkout}`)
    process.exit(1)
  }

  console.log(`[build] plugin ${plugin.id} install`)
  if (plugin.build?.install?.length) {
    run(plugin.build.install[0], plugin.build.install.slice(1), { cwd: checkout })
  }
  console.log(`[build] plugin ${plugin.id} build`)
  if (plugin.build?.command?.length) {
    run(plugin.build.command[0], plugin.build.command.slice(1), { cwd: checkout })
  }

  const pkg = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'))
  const packageName = plugin.packageName ?? pkg.name ?? plugin.id
  const target = join(outRoot, plugin.id, packageName)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  const files = Array.isArray(pkg.files) ? pkg.files : []
  for (const pattern of ['package.json', 'cordis.patch.yml', ...files]) {
    const from = join(checkout, pattern)
    if (!existsSync(from)) continue
    const to = join(target, pattern)
    mkdirSync(join(to, '..'), { recursive: true })
    cpSync(from, to, { recursive: true, filter: (src) => !src.includes(`${join(checkout, '.git')}`) })
  }
  const tarball = join(outRoot, `${plugin.id}.tgz`)
  rmSync(tarball, { force: true })
  console.log(`[build] plugin ${plugin.id} pack -> ${tarball}`)
  run('pnpm', ['pack', '--out', tarball], { cwd: checkout })
  console.log(`[build] plugin ${plugin.id} -> ${target}`)
}
console.log('[build] plugins done')
