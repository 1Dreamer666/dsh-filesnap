/** Fill only an idle, empty child composer; never replace a newly written draft. */
export function refillPrompt(input: {
  state: { getSnapshot(): { draft: string; imageIds: readonly unknown[]; phase: string } }
  setDraft(text: string): void
}, text: string | undefined): boolean {
  if (text === undefined || text === '') return false
  const current = input.state.getSnapshot()
  if (current.draft !== '' || current.imageIds.length !== 0 || current.phase !== 'plain') return false
  input.setDraft(text)
  return true
}
