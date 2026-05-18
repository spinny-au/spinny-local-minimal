import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spinnyHome } from './paths.js'

function ollamaModelsDir() {
  return process.env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models')
}

function safeModelName(model) {
  if (!/^[a-zA-Z0-9._:/-]+$/.test(model || '')) throw new Error('Invalid model name')
  return model.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

function parseModelRef(model) {
  const [rawName, rawTag = 'latest'] = model.split(':')
  const parts = rawName.split('/').filter(Boolean)
  const tag = rawTag || 'latest'
  if (parts.length === 1) return { registry: 'registry.ollama.ai', namespace: 'library', name: parts[0], tag }
  if (parts.length === 2) return { registry: 'registry.ollama.ai', namespace: parts[0], name: parts[1], tag }
  return { registry: parts[0], namespace: parts[1], name: parts.slice(2).join('/'), tag }
}

function manifestPath(model) {
  const ref = parseModelRef(model)
  return join(ollamaModelsDir(), 'manifests', ref.registry, ref.namespace, ref.name, ref.tag)
}

function blobPath(digest) {
  return join(ollamaModelsDir(), 'blobs', digest.replace(':', '-'))
}

function bundleDir() {
  const dir = join(spinnyHome(), 'model-bundles')
  mkdirSync(dir, { recursive: true })
  return dir
}

function bundlePath(model) {
  return join(bundleDir(), `${safeModelName(model)}.spinny-model.tgz`)
}

function tar(args) {
  const result = spawnSync('tar', args, { stdio: 'pipe' })
  if (result.status !== 0) {
    throw new Error((result.stderr?.toString() || result.stdout?.toString() || 'tar failed').trim())
  }
}

function copyInto(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
}

export function exportModelBundle(model) {
  safeModelName(model)
  const srcManifest = manifestPath(model)
  if (!existsSync(srcManifest)) throw new Error(`Model manifest not found. Is ${model} installed?`)

  const manifest = JSON.parse(readFileSync(srcManifest, 'utf8'))
  const digests = [
    manifest.config?.digest,
    ...(manifest.layers || []).map(layer => layer.digest),
  ].filter(Boolean)

  const work = join(tmpdir(), `spinny-model-${safeModelName(model)}-${Date.now()}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(join(work, 'blobs'), { recursive: true })

  const metadata = {
    format: 'spinny-model-bundle/v1',
    model,
    createdAt: new Date().toISOString(),
    manifest: parseModelRef(model),
    digests,
  }
  copyInto(srcManifest, join(work, 'manifest.json'))
  for (const digest of digests) {
    const src = blobPath(digest)
    if (!existsSync(src)) throw new Error(`Model blob not found: ${digest}`)
    copyInto(src, join(work, 'blobs', digest.replace(':', '-')))
  }
  writeFileSync(join(work, 'spinny-model.json'), JSON.stringify(metadata, null, 2))

  const out = bundlePath(model)
  rmSync(out, { force: true })
  tar(['-czf', out, '-C', work, '.'])
  rmSync(work, { recursive: true, force: true })
  return { ok: true, model, path: out, fileName: basename(out), bytes: statSync(out).size, digests: digests.length }
}

export function importModelBundle(path) {
  const full = resolve(path)
  if (!existsSync(full)) throw new Error('Bundle file not found')
  const work = join(tmpdir(), `spinny-import-${Date.now()}`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  tar(['-xzf', full, '-C', work])

  const metadata = JSON.parse(readFileSync(join(work, 'spinny-model.json'), 'utf8'))
  if (metadata.format !== 'spinny-model-bundle/v1') throw new Error('Unsupported bundle format')
  const ref = metadata.manifest
  const destManifest = join(ollamaModelsDir(), 'manifests', ref.registry, ref.namespace, ref.name, ref.tag)
  copyInto(join(work, 'manifest.json'), destManifest)
  for (const digest of metadata.digests || []) {
    copyInto(join(work, 'blobs', digest.replace(':', '-')), blobPath(digest))
  }
  rmSync(work, { recursive: true, force: true })
  return { ok: true, model: metadata.model, imported: true, digests: metadata.digests?.length || 0 }
}

export async function importModelBundleFromUrl(url, model) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Bundle URL must be http or https')
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Bundle download failed: ${response.status}`)
  const file = join(bundleDir(), `${safeModelName(model || 'download')}-${Date.now()}.spinny-model.tgz`)
  await pipeline(response.body, createWriteStream(file))
  return importModelBundle(file)
}

export function getBundleReadStream(model) {
  const info = exportModelBundle(model)
  return { ...info, stream: createReadStream(info.path) }
}
