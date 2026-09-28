import { expect, it } from 'vitest'
import { detectCurrencyPair, fetchExchangeRate, tryDirectAnswer } from './direct-answers'

it('detects ISO code pairs', () => {
    expect(detectCurrencyPair('usd to inr current rate ?')).toEqual({ from: 'USD', to: 'INR' })
    expect(detectCurrencyPair('What is EUR→JPY today?')).toEqual({ from: 'EUR', to: 'JPY' })
})

it('detects currency names', () => {
    expect(detectCurrencyPair('dollar to rupee')).toEqual({ from: 'USD', to: 'INR' })
    expect(detectCurrencyPair('euro to dollar')).toEqual({ from: 'EUR', to: 'USD' })
})

it('rejects non-currency lookalikes', () => {
    expect(detectCurrencyPair('how to get a refund')).toBeNull()
    expect(detectCurrencyPair('cat to dog')).toBeNull()
    expect(detectCurrencyPair('convert pdf to doc')).toBeNull()
    expect(detectCurrencyPair('usd to usd')).toBeNull()
    expect(detectCurrencyPair('who is the president?')).toBeNull()
})

it('fetches a rate from the API shape', async () => {
    const fetchImpl = (async () => ({
        ok: true,
        json: async () => ({ result: 'success', rates: { INR: 96.378852 }, time_last_update_utc: 'Fri, 02 Oct 2026 00:02:31 +0000' })
    })) as unknown as typeof fetch
    expect(await fetchExchangeRate('USD', 'INR', undefined, fetchImpl)).toEqual({
        rate: 96.378852,
        updated: 'Fri, 02 Oct 2026 00:02:31 +0000'
    })
})

it('returns null when the API fails', async () => {
    const failing = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    expect(await fetchExchangeRate('USD', 'INR', undefined, failing)).toBeNull()
    const badPayload = (async () => ({ ok: true, json: async () => ({ result: 'error' }) })) as unknown as typeof fetch
    expect(await fetchExchangeRate('USD', 'INR', undefined, badPayload)).toBeNull()
})

it('answers a rate question directly with a source link', async () => {
    const fetchImpl = (async () => ({
        ok: true,
        json: async () => ({ result: 'success', rates: { INR: 96.378852 }, time_last_update_utc: 'Fri, 02 Oct 2026 00:02:31 +0000' })
    })) as unknown as typeof fetch
    const answer = await tryDirectAnswer('usd to inr current rate ?', undefined, fetchImpl)
    expect(answer).toContain('1 USD =')
    expect(answer).toContain('96.3789 INR')
    expect(answer).toContain('https://open.er-api.com/v6/latest/USD')
})

it('returns null for non-currency questions', async () => {
    expect(await tryDirectAnswer('who is the president?')).toBeNull()
})

it('does not replace historical rates or amount conversions with a one-unit latest rate', async () => {
    const fetchImpl = (() => { throw new Error('Should not fetch') }) as unknown as typeof fetch
    expect(await tryDirectAnswer('USD to INR in 2020', undefined, fetchImpl)).toBeNull()
    expect(await tryDirectAnswer('Convert 100 USD to INR', undefined, fetchImpl)).toBeNull()
})

it('rejects an undated or invalid rate', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ result: 'success', rates: { INR: 0 } }) })) as unknown as typeof fetch
    expect(await fetchExchangeRate('USD', 'INR', undefined, fetchImpl)).toBeNull()
})

it('propagates cancellation instead of continuing to search', async () => {
    const controller = new AbortController()
    controller.abort(new Error('User canceled'))
    const fetchImpl = (async (_url: unknown, init: RequestInit) => { init.signal?.throwIfAborted() }) as unknown as typeof fetch
    await expect(fetchExchangeRate('USD', 'INR', controller.signal, fetchImpl)).rejects.toThrow('User canceled')
})
