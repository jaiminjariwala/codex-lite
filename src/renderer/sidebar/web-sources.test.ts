import { expect, it } from 'vitest'
import { webSources } from './web-sources'
it('moves numbered citations into deduplicated sources with real titles', () => {
    const result = webSources('Answer [1](https://example.com/fact). [1](https://example.com/fact)\n\n<!-- web-sources -->\n- [Fact title](https://example.com/fact)')
    expect(result.text).toBe('Answer.')
    expect(result.sources).toEqual([{ title: 'Fact title', url: 'https://example.com/fact', domain: 'example.com' }])
})
it('keeps ordinary inline links and code examples untouched', () => {
    const text = 'Try [React](https://react.dev).\n```md\n[1](https://example.org)\n```'
    expect(webSources(text)).toEqual({ text, sources: [] })
})
it('moves a standalone reference link into the accordion', () => {
    const result = webSources('Daily rate.\n\n[Reference rate](https://example.org/rates)')
    expect(result.text).toBe('Daily rate.')
    expect(result.sources[0].title).toBe('Reference rate')
})
