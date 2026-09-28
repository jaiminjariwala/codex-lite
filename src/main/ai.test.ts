import { describe, it, expect, vi } from 'vitest'
vi.mock('./text-web-search', () => ({ textWebSearch: vi.fn(async () => JSON.stringify({ results: [{ title: 'Source', url: 'https://example.org/evidence', snippet: 'Evidence text' }] })) }))
import type {
    GatewayConfig,
    SessionContext,
    SessionSummary,
    Turn,
    TurnCapture
} from '@shared/types'
import {
    SYSTEM_PROMPT,
    SUMMARY_SYSTEM_PROMPT,
    formatSummary,
    turnToMessage,
    buildCompletionMessages,
    buildSummaryRequestMessages,
    extractUserFacts,
    mergeSummary,
    GatewayAIClient,
    GlassErrorException,
    credentialsMissingError,
    gatewayFailedError,
    type ChatClient,
    type ChatCreateParams,
    type ChatCompletionResult
} from './ai'

// --- Fixtures ---------------------------------------------------------------

const rect = { x: 0, y: 0, width: 10, height: 10 }

function capture(dataUrl: string): TurnCapture {
    return { dataUrl, thumbnailUrl: `${dataUrl}#thumb`, rect }
}

function userTurn(id: string, text?: string, cap?: TurnCapture): Turn {
    return { id, role: 'user', text, capture: cap, createdAt: '2024-01-01T00:00:00Z', status: 'ok' }
}

function assistantTurn(id: string, text: string): Turn {
    return { id, role: 'assistant', text, createdAt: '2024-01-01T00:00:00Z', status: 'ok' }
}

const emptySummary: SessionSummary = {
    inferredIntent: '',
    completedSteps: [],
    updatedThroughTurnId: null
}

it('uses the dedicated search provider and completes a sourced answer', async () => {
    const fake = makeFakeClient('The evidence says so [1].')
    const provider = vi.fn(async () => ({ baseURL: 'http://localhost:11435/v1', model: 'research-model', apiKey: 'local' }))
    const ai = new GatewayAIClient({ getConfig: async () => ({ baseURL: 'http://localhost:11435/v1', model: 'text' }), getApiKey: async () => null, getSearchProvider: provider, createClient: () => fake.client })
    const answer = await ai.complete({ summary: emptySummary, recentTurns: [userTurn('search', 'search on internet for a fact')] })
    expect(provider).toHaveBeenCalledOnce()
    expect(fake.calls[0].model).toBe('research-model')
    expect(answer).toContain('[1](https://example.org/evidence)')
})

it('routes screenshot messages to local vision without a cloud fallback', async () => {
    const fake = makeFakeClient('I see a screenshot')
    const fallback = vi.fn(async () => [])
    const ai = new GatewayAIClient({
        textOnly: true,
        getConfig: async () => ({ baseURL: 'http://localhost:11435/v1', model: 'text' }),
        getApiKey: async () => null,
        getVisionProvider: async () => ({ baseURL: 'http://localhost:11435/v1', model: 'qwen3-vl:2b', apiKey: 'local' }),
        getFallbackProviders: fallback,
        createClient: () => fake.client
    })
    const result = await ai.complete({ summary: emptySummary, recentTurns: [userTurn('image', 'Describe this', capture('data:image/png;base64,AAAA'))] })
    expect(result).toBe('I see a screenshot')
    expect(fake.calls[0].model).toBe('qwen3-vl:2b')
    expect(fake.calls[0].messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))).toBe(true)
    expect(fallback).not.toHaveBeenCalled()
})

it('keeps captures on the private vision route when a question requests search', async () => {
    const fake = makeFakeClient('Visible issue explained using [1].')
    const searchProvider = vi.fn()
    const ai = new GatewayAIClient({
        textOnly: true,
        getConfig: async () => ({ baseURL: 'http://localhost:11435/v1', model: 'text' }),
        getApiKey: async () => null,
        getVisionProvider: async () => ({ baseURL: 'http://localhost:11435/v1', model: 'vision', apiKey: 'local' }),
        getSearchProvider: searchProvider,
        createClient: () => fake.client
    })
    expect(await ai.complete({ summary: emptySummary, recentTurns: [userTurn('image', 'search on internet for this error', capture('data:image/png;base64,AAAA'))] })).toContain('Visible issue')
    expect(fake.calls[0].model).toBe('vision')
    expect(fake.calls[0].messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))).toBe(true)
    expect(searchProvider).not.toHaveBeenCalled()
})

it('does not try another provider after the user cancels', async () => {
    const controller = new AbortController()
    const fallbacks = vi.fn(async () => [])
    const fake = makeFakeClient('unused')
    fake.client.chat.completions.create = async () => {
        controller.abort(new Error('User canceled'))
        throw new Error('Connection stopped')
    }
    const ai = new GatewayAIClient({ ...makeClientOptions(fake.client), getFallbackProviders: fallbacks })
    await expect(ai.complete({ summary: emptySummary, recentTurns: [userTurn('one', 'Hello')] }, SYSTEM_PROMPT, controller.signal)).rejects.toThrow('User canceled')
    expect(fallbacks).not.toHaveBeenCalled()
})

it('tries the configured fallback when the primary returns whitespace', async () => {
    const empty = makeFakeClient('   ')
    const working = makeFakeClient('A real answer')
    const ai = new GatewayAIClient({
        ...makeClientOptions(empty.client),
        getFallbackProviders: async () => [{ baseURL: 'https://fallback.example/v1', model: 'other', apiKey: 'key' }],
        createClient: config => config.model === 'other' ? working.client : empty.client
    })
    expect(await ai.complete({ summary: emptySummary, recentTurns: [userTurn('one', 'Hello')] })).toBe('A real answer')
    expect(working.calls).toHaveLength(1)
})

/** A fake chat client that records the params it received. */
function makeFakeClient(content: string | null): {
    client: ChatClient
    calls: ChatCreateParams[]
} {
    const calls: ChatCreateParams[] = []
    const client: ChatClient = {
        chat: {
            completions: {
                create: async (params: ChatCreateParams): Promise<ChatCompletionResult> => {
                    calls.push(params)
                    return { choices: [{ message: { content } }] }
                }
            }
        }
    }
    return { client, calls }
}

/** A fake chat client whose `create` always rejects with the given error. */
function makeFailingClient(error: unknown): { client: ChatClient; calls: ChatCreateParams[] } {
    const calls: ChatCreateParams[] = []
    const client: ChatClient = {
        chat: {
            completions: {
                create: async (params: ChatCreateParams): Promise<ChatCompletionResult> => {
                    calls.push(params)
                    throw error
                }
            }
        }
    }
    return { client, calls }
}

const config: GatewayConfig = { baseURL: 'https://gw.example/v1', model: 'vision-model' }

function makeClientOptions(
    fake: ChatClient,
    apiKey: string | null = 'secret-key'
): ConstructorParameters<typeof GatewayAIClient>[0] {
    return {
        getConfig: async () => config,
        getApiKey: async () => apiKey,
        createClient: () => fake
    }
}

// --- SYSTEM_PROMPT behavior contract (Req 3.4, 3.5, 3.6, 5.1) ---------------

describe('SYSTEM_PROMPT behavior contract', () => {
    const prompt = SYSTEM_PROMPT.toLowerCase()

    it('is a non-empty string', () => {
        expect(typeof SYSTEM_PROMPT).toBe('string')
        expect(SYSTEM_PROMPT.trim().length).toBeGreaterThan(0)
    })

    it('instructs inferring intent without an explicit goal step (Req 3.4)', () => {
        expect(prompt).toContain('infer')
        expect(prompt).toMatch(/goal|intent/)
        expect(prompt).toMatch(/never (ask|require)|without|implicitly/)
    })

    it('instructs interpreting a text-less capture against the session (Req 3.3)', () => {
        expect(prompt).toMatch(/without (any )?(accompanying )?text/)
        expect(prompt).toContain('context')
    })

    it('instructs returning exactly one concrete next step, not a full plan (Req 5.1)', () => {
        expect(prompt).toMatch(/one|single/)
        expect(prompt).toContain('next step')
        expect(prompt).toMatch(/not (a )?(dump|full)|do not dump/)
    })

    it('instructs asking exactly one clarifying question when unclear (Req 3.5)', () => {
        expect(prompt).toContain('clarifying question')
        expect(prompt).toMatch(/exactly one|one clarifying/)
        expect(prompt).toMatch(/not guess|never guess|do not guess/)
    })

    it('instructs pivoting on a topic change while keeping context (Req 3.6)', () => {
        expect(prompt).toMatch(/new topic|topic change|pivot/)
        expect(prompt).toContain('context')
    })

    it('instructs staying advice-only (never claim to perform actions)', () => {
        expect(prompt).toMatch(/advice-only|observe and advise|advise only/)
        expect(prompt).toMatch(/never (claim|perform)|do not perform/)
    })

    it('answers ordinary coding requests directly with fenced code', () => {
        expect(prompt).toMatch(/coding request|coding questions/)
        expect(prompt).toMatch(/directly and completely/)
        expect(prompt).toMatch(/fenced markdown code block/)
        expect(prompt).toMatch(/right-side code workspace/)
    })
})

// --- formatSummary ----------------------------------------------------------

describe('formatSummary', () => {
    it('renders intent and steps when present', () => {
        const out = formatSummary({
            inferredIntent: 'Grant DynamoDB access',
            completedSteps: ['Opened IAM', 'Selected user'],
            updatedThroughTurnId: 't3'
        })
        expect(out).toContain('Grant DynamoDB access')
        expect(out).toContain('- Opened IAM')
        expect(out).toContain('- Selected user')
    })

    it('uses placeholders when empty so context is always present', () => {
        const out = formatSummary(emptySummary)
        expect(out).toContain('(not yet inferred)')
        expect(out).toContain('(none yet)')
    })
})

// --- turnToMessage ----------------------------------------------------------

describe('turnToMessage', () => {
    it('maps a text-only user turn to a string-content user message', () => {
        expect(turnToMessage(userTurn('t1', 'hello'))).toEqual({
            role: 'user',
            content: 'hello'
        })
    })

    it('maps an assistant turn to an assistant message', () => {
        expect(turnToMessage(assistantTurn('t2', 'do this next'))).toEqual({
            role: 'assistant',
            content: 'do this next'
        })
    })

    it('maps a capture turn to text + image_url content parts', () => {
        const msg = turnToMessage(userTurn('t3', 'look here', capture('data:img1')))
        expect(msg.role).toBe('user')
        expect(msg.content).toEqual([
            { type: 'text', text: 'look here' },
            { type: 'image_url', image_url: { url: 'data:img1' } }
        ])
    })

    it('omits the text part for a text-less capture turn', () => {
        const msg = turnToMessage(userTurn('t4', undefined, capture('data:img2')))
        expect(msg.content).toEqual([{ type: 'image_url', image_url: { url: 'data:img2' } }])
    })
})

// --- buildCompletionMessages ------------------------------------------------

describe('buildCompletionMessages', () => {
    it('orders system contract, summary, then recent turns', () => {
        const ctx: SessionContext = {
            summary: { inferredIntent: 'goal', completedSteps: ['a'], updatedThroughTurnId: 't0' },
            recentTurns: [userTurn('t1', 'hi'), assistantTurn('t2', 'hello')]
        }
        const messages = buildCompletionMessages(ctx)
        expect(messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT })
        expect(messages[1].role).toBe('system')
        expect(messages[1].content).toContain('goal')
        expect(messages[2]).toEqual({ role: 'user', content: 'hi' })
        expect(messages[3]).toEqual({ role: 'assistant', content: 'hello' })
    })

    it('folds persistent memories in as a system message after the summary', () => {
        const ctx: SessionContext = {
            summary: emptySummary,
            recentTurns: [userTurn('t1', 'hi')],
            memories: ['I prefer short answers', 'my timezone is PT']
        }
        const messages = buildCompletionMessages(ctx)
        expect(messages[2]?.role).toBe('system')
        expect(messages[2]?.content).toContain('I prefer short answers')
        expect(messages[2]?.content).toContain('my timezone is PT')
        expect(messages[3]).toEqual({ role: 'user', content: 'hi' })
    })

    it('extractUserFacts keeps at most 3 clean string facts', () => {
        expect(
            extractUserFacts({
                userFacts: ['  prefers short answers ', 42, 'uses pnpm', '', 'x', 'lives in Seattle', 'a fourth fact']
            })
        ).toEqual(['prefers short answers', 'uses pnpm', 'lives in Seattle'])
        expect(extractUserFacts({})).toEqual([])
        expect(extractUserFacts({ userFacts: 'not-an-array' })).toEqual([])
    })

    it('omits the memory message when there are no memories', () => {
        const ctx: SessionContext = {
            summary: emptySummary,
            recentTurns: [userTurn('t1', 'hi')],
            memories: []
        }
        const messages = buildCompletionMessages(ctx)
        expect(messages).toHaveLength(3)
        expect(messages[2]).toEqual({ role: 'user', content: 'hi' })
    })

    it('appends currentCapture as a final user image message', () => {
        const ctx: SessionContext = {
            summary: emptySummary,
            recentTurns: [userTurn('t1', 'context')],
            currentCapture: capture('data:current')
        }
        const messages = buildCompletionMessages(ctx)
        const last = messages[messages.length - 1]
        expect(last.role).toBe('user')
        expect(last.content).toEqual([{ type: 'image_url', image_url: { url: 'data:current' } }])
    })

    it('does not duplicate currentCapture when it is already the last turn', () => {
        const cap = capture('data:dup')
        const ctx: SessionContext = {
            summary: emptySummary,
            recentTurns: [userTurn('t1', 'context'), userTurn('t2', undefined, cap)],
            currentCapture: cap
        }
        const messages = buildCompletionMessages(ctx)
        const imageMessages = messages.filter(
            (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
        )
        expect(imageMessages).toHaveLength(1)
    })

    it('always includes summary context even with no recent turns (Property 1)', () => {
        const ctx: SessionContext = { summary: emptySummary, recentTurns: [] }
        const messages = buildCompletionMessages(ctx)
        expect(messages.filter((m) => m.role === 'system')).toHaveLength(2)
    })
})

// --- buildSummaryRequestMessages --------------------------------------------

describe('buildSummaryRequestMessages', () => {
    it('starts with the summary system prompt and includes prior summary + turns', () => {
        const turns = [userTurn('t1', 'first'), assistantTurn('t2', 'guidance')]
        const messages = buildSummaryRequestMessages(turns, emptySummary)
        expect(messages[0]).toEqual({ role: 'system', content: SUMMARY_SYSTEM_PROMPT })
        expect(messages[1].role).toBe('system')
        expect(messages[1].content).toContain('Previous')
        expect(messages[2]).toEqual({ role: 'user', content: 'first' })
        expect(messages[messages.length - 1].role).toBe('user')
    })
})

// --- mergeSummary -----------------------------------------------------------

describe('mergeSummary', () => {
    const prev: SessionSummary = {
        inferredIntent: 'original intent',
        completedSteps: ['step1'],
        updatedThroughTurnId: 't1'
    }

    it('retains prior intent and steps when the model returns nothing useful', () => {
        const merged = mergeSummary(prev, {}, [userTurn('t2', 'x')])
        expect(merged.inferredIntent).toBe('original intent')
        expect(merged.completedSteps).toEqual(['step1'])
        expect(merged.updatedThroughTurnId).toBe('t2')
    })

    it('unions new steps without dropping existing ones (monotonicity)', () => {
        const merged = mergeSummary(
            prev,
            { inferredIntent: 'refined intent', completedSteps: ['step1', 'step2'] },
            [userTurn('t3', 'y')]
        )
        expect(merged.inferredIntent).toBe('refined intent')
        expect(merged.completedSteps).toEqual(['step1', 'step2'])
        expect(merged.updatedThroughTurnId).toBe('t3')
    })

    it('keeps prior updatedThroughTurnId when there are no turns', () => {
        const merged = mergeSummary(prev, {}, [])
        expect(merged.updatedThroughTurnId).toBe('t1')
    })
})

// --- GatewayAIClient --------------------------------------------------------

describe('GatewayAIClient', () => {
    it('does not bypass a managed access failure using local credentials', async () => {
        const local = makeFakeClient('local answer')
        const ai = new GatewayAIClient({
            getConfig: async () => config,
            getApiKey: async () => 'local-key',
            getManagedProvider: async () => { throw new Error('Desktop access required') },
            createClient: () => local.client
        })
        await expect(ai.complete({ summary: emptySummary, recentTurns: [userTurn('t1', 'hello')] }))
            .rejects.toThrow('Desktop access required')
        expect(local.calls).toHaveLength(0)
    })
    it('keeps custom action instructions and summary in one system message', async () => {
        const { client, calls } = makeFakeClient('{"tool":"done"}')
        const ai = new GatewayAIClient(makeClientOptions(client))
        await ai.complete({ summary: emptySummary, recentTurns: [userTurn('t1', 'open Blender')] }, 'Return one JSON action.')
        const system = calls[0].messages.filter(message => message.role === 'system')
        expect(system).toHaveLength(1)
        expect(system[0].content).toContain('Return one JSON action.')
        expect(system[0].content).toContain(formatSummary(emptySummary))
    })
    it('uses the publisher-managed provider before developer-local credentials', async () => {
        const managed = makeFakeClient('managed answer')
        const local = makeFakeClient('local answer')
        const ai = new GatewayAIClient({
            getConfig: async () => config,
            getApiKey: async () => 'local-key',
            getManagedProvider: async () => ({
                baseURL: 'https://managed.example/v1',
                model: 'managed-standard',
                apiKey: 'app-session'
            }),
            createClient: (nextConfig) => nextConfig.baseURL.includes('managed') ? managed.client : local.client
        })

        await expect(ai.complete({ summary: emptySummary, recentTurns: [userTurn('t1', 'hello')] }))
            .resolves.toBe('managed answer')
        expect(managed.calls).toHaveLength(1)
        expect(local.calls).toHaveLength(0)
    })

    it('complete sends assembled messages with the configured model and returns content', async () => {
        const { client, calls } = makeFakeClient('Next: click Add permissions')
        const ai = new GatewayAIClient(makeClientOptions(client))
        const ctx: SessionContext = {
            summary: emptySummary,
            recentTurns: [userTurn('t1', 'stuck on IAM')],
            currentCapture: capture('data:cap')
        }
        const out = await ai.complete(ctx)
        expect(out).toBe('Next: click Add permissions')
        expect(calls).toHaveLength(1)
        expect(calls[0].model).toBe('vision-model')
        expect(calls[0].messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT })
    })

    it('rejects an empty reply instead of saving a successful blank answer', async () => {
        const { client } = makeFakeClient(null)
        const ai = new GatewayAIClient(makeClientOptions(client))
        await expect(ai.complete({ summary: emptySummary, recentTurns: [] })).rejects.toThrow('empty answer')
    })

    it('throws a typed credentials-missing GlassError when credentials are missing', async () => {
        const { client } = makeFakeClient('unused')
        const ai = new GatewayAIClient(makeClientOptions(client, null))
        await expect(ai.complete({ summary: emptySummary, recentTurns: [] })).rejects.toThrow(
            /credentials are missing/i
        )
        const err = await ai
            .complete({ summary: emptySummary, recentTurns: [] })
            .catch((e) => e)
        expect(err).toBeInstanceOf(GlassErrorException)
        expect(err.glassError.kind).toBe('credentials-missing')
        expect(err.glassError.recoverable).toBe(true)
        expect(err.glassError.action).toBe('enter-credentials')
    })

    it('summarize parses JSON and merges into the prior summary', async () => {
        const { client } = makeFakeClient(
            'Here you go:\n{"inferredIntent":"grant access","completedSteps":["opened IAM"]}'
        )
        const ai = new GatewayAIClient(makeClientOptions(client))
        const prev: SessionSummary = {
            inferredIntent: 'old',
            completedSteps: ['opened IAM'],
            updatedThroughTurnId: null
        }
        const result = await ai.summarize([userTurn('t9', 'context')], prev)
        expect(result.inferredIntent).toBe('grant access')
        expect(result.completedSteps).toEqual(['opened IAM'])
        expect(result.updatedThroughTurnId).toBe('t9')
    })

    it('summarize falls back to prior summary on unparseable output', async () => {
        const { client } = makeFakeClient('no json here')
        const ai = new GatewayAIClient(makeClientOptions(client))
        const prev: SessionSummary = {
            inferredIntent: 'keep me',
            completedSteps: ['s1'],
            updatedThroughTurnId: 't1'
        }
        const result = await ai.summarize([], prev)
        expect(result.inferredIntent).toBe('keep me')
        expect(result.completedSteps).toEqual(['s1'])
    })
})

// --- Failure mapping (Req 7.3) ----------------------------------------------

describe('credentialsMissingError / gatewayFailedError helpers', () => {
    it('credentialsMissingError is a recoverable, settings-routable GlassError', () => {
        const err = credentialsMissingError()
        expect(err.kind).toBe('credentials-missing')
        expect(err.recoverable).toBe(true)
        expect(err.action).toBe('enter-credentials')
        expect(err.message).toMatch(/credentials are missing/i)
    })

    it('gatewayFailedError folds an Error message into a recoverable, retryable GlassError', () => {
        const err = gatewayFailedError(new Error('502 Bad Gateway'))
        expect(err.kind).toBe('gateway-failed')
        expect(err.recoverable).toBe(true)
        expect(err.action).toBe('retry')
        expect(err.message).toContain('502 Bad Gateway')
    })

    it('gatewayFailedError tolerates non-Error causes', () => {
        expect(gatewayFailedError('boom').message).toContain('boom')
        expect(gatewayFailedError(undefined).message).toContain('unknown error')
    })
})

describe('GatewayAIClient failure mapping (Req 7.3, Property 6)', () => {
    it('complete maps a gateway request failure to a typed gateway-failed GlassError', async () => {
        const { client } = makeFailingClient(new Error('network down'))
        const ai = new GatewayAIClient(makeClientOptions(client))
        const err = await ai
            .complete({ summary: emptySummary, recentTurns: [userTurn('t1', 'hi')] })
            .catch((e) => e)
        expect(err).toBeInstanceOf(GlassErrorException)
        expect(err.glassError.kind).toBe('gateway-failed')
        expect(err.glassError.recoverable).toBe(true)
        expect(err.glassError.action).toBe('retry')
        expect(err.glassError.message).toContain('network down')
        // Original cause is preserved for logging.
        expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error)
    })

    it('summarize maps a gateway request failure to a typed gateway-failed GlassError', async () => {
        const { client } = makeFailingClient(new Error('timeout'))
        const ai = new GatewayAIClient(makeClientOptions(client))
        const prev: SessionSummary = {
            inferredIntent: 'keep me',
            completedSteps: ['s1'],
            updatedThroughTurnId: 't1'
        }
        const err = await ai.summarize([userTurn('t2', 'x')], prev).catch((e) => e)
        expect(err).toBeInstanceOf(GlassErrorException)
        expect(err.glassError.kind).toBe('gateway-failed')
    })

    it('does not mutate the SessionContext when complete fails', async () => {
        const { client } = makeFailingClient(new Error('boom'))
        const ai = new GatewayAIClient(makeClientOptions(client))
        const ctx: SessionContext = {
            summary: { inferredIntent: 'goal', completedSteps: ['a'], updatedThroughTurnId: 't0' },
            recentTurns: [userTurn('t1', 'hi'), assistantTurn('t2', 'hello')],
            currentCapture: capture('data:cap')
        }
        const snapshot = JSON.parse(JSON.stringify(ctx))
        await ai.complete(ctx).catch(() => undefined)
        expect(ctx).toEqual(snapshot)
    })

    it('does not mutate the prior summary or turns when summarize fails', async () => {
        const { client } = makeFailingClient(new Error('boom'))
        const ai = new GatewayAIClient(makeClientOptions(client))
        const prev: SessionSummary = {
            inferredIntent: 'keep me',
            completedSteps: ['s1'],
            updatedThroughTurnId: 't1'
        }
        const turns = [userTurn('t2', 'x')]
        const prevSnapshot = JSON.parse(JSON.stringify(prev))
        const turnsSnapshot = JSON.parse(JSON.stringify(turns))
        await ai.summarize(turns, prev).catch(() => undefined)
        expect(prev).toEqual(prevSnapshot)
        expect(turns).toEqual(turnsSnapshot)
    })

    it('passes a credentials-missing failure through without re-wrapping it as gateway-failed', async () => {
        const { client } = makeFailingClient(new Error('should not be reached'))
        const ai = new GatewayAIClient(makeClientOptions(client, null))
        const err = await ai.complete({ summary: emptySummary, recentTurns: [] }).catch((e) => e)
        expect(err).toBeInstanceOf(GlassErrorException)
        expect(err.glassError.kind).toBe('credentials-missing')
    })
})
