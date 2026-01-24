'use client'

import { useEffect, useRef, useState } from 'react'
import {
  Badge,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverItem,
  PopoverScrollArea,
} from '@/components/emcn'
import { getProviderIcon } from '@/providers/utils'
import { MODEL_OPTIONS } from '../../constants'

interface ModelSelectorProps {
  /** Currently selected model */
  selectedModel: string
  /** Whether the input is near the top of viewport (affects dropdown direction) */
  isNearTop: boolean
  /** Callback when model is selected */
  onModelSelect: (model: string) => void
}

/**
 * Gets the appropriate icon component for a model
 */
function getModelIconComponent(modelValue: string) {
  const IconComponent = getProviderIcon(modelValue)
  if (!IconComponent) {
    return null
  }
  return <IconComponent className='h-3.5 w-3.5' />
}

/**
 * Model selector dropdown for choosing AI model.
 * Displays model icon and label.
 *
 * @param props - Component props
 * @returns Rendered model selector dropdown
 */
export function ModelSelector({ selectedModel, isNearTop, onModelSelect }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<{ value: string; label: string }[]>([])
  const triggerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    async function fetchModels() {
      try {
        const response = await fetch('/api/providers/litellm/models')
        if (response.ok) {
          const data = await response.json()
          if (Array.isArray(data.models)) {
            const dynamicModels = data.models.map((id: string) => ({
              value: id,
              label: id,
            }))
            // Fallback to static if dynamic is empty, or just use dynamic
            // If the user wants ONLY models from endpoint, we should use dynamic ONLY.
            if (dynamicModels.length > 0) {
              setModels(dynamicModels)
            } else {
              // Fallback or empty?
              // User said: "litellm will only show the models...".
              // The API might return [] if not configured, in which case we might show nothing or static.
              // Let's set it to dynamic even if empty, or maybe keep a safe fallback.
              setModels([])
            }
          }
        }
      } catch (error) {
        console.error('Failed to fetch models', error)
      }
    }
    fetchModels()
  }, [])

  const getCollapsedModeLabel = () => {
    const model = models.find((m) => m.value === selectedModel)
    return model ? model.label : selectedModel
  }

  const getModelIcon = () => {
    // Attempt to get icon, fallback to a generic one or simple dot if null
    const IconComponent = getProviderIcon(selectedModel)
    if (IconComponent) {
      return (
        <span className='flex-shrink-0'>
          <IconComponent className='h-3 w-3' />
        </span>
      )
    }
    return null
  }

  const handleSelect = (modelValue: string) => {
    onModelSelect(modelValue)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return

    const handleClickOutside = (event: MouseEvent) => {
      // Keep popover open while resizing the panel (mousedown on resize handle)
      const target = event.target as Element | null
      if (
        target &&
        (target.closest('[aria-label="Resize panel"]') ||
          target.closest('[role="separator"]') ||
          target.closest('.cursor-ew-resize'))
      ) {
        return
      }

      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  // If no models loaded yet, use selectedModel as single option or static fallback?
  // User wants just the list.
  const displayModels = models.length > 0 ? models : (MODEL_OPTIONS.length > 0 ? MODEL_OPTIONS : [{ value: selectedModel, label: selectedModel }])

  return (
    <Popover open={open} variant='default'>
      <PopoverAnchor asChild>
        <div ref={triggerRef} className='min-w-0 max-w-full'>
          <Badge
            variant='outline'
            className='min-w-0 max-w-full cursor-pointer rounded-[6px]'
            title='Choose model'
            aria-expanded={open}
            onMouseDown={(e) => {
              e.stopPropagation()
              setOpen((prev) => !prev)
            }}
          >
            {getModelIcon()}
            <span className='min-w-0 flex-1 truncate'>{getCollapsedModeLabel()}</span>
          </Badge>
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={popoverRef}
        side={isNearTop ? 'bottom' : 'top'}
        align='start'
        sideOffset={4}
        maxHeight={280}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <PopoverScrollArea className='space-y-[2px]'>
          {displayModels.map((option) => (
            <PopoverItem
              key={option.value}
              active={selectedModel === option.value}
              onClick={() => handleSelect(option.value)}
            >
              {getModelIconComponent(option.value)}
              <span>{option.label}</span>
            </PopoverItem>
          ))}
        </PopoverScrollArea>
      </PopoverContent>
    </Popover>
  )
}
