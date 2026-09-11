/** Session actions and independent result panels; no command transcript output. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RewindHeaderActions } from './actions.ts'
import { SnapshotPanel } from './SnapshotPanel.tsx'
import { RedoAction } from './RedoAction.tsx'

export type RewindHeaderProps = PropsRuntime<'conversation.session.header.actions'> & RewindHeaderActions & PropsLocale<'filesnap'>

export function RewindHeader(props: RewindHeaderProps) {
  return <><RedoAction {...props} /><SnapshotPanel onStatus={props.onStatus} onCleanupPreview={props.onCleanupPreview} onCleanupConfirm={props.onCleanupConfirm} t={props.t} /></>
}
