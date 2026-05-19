/**
 * Generate src/assets/tray.ico — 16x16 + 32x32 BMP-based ICO
 * Brand color: #7c5cfc (Spinny purple)
 * Run: node scripts/generate-ico.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function makeFrame(size) {
  const cx = size / 2, cy = size / 2, r = size / 2 - 1
  const andStride = Math.ceil(size / 32) * 4
  const buf = Buffer.alloc(40 + size * size * 4 + size * andStride)
  let o = 0

  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, o); o += 4
  buf.writeInt32LE(size, o); o += 4
  buf.writeInt32LE(size * 2, o); o += 4  // doubled height for ICO
  buf.writeUInt16LE(1, o); o += 2
  buf.writeUInt16LE(32, o); o += 2
  o += 24  // compression, sizeImage, xPPM, yPPM, clrUsed, clrImportant

  // XOR mask — BGRA, bottom-up rows
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy
      const dist = Math.sqrt(dx*dx + dy*dy)
      if (dist <= r) {
        // Gradient: centre #a78bfa (light purple) → edge #7c5cfc (deep purple)
        const t = dist / r
        const R = Math.round(167 + (124 - 167) * t)
        const G = Math.round(139 + (92  - 139) * t)
        const B = Math.round(250 + (252 - 250) * t)
        buf[o++] = B; buf[o++] = G; buf[o++] = R; buf[o++] = 255
      } else {
        buf[o++] = 0; buf[o++] = 0; buf[o++] = 0; buf[o++] = 0
      }
    }
  }
  // AND mask: all zeros
  return buf
}

function buildICO(sizes) {
  const frames = sizes.map(s => ({ s, data: makeFrame(s) }))
  const dirSize = 6 + frames.length * 16
  const out = Buffer.alloc(dirSize + frames.reduce((n, f) => n + f.data.length, 0))
  out.writeUInt16LE(0, 0); out.writeUInt16LE(1, 2); out.writeUInt16LE(frames.length, 4)
  let dOff = 6, imgOff = dirSize
  for (const { s, data } of frames) {
    out[dOff] = s; out[dOff+1] = s; out[dOff+2] = 0; out[dOff+3] = 0
    out.writeUInt16LE(1, dOff+4); out.writeUInt16LE(32, dOff+6)
    out.writeUInt32LE(data.length, dOff+8); out.writeUInt32LE(imgOff, dOff+12)
    data.copy(out, imgOff)
    dOff += 16; imgOff += data.length
  }
  return out
}

mkdirSync(join(root, 'src', 'assets'), { recursive: true })
const ico = buildICO([16, 32])
writeFileSync(join(root, 'src', 'assets', 'tray.ico'), ico)
console.log(`Written tray.ico — ${ico.length} bytes (16x16 + 32x32)`)
