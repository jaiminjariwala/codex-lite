import { expect, it } from 'vitest'
import { fitPanelWidth } from './panel-layout'
it('reserves chat space after subtracting the conversation sidebar', () => {
    const panel = fitPanelWidth(820, 1040, 296)
    expect(panel).toBeCloseTo(409.2)
    expect(1040 - 296 - panel).toBeGreaterThan(330)
})
it('keeps the user chosen width when there is enough space', () => {
    expect(fitPanelWidth(500, 1440, 296)).toBe(500)
})
it('clamps a large panel when the window shrinks', () => {
    expect(fitPanelWidth(820, 800, 230)).toBeCloseTo(313.5)
})
