import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const RUNTIME = join(ROOT, 'runtime')
const DEFAULT_HOME = join(ROOT, 'data/dsh-home')
const SAFE_HOME = join(ROOT, 'data/safe-home')
const SEED_HOME = join(ROOT, 'seed-dsh-home')
const HARNESS = join(RUNTIME, 'harness')

const CLI_ARGS = new Set(process.argv.slice(2))
const SAFE_MODE = CLI_ARGS.has('--safe-mode')
const RESET_HOME = CLI_ARGS.has('--reset-home')
const DSH_HOME = SAFE_MODE
  ? SAFE_HOME
  : (process.env.DSH_HOME ?? DEFAULT_HOME)
const DATA = process.env.DSH_HOME && !SAFE_MODE ? resolve(dirname(process.env.DSH_HOME)) : join(ROOT, 'data')
const LOGS = join(DATA, 'logs')

const NODE = process.platform === 'win32'
  ? join(RUNTIME, 'node', 'node.exe')
  : join(RUNTIME, 'node', 'bin', 'node')
const RUN_NODE = existsSync(NODE) ? NODE : process.execPath

let child = null
let shuttingDown = false
let restarts = 0
const MAX_RESTARTS = 3
let diagServer = null
let diagToken = null
let diagUrl = null

function emit(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function log(level, text) {
  const line = `${new Date().toISOString()} [${level}] ${text}\n`
  try {
    mkdirSync(LOGS, { recursive: true })
    appendFileSync(join(LOGS, `manager-${new Date().toISOString().slice(0, 10)}.log`), line)
  } catch {
    process.stderr.write(line)
  }
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value).match(/^v?(\d{8})\.(\d+)$/)
    if (!match) return null
    return [Number(match[1]), Number(match[2])]
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return 0
  return a[0] - b[0] || a[1] - b[1]
}

function readCurrentVersion() {
  for (const manifest of [join(ROOT, 'manifest.json'), join(RUNTIME, 'manifest.json')]) {
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof parsed.version === 'string') return parsed.version
  }
  return null
}

async function checkForUpdates() {
  const current = readCurrentVersion()
  if (!current) return
  try {
    const response = await fetch('https://api.github.com/repos/my-dsh-plugin/dsh-desktop-pack/releases/latest', {
      headers: { accept: 'application/vnd.github+json' },
    })
    if (!response.ok) return
    const release = await response.json()
    const latest = String(release.tag_name ?? '').replace(/^v/, '')
    const available = compareVersions(latest, current) > 0
    emit({
      type: 'update',
      current,
      latest,
      available,
      url: typeof release.html_url === 'string' ? release.html_url : null,
      body: typeof release.body === 'string' ? release.body.slice(0, 4000) : null,
    })
    if (available) log('info', `update available: ${current} -> ${latest}`)
  } catch (error) {
    log('warn', `update check failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readDiagLogs() {
  const logs = {}
  for (const name of ['dsh-latest.out', 'dsh-latest.log']) {
    const file = join(LOGS, name)
    logs[name] = existsSync(file) ? readFileSync(file, 'utf8').slice(-120_000) : ''
  }
  return logs
}

function patchFilePath() {
  return join(DSH_HOME, 'profiles/web/cordis.patch.yml')
}

function readPatchFile() {
  const file = patchFilePath()
  return { file, text: existsSync(file) ? readFileSync(file, 'utf8') : '[]\n' }
}

function writePatchText(text) {
  const file = patchFilePath()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
  return file
}

function appendDisabledPatch(id) {
  const safeId = String(id).replaceAll('"', '\\"')
  const flow = `{ id: "${safeId}", disabled: true }`
  const current = readPatchFile().text
  if (!current.trim() || current.trim() === '[]') {
    return writePatchText(`[\n  ${flow}\n]\n`)
  }
  const match = current.match(/(\s*)\]\s*$/)
  if (!match) return writePatchText(`${current.trimEnd()}\n- ${flow}\n`)
  return writePatchText(`${current.slice(0, match.index)}- ${flow}\n]\n`)
}

function runConfigDump() {
  try {
    const bin = resolveHarnessBin()
    const result = spawnSync(RUN_NODE, [bin, 'web', '--dump-config'], {
      cwd: process.env.DSH_CWD || homedir(),
      env: { ...process.env, DSH_HOME },
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return {
      ok: result.status === 0,
      code: result.status,
      stdout: (result.stdout ?? '').slice(-200_000),
      stderr: (result.stderr ?? '').slice(-40_000),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function collectDiagnostics() {
  return {
    home: DSH_HOME,
    safeMode: SAFE_MODE,
    logs: readDiagLogs(),
    patch: readPatchFile(),
    dump: runConfigDump(),
  }
}

function diagHtml() {
  const diagnostics = collectDiagnostics()
  const data = JSON.stringify(diagnostics).replaceAll('<', '\\u003c')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DSH 故障排查</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#e6e6e6;margin:24px;max-width:1200px}
h1{font-size:20px}.row{display:flex;gap:12px;margin:12px 0}
button{background:#2563eb;border:0;color:white;padding:8px 14px;border-radius:8px;cursor:pointer}
button.danger{background:#b91c1c}pre{background:#111827;border:1px solid #374151;border-radius:8px;padding:12px;overflow:auto;max-height:360px}
label{display:block;margin-top:10px;color:#93c5fd}input{width:340px;padding:6px;border-radius:6px;border:1px solid #374151;background:#111827;color:white}
</style></head><body>
<h1>DSH 故障排查</h1><div class="row"><button onclick="postAction('retry')">重启应用</button>
<button class="danger" onclick="postAction('reset-home')">重置 Home（备份后恢复 seed）</button>
<button onclick="postAction('clear-patches')">恢复全部 patch</button></div>
<div><label>禁用单个插件（entry id）</label><input id="id" placeholder="例如 thinking-level-override">
<button onclick="postAction('disable',document.getElementById('id').value)">禁用</button></div>
<h2>启动日志</h2><pre id="logs"></pre><h2>有效配置（dsh web --dump-config）</h2><pre id="dump"></pre>
<script>
const diagnostics=${data};
const token=location.pathname.split('/').filter(Boolean)[1];
document.getElementById('logs').textContent=(diagnostics.logs['dsh-latest.log']||'')+(diagnostics.logs['dsh-latest.out']||'');
document.getElementById('dump').textContent=diagnostics.dump.stdout||diagnostics.dump.stderr||diagnostics.dump.error||'';
async function postAction(action,id){const body=id?JSON.stringify({id}):'{}';const r=await fetch('/api/'+action+'?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body});const t=await r.text();if(r.ok&&action==='retry'){document.body.innerHTML='<h2>正在重启…</h2>';return;}alert(t.slice(0,1000));}
</script></body></html>`
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function startDiag(reason) {
  if (diagServer) return
  diagToken = randomBytes(16).toString('hex')
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const token = url.searchParams.get('token') ?? ''
      if (url.pathname === `/diag/${diagToken}/`) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(diagHtml())
        return
      }
      if (url.pathname === `/diag/${token}/`) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(diagHtml())
        return
      }
      if (token !== diagToken) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (url.pathname === '/api/state' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ...collectDiagnostics() })
        return
      }
      if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') {
        sendJson(res, 415, { ok: false, error: 'POST application/json required' })
        return
      }
      const body = await readJsonBody(req)
      if (url.pathname === '/api/disable') {
        const id = String(body.id ?? '').trim()
        if (!id) return sendJson(res, 400, { ok: false, error: 'id required' })
        const file = appendDisabledPatch(id)
        return sendJson(res, 200, { ok: true, disabled: id, file })
      }
      if (url.pathname === '/api/clear-patches') {
        writePatchText('[]\n')
        return sendJson(res, 200, { ok: true })
      }
      if (url.pathname === '/api/retry') {
        server.close()
        diagServer = null
        restarts = 0
        sendJson(res, 200, { ok: true, retrying: true })
        setTimeout(() => {
          try { startDsh() } catch (error) { startDiag(error instanceof Error ? error.message : String(error)) }
        }, 200)
        return
      }
      if (url.pathname === '/api/reset-home') {
        if (SAFE_MODE) return sendJson(res, 400, { ok: false, error: 'safe mode has no home to reset' })
        if (existsSync(DSH_HOME)) {
          renameSync(DSH_HOME, `${DSH_HOME}.bak-${new Date().toISOString().replaceAll(':', '-')}`)
        }
        if (existsSync(SEED_HOME)) copySeedInto(DSH_HOME)
        writeFileSync(join(DSH_HOME, '.home-init-done'), `${new Date().toISOString()}\n`)
        server.close()
        diagServer = null
        restarts = 0
        sendJson(res, 200, { ok: true, reset: true, retrying: true })
        setTimeout(() => {
          try { startDsh() } catch (error) { startDiag(error instanceof Error ? error.message : String(error)) }
        }, 200)
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
  server.on('error', (error) => {
    diagServer = null
    log('error', `diag server error: ${error.message}`)
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      return
    }
    diagServer = server
    diagUrl = `http://127.0.0.1:${address.port}/diag/${diagToken}/`
    log('warn', `diag mode: ${reason} -> ${diagUrl}`)
    emit({ type: 'diag', url: diagUrl, reason })
  })
}

function resolveHarnessBin() {
  const pointer = join(HARNESS, 'current.json')
  if (!existsSync(pointer)) throw new Error(`missing ${pointer}`)
  const current = JSON.parse(readFileSync(pointer, 'utf8'))
  if (typeof current.path === 'string') {
    const path = resolve(current.path)
    const bin = join(path, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    if (existsSync(bin)) return bin
    if (existsSync(path) && path.endsWith('.js')) return path
    throw new Error(`harness current.path does not resolve to a dsh bin: ${path}`)
  }
  if (typeof current.version !== 'string') throw new Error('harness current.json must contain version or path')
  const bin = join(HARNESS, 'versions', current.version, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!existsSync(bin)) throw new Error(`harness version not found: ${bin}`)
  return bin
}

function copySeedInto(home, { replace = false } = {}) {
  if (!existsSync(SEED_HOME)) return
  mkdirSync(home, { recursive: true })
  for (const name of ['.agent-presets', 'profiles']) {
    const source = join(SEED_HOME, name)
    if (!existsSync(source)) continue
    cpSync(source, join(home, name), {
      recursive: true,
      force: replace,
      errorOnExist: false,
    })
  }
}

function prepareHome() {
  if (SAFE_MODE) {
    rmSync(DSH_HOME, { recursive: true, force: true })
    mkdirSync(DSH_HOME, { recursive: true })
    log('info', `safe-mode home reset: ${DSH_HOME}`)
    return
  }

  const marker = join(DSH_HOME, '.home-init-done')
  if (RESET_HOME && existsSync(DSH_HOME)) {
    const backup = `${DSH_HOME}.bak-${new Date().toISOString().replaceAll(':', '-')}`
    renameSync(DSH_HOME, backup)
    log('info', `reset-home backed up to ${backup}`)
  }

  if (!existsSync(marker) && existsSync(SEED_HOME) && resolve(DSH_HOME) !== resolve(SEED_HOME)) {
    copySeedInto(DSH_HOME)
    writeFileSync(marker, `${new Date().toISOString()}\n`)
    log('info', `seeded home from ${SEED_HOME}`)
  }
}

function startDsh() {
  const bin = resolveHarnessBin()
  prepareHome()
  mkdirSync(DSH_HOME, { recursive: true })
  mkdirSync(LOGS, { recursive: true })
  const env = { ...process.env, DSH_HOME }
  if (process.platform === 'win32') {
    env.Path = `${join(RUNTIME, 'node')};${env.Path ?? ''}`
  } else {
    env.PATH = `${join(RUNTIME, 'node', 'bin')}:${env.PATH ?? ''}`
  }
  writeFileSync(join(LOGS, 'dsh-latest.out'), '')
  writeFileSync(join(LOGS, 'dsh-latest.log'), '')
  child = spawn(RUN_NODE, [bin, 'web', '--port', '0'], {
    cwd: process.env.DSH_CWD || homedir(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  log('info', `spawn dsh pid=${child.pid} harness=${bin} home=${DSH_HOME}`)
  emit({ type: 'spawn', pid: child.pid, harness: bin })
  pipeLines(child.stdout, 'stdout')
  pipeLines(child.stderr, 'stderr')
  child.on('exit', (code, signal) => {
    log('warn', `dsh exited code=${String(code)} signal=${String(signal)}`)
    emit({ type: 'exit', pid: child?.pid, code: code ?? null, signal: signal ?? null })
    child = null
    if (shuttingDown) {
      process.exit(code ?? 0)
      return
    }
    if (restarts >= MAX_RESTARTS) {
      startDiag(`dsh exited ${restarts + 1} times (last code ${String(code)})`)
      return
    }
    restarts += 1
    const delay = Math.min(1000 * 2 ** restarts, 5000)
    emit({ type: 'restart', attempt: restarts, delayMs: delay })
    setTimeout(startDsh, delay)
  })
}

function pipeLines(stream, streamName) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      const logFile = streamName === 'stdout' ? 'dsh-latest.out' : 'dsh-latest.log'
      try {
        appendFileSync(join(LOGS, logFile), `${line}\n`)
      } catch {}
      if (streamName === 'stdout') {
        const match = line.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/)
        if (match) emit({ type: 'ready', url: match[1] })
        else emit({ type: 'stdout', line })
      } else {
        emit({ type: 'stderr', line })
      }
    }
  })
  stream.on('close', () => {
    if (buffer.trim()) emit({ type: streamName, line: buffer.replace(/\r$/, '') })
  })
}

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  if (!child || child.killed) {
    process.exit(0)
    return
  }
  child.kill(signal === 'SIGTERM' ? 'SIGTERM' : 'SIGINT')
  const timer = setTimeout(() => {
    if (child) child.kill('SIGKILL')
  }, 5000)
  timer.unref()
}

let inputBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk
  let index
  while ((index = inputBuffer.indexOf('\n')) >= 0) {
    const line = inputBuffer.slice(0, index).trim()
    inputBuffer = inputBuffer.slice(index + 1)
    if (!line) continue
    let command
    try {
      command = JSON.parse(line)
    } catch {
      emit({ type: 'error', message: `invalid command: ${line}` })
      continue
    }
    if (command.type === 'shutdown') shutdown('SIGTERM')
    else if (command.type === 'check-update') void checkForUpdates()
    else if (command.type === 'diag') startDiag('manual')
    else if (command.type === 'restart' && child) {
      restarts = 0
      child.kill('SIGTERM')
    } else {
      emit({ type: 'error', message: `unknown command: ${command.type}` })
    }
  }
})

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

log('info', `manager boot node=${RUN_NODE} home=${DSH_HOME}`)
emit({ type: 'boot', node: RUN_NODE, home: DSH_HOME, safeMode: SAFE_MODE, resetHome: RESET_HOME })
if (CLI_ARGS.has('--update-check')) void checkForUpdates()
else setTimeout(() => void checkForUpdates(), 3000).unref()
setInterval(() => void checkForUpdates(), 24 * 60 * 60 * 1000).unref()
try {
  if (CLI_ARGS.has('--diag')) {
    startDiag('manual')
  } else {
    startDsh()
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  log('error', message)
  startDiag(message)
}
