import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const RUNTIME = join(ROOT, 'runtime')
const DATA = join(ROOT, 'data')
const LOGS = join(DATA, 'logs')
const DSH_HOME = process.env.DSH_HOME ?? join(DATA, 'dsh-home')
const HARNESS = join(RUNTIME, 'harness')

const NODE = process.platform === 'win32'
  ? join(RUNTIME, 'node', 'node.exe')
  : join(RUNTIME, 'node', 'bin', 'node')
const RUN_NODE = existsSync(NODE) ? NODE : process.execPath

let child = null
let shuttingDown = false
let restarts = 0
const MAX_RESTARTS = 3

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

function startDsh() {
  const bin = resolveHarnessBin()
  mkdirSync(DSH_HOME, { recursive: true })
  mkdirSync(LOGS, { recursive: true })
  const env = { ...process.env, DSH_HOME }
  if (process.platform === 'win32') {
    env.Path = `${join(RUNTIME, 'node')};${env.Path ?? ''}`
  } else {
    env.PATH = `${join(RUNTIME, 'node', 'bin')}:${env.PATH ?? ''}`
  }
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
      emit({ type: 'fatal', message: `dsh exited ${restarts} times; giving up` })
      process.exit(code ?? 1)
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
emit({ type: 'boot', node: RUN_NODE, home: DSH_HOME })
try {
  startDsh()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  log('error', message)
  emit({ type: 'fatal', message })
  process.exit(1)
}
