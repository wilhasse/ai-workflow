import fs from 'node:fs/promises'
import path from 'node:path'
import config from './config.js'

const wmFile = path.join(config.dataDir, 'watermarks.json')
let cache = null

export async function load() {
  try {
    const raw = await fs.readFile(wmFile, 'utf8')
    cache = JSON.parse(raw)
  } catch {
    cache = {}
  }
  return cache
}

export async function save() {
  await fs.mkdir(config.dataDir, { recursive: true })
  await fs.writeFile(wmFile, JSON.stringify(cache, null, 2))
}

export function get(key) {
  if (!cache) cache = {}
  return cache[key] ?? { size: 0, lines: 0, mtime: null }
}

export function set(key, data) {
  if (!cache) cache = {}
  cache[key] = data
}
