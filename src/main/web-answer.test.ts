import { expect, it, vi } from 'vitest'
import { answerFromEvidence } from './web-answer'

const evidence = { results: [{ title: 'Example source', url: 'https://example.org/fact', snippet: 'A source excerpt.' }] }
it('resolves valid numbered citations without inventing sources', async () => {
    expect(await answerFromEvidence('Question', evidence, async () => 'Answer [1].')).toBe('Answer [1](https://example.org/fact).\n\n<!-- web-sources -->\n- [Example source](https://example.org/fact)')
})
it('allows honest uncertainty rather than forcing an unsupported answer', async () => {
    const generate = vi.fn()
        .mockResolvedValueOnce('The evidence is insufficient. [Source](https://example.org/fact)')
        .mockResolvedValueOnce('The answer is 42. [Source](https://example.org/fact)')
    const answer = await answerFromEvidence('An arbitrary question', evidence, generate)
    expect(answer).toContain('evidence is insufficient')
    expect(generate).toHaveBeenCalledTimes(1)
})
it('rejects invented source links and out-of-range citations', async () => {
    for (const invalid of ['Answer [9].', 'Answer [source](https://invented.example/fact).']) {
        const generate = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce('Supported answer [1].')
        expect(await answerFromEvidence('Question', evidence, generate)).toContain('Supported answer')
        expect(generate).toHaveBeenCalledTimes(2)
    }
})
it('does not ask a model to answer without evidence', async () => {
    const generate = vi.fn()
    expect(await answerFromEvidence('Question', { results: [] }, generate)).toContain('cannot verify')
    expect(generate).not.toHaveBeenCalled()
})
it('returns honest source links after two unusable responses', async () => {
    const generate = vi.fn().mockResolvedValue('I will search for that now.')
    expect(await answerFromEvidence('Another question', evidence, generate)).toContain('could not produce a reliable sourced answer')
    expect(generate).toHaveBeenCalledTimes(2)
})
