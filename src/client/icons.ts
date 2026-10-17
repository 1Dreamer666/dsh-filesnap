/**
 * The icons this plugin's controls render, bound once.
 *
 * The harness renamed its icon set across the generations this plugin spans:
 * the train this plugin was built against names a glyph by its pixel size
 * (`IconRefreshOutline16`), the desktop client now shipping names it by stroke
 * weight (`IconRefreshOutlineRegular`), and neither exports the other's name.
 * Resolving both here keeps a renamed glyph from taking its whole control down
 * with it — an unresolved element type is React error #130, not a missing dot,
 * and a control that crashes renders nothing at all.
 *
 * @module
 */
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { pickIcon, type IconAsset } from './icon-pick.ts'

const table = primitives as unknown as Record<string, unknown>

/** A quiet stand-in so a future rename costs the glyph, never the button. */
const Plain: IconAsset = () => null

/** The refresh mark on the rewind and redo controls. */
export const IconRefresh = pickIcon(table, ['IconRefreshOutlineRegular', 'IconRefreshOutline16']) ?? Plain

/** The data mark on the snapshot panel control. */
export const IconData = pickIcon(table, ['IconDataOutlineRegular', 'IconDataOutline16']) ?? Plain
