import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { cacheVerifiedRelease, verifyGitCommit, verifyWorkingTree } from '../src/release-manifest.js'

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

async function restartNode() {
  if (process.platform === 'win32') {
    const taskName = 'SpinnyLocalNode'
    await new Promise(resolve => {
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" -EA SilentlyContinue | Where-Object { $_.CommandLine -like "*tray-windows.ps1*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }',
      ], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      })
      ps.on('close', () => resolve(undefined))
      ps.on('error', err => { log(`tray cleanup error: ${err.message}`); resolve(undefined) })
    })
    // End the task first — if Task Scheduler still thinks it's Running (process
    // already gone but state not yet flushed), /run is a silent no-op.
    await new Promise(resolve => {
      const end = spawn('schtasks.exe', ['/end', '/tn', taskName], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      let out = ''
      end.stdout?.on('data', d => { out += d })
      end.stderr?.on('data', d => { out += d })
      end.on('close', code => {
        log(`schtasks /end exited ${code}: ${out.trim() || '(no output)'}`)
        resolve(undefined)
      })
      end.on('error', err => { log(`schtasks /end error: ${err.message}`); resolve(undefined) })
    })
    await sleep(1500)
    // Now launch via Task Scheduler — hidden, no console flash
    await new Promise(resolve => {
      const run = spawn('schtasks.exe', ['/run', '/tn', taskName], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      let out = ''
      run.stdout?.on('data', d => { out += d })
      run.stderr?.on('data', d => { out += d })
      run.on('close', code => {
        log(`schtasks /run exited ${code}: ${out.trim() || '(no output)'}`)
        resolve(undefined)
      })
      run.on('error', err => { log(`schtasks /run error: ${err.message}`); resolve(undefined) })
    })
  } else {
    spawn(process.execPath, [
      '--experimental-sqlite',
      '--no-warnings',
      '--env-file-if-exists=.env',
      'src/main.js',
      'start',
    ], {
      cwd: repoRoot, detached: true, stdio: 'ignore',
    }).unref()
  }
}

async function main() {
  try {
    await sleep(1500)
    log(`${mode} started`)

    if (mode === 'apply') {
      if (await run(process.platform === 'win32' ? 'git.exe' : 'git', ['fetch', 'origin', 'main']) !== 0) throw new Error('git fetch failed')
      const targetCommit = await gitOutput(['rev-parse', 'origin/main'])
      await verifyGitCommit(repoRoot, targetCommit)
      if (await run(process.platform === 'win32' ? 'git.exe' : 'git', ['reset', '--hard', 'origin/main']) !== 0) throw new Error('git reset failed')
      cacheVerifiedRelease(repoRoot, await verifyWorkingTree(repoRoot))
      if (await runNpmInstall() !== 0) throw new Error('npm install failed')
    } else if (mode === 'rollback') {
      if (!target || target === 'null') throw new Error('missing rollback target')
      await verifyGitCommit(repoRoot, target)
      if (await run(process.platform === 'win32' ? 'git.exe' : 'git', ['reset', '--hard', target]) !== 0) throw new Error('git reset failed')
      cacheVerifiedRelease(repoRoot, await verifyWorkingTree(repoRoot))
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

function gitOutput(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'git.exe' : 'git', args, {
      cwd: repoRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `git ${args.join(' ')} failed`)))
  })
}
