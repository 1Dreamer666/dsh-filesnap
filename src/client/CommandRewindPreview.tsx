import { useEffect, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RewindActions } from './actions.ts'
import type { rewindSelection } from './rewind-menu.ts'
import { RewindControl } from './RewindAction.tsx'

export interface CommandRewindActions {
  selection: ReturnType<typeof rewindSelection>
  onPreview: RewindActions['onPreview']
  onRewind: RewindActions['onRewind']
}

/** The menu chooses a target; this independent dialog owns file confirmation. */
export function CommandRewindPreview({ selection, onPreview, onRewind, t }: CommandRewindActions & PropsLocale<'filesnap'>) {
  const current = useSyncExternalStore(selection.subscribe, selection.snapshot)
  useEffect(() => () => { selection.close() }, [selection])
  return current === null ? null : <RewindControl key={current.sequence} point={current.point}
    autoOpen onClose={selection.close} onPreview={onPreview} onRewind={onRewind} t={t} />
}
