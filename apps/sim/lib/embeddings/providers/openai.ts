import { getEnv } from '@/lib/core/config/env'
import type { EmbeddingAdapterFactory } from '@/lib/embeddings/types'

/**
 * ASU: base URL for the OpenAI-compatible embeddings endpoint. Unset upstream,
 * so the default reproduces stock behaviour exactly; set to a LiteLLM/vLLM
 * proxy to serve knowledge-base embeddings from a self-hosted model. Sim pins
 * every KB vector to KB_EMBEDDING_DIMENSIONS and passes it as `dimensions`, so
 * the served model must honour Matryoshka truncation at that width.
 */
const openAIEmbeddingsBase = (): string | undefined =>
  getEnv('OPENAI_BASE_URL')?.replace(/\/+$/, '') || undefined

const openAIEmbeddingsUrl = (): string => {
  const base = openAIEmbeddingsBase()
  return base ? `${base}/embeddings` : 'https://api.openai.com/v1/embeddings'
}

/** OpenAI-compatible envelope; Azure and OpenRouter request numeric vectors. */
export interface OpenAIEmbeddingResponse<TEmbedding = number[]> {
  data: Array<{ embedding: TEmbedding }>
  usage?: { prompt_tokens?: number; total_tokens?: number }
}

/** OpenAI rejects an `input` array longer than 2048 entries. */
export const OPENAI_MAX_ITEMS_PER_REQUEST = 2048

/** Reject malformed or oversized payloads before materializing the numeric vector. */
function decodeEmbedding(encoded: string, dimensions: number): number[] {
  const byteLength = dimensions * Float32Array.BYTES_PER_ELEMENT
  if (typeof encoded !== 'string' || encoded.length !== 4 * Math.ceil(byteLength / 3)) {
    throw new Error('Invalid base64 embedding length')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== byteLength || bytes.toString('base64') !== encoded) {
    throw new Error('Invalid base64 embedding')
  }
  return Array.from({ length: dimensions }, (_, index) =>
    bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT)
  )
}

/**
 * OpenAI `/v1/embeddings`. Omitting `dimensions` yields the model's native
 * dimensionality. Base64 carries Float32 coordinates with less JSON overhead,
 * matching the native OpenAI SDK's transport; callers still receive number arrays.
 */
export const createOpenAIAdapter: EmbeddingAdapterFactory = ({
  modelName,
  apiKey,
  nativeDimensions,
}) => ({
  maxItemsPerRequest: OPENAI_MAX_ITEMS_PER_REQUEST,
  buildRequest: ({ inputs, dimensions }) => {
    // ASU: `encoding_format: 'base64'` is a request, not a guarantee. OpenAI
    // honours it; an OpenAI-compatible gateway need not, and ours (LiteLLM in
    // front of vLLM) answers with plain float arrays whatever we ask for --
    // which `decodeEmbedding` rejects, failing every knowledge-base embedding.
    // Upstream is right to reject an unexpected shape rather than guess at it,
    // so do not loosen the check: ask for the format we can actually parse.
    // Only a deployment that has pointed OPENAI_BASE_URL at its own gateway
    // takes this branch; the stock OpenAI path is untouched, base64 and strict.
    const base64 = openAIEmbeddingsBase() === undefined
    return {
      apiUrl: openAIEmbeddingsUrl(),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: {
        input: inputs,
        model: modelName,
        encoding_format: base64 ? 'base64' : 'float',
        ...(dimensions !== undefined && { dimensions }),
      },
      parse: (json) =>
        (json as OpenAIEmbeddingResponse<string | number[]>).data.map((item) => {
          if (base64) {
            if (typeof item.embedding !== 'string') throw new Error('Invalid base64 embedding')
            return decodeEmbedding(item.embedding, dimensions ?? nativeDimensions)
          }
          const width = dimensions ?? nativeDimensions
          if (!Array.isArray(item.embedding) || item.embedding.length !== width) {
            throw new Error(`Expected a ${width}-dimensional float embedding`)
          }
          return item.embedding
        }),
      parseTokens: (json) => (json as OpenAIEmbeddingResponse).usage?.total_tokens,
    }
  },
})
