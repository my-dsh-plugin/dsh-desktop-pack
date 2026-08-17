import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readJson, readLock, resolveCheckout, ROOT } from './lib/sources.mjs'

const builtin = readJson('builtin-sources.json')
const lock = readLock()
const seedRoot = resolve(ROOT, 'out/seed-dsh-home')
rmSync(seedRoot, { recursive: true, force: true })

// 1. Modes from dsh-presets.
const modesSource = lock.sources.modes
if (!modesSource?.checkout) {
  console.error('modes source not fetched yet; run: pnpm run sources:fetch')
  process.exit(1)
}
const modesCheckout = resolveCheckout(modesSource.checkout)
if (!existsSync(modesCheckout)) {
  console.error(`modes checkout missing: ${modesCheckout}`)
  process.exit(1)
}
const presetsDir = join(seedRoot, '.agent-presets')
for (const mode of builtin.modes.include ?? []) {
  const from = join(modesCheckout, mode)
  if (!existsSync(from)) {
    console.error(`mode ${mode} not found in ${modesCheckout}`)
    process.exit(1)
  }
  const to = join(presetsDir, mode)
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true, filter: (src) => !src.includes('/.git/') })
  console.log(`[seed] mode ${mode} -> ${to}`)
}

// 2. Web profile with bundled plugin bundles.
const profileDir = join(seedRoot, 'profiles/web')
mkdirSync(profileDir, { recursive: true })

const coreBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const pluginBundles = (builtin.plugins ?? []).map((plugin) => plugin.bundleName ?? plugin.packageName ?? plugin.id)
const profileManifest = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: [...coreBundles, ...pluginBundles],
    },
  },
}
writeFileSync(join(profileDir, 'package.json'), JSON.stringify(profileManifest, null, 2) + '\n')
writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

const profileModules = join(profileDir, 'node_modules')
mkdirSync(profileModules, { recursive: true })
for (const plugin of builtin.plugins ?? []) {
  const packageName = plugin.packageName
  if (!packageName) continue
  const built = join(ROOT, 'out/plugins', plugin.id, packageName)
  if (!existsSync(built)) {
    console.error(`plugin ${plugin.id} not built yet; run: pnpm run build:plugins`)
    process.exit(1)
  }
  const to = join(profileModules, packageName)
  rmSync(to, { recursive: true, force: true })
  cpSync(built, to, { recursive: true })
  console.log(`[seed] plugin ${packageName} -> ${to}`)
}

console.log(`[seed] assembled -> ${seedRoot}`)
console.log('[seed] plugin runtime dependencies resolve through DSH profile module fallback to the harness closure')
