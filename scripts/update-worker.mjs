import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const repoRoot = resolve(process.argv[2] || join(import.meta.dirname, '..'))
const mode = process.argv[3] || 'apply'
const target = process.argv[4] || 'origin/main'
const logPath = join(repoRoot, 'spinny-update.log')

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try { appendFileSync(logPath, line, 'utf8') } catch {}
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function npmCommand(args) {
  if (process.platform !== 'win32') return { command: 'npm', args }
  const candidates = [
    process.env.npm_execpath && process.env.npm_execpath.endsWith('.js') ? process.env.npm_execpath : null,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const npmCli = candidates.find(path => existsSync(path))
  if (npmCli) return { command: process.execPath, args: [npmCli, ...args] }
  return { command: 'npm.cmd', args }
}

function run(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
    child.on('error', err => {
      log(`${command} failed to start: ${err.message}`)
      resolve(1)
    })
    child.on('close', code => resolve(code ?? 1))
  })
}

async function runNpmInstall() {
  const npm = npmCommand(['install', '--omit=dev'])
  return run(npm.command, npm.args)
}

function restartNode() {
  const child = spawn(process.execPath, [
    '--experimental-sqlite',
    '--no-warnings',
    '--env-file-if-exists=.env',
    'src/main.js',
    'start',
  ], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

async function main() {
  try {
    await sleep(1500)
    log(`${mode} started`)

    if (mode === 'apply') {
      if (await run(process.platform === 'win32' ? 'git.exe' : 'git', ['fetch', 'origin', 'main']) !== 0) throw new Error('git fetch failed')
      if (await run(process.platform === 'win32' ? 'git.exe' : 'git', ['reset', '--hard', 'origin/main']) !== 0) throw new Error('git reset failed')
      if (await runNpmInstall() !== 0) throw new Error('npm install failed')
    } else if (mode === 'rollback') {
      if (!target || target === 'null') throw new Error('missing rollback target')
      if (await run(process.platform === 'win32' ? 'git.exe' : 'git', ['reset', '--hard', target]) !== 0) throw new Error('git reset failed')
      if (await runNpmInstall() !== 0) throw new Error('npm install failed')
    } else if (mode === 'restart') {
      // no-op; just relaunch below
    } else {
      throw new Error(`unknown mode: ${mode}`)
    }

    log(`${mode} complete; restarting node`)
  } catch (err) {
    log(`${mode} failed: ${err.message}`)
  } finally {
    restartNode()
  }
}

main()
