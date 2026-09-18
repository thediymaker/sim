import type { Dirent } from 'node:fs'
import { opendir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '@sim/logger'
import { UPLOAD_DIR_SERVER } from '@/lib/uploads/core/setup.server'
import { LOCAL_MULTIPART_ROOT, LOCAL_STAGING_ROOT } from '@/lib/uploads/core/storage-key'

const logger = createLogger('LocalUploadCleanup')

export const LOCAL_UPLOAD_CLEANUP_INTERVAL_MS = 15 * 60 * 1000
export const LOCAL_UPLOAD_ARTIFACT_TTL_MS = 25 * 60 * 60 * 1000
export const LOCAL_UPLOAD_CLEANUP_MAX_ENTRIES = 200

export interface LocalUploadCleanupResult {
  scanned: number
  removed: number
}

let activeCleanup: Promise<LocalUploadCleanupResult> | null = null
let lastCleanupAt = 0

const CLEANUP_ROOTS = [LOCAL_MULTIPART_ROOT, LOCAL_STAGING_ROOT] as const

interface CleanupRootState {
  directory: Awaited<ReturnType<typeof opendir>> | null
}

const cleanupRootStates: CleanupRootState[] = CLEANUP_ROOTS.map(() => ({ directory: null }))
let nextCleanupRootIndex = 0

/**
 * Opportunistically removes expired local multipart state.
 * Calls are single-flight and rate-limited; each sweep examines a bounded number of entries.
 */
export function maybeCleanupLocalUploadArtifacts(
  now = Date.now()
): Promise<LocalUploadCleanupResult> {
  if (activeCleanup) return activeCleanup
  if (now - lastCleanupAt < LOCAL_UPLOAD_CLEANUP_INTERVAL_MS) {
    return Promise.resolve({ scanned: 0, removed: 0 })
  }
  activeCleanup = sweepLocalUploadArtifacts({ now })
    .catch((error) => {
      // This sweep is opportunistic maintenance, but it runs inline on every
      // upload-session create -- so a rejection here decides whether a user's
      // upload succeeds. It must not. Report it and yield an empty result; the
      // next sweep re-derives everything it needs from the filesystem.
      logger.error('Local upload artifact sweep failed', { error })
      return { scanned: 0, removed: 0 }
    })
    .then((result) => {
      lastCleanupAt = now
      return result
    })
  return activeCleanup.finally(() => {
    activeCleanup = null
  })
}

/** Performs one bounded sweep for per-replica maintenance hooks and deterministic tests. */
export async function sweepLocalUploadArtifacts(params?: {
  now?: number
  maxEntries?: number
}): Promise<LocalUploadCleanupResult> {
  const now = params?.now ?? Date.now()
  const maxEntries = params?.maxEntries ?? LOCAL_UPLOAD_CLEANUP_MAX_ENTRIES
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxEntries must be a positive integer')
  }
  const cutoff = now - LOCAL_UPLOAD_ARTIFACT_TTL_MS
  let scanned = 0
  let removed = 0
  const exhaustedRoots = new Set<number>()

  while (scanned < maxEntries) {
    const artifact = await readNextCleanupArtifact(exhaustedRoots)
    if (!artifact) break
    scanned++
    const path = join(artifact.directoryPath, artifact.entry.name)
    let file
    try {
      file = await stat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (file.mtimeMs > cutoff) continue
    await rm(path, { recursive: artifact.entry.isDirectory(), force: true })
    removed++
  }

  return { scanned, removed }
}

export function resetLocalUploadCleanupForTesting(): void {
  for (const state of cleanupRootStates) {
    if (!state.directory) continue
    try {
      state.directory.closeSync()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') throw error
    }
    state.directory = null
  }
  nextCleanupRootIndex = 0
  activeCleanup = null
  lastCleanupAt = 0
}

/**
 * Drops a root's cached directory handle, closing it on a best effort.
 *
 * The reference is cleared BEFORE the close is attempted: `cleanupRootStates`
 * outlives the request, so a throw between "handle is dead" and "handle is
 * forgotten" caches a closed handle for the life of the process and every
 * later sweep fails on it. Node's `Dir.close()` returns a promise; Bun's
 * returns `undefined`, so the result is awaited rather than `.catch()`-ed.
 */
async function releaseDirectory(state: CleanupRootState): Promise<void> {
  const directory = state.directory
  state.directory = null
  if (!directory) return
  try {
    await directory.close()
  } catch {
    // Already closed, or the root vanished underneath us. Either way there is
    // nothing left to reclaim and nothing the caller can do about it.
  }
}

async function readNextCleanupArtifact(
  exhaustedRoots: Set<number>
): Promise<{ directoryPath: string; entry: Dirent } | null> {
  for (let attempt = 0; attempt < CLEANUP_ROOTS.length; attempt++) {
    const rootIndex = nextCleanupRootIndex
    nextCleanupRootIndex = (nextCleanupRootIndex + 1) % CLEANUP_ROOTS.length
    if (exhaustedRoots.has(rootIndex)) continue

    const directoryPath = join(UPLOAD_DIR_SERVER, CLEANUP_ROOTS[rootIndex])
    const state = cleanupRootStates[rootIndex]
    if (!state.directory) {
      try {
        state.directory = await opendir(directoryPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          exhaustedRoots.add(rootIndex)
          continue
        }
        throw error
      }
    }

    let entry: Dirent | null
    try {
      entry = await state.directory.read()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Two ways a handle stops producing entries without the directory being
      // walked to its end:
      //   ENOENT         Bun's opendir is lazy, so a missing root resolves and
      //                  the error (reported as `scandir`) surfaces here rather
      //                  than at opendir() above, where Node raises it.
      //   ERR_DIR_CLOSED the handle cached from an earlier sweep did not
      //                  survive to this one.
      // Neither is a reason to fail an upload: the root simply has nothing more
      // to give this pass, and the next sweep reopens it.
      await releaseDirectory(state)
      if (code !== 'ENOENT' && code !== 'ERR_DIR_CLOSED') throw error
      exhaustedRoots.add(rootIndex)
      continue
    }
    if (entry) return { directoryPath, entry }

    await releaseDirectory(state)
    exhaustedRoots.add(rootIndex)
  }
  return null
}
