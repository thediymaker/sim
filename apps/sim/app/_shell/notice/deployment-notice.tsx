'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@sim/emcn'
import { getEnv } from '@/lib/core/config/env'

/**
 * One-time operator announcement, shown once per `NEXT_PUBLIC_NOTICE_ID` per
 * browser. Used to tell users about a change they did not ask for and cannot
 * infer — a migration, a hostname move, a model rename.
 *
 * Everything is read through {@link getEnv}, so the text is a values change and
 * a redeploy, never a rebuild: this deployment serves `NEXT_PUBLIC_*` at runtime
 * off `window.__ENV`, and nothing here is inlined into the client bundle.
 *
 * - `NEXT_PUBLIC_NOTICE_ID`    dismissal key. **Unset or empty = feature off.**
 *                              Bumping it re-shows the notice to everyone, so
 *                              treat it as the announcement's version.
 * - `NEXT_PUBLIC_NOTICE_TITLE` heading.
 * - `NEXT_PUBLIC_NOTICE_BODY`  body. Split on `\n` into paragraphs; blank lines
 *                              collapse.
 * - `NEXT_PUBLIC_NOTICE_CTA`   dismiss label, default `Got it`.
 *
 * The body is rendered as text nodes, never `dangerouslySetInnerHTML`. It is
 * operator-authored and so not hostile, but it arrives through an env var that
 * is echoed into every page's `<html>` attribute — keeping it inert means a
 * careless edit cannot become script on every surface of the app.
 */
export function DeploymentNotice() {
  const id = getEnv('NEXT_PUBLIC_NOTICE_ID')?.trim()
  const title = getEnv('NEXT_PUBLIC_NOTICE_TITLE')?.trim()
  const body = getEnv('NEXT_PUBLIC_NOTICE_BODY') ?? ''
  const cta = getEnv('NEXT_PUBLIC_NOTICE_CTA')?.trim() || 'Got it'

  /**
   * Starts closed and opens from an effect. The dismissal lives in
   * `localStorage`, which the server cannot read, so rendering it open on the
   * first pass would flash the modal at everyone who had already dismissed it
   * and break hydration. One frame late is the correct trade.
   */
  const [open, setOpen] = useState(false)

  const storageKey = id ? `sim:notice:${id}` : null

  useEffect(() => {
    if (!storageKey) return
    try {
      if (window.localStorage.getItem(storageKey) === null) setOpen(true)
    } catch {
      // Private mode, or storage disabled/full. Showing the notice every load
      // is worse than never showing it, so stay closed.
    }
  }, [storageKey])

  function dismiss() {
    setOpen(false)
    if (!storageKey) return
    try {
      window.localStorage.setItem(storageKey, new Date().toISOString())
    } catch {
      // Dismissal will not persist; the modal is still closed for this page.
    }
  }

  if (!storageKey || !title) return null

  const paragraphs = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return (
    <Modal open={open} onOpenChange={(next) => (next ? setOpen(true) : dismiss())}>
      <ModalContent size='sm'>
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
          {paragraphs.length === 0 && <ModalDescription className='sr-only'>{title}</ModalDescription>}
        </ModalHeader>
        {paragraphs.length > 0 && (
          <ModalBody>
            <div className='flex flex-col gap-3 text-[var(--text-secondary)] text-sm leading-relaxed'>
              {paragraphs.map((text, i) => (
                // Operator-authored static text, reordered only by an env edit
                // that also changes NOTICE_ID and remounts the whole tree.
                // biome-ignore lint/suspicious/noArrayIndexKey: stable list
                <p key={i}>{text}</p>
              ))}
            </div>
          </ModalBody>
        )}
        <ModalFooter>
          <Button onClick={dismiss}>{cta}</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
