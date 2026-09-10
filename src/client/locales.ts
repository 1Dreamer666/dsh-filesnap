/**
 * `filesnap` namespace dictionaries. Product copy is Chinese, so `zh` is the
 * key-set source of truth and `en` is checked complete against it.
 *
 * @module
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'previewTitle': '回退到第 {turn} 轮之前：文件变更清单',
  'previewExplanation': '确认后将恢复对话和以下文件，并打开新分支。原对话保留，可用 /redo 撤销回退。',
  'previewLoading': '正在检查文件变更…',
  'previewUnavailable': '无法获取完整文件清单，请重新预览。',
  'previewCounts': '写回或恢复 {written} 个文件，删除 {deleted} 个文件',
  'previewEmpty': '已跟踪文件没有变化；确认后仍会回退对话。',
  'previewFiles': '将变更的文件',
  'previewWrite': '写回 / 恢复',
  'previewDelete': '删除',
  'previewRefreshNotice': '清单根据当前文件状态计算。若文件变化或预览超过 5 分钟，需要重新预览。',
  'previewRetry': '重新预览',
  'cancel': '取消',
  'confirmRewind': '确认回退对话和文件',
  'rewinding': '正在回退…',
  'rewindHere': '回退到这一轮之前',
  'rewindTo': '回退到「{label}」之前',
  'covered': '本轮跟踪 {tracked} 个文件（新哈希 {hashed}）',
  'dropped': '跳过 {dropped} 个',
  'failed': '回退未完成：{reason}',
  'undo': '撤销回退',
  'undoFrom': '撤销回退到「{label}」',
  'status': '查看快照状态',
} satisfies Record<string, string>

/** The filesnap namespace key union. */
export type RewindKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'previewTitle': 'Rewind to before turn {turn}: file changes',
  'previewExplanation': 'Confirmation restores the conversation and these files, then opens a new branch. The original conversation is kept; /redo reverses the rewind.',
  'previewLoading': 'Checking file changes…',
  'previewUnavailable': 'Could not read the complete file list. Preview again.',
  'previewCounts': '{written} files to write or restore, {deleted} files to delete',
  'previewEmpty': 'No tracked file changes. Confirmation will still rewind the conversation.',
  'previewFiles': 'Files that will change',
  'previewWrite': 'Write / restore',
  'previewDelete': 'Delete',
  'previewRefreshNotice': 'This list reflects current files. Preview again if files change or more than 5 minutes pass.',
  'previewRetry': 'Refresh preview',
  'cancel': 'Cancel',
  'confirmRewind': 'Confirm conversation and file rewind',
  'rewinding': 'Rewinding…',
  'rewindHere': 'Rewind to before this turn',
  'rewindTo': 'Rewind to before “{label}”',
  'covered': '{tracked} files tracked this turn ({hashed} newly hashed)',
  'dropped': '{dropped} skipped',
  'failed': 'The rewind did not complete: {reason}',
  'undo': 'Undo the rewind',
  'undoFrom': 'Undo the rewind to “{label}”',
  'status': 'Show snapshot status',
} satisfies Record<RewindKey, string>
