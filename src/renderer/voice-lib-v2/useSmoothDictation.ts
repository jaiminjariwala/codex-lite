import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * voice-lib-v2 — WebGPU-accelerated dictation with smooth character reveal.
 *
 * Same UX contract as v1 (record → live text → instant stop → append), but the
 * worker runs Whisper on **WebGPU** (transformers.js v3) when available, which
 * is dramatically faster and lets us use the more accurate `whisper-base.en`
 * model in real time. Falls back to WASM + tiny model automatically.
 *
 * Self-contained on purpose so it can't regress the frozen v1 baseline.
 */

export interface Dictation {
    supported: boolean
    listening: boolean
    transcribing: boolean
    start: () => void
    stop: () => void
    toggle: () => void
    /** Stop immediately, clear the live buffer, and empty the field. */
    cancel: () => void
}

export interface SmoothDictationOptions {
    getText: () => string
    setText: (text: string) => void
    onError?: (message: string) => void
    revealMs?: number
}

const TARGET_RATE = 16000
// WebGPU is fast, so we can poll more aggressively for a near-real-time feel.
const INTERIM_MS = 300
const FIRST_PASS_MS = 120

// --- Worker plumbing --------------------------------------------------------

let worker: Worker | null = null
let reqId = 0
const pending = new Map<number, (r: { text?: string; error?: string }) => void>()
let preparation: Promise<void> | null = null

function getWorker(): Worker {
    if (!worker) {
        worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = (
            e: MessageEvent<{ id: number; text?: string; error?: string }>
        ): void => {
            const cb = pending.get(e.data.id)
            if (cb) {
                pending.delete(e.data.id)
                cb(e.data)
            }
        }
        worker.onerror = (event: ErrorEvent): void => {
            // Surface the real reason (WebGPU/model init usually) instead of a
            // generic message, and drop the dead worker so the next attempt
            // rebuilds it and can fall back to the WASM path.
            const detail = event?.message ? `Speech worker error: ${event.message}` : 'Speech worker failed to load.'
            worker?.terminate()
            worker = null
            preparation = null
            for (const [id, cb] of pending) {
                pending.delete(id)
                cb({ error: detail })
            }
        }
        worker.onmessageerror = (): void => {
            worker?.terminate()
            worker = null
            preparation = null
            for (const [id, cb] of pending) {
                pending.delete(id)
                cb({ error: 'Speech worker message could not be decoded.' })
            }
        }
    }
    return worker
}

function transcribeInWorker(audio: Float32Array): Promise<string> {
    return new Promise((resolve, reject) => {
        const speechWorker = getWorker()
        const id = ++reqId
        pending.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.text ?? '')))
        speechWorker.postMessage({ id, audio })
    })
}

/** Preload weights and compile inference without requesting microphone access. */
export function prepareDictation(): Promise<void> {
    if (!preparation) preparation = new Promise<void>((resolve, reject) => {
        const speechWorker = getWorker()
        const id = ++reqId
        pending.set(id, result => result.error ? reject(new Error(result.error)) : resolve())
        speechWorker.postMessage({ id, kind: 'prepare' })
    }).catch(error => { preparation = null; throw error })
    return preparation
}

function downsample(buffer: Float32Array, inRate: number, outRate: number): Float32Array {
    if (outRate >= inRate) return buffer
    const ratio = inRate / outRate
    const outLen = Math.round(buffer.length / ratio)
    const result = new Float32Array(outLen)
    let outOffset = 0
    let inOffset = 0
    while (outOffset < outLen) {
        const nextIn = Math.round((outOffset + 1) * ratio)
        let accum = 0
        let count = 0
        for (let i = inOffset; i < nextIn && i < buffer.length; i++) {
            accum += buffer[i]
            count++
        }
        result[outOffset] = count > 0 ? accum / count : 0
        outOffset++
        inOffset = nextIn
    }
    return result
}

export function useSmoothDictation(options: SmoothDictationOptions): Dictation {
    const { getText, setText, onError } = options
    const revealMs = options.revealMs ?? 16

    const [listening, setListening] = useState(false)
    const [transcribing, setTranscribing] = useState(false)
    const supported = useRef<boolean>(
        typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
    ).current

    // Audio capture
    const streamRef = useRef<MediaStream | null>(null)
    const ctxRef = useRef<AudioContext | null>(null)
    const processorRef = useRef<ScriptProcessorNode | null>(null)
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
    const chunksRef = useRef<Float32Array[]>([])
    const rateRef = useRef<number>(TARGET_RATE)
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const inferringRef = useRef(false)
    const listeningRef = useRef(false)
    const emittedRef = useRef(false)
    const generationRef = useRef(0)
    const startingRef = useRef(false)
    const baseRef = useRef('')

    // Reveal buffer
    const targetRef = useRef('')
    const curRef = useRef('')
    const revealRef = useRef<ReturnType<typeof setInterval> | null>(null)

    const getTextRef = useRef(getText)
    const setTextRef = useRef(setText)
    const onErrorRef = useRef(onError)
    useEffect(() => {
        getTextRef.current = getText
        setTextRef.current = setText
        onErrorRef.current = onError
    }, [getText, setText, onError])
    useEffect(() => {
        // Startup preparation stays silent; a later mic attempt can retry if offline.
        if (supported) void prepareDictation().catch(() => undefined)
    }, [supported])

    const revealTick = useCallback(() => {
        const target = targetRef.current
        const cur = curRef.current
        if (cur === target) {
            if (!listeningRef.current && revealRef.current !== null) {
                clearInterval(revealRef.current)
                revealRef.current = null
            }
            return
        }
        let next: string
        if (target.startsWith(cur)) {
            const step = Math.max(4, Math.ceil((target.length - cur.length) / 5))
            next = target.slice(0, Math.min(target.length, cur.length + step))
        } else {
            next = target
        }
        curRef.current = next
        setTextRef.current(next)
    }, [])

    const ensureReveal = useCallback(() => {
        if (revealRef.current === null) revealRef.current = setInterval(revealTick, revealMs)
    }, [revealTick, revealMs])

    const pushTarget = useCallback(
        (sessionText: string, isFinal: boolean) => {
            const base = baseRef.current.replace(/\s+$/, '')
            const combined = base.length > 0 ? `${base} ${sessionText}` : sessionText
            emittedRef.current = true
            targetRef.current = combined
            ensureReveal()
            if (isFinal) {
                // Make sure the field ends exactly at the final text.
                targetRef.current = combined
            }
        },
        [ensureReveal]
    )

    const snapshotAudio = useCallback((): Float32Array => {
        const chunks = chunksRef.current
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const merged = new Float32Array(total)
        let off = 0
        for (const c of chunks) {
            merged.set(c, off)
            off += c.length
        }
        return downsample(merged, rateRef.current, TARGET_RATE)
    }, [])

    const runInference = useCallback(
        async (audio: Float32Array, isFinal: boolean, generation = generationRef.current): Promise<void> => {
            if (audio.length === 0) return
            if (!isFinal && audio.length < TARGET_RATE * 0.65) return
            if (!isFinal && inferringRef.current) return
            inferringRef.current = true
            try {
                const text = await transcribeInWorker(audio)
                if (generation === generationRef.current && text.length > 0 && (isFinal || listeningRef.current)) {
                    pushTarget(text, isFinal)
                }
            } catch (err) {
                if (generation === generationRef.current) onErrorRef.current?.(err instanceof Error ? err.message : String(err))
            } finally {
                if (generation === generationRef.current) inferringRef.current = false
            }
        },
        [pushTarget]
    )

    const teardown = useCallback((): void => {
        if (intervalRef.current !== null) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }
        processorRef.current?.disconnect()
        sourceRef.current?.disconnect()
        if (ctxRef.current && ctxRef.current.state !== 'closed') {
            void ctxRef.current.close()
        }
        streamRef.current?.getTracks().forEach((t) => t.stop())
        processorRef.current = null
        sourceRef.current = null
        ctxRef.current = null
        streamRef.current = null
    }, [])

    const stop = useCallback(() => {
        if (!listeningRef.current && !startingRef.current) return
        startingRef.current = false
        setListening(false)
        listeningRef.current = false
        if (intervalRef.current !== null) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }
        const audio = snapshotAudio()
        chunksRef.current = []
        teardown()
        if (audio.length === 0) { generationRef.current++; return }
        setTranscribing(true)
        const generation = generationRef.current
        void runInference(audio, true, generation).finally(() => {
            if (generation === generationRef.current) setTranscribing(false)
        })
    }, [listening, teardown, snapshotAudio, runInference])

    const start = useCallback(() => {
        if (!supported || listeningRef.current || startingRef.current || transcribing) return
        const generation = ++generationRef.current
        startingRef.current = true
        inferringRef.current = false
        void prepareDictation().catch(() => undefined)
        chunksRef.current = []
        emittedRef.current = false
        baseRef.current = getTextRef.current()
        curRef.current = baseRef.current
        targetRef.current = baseRef.current
        void navigator.mediaDevices
            .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
            .then(async (stream) => {
                if (generation !== generationRef.current) { stream.getTracks().forEach(track => track.stop()); return }
                streamRef.current = stream
                const Ctx =
                    window.AudioContext ||
                    (window as unknown as { webkitAudioContext: typeof AudioContext })
                        .webkitAudioContext
                const ctx = new Ctx({ latencyHint: 'interactive' })
                ctxRef.current = ctx
                await ctx.resume()
                if (generation !== generationRef.current) {
                    stream.getTracks().forEach(track => track.stop())
                    if (ctx.state !== 'closed') void ctx.close()
                    return
                }
                rateRef.current = ctx.sampleRate
                const source = ctx.createMediaStreamSource(stream)
                sourceRef.current = source
                const processor = ctx.createScriptProcessor(2048, 1, 1)
                processorRef.current = processor
                processor.onaudioprocess = (e: AudioProcessingEvent): void => {
                    chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
                }
                source.connect(processor)
                processor.connect(ctx.destination)
                setListening(true)
                listeningRef.current = true
                startingRef.current = false
                ensureReveal()
                setTimeout(() => {
                    if (generation === generationRef.current && listeningRef.current) void runInference(snapshotAudio(), false, generation)
                }, FIRST_PASS_MS)
                intervalRef.current = setInterval(() => {
                    if (generation === generationRef.current && listeningRef.current) void runInference(snapshotAudio(), false, generation)
                }, INTERIM_MS)
            })
            .catch((err) => {
                if (generation !== generationRef.current) return
                startingRef.current = false
                onErrorRef.current?.(
                    err instanceof Error ? err.message : 'Could not access the microphone.'
                )
                teardown()
                setListening(false)
                listeningRef.current = false
            })
    }, [supported, listening, transcribing, teardown, snapshotAudio, runInference, ensureReveal])

    const toggle = useCallback(() => {
        if (listening || startingRef.current) stop()
        else start()
    }, [listening, start, stop])

    /**
     * Abort dictation and wipe everything: stop recording, kill the reveal
     * loop, clear the live buffer, and empty the field. Used when the user
     * clears the input (e.g. Cmd/Ctrl+A then Backspace/Delete) mid-dictation.
     */
    const cancel = useCallback(() => {
        generationRef.current++
        startingRef.current = false
        setListening(false)
        listeningRef.current = false
        setTranscribing(false)
        if (intervalRef.current !== null) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }
        if (revealRef.current !== null) {
            clearInterval(revealRef.current)
            revealRef.current = null
        }
        teardown()
        chunksRef.current = []
        emittedRef.current = false
        baseRef.current = ''
        targetRef.current = ''
        curRef.current = ''
        setTextRef.current('')
    }, [teardown])

    useEffect(
        () => () => {
            generationRef.current++
            startingRef.current = false
            teardown()
            if (revealRef.current !== null) clearInterval(revealRef.current)
        },
        [teardown]
    )

    return { supported, listening, transcribing, start, stop, toggle, cancel }
}
