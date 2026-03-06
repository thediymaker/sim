import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { SIM_AGENT_API_URL, SIM_AGENT_API_URL_DEFAULT } from '@/lib/copilot/constants'
import { authenticateCopilotRequestSessionOnly } from '@/lib/copilot/request-helpers'
import type { AvailableModel } from '@/lib/copilot/types'
import { env } from '@/lib/core/config/env'
import { filterBlacklistedModels } from '@/providers/utils'

const logger = createLogger('CopilotModelsAPI')

interface RawAvailableModel {
  id: string
  friendlyName?: string
  displayName?: string
  provider?: string
}

function isRawAvailableModel(item: unknown): item is RawAvailableModel {
  return (
    typeof item === 'object' &&
    item !== null &&
    'id' in item &&
    typeof (item as { id: unknown }).id === 'string'
  )
}

/**
 * Fetch models from LiteLLM proxy (used when no external copilot backend is configured).
 */
async function fetchLiteLLMModels(): Promise<AvailableModel[]> {
  const baseUrl = (env.LITELLM_BASE_URL || '').replace(/\/v1\/?$/, '').replace(/\/$/, '')
  if (!baseUrl) return []

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.LITELLM_API_KEY) {
    headers.Authorization = `Bearer ${env.LITELLM_API_KEY}`
  }

  const response = await fetch(`${baseUrl}/v1/models`, {
    headers,
    cache: 'no-store',
  })

  if (!response.ok) {
    logger.warn('LiteLLM models endpoint returned non-OK', { status: response.status })
    return []
  }

  const data = (await response.json()) as { data: Array<{ id: string }> }
  const allIds = data.data.map((m) => m.id)
  const filtered = filterBlacklistedModels(allIds)

  return filtered.map((id) => ({
    id,
    friendlyName: id,
    provider: 'litellm',
  }))
}

export async function GET(_req: NextRequest) {
  const { userId, isAuthenticated } = await authenticateCopilotRequestSessionOnly()
  if (!isAuthenticated || !userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // If no custom SIM_AGENT_API_URL is configured, use LiteLLM as the model source
  const useLiteLLM = !env.SIM_AGENT_API_URL || SIM_AGENT_API_URL === SIM_AGENT_API_URL_DEFAULT

  if (useLiteLLM && env.LITELLM_BASE_URL) {
    try {
      logger.info('Fetching copilot models from LiteLLM', { baseUrl: env.LITELLM_BASE_URL })
      const models = await fetchLiteLLMModels()
      logger.info('LiteLLM copilot models fetched', { count: models.length })
      return NextResponse.json({ success: true, models })
    } catch (error) {
      logger.error('Error fetching LiteLLM models for copilot', {
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        { success: false, error: 'Failed to fetch models from LiteLLM', models: [] },
        { status: 500 }
      )
    }
  }

  // Otherwise proxy to external copilot backend
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (env.COPILOT_API_KEY) {
    headers['x-api-key'] = env.COPILOT_API_KEY
  }

  try {
    const response = await fetch(`${SIM_AGENT_API_URL}/api/get-available-models`, {
      method: 'GET',
      headers,
      cache: 'no-store',
    })

    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      logger.warn('Failed to fetch available models from copilot backend', {
        status: response.status,
      })
      return NextResponse.json(
        {
          success: false,
          error: payload?.error || 'Failed to fetch available models',
          models: [],
        },
        { status: response.status }
      )
    }

    const rawModels = Array.isArray(payload?.models) ? payload.models : []
    const models: AvailableModel[] = rawModels
      .filter((item: unknown): item is RawAvailableModel => isRawAvailableModel(item))
      .map((item: RawAvailableModel) => ({
        id: item.id,
        friendlyName: item.friendlyName || item.displayName || item.id,
        provider: item.provider || 'unknown',
      }))

    return NextResponse.json({ success: true, models })
  } catch (error) {
    logger.error('Error fetching available models', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch available models',
        models: [],
      },
      { status: 500 }
    )
  }
}
