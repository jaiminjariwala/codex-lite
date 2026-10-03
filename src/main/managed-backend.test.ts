import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
    app: { getPath: () => tmpdir() },
    shell: { openExternal: vi.fn(async () => undefined) },
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString('utf8')
    }
}))

import { ManagedBackendClient } from './managed-backend'

const created: string[] = []

afterEach(async () => {
    await Promise.all(created.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

async function tempDirectory(): Promise<string> {
    const path = await fs.mkdtemp(join(tmpdir(), 'managed-backend-test-'))
    created.push(path)
    return path
}

describe('ManagedBackendClient', () => {
    it('exchanges the GitHub token once and persists the app session', async () => {
        const calls: string[] = []
        const client = new ManagedBackendClient({
            baseURL: 'https://api.example.test',
            userDataDir: await tempDirectory(),
            getGitHubToken: async () => 'github-secret',
            fetchImpl: vi.fn(async (input) => {
                calls.push(String(input))
                return Response.json({
                    session_token: 'app-session',
                    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
                    user: { id: 'gh_42', login: 'jaimin', name: 'Jaimin', plan: 'free', subscription_status: 'inactive' },
                    usage: { plan: 'free', used_units: 0, limit_units: 1000, remaining_units: 1000, resets_at: new Date().toISOString() }
                })
            }) as typeof fetch
        })

        await expect(client.provider()).resolves.toEqual({
            baseURL: 'https://api.example.test/v1',
            model: 'managed-standard',
            apiKey: 'app-session'
        })
        await expect(client.provider()).resolves.toMatchObject({ apiKey: 'app-session' })
        expect(calls).toEqual(['https://api.example.test/v1/auth/github'])
    })

    it('starts and polls Google through the backend without trusting renderer identity claims', async () => {
        const bodies: unknown[] = []
        const client = new ManagedBackendClient({
            baseURL: 'https://api.example.test', userDataDir: await tempDirectory(), getGitHubToken: async () => null,
            fetchImpl: vi.fn(async (input, options) => {
                bodies.push(JSON.parse(String(options?.body)))
                if (String(input).endsWith('/start')) return Response.json({authorization_url:'https://accounts.google.com/o/oauth2/v2/auth',state:'state',poll_token:'poll'})
                return Response.json({ session_token: 'google-session', expires_at: new Date(Date.now() + 86_400_000).toISOString(), user: {id:'google_42',email:'demo@example.com'} })
            }) as typeof fetch
        })
        await client.startGoogleLogin()
        const result = await client.pollGoogleLogin('state','poll')
        expect(result!.session_token).toBe('google-session')
        expect(bodies).toEqual([{},{state:'state',poll_token:'poll'}])
    })

    it('rejects an external Google authorization URL supplied by the backend', async () => {
        const client = new ManagedBackendClient({
            baseURL:'https://api.example.test',userDataDir:await tempDirectory(),getGitHubToken:async()=>null,
            fetchImpl:vi.fn(async()=>Response.json({authorization_url:'https://attacker.example/o/oauth2/v2/auth',state:'state',poll_token:'poll'})) as typeof fetch
        })
        await expect(client.startGoogleLogin()).rejects.toThrow('Invalid Google authorization URL')
    })
    it('handles pending Google sign-in and rejects invalid app sessions', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(Response.json({status:'pending'},{status:202}))
            .mockResolvedValueOnce(Response.json({session_token:'bad',expires_at:'2000-01-01',user:{id:'google_42',email:'demo@example.com'}}))
        const client = new ManagedBackendClient({baseURL:'https://api.example.test',userDataDir:await tempDirectory(),getGitHubToken:async()=>null,fetchImpl:fetchImpl as typeof fetch})
        await expect(client.pollGoogleLogin('state','poll')).resolves.toBeNull()
        await expect(client.pollGoogleLogin('state','poll')).rejects.toThrow('invalid session')
    })
    it('does not use a cached GitHub identity after another provider session expires', async () => {
        const getGitHubToken = vi.fn(async () => 'other-github-user')
        const client = new ManagedBackendClient({ baseURL:'https://api.example.test', userDataDir:await tempDirectory(), getGitHubToken })
        await client.adoptSession({token:'expired-email',expiresAt:'2000-01-01T00:00:00Z'})
        await expect(client.provider()).resolves.toBeNull()
        expect(getGitHubToken).not.toHaveBeenCalled()
    })

})
