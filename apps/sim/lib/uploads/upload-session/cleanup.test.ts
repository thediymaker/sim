/**
 * @vitest-environment node
 */
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { testUploadDirectory, bunLazyRoots, unreadableRoots } = vi.hoisted(() => ({
  testUploadDirectory: `/tmp/sim-upload-session-cleanup-${process.pid}`,
  /** Roots that should behave the way Bun's lazy `opendir` does. */
  bunLazyRoots: new Set<string>(),
  /** Roots whose `opendir` fails with something the sweep cannot interpret. */
  unreadableRoots: new Set<string>(),
}))

vi.mock('@/lib/uploads/core/setup.server', () => ({
  UPLOAD_DIR_SERVER: testUploadDirectory,
}))

/**
 * Bun and Node disagree about `fs.promises.opendir` in two ways that decide
 * whether a missing sweep root is survivable, and the tests below are the only
 * place either difference is visible under a Node test runner:
 *
 *   - Bun's `opendir` is lazy. A missing directory resolves, and the ENOENT
 *     (reported as `scandir`) is raised by the first `read()`.
 *   - Bun's `Dir.close()` returns `undefined`; Node's returns a promise. Code
 *     that treats the result as thenable throws a TypeError on Bun.
 *
 * Together those turned one missing directory into a permanent upload outage:
 * the TypeError escaped before the dead handle was dropped from module state,
 * so every later sweep read a closed handle and every upload 500'd until the
 * process restarted.
 */
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    opendir: async (path: string) => {
      if (unreadableRoots.has(path)) {
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${path}'`), {
          code: 'EACCES',
          syscall: 'scandir',
          path,
        })
      }
      if (!bunLazyRoots.has(path)) return actual.opendir(path)
      let closed = false
      return {
        path,
        async read() {
          if (closed) {
            throw Object.assign(new Error('Directory handle was closed'), {
              code: 'ERR_DIR_CLOSED',
            })
          }
          throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), {
            code: 'ENOENT',
            syscall: 'scandir',
            path,
          })
        },
        close() {
          closed = true
          return undefined as unknown as Promise<void>
        },
        closeSync() {
          closed = true
        },
      } as unknown as Awaited<ReturnType<typeof actual.opendir>>
    },
  }
})

import {
  LOCAL_UPLOAD_ARTIFACT_TTL_MS,
  maybeCleanupLocalUploadArtifacts,
  resetLocalUploadCleanupForTesting,
  sweepLocalUploadArtifacts,
} from '@/lib/uploads/upload-session/cleanup'

describe('local upload artifact cleanup', () => {
  beforeEach(async () => {
    resetLocalUploadCleanupForTesting()
    bunLazyRoots.clear()
    unreadableRoots.clear()
    await rm(testUploadDirectory, { recursive: true, force: true })
    await mkdir(testUploadDirectory, { recursive: true })
  })

  it('removes expired multipart entries while retaining fresh entries', async () => {
    const now = Date.UTC(2026, 7, 4, 12)
    await createArtifact('.multipart/expired', now - LOCAL_UPLOAD_ARTIFACT_TTL_MS - 1)
    await createArtifact('.multipart/fresh', now)

    await expect(sweepLocalUploadArtifacts({ now })).resolves.toEqual({ scanned: 2, removed: 1 })
    await expect(stat(`${testUploadDirectory}/.multipart/expired`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(stat(`${testUploadDirectory}/.multipart/fresh`)).resolves.toBeDefined()
  })

  // A PUT or multipart assembly that dies mid-write leaves a staged object
  // behind, so staging lives under a sweep root rather than beside its
  // destination.
  it('reclaims abandoned staged objects', async () => {
    const now = Date.UTC(2026, 7, 4, 12)
    await createStagedObject('abandoned.tmp', now - LOCAL_UPLOAD_ARTIFACT_TTL_MS - 1)
    await createStagedObject('in-flight.tmp', now)

    await expect(sweepLocalUploadArtifacts({ now })).resolves.toEqual({ scanned: 2, removed: 1 })
    await expect(stat(`${testUploadDirectory}/.staging/abandoned.tmp`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(stat(`${testUploadDirectory}/.staging/in-flight.tmp`)).resolves.toBeDefined()
  })

  it('bounds each sweep by the requested entry count', async () => {
    const now = Date.UTC(2026, 7, 4, 12)
    await createArtifact('.multipart/one', now - LOCAL_UPLOAD_ARTIFACT_TTL_MS - 1)
    await createArtifact('.multipart/two', now - LOCAL_UPLOAD_ARTIFACT_TTL_MS - 1)

    const result = await sweepLocalUploadArtifacts({ now, maxEntries: 1 })

    expect(result).toEqual({ scanned: 1, removed: 1 })
  })

  it('continues from its directory cursor so old entries cannot starve behind fresh ones', async () => {
    const now = Date.UTC(2026, 7, 4, 12)
    for (let index = 0; index < 5; index++) {
      await createArtifact(`.multipart/fresh-${index}`, now)
    }
    await createArtifact('.multipart/expired-last', now - LOCAL_UPLOAD_ARTIFACT_TTL_MS - 1)

    const sweeps = [
      await sweepLocalUploadArtifacts({ now, maxEntries: 2 }),
      await sweepLocalUploadArtifacts({ now, maxEntries: 2 }),
      await sweepLocalUploadArtifacts({ now, maxEntries: 2 }),
    ]

    expect(sweeps.reduce((total, result) => total + result.scanned, 0)).toBe(6)
    expect(sweeps.reduce((total, result) => total + result.removed, 0)).toBe(1)
    await expect(stat(`${testUploadDirectory}/.multipart/expired-last`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  // Every restart hands the app an empty upload volume, so the first
  // upload-session create of a pod's life sweeps roots that nothing has written
  // yet. That must cost the upload nothing -- and, because the handles are
  // cached in module state, it must cost the NEXT upload nothing either.
  it('survives roots that only report their absence at read, and does not poison later sweeps', async () => {
    const now = Date.UTC(2026, 7, 4, 12)
    bunLazyRoots.add(`${testUploadDirectory}/.multipart`)
    bunLazyRoots.add(`${testUploadDirectory}/.staging`)

    await expect(sweepLocalUploadArtifacts({ now })).resolves.toEqual({ scanned: 0, removed: 0 })
    await expect(sweepLocalUploadArtifacts({ now })).resolves.toEqual({ scanned: 0, removed: 0 })
  })

  // The sweep is maintenance. It runs inline on upload-session create, so any
  // failure it cannot interpret must still leave the upload alone.
  it('never fails its caller, even when the sweep itself cannot run', async () => {
    const now = Date.UTC(2026, 7, 4, 12)
    unreadableRoots.add(`${testUploadDirectory}/.multipart`)
    unreadableRoots.add(`${testUploadDirectory}/.staging`)

    await expect(sweepLocalUploadArtifacts({ now })).rejects.toMatchObject({ code: 'EACCES' })
    await expect(maybeCleanupLocalUploadArtifacts(now)).resolves.toEqual({
      scanned: 0,
      removed: 0,
    })
  })

  it('coalesces concurrent cleanup and rate-limits the next sweep', async () => {
    const now = Date.UTC(2026, 7, 4, 12)
    await createArtifact('.multipart/expired', now - LOCAL_UPLOAD_ARTIFACT_TTL_MS - 1)

    const [first, concurrent] = await Promise.all([
      maybeCleanupLocalUploadArtifacts(now),
      maybeCleanupLocalUploadArtifacts(now),
    ])

    expect(first).toEqual({ scanned: 1, removed: 1 })
    expect(concurrent).toEqual(first)
    await expect(maybeCleanupLocalUploadArtifacts(now)).resolves.toEqual({ scanned: 0, removed: 0 })
  })
})

/** Staged objects are files, not the per-upload directories multipart leaves. */
async function createStagedObject(name: string, modifiedAt: number): Promise<void> {
  const directory = `${testUploadDirectory}/.staging`
  await mkdir(directory, { recursive: true })
  const path = `${directory}/${name}`
  await writeFile(path, 'test')
  const time = new Date(modifiedAt)
  await utimes(path, time, time)
}

async function createArtifact(relativePath: string, modifiedAt: number): Promise<void> {
  const path = `${testUploadDirectory}/${relativePath}`
  await mkdir(path, { recursive: true })
  await writeFile(`${path}/payload`, 'test')
  const time = new Date(modifiedAt)
  await utimes(path, time, time)
}
