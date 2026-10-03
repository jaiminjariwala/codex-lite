import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ManagedAccountStatus, ManagedUsage } from '@shared/types'
import { safeStorageCodec, type SecretCodec } from './config'

declare const __MANAGED_BACKEND_URL__: string

const SESSION_FILE = 'managed-backend-session.enc'
const REQUEST_TIMEOUT_MS = 45_000

export interface ManagedSession {
    token: string
    expiresAt: string
}

export interface ManagedAuthResponse {
    session_token: string
    expires_at: string
    user: ManagedAccountStatus['user']
    usage: ManagedUsage
}

interface ManagedBackendOptions {
    baseURL?: string
    userDataDir?: string
    codec?: SecretCodec
    fetchImpl?: typeof fetch
    getGitHubToken: () => Promise<string | null>
}

export function configuredManagedBackendURL(): string {
    const runtime = process.env.MANAGED_BACKEND_URL?.trim() ?? ''
    const embedded = typeof __MANAGED_BACKEND_URL__ === 'string' ? __MANAGED_BACKEND_URL__.trim() : ''
    return runtime || embedded
}

export class ManagedBackendClient {
    private readonly baseURL: string
    private readonly sessionPath: string
    private readonly codec: SecretCodec
    private readonly fetchImpl: typeof fetch
    private readonly getGitHubToken: () => Promise<string | null>

    constructor(options: ManagedBackendOptions) {
        this.baseURL = (options.baseURL ?? configuredManagedBackendURL()).replace(/\/+$/, '')
        this.sessionPath = join(options.userDataDir ?? app.getPath('userData'), SESSION_FILE)
        this.codec = options.codec ?? safeStorageCodec
        this.fetchImpl = options.fetchImpl ?? fetch
        this.getGitHubToken = options.getGitHubToken
    }

    configured(): boolean { return this.baseURL.length > 0 }

    async provider(): Promise<{ baseURL: string; model: string; apiKey: string } | null> {
        if (!this.configured()) return null
        const token = await this.ensureSession()
        if (!token) return null
        return { baseURL: `${this.baseURL}/v1`, model: 'managed-standard', apiKey: token }
    }

    async status(): Promise<ManagedAccountStatus> {
        if (!this.configured()) return { configured: false, authenticated: false }
        try {
            const token = await this.ensureSession()
            if (!token) return { configured: true, authenticated: false }
            const response = await this.authorizedRequest('/v1/me', { method: 'GET' }, token)
            const body = await this.readJSON<{ user: ManagedAccountStatus['user']; usage: ManagedUsage }>(response)
            return { configured: true, authenticated: true, user: body.user, usage: body.usage }
        } catch (error) {
            return {
                configured: true,
                authenticated: false,
                message: error instanceof Error ? error.message : 'Managed service is unavailable.'
            }
        }
    }

    async startGoogleLogin(): Promise<{ authorization_url: string; state: string; poll_token: string }> {
        const response = await this.request('/v1/auth/google/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        const result = await this.readJSON<{ authorization_url: string; state: string; poll_token: string }>(response)
        const url = new URL(result.authorization_url)
        if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password || !result.state || !result.poll_token) throw new Error('Invalid Google authorization URL.')
        return result
    }
    async pollGoogleLogin(state: string, poll_token: string): Promise<ManagedAuthResponse | null> {
        const response = await this.request('/v1/auth/google/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, poll_token }) })
        if (response.status === 202) return null
        const result = await this.readJSON<ManagedAuthResponse>(response)
        if (!result.session_token || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now() || !result.user?.id?.startsWith('google_') || !result.user.email) throw new Error('Google sign-in returned an invalid session.')
        return result
    }
    async savedSession(): Promise<ManagedSession | null> { return this.readSession() }
    async adoptSession(session: ManagedSession): Promise<void> { await this.writeSession(session) }

    async clearSession(): Promise<void> {
        await fs.rm(this.sessionPath, { force: true }).catch(() => undefined)
    }

    private async ensureSession(): Promise<string | null> {
        const saved = await this.readSession()
        if (saved && new Date(saved.expiresAt).getTime() > Date.now() + 60_000) return saved.token
        if (saved) return null // Expired sessions require sign-in, never another cached identity.
        const githubToken = await this.getGitHubToken()
        if (!githubToken) return null
        const response = await this.request('/v1/auth/github', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: githubToken })
        })
        const body = await this.readJSON<ManagedAuthResponse>(response)
        if (!body.session_token || !body.expires_at) throw new Error('Managed sign-in returned an invalid session.')
        await this.writeSession({ token: body.session_token, expiresAt: body.expires_at })
        return body.session_token
    }

    private async authorizedRequest(path: string, init: RequestInit, token: string): Promise<Response> {
        const headers = new Headers(init.headers)
        headers.set('Authorization', `Bearer ${token}`)
        let response = await this.request(path, { ...init, headers }, false)
        if (response.status !== 401) return response
        await this.clearSession()
        const refreshed = await this.ensureSession()
        if (!refreshed) return response
        headers.set('Authorization', `Bearer ${refreshed}`)
        response = await this.request(path, { ...init, headers }, false)
        return response
    }

    private async request(path: string, init: RequestInit, requireOK = true): Promise<Response> {
        if (!this.configured()) throw new Error('Managed backend is not configured for this build.')
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            const response = await this.fetchImpl(`${this.baseURL}${path}`, { ...init, signal: controller.signal }).catch(() => {
                throw new Error('Cannot reach the app backend. Please try again later. For local development, start the database and Go server.')
            })
            if (requireOK && !response.ok) await this.throwResponse(response)
            if (!requireOK && !response.ok && response.status !== 401) await this.throwResponse(response)
            return response
        } finally {
            clearTimeout(timeout)
        }
    }

    private async throwResponse(response: Response): Promise<never> {
        const body = await response.json().catch(() => ({})) as { error?: unknown }
        const detail = typeof body.error === 'string' ? body.error : `Managed service returned ${response.status}.`
        throw new Error(detail)
    }

    private async readJSON<T>(response: Response): Promise<T> {
        if (!response.ok) await this.throwResponse(response)
        return response.json() as Promise<T>
    }

    private async readSession(): Promise<ManagedSession | null> {
        try {
            const encrypted = await fs.readFile(this.sessionPath)
            const parsed = JSON.parse(this.codec.decryptString(encrypted)) as Partial<ManagedSession>
            return typeof parsed.token === 'string' && typeof parsed.expiresAt === 'string'
                ? { token: parsed.token, expiresAt: parsed.expiresAt }
                : null
        } catch {
            return null
        }
    }

    private async writeSession(session: ManagedSession): Promise<void> {
        if (!this.codec.isEncryptionAvailable()) throw new Error('Secure storage is unavailable.')
        await fs.mkdir(dirname(this.sessionPath), { recursive: true })
        await fs.writeFile(this.sessionPath, this.codec.encryptString(JSON.stringify(session)))
    }

}
