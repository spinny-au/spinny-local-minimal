import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const repoRoot = resolve(process.argv[2] || join(import.meta.dirname, '..'))
const mode = process.argv[3] || 'apply'
const target = process.argv[4] || 'origin/main'
const logPath = join(repoRoot, 'spinny-update.log')
const signalPath = join(repoRoot, '.update-signal')
const statePath = join(repoRoot, 'spinny-update-state.json')

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try { appendFileSync(logPath, line, 'utf8') } catch {}
}

function readState() {
  try {
    if (!existsSync(statePath)) return {}
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return {}
  }
}

function writeState(patch) {
  const current = readState()
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  try { writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8') } catch {}
  return next
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

async function runNpmScript(script) {
  const npm = npmCommand(['run', script])
  return run(npm.command, npm.args)
}

function currentCommit() {
  return new Promise(resolve => {
    const child = spawn(process.platform === 'win32' ? 'git.exe' : 'git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let out = ''
    child.stdout?.on('data', d => { out += d })
    child.on('close', code => resolve(code === 0 ? out.trim() : null))
    child.on('error', () => resolve(null))
  })
}

function writeSignal(status, error = null) {
  try {
    try { rmSync(signalPath) } catch {}
    const data = JSON.stringify({ mode, status, timestamp: new Date().toISOString(), error })
    appendFileSync(signalPath, data + '\n', 'utf8')
    log(`signal written: ${status}`)
  } catch (err) {
    log(`signal write failed: ${err.message}`)
  }
}

async function restartNode() {
  log('restartNode called (safety fallback)')
  if (process.platform === 'win32') {
    const taskName = 'SpinnyLocalNode'
    await new Promise(resolve => {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" -EA SilentlyContinue | Where-Object { $_.CommandLine -like "*tray-windows.ps1*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }',
      ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
      ps.on('close', () => resolve(undefined))
      ps.on('error', err => { log(`tray cleanup error: ${err.message}`); resolve(undefined) })
    })
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
    await sleep(2000)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ok = await new Promise(resolve => {
        const run = spawn('schtasks.exe', ['/run', '/tn', taskName], {
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        })
        let out = ''
        run.stdout?.on('data', d => { out += d })
        run.stderr?.on('data', d => { out += d })
        run.on('close', code => {
          if (code === 0) {
            log(`schtasks /run succeeded on attempt ${attempt}`)
            resolve(true)
          } else {
            log(`schtasks /run exited ${code} on attempt ${attempt}: ${out.trim() || '(no output)'}`)
            resolve(false)
          }
        })
        run.on('error', err => { log(`schtasks /run error on attempt ${attempt}: ${err.message}`); resolve(false) })
      })
      if (ok) return
      if (attempt < 3) await sleep(2000)
    }
    log('all schtasks attempts failed; spawning node directly as fallback')
    spawn(process.execPath, [
      '--experimental-sqlite', '--no-warnings', '--env-file-if-exists=.env',
      'src/main.js', 'start',
    ], { cwd: repoRoot, detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn(process.execPath, [
      '--experimental-sqlite', '--no-warnings', '--env-file-if-exists=.env',
      'src/main.js', 'start',
    ], { cwd: repoRoot, detached: true, stdio: 'ignore' }).unref()
  }
}

async function main() {
  let err = null
  let status = 'complete'
  try {
    await sleep(1500)
    log(`${mode} started`)
    writeState({
      mode,
      stage: mode === 'rollback' ? 'rollback-started' : `${mode}-started`,
      previousCommit: target && target !== 'null' ? target : readState().previousCommit || null,
      error: null,
    })

    if (mode === 'apply') {
      writeState({ stage: 'fetching' })
      if (await run(process.platform === 'win32' ? 'git.exe' : 'git', ['fetch', 'origin', 'main']) !== 0) throw new Error('git fetch failed')
      writeState({ stage: 'resetting', previousCommit: target || null })
      if (await run(process.platform === 'win32' ? 'git.exe' : 'git', ['reset', '--hard', 'origin/main']) !== 0) throw new Error('git reset failed')
      writeState({ stage: 'installing' })
      if (await runNpmInstall() !== 0) throw new Error('npm install failed')
      writeState({ stage: 'building-ui' })
      if (await runNpmScript('build:ui') !== 0) throw new Error('npm run build:ui failed')
      writeState({ stage: 'testing' })
      if (await runNpmScript('test') !== 0) throw new Error('npm test failed')
    } else if (mode === 'rollback') {
      if (!target || target === 'null') throw new Error('missing rollback target')
      writeState({ stage: 'rollback-resetting', previousCommit: target })
      if (await run(process.platform === 'win32' ? 'git.exe' : 'git', ['reset', '--hard', target]) !== 0) throw new Error('git reset failed')
      writeState({ stage: 'rollback-installing' })
      if (await runNpmInstall() !== 0) throw new Error('npm install failed')
      writeState({ stage: 'rollback-building-ui' })
      if (await runNpmScript('build:ui') !== 0) throw new Error('npm run build:ui failed')
    } else if (mode === 'restart') {
      // no-op; just signal and let parent restart
    } else {
      throw new Error(`unknown mode: ${mode}`)
    }

    const after = await currentCommit()
    writeState({
      stage: 'ready-to-restart',
      lastGoodCommit: after || readState().lastGoodCommit || null,
      currentCommit: after || null,
      completedAt: new Date().toISOString(),
    })
    log(`${mode} complete; writing signal for parent`)
  } catch (e) {
    err = e
    log(`${mode} failed: ${e.message}`)
    writeState({ stage: `${mode}-failed`, error: e.message })
    if (mode === 'apply' && target && target !== 'null') {
      log(`attempting automatic rollback to ${target}`)
      writeState({ stage: 'auto-rollback-started', rollbackTarget: target })
      const resetCode = await run(process.platform === 'win32' ? 'git.exe' : 'git', ['reset', '--hard', target])
      const installCode = resetCode === 0 ? await runNpmInstall() : 1
      const buildCode = installCode === 0 ? await runNpmScript('build:ui') : 1
      if (resetCode === 0 && installCode === 0 && buildCode === 0) {
        status = 'rolled_back'
        const afterRollback = await currentCommit()
        writeState({
          stage: 'rolled-back',
          currentCommit: afterRollback || target,
          lastGoodCommit: afterRollback || target,
          rollbackError: e.message,
          completedAt: new Date().toISOString(),
        })
        log(`automatic rollback complete after failed apply: ${e.message}`)
      } else {
        status = 'failed'
        writeState({
          stage: 'rollback-failed',
          rollbackError: e.message,
          rollbackCodes: { resetCode, installCode, buildCode },
        })
        log(`automatic rollback failed reset=${resetCode} install=${installCode} build=${buildCode}`)
      }
    } else {
      status = 'failed'
    }
  } finally {
    writeSignal(err ? status : 'complete', err?.message || null)
    if (err) {
      await sleep(4000)
      if (existsSync(signalPath)) {
        log('fallback: parent did not restart; worker initiating restart')
        restartNode()
      }
    }
  }
}

main()
