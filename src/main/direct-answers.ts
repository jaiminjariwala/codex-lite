/**
 * Direct answers for question shapes where snippet scraping reliably fails.
 *
 * Flagship case: currency conversion. Google renders the rate inside a
 * converter widget that SERP scraping never sees, so the synthesis model only
 * ever receives prose *about* rates ("updated every second") and hedges. A
 * free rates API returns the number itself, so answer it directly and skip the
 * snippet pipeline entirely.
 */

export interface CurrencyPair { from: string; to: string }

// ISO 4217 codes worth recognizing. Deliberately a subset of the most-asked
// ones; the set-membership check is what rejects false positives like
// "how to get" (HOW/GET are not currencies).
const ISO_4217 = new Set([
    'USD', 'INR', 'EUR', 'GBP', 'JPY', 'CNY', 'AUD', 'CAD', 'CHF', 'SGD',
    'AED', 'SAR', 'KRW', 'MXN', 'BRL', 'ZAR', 'HKD', 'NZD', 'SEK', 'NOK',
    'DKK', 'PLN', 'THB', 'MYR', 'IDR', 'PHP', 'VND', 'TWD', 'TRY', 'RUB',
    'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'ILS', 'EGP', 'NGN', 'KES', 'PKR',
    'BDT', 'LKR', 'NPR', 'MMK', 'KHR', 'LAK', 'BND', 'FJD', 'ARS', 'CLP',
    'COP', 'PEN', 'UYU', 'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'ISK', 'UAH'
])

const CURRENCY_NAMES: Record<string, string> = {
    dollar: 'USD', dollars: 'USD', buck: 'USD', bucks: 'USD',
    rupee: 'INR', rupees: 'INR',
    euro: 'EUR', euros: 'EUR',
    pound: 'GBP', pounds: 'GBP', quid: 'GBP',
    yen: 'JPY', yuan: 'CNY', renminbi: 'CNY',
    franc: 'CHF', francs: 'CHF',
    krona: 'SEK', krone: 'NOK',
    dirham: 'AED', dirhams: 'AED',
    riyal: 'SAR', riyals: 'SAR',
    won: 'KRW', peso: 'MXN', pesos: 'MXN',
    real: 'BRL', reais: 'BRL',
    rand: 'ZAR', baht: 'THB',
    ringgit: 'MYR', rupiah: 'IDR',
    dong: 'VND', lira: 'TRY',
    dinar: 'KWD', shekel: 'ILS', shekels: 'ILS'
}

const SYMBOLS: Record<string, string> = {
    USD: '$', INR: '₹', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥'
}

/** "usd to inr", "USD→INR", "dollar to rupee". Null when not a currency question. */
export function detectCurrencyPair(text: string): CurrencyPair | null {
    const codes = text.match(/\b([A-Za-z]{3})\s*(?:to|->|→|in|per)\s*([A-Za-z]{3})\b/)
    if (codes) {
        const from = codes[1].toUpperCase()
        const to = codes[2].toUpperCase()
        if (from !== to && ISO_4217.has(from) && ISO_4217.has(to)) return { from, to }
    }
    const names = text.match(/\b([a-z]+)\s+to\s+([a-z]+)\b/i)
    if (names) {
        const from = CURRENCY_NAMES[names[1].toLowerCase()]
        const to = CURRENCY_NAMES[names[2].toLowerCase()]
        if (from && to && from !== to) return { from, to }
    }
    return null
}

export interface ExchangeQuote { rate: number; updated: string }

const RATES_API_TIMEOUT_MS = 8000

export async function fetchExchangeRate(from: string, to: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ExchangeQuote | null> {
    const controller = new AbortController()
    const cancel = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const timeout = setTimeout(() => controller.abort(), RATES_API_TIMEOUT_MS)
    try {
        const response = await fetchImpl(`https://open.er-api.com/v6/latest/${from}`, {
            signal: controller.signal
        })
        if (!response.ok) return null
        const payload = await response.json().catch(() => null) as {
            result?: string; rates?: Record<string, number>; time_last_update_utc?: string
        } | null
        const rate = payload?.result === 'success' ? payload?.rates?.[to] : undefined
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 ||
            !payload?.time_last_update_utc || !Number.isFinite(Date.parse(payload.time_last_update_utc))) return null
        return { rate, updated: payload?.time_last_update_utc ?? 'recently' }
    } catch {
        signal?.throwIfAborted()
        return null
    } finally {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', cancel)
    }
}

function formatRate(rate: number): string {
    return String(Number(rate.toFixed(4)))
}

/**
 * Returns a ready-to-display answer, or null when the question is not a
 * recognized direct-answer shape or the lookup failed. Fail-soft by design:
 * callers fall through to normal web search on null.
 */
export async function tryDirectAnswer(question: string, signal?: AbortSignal, fetchImpl?: typeof fetch): Promise<string | null> {
    const pair = detectCurrencyPair(question)
    if (!pair) return null
    // This endpoint supplies daily reference rates, not historical rates or
    // arbitrary amount conversions. Do not answer a different question.
    if (/\b(ago|yesterday|historical|history|last (?:week|month|year)|20\d{2})\b/i.test(question) ||
        /\b\d+(?:[.,]\d+)?\s*(?:USD|INR|EUR|GBP|JPY|CNY|dollars?|rupees?|euros?|pounds?)\b/i.test(question)) return null
    const quote = await fetchExchangeRate(pair.from, pair.to, signal, fetchImpl)
    if (!quote) return null
    const symbol = SYMBOLS[pair.to] ? `${SYMBOLS[pair.to]} ` : ''
    return `1 ${pair.from} = ${symbol}${formatRate(quote.rate)} ${pair.to} (as of ${quote.updated}).\n\nThis is the latest daily reference rate, not a live market or bank quote.\n\n[ExchangeRate-API reference rate](https://open.er-api.com/v6/latest/${pair.from})`
}
