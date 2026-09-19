/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GET } from '@/app/api/health/route'

describe('GET /api/health', () => {
  const originalVersion = process.env.SIM_VERSION

  afterEach(() => {
    if (originalVersion === undefined) delete process.env.SIM_VERSION
    else process.env.SIM_VERSION = originalVersion
  })

  it('returns an ok status payload', async () => {
    process.env.SIM_VERSION = 'v0.8.43-20260918'
    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      timestamp: expect.any(String),
      version: 'v0.8.43-20260918',
    })
  })

  // An image built without --build-arg SIM_VERSION still has to answer probes:
  // the endpoint's first job is liveness, and reporting an unknown build is
  // strictly better than 500ing a container out of its own rollout.
  it('reports an unknown version rather than failing when SIM_VERSION is unset', async () => {
    delete process.env.SIM_VERSION
    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      version: 'unknown',
    })
  })
})
