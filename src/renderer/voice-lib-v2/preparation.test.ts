import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
async function fixture() {
    vi.resetModules()
    const instances: FakeWorker[] = []
    class FakeWorker {
        onmessage: ((event: { data: unknown }) => void) | null = null
        onerror: ((event: { message: string }) => void) | null = null
        onmessageerror: (() => void) | null = null
        requests: { id: number; kind: string; audio?: unknown }[] = []
        terminate = vi.fn()
        constructor() { instances.push(this) }
        postMessage(message: { id: number; kind: string }) { this.requests.push(message) }
    }
    vi.stubGlobal('Worker', FakeWorker)
    const microphone = vi.fn()
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: microphone } })
    const { prepareDictation } = await import('./useSmoothDictation')
    return { prepareDictation, instances, microphone }
}
it('prepares the model once without accessing the microphone or sending audio', async () => {
    const { prepareDictation, instances, microphone } = await fixture()
    const first = prepareDictation(), second = prepareDictation()
    expect(first).toBe(second)
    expect(instances).toHaveLength(1)
    const worker = instances[0]
    expect(worker.requests).toHaveLength(1)
    expect(worker.requests[0].kind).toBe('prepare')
    expect(worker.requests[0].audio).toBeUndefined()
    worker.onmessage?.({ data: { id: worker.requests[0].id, ready: true } })
    await first
    await prepareDictation()
    expect(worker.requests).toHaveLength(1)
    expect(microphone).not.toHaveBeenCalled()
})
it('allows preparation to retry after a download failure', async () => {
    const { prepareDictation, instances } = await fixture()
    const first = prepareDictation()
    const failed = expect(first).rejects.toThrow('Offline')
    const worker = instances[0]
    worker.onmessage?.({ data: { id: worker.requests[0].id, error: 'Offline' } })
    await failed
    const retry = prepareDictation()
    expect(worker.requests).toHaveLength(2)
    worker.onmessage?.({ data: { id: worker.requests[1].id, ready: true } })
    await retry
})
it('recreates a crashed worker on the next attempt', async () => {
    const { prepareDictation, instances } = await fixture()
    const first = prepareDictation()
    const failed = expect(first).rejects.toThrow('Speech worker error: Crash')
    instances[0].onerror?.({ message: 'Crash' })
    await failed
    expect(instances[0].terminate).toHaveBeenCalledOnce()
    const retry = prepareDictation()
    expect(instances).toHaveLength(2)
    const worker = instances[1]
    worker.onmessage?.({ data: { id: worker.requests[0].id, ready: true } })
    await retry
})
