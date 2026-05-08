import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Logger } from '../services/logger.js'
import type { EntityFolder } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = resolve(HERE, '..')
const FILE_REGEX = /\.(?:js|ts)$/

export async function loadEntities(folder: EntityFolder): Promise<void> {
  const dir = resolve(SRC_ROOT, folder)
  let files: string[] = []
  try {
    files = readdirSync(dir)
  } catch {
    // Folder absent (no .ts files in src/<folder>) — that's the expected idle
    // state for plugins/ and jobs/ until something is added.
    return
  }
  for (const file of files) {
    if (!FILE_REGEX.test(file)) continue
    if (file.endsWith('.d.ts')) continue
    const abs = resolve(dir, file)
    try {
      await import(pathToFileURL(abs).href)
    } catch (err) {
      Logger.error(`Error loading ${folder}/${file}`, err)
    }
  }
}
