'use client'

import dynamic from 'next/dynamic'

/**
 * Loads {@link DeploymentNotice} on the client only.
 *
 * Deliberately unlike {@link ConsentProvider} in two ways. It is **not** gated
 * on `isHosted` — this is the self-hosted operator's own channel to its users,
 * and it is the only one. And it mounts inside the workspace too: consent
 * belongs in Settings once you are signed in, but a migration notice is for
 * exactly the signed-in user staring at a workspace that changed under them.
 *
 * `ssr: false` keeps it off the server render, so a deployment with no notice
 * configured never ships the chunk — `NEXT_PUBLIC_NOTICE_ID` unset makes the
 * component render `null`, and the import is the only cost, paid lazily.
 */
const DeploymentNotice = dynamic(
  () => import('@/app/_shell/notice/deployment-notice').then((m) => m.DeploymentNotice),
  { ssr: false }
)

export function NoticeProvider() {
  return <DeploymentNotice />
}
