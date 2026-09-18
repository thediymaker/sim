/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAzureOpenAIAdapter } from '@/lib/embeddings/providers/azure-openai'
import { createOpenAIAdapter } from '@/lib/embeddings/providers/openai'
import { createOpenRouterAdapter } from '@/lib/embeddings/providers/openrouter'

const IDENTITY = {
  modelName: 'text-embedding-3-small',
  apiKey: 'fixture-key',
  nativeDimensions: 1536,
}

describe('OpenAI base64 embeddings', () => {
  it('decodes little-endian Float32 values without changing their bits', () => {
    const bytes = Buffer.from('cdcccc3d00000080010000000000803f', 'hex')
    const request = createOpenAIAdapter(IDENTITY).buildRequest({
      inputs: ['query'],
      taskType: 'query',
      dimensions: 4,
    })
    const [vector] = request.parse({ data: [{ embedding: bytes.toString('base64') }] })

    expect(vector).toEqual([Math.fround(0.1), -0, 2 ** -149, 1])
    const roundTrip = Buffer.alloc(bytes.length)
    vector.forEach((value, index) => roundTrip.writeFloatLE(value, index * 4))
    expect(roundTrip).toEqual(bytes)
    expect(Array.isArray(vector)).toBe(true)
  })

  it.each([384, 768, 1024, 1536, 3072])('retains a %i-dimensional vector', (dimensions) => {
    const bytes = Buffer.alloc(dimensions * 4)
    bytes.writeFloatLE(0.5, bytes.length - 4)
    const request = createOpenAIAdapter(IDENTITY).buildRequest({
      inputs: ['document'],
      taskType: 'document',
      dimensions,
    })
    const [vector] = request.parse({ data: [{ embedding: bytes.toString('base64') }] })

    expect(vector).toHaveLength(dimensions)
    expect(vector.at(-1)).toBe(0.5)
  })

  it.each([
    ['text-embedding-ada-002', 1536],
    ['text-embedding-3-small', 1536],
    ['text-embedding-3-large', 3072],
  ])(
    'validates the native width of %s when dimensions are omitted',
    (modelName, nativeDimensions) => {
      const request = createOpenAIAdapter({
        ...IDENTITY,
        modelName,
        nativeDimensions,
      }).buildRequest({
        inputs: ['document'],
        taskType: 'document',
      })
      const encoded = Buffer.alloc(nativeDimensions * 4).toString('base64')

      expect(request.body).toMatchObject({ encoding_format: 'base64', model: modelName })
      expect(request.body).not.toHaveProperty('dimensions')
      expect(request.parse({ data: [{ embedding: encoded }] })[0]).toHaveLength(nativeDimensions)
      expect(() => request.parse({ data: [{ embedding: 'AAAAAA==' }] })).toThrow('length')
    }
  )

  it.each([
    ['numeric array', [0, 0]],
    ['empty value', ''],
    ['invalid alphabet', '!AAAAAAAAAA='],
    ['whitespace', ' AAAAAAAAAA='],
    ['noncanonical padding bits', 'AAAAAAAAAAB='],
    ['missing padding', 'AAAAAAAAAAA'],
    ['extra padding', 'AAAAAAAAAAA=='],
    ['short byte payload', Buffer.alloc(7).toString('base64')],
    ['trailing byte', Buffer.alloc(9).toString('base64')],
    ['oversized vector', Buffer.alloc(12).toString('base64')],
  ])('rejects %s', (_name, embedding) => {
    const request = createOpenAIAdapter(IDENTITY).buildRequest({
      inputs: ['query'],
      taskType: 'query',
      dimensions: 2,
    })

    expect(() => request.parse({ data: [{ embedding }] })).toThrow('base64 embedding')
  })

  it('keeps Azure and OpenRouter on their existing numeric wire format', () => {
    const adapters = [
      createAzureOpenAIAdapter({
        ...IDENTITY,
        endpoint: 'https://fixture.openai.azure.com',
        apiVersion: '2024-10-21',
      }),
      createOpenRouterAdapter(IDENTITY),
    ]

    for (const adapter of adapters) {
      const request = adapter.buildRequest({ inputs: ['query'], taskType: 'query' })
      expect(request.body).toMatchObject({ encoding_format: 'float' })
      expect(request.parse({ data: [{ embedding: [0.1, 0.2] }] })).toEqual([[0.1, 0.2]])
    }
  })
})

/**
 * ASU: a self-hosted gateway is pointed at with OPENAI_BASE_URL. Ours (LiteLLM
 * in front of vLLM) ignores `encoding_format: 'base64'` and answers with plain
 * float arrays, which the base64 path above correctly refuses -- so that path
 * asks for the format it can parse instead of loosening what it accepts.
 */
describe('OpenAI-compatible gateway (OPENAI_BASE_URL)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const gatewayRequest = (dimensions: number) => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.example.edu/v1/')
    return createOpenAIAdapter(IDENTITY).buildRequest({
      inputs: ['query'],
      taskType: 'query',
      dimensions,
    })
  }

  it('addresses the configured gateway and asks for float, not base64', () => {
    const request = gatewayRequest(4)

    expect(request.apiUrl).toBe('https://openai.example.edu/v1/embeddings')
    expect(request.body).toMatchObject({ encoding_format: 'float', dimensions: 4 })
  })

  it('accepts the numeric array the gateway actually returns', () => {
    const request = gatewayRequest(4)

    expect(request.parse({ data: [{ embedding: [0.1, -0, 2, 1] }] })).toEqual([[0.1, -0, 2, 1]])
  })

  it('still rejects a vector of the wrong width', () => {
    const request = gatewayRequest(4)

    expect(() => request.parse({ data: [{ embedding: [0.1, 0.2] }] })).toThrow('4-dimensional')
  })

  it('leaves the stock OpenAI path on strict base64', () => {
    const request = createOpenAIAdapter(IDENTITY).buildRequest({
      inputs: ['query'],
      taskType: 'query',
      dimensions: 2,
    })

    expect(request.apiUrl).toBe('https://api.openai.com/v1/embeddings')
    expect(request.body).toMatchObject({ encoding_format: 'base64' })
    expect(() => request.parse({ data: [{ embedding: [0, 0] }] })).toThrow('base64 embedding')
  })
})
