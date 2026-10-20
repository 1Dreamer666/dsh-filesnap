import { expect, it } from 'vitest'
import { pickIcon } from '../src/client/icon-pick.ts'

it('takes the first candidate the module exports', () => {
  const regular = () => null
  const sized = () => null
  expect(pickIcon({ IconRefreshOutlineRegular: regular, IconRefreshOutline16: sized }, ['IconRefreshOutlineRegular', 'IconRefreshOutline16'])).toBe(regular)
})

it('falls through candidate names the module lacks', () => {
  const sized = () => null
  expect(pickIcon({ IconRefreshOutline16: sized }, ['IconRefreshOutlineRegular', 'IconRefreshOutline16'])).toBe(sized)
})

it('treats a non-component value as absent', () => {
  const sized = () => null
  expect(pickIcon({ IconDataOutlineRegular: 'SHIELD_OUTLINE_PATH', IconDataOutline16: sized }, ['IconDataOutlineRegular', 'IconDataOutline16'])).toBe(sized)
})

it('resolves nothing when the module exports none of the names', () => {
  expect(pickIcon({}, ['IconRefreshOutlineRegular', 'IconRefreshOutline16'])).toBeUndefined()
})
