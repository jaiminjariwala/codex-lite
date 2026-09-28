import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalAI } from './local-ai'

const paths: string[] = []
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path,{recursive:true,force:true}))) })
async function service(): Promise<LocalAI> {
    const path = await mkdtemp(join(tmpdir(),'codex-lite-test-')); paths.push(path)
    return new LocalAI(path)
}
it('refuses inference before setup completes', async () => {
    await expect((await service()).provider()).rejects.toThrow('Preparing')
})
it('persists pause so launch does not silently restart a download', async () => {
    const ai = await service()
    await ai.pause()
    await ai.start()
    expect(ai.status().phase).toBe('paused')
})
it('deduplicates concurrent startup requests and reports preparation errors', async () => {
    const ai = await service()
    const prepare = vi.spyOn(ai as unknown as {prepare(signal:AbortSignal):Promise<void>},'prepare')
        .mockRejectedValue(new Error('Download interrupted'))
    await Promise.all([ai.start(),ai.start(),ai.start()])
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(ai.status()).toMatchObject({phase:'error',message:'Local AI setup could not finish. Check your connection and retry in Settings.'})
})
it('keeps text available when the optional vision download fails and hides raw URLs', async () => {
    const ai = await service()
    vi.spyOn(ai as unknown as {prepare(signal:AbortSignal):Promise<void>}, 'prepare').mockImplementation(async () => {
        Object.assign(ai, { textReady: true })
        throw new Error('download failed https://example.com/signed-secret')
    })
    await ai.start()
    expect((await ai.provider()).model).toBe('qwen3.5:9b')
    await expect(ai.provider(true)).rejects.toThrow('Screenshot model download failed')
    expect(ai.status().message).not.toContain('https://')
})
