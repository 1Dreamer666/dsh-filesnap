import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldPoints, initialPoints, reducePoints, selectPoint } from '../src/points.ts'
function events(): SessionEvent[] {
  return [1, 2, 3].flatMap(turn => [
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: { content: [{ type: 'text', text: `prompt ${turn}\nmore` }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { turn, message: { id: `m${turn}` } } },
    { type: 'turn/end', data: { turn } },
  ]).map((e, seq) => ({ ...e, seq: seq * 2, time: 1000 + seq })) as unknown as SessionEvent[]
}
describe('structural turn anchors', () => {
  it('uses only native messages, retaining labels and sparse sequence anchors', () => {
    const log = events()
    const points = foldPoints(log)
    expect(points.map(p => p.point)).toEqual(['', '', ''])
    expect(points.map(p => p.label)).toEqual(['prompt 1', 'prompt 2', 'prompt 3'])
    expect(points[0]?.boundary).toBeUndefined()
    for (const point of points.slice(1)) {
      const end = log.find(e => e.type === 'turn/end' && e.seq >= point.boundary!)!
      expect((end.data as { turn: number }).turn).toBe(point.turn - 1)
      expect(point.messageId).toBe(`m${point.turn - 1}`)
    }
  })
  it('ignores historical plugin events and does not recreate an operation log', () => {
    const state = initialPoints()
    const event = { type: 'filesnap/rewound', data: { child: 'x' } } as unknown as SessionEvent
    expect(reducePoints(state, event)).toBe(state)
    expect(foldPoints(events())).not.toHaveProperty('lastReply')
  })
  it('ignores injected user-role content when labelling turns', () => {
    const log = events()
    const user = log[1]!
    const injected = { ...user, data: { ...user.data, source: { kind: 'tool' } } } as unknown as SessionEvent
    expect(foldPoints([log[0]!, injected])[0]?.label).toBeUndefined()
  })
  it('selects explicit snapshot ids before numeric turn selectors', () => {
    const points = foldPoints(events()).map((p, i) => ({ ...p, point: i === 0 ? '2' : `s.t${p.turn}` }))
    expect(selectPoint(points, '2')?.turn).toBe(1)
    expect(selectPoint(points, 's.t3')?.turn).toBe(3)
    expect(selectPoint(points, '999')).toBeUndefined()
  })
})
