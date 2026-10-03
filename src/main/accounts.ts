import { app, shell, systemPreferences } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AccountAuthRequest, AccountSnapshot } from '@shared/types'
import { safeStorageCodec, type SecretCodec } from './config'
import type { GitHubAuthService } from './github-auth'
import type { ManagedBackendClient, ManagedSession } from './managed-backend'

interface SavedAccount extends ManagedSession {
    id: string; email: string; name: string; provider: 'email' | 'github' | 'google'
    avatarUrl?: string
}
type RememberedAccount = Pick<SavedAccount, 'id' | 'email' | 'name' | 'provider' | 'avatarUrl'>
interface Vault { accounts: SavedAccount[]; rememberedAccounts?: RememberedAccount[]; activeId: string | null; onboardingComplete: boolean }
const identity = ({ id, email, name, provider, avatarUrl }: RememberedAccount): RememberedAccount => ({ id, email, name, provider, avatarUrl })
type GitHub = Pick<GitHubAuthService, 'getStatus' | 'startLogin' | 'logout'>
const expired = (date: string): boolean => !Number.isFinite(Date.parse(date)) || Date.parse(date) <= Date.now()
/** Tokens stay in the main process and an encrypted, serialized account vault. */
export class AccountService {
    private vault: Vault | null = null
    private pendingGitHub = false
    private pendingGoogle: { authorization_url: string; state: string; poll_token: string; expires: number } | null = null
    private queue: Promise<unknown> = Promise.resolve()
    private readonly path: string
    constructor(private backend: ManagedBackendClient, private github: GitHub, private codec: SecretCodec = safeStorageCodec, userData = app.getPath('userData')) {
        this.path = join(userData, 'accounts.enc')
    }
    run(request: AccountAuthRequest): Promise<AccountSnapshot> {
        const work = this.queue.then(() => this.execute(request))
        this.queue = work.catch(() => undefined)
        return work
    }
    private async load(): Promise<void> {
        if (this.vault) return
        try {
            const data = JSON.parse(this.codec.decryptString(await fs.readFile(this.path))) as Vault
            if (!Array.isArray(data.accounts) || !data.accounts.every(a => typeof a.id === 'string' && typeof a.token === 'string' && typeof a.expiresAt === 'string' && ['email','github','google'].includes(a.provider))) throw Error('Invalid account storage')
            if (data.rememberedAccounts !== undefined && (!Array.isArray(data.rememberedAccounts) || !data.rememberedAccounts.every(a => typeof a.id === 'string' && typeof a.email === 'string' && typeof a.name === 'string' && ['email','github','google'].includes(a.provider)))) throw Error('Invalid remembered accounts')
            data.rememberedAccounts = (data.rememberedAccounts ?? []).map(identity)
            this.vault = data
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Saved accounts could not be read securely. Check macOS Keychain access.')
            this.vault = { accounts: [], activeId: null, onboardingComplete: false }
            this.pendingGitHub = true
        }
    }
    private async save(): Promise<void> {
        if (!this.codec.isEncryptionAvailable()) throw Error('Secure storage is unavailable. Accounts cannot be saved.')
        await fs.mkdir(dirname(this.path), { recursive: true })
        await fs.writeFile(this.path + '.tmp', this.codec.encryptString(JSON.stringify(this.vault)), { mode: 0o600 })
        await fs.rename(this.path + '.tmp', this.path)
    }
    private async add(account: SavedAccount): Promise<void> {
        const previous = this.vault!
        this.vault = { ...previous, accounts: [...previous.accounts.filter(a => a.id !== account.id), account], rememberedAccounts: (previous.rememberedAccounts ?? []).filter(a => a.id !== account.id), activeId: account.id }
        try { await this.save(); await this.backend.adoptSession(account) }
        catch (error) { this.vault = previous; await this.backend.clearSession(); throw error }
    }
    private async reconcileGitHub(): Promise<void> {
        if (!this.pendingGitHub || (await this.github.getStatus()).state !== 'signed-in') return
        await this.backend.clearSession()
        const status = await this.backend.status()
        const session = await this.backend.savedSession()
        if (!status.authenticated || !status.user || !session) throw Error(status.message || 'Could not finish GitHub sign-in.')
        await this.add({ ...session, id: status.user.id, email: status.user.email || status.user.login, name: status.user.name || status.user.login, avatarUrl: status.user.avatar_url, provider: 'github' })
        this.pendingGitHub = false
    }
    private snapshot(): AccountSnapshot {
        const vault = this.vault!
        const accounts = [
            ...vault.accounts.map(({id, email, name, avatarUrl, provider, expiresAt}) => ({ id, email, name, avatarUrl, provider, expired: expired(expiresAt), signedOut: false })),
            ...(vault.rememberedAccounts ?? []).filter(a => !vault.accounts.some(saved => saved.id === a.id)).map(a => ({ ...identity(a), expired: true, signedOut: true }))
        ]
        const active = accounts.find(a => a.id === vault.activeId && !a.expired && !a.signedOut)
        return { accounts, activeId: active?.id ?? null, onboardingComplete: vault.onboardingComplete, googlePending: !!this.pendingGoogle,
            auth: active ? { state: 'signed-in', user: { login: active.email, name: active.name, avatarUrl: active.avatarUrl } } : { state: 'signed-out' } }
    }
    private async execute(request: AccountAuthRequest): Promise<AccountSnapshot> {
        await this.load()
        const vault = this.vault!
        switch (request.action) {
            case 'status': await this.reconcileGitHub(); break
            case 'github': {
                this.pendingGoogle = null
                await this.github.logout()
                await this.backend.clearSession()
                this.pendingGitHub = true
                const challenge = await this.github.startLogin()
                return { ...this.snapshot(), challenge }
            }
            case 'google': {
                this.pendingGoogle = null
                this.pendingGitHub = false
                await this.github.logout()
                const pending = await this.backend.startGoogleLogin()
                this.pendingGoogle = { ...pending, expires: Date.now() + 10 * 60_000 }
                try { await shell.openExternal(pending.authorization_url) }
                catch (error) { this.pendingGoogle = null; throw error }
                break
            }
            case 'google-reopen':
                if (!this.pendingGoogle || this.pendingGoogle.expires <= Date.now()) throw Error('Sign-in expired. Try again.')
                await shell.openExternal(this.pendingGoogle.authorization_url)
                break
            case 'google-poll': {
                const pending = this.pendingGoogle
                if (!pending || pending.expires <= Date.now()) { this.pendingGoogle = null; throw Error('Sign-in expired. Try again.') }
                let result
                try { result = await this.backend.pollGoogleLogin(pending.state, pending.poll_token) }
                catch (error) { this.pendingGoogle = null; throw error }
                if (!result) break
                this.pendingGoogle = null
                await this.add({ token: result.session_token, expiresAt: result.expires_at, id: result.user!.id, email: result.user!.email!, name: result.user!.name || result.user!.email!, avatarUrl: result.user!.avatar_url, provider: 'google' })
                break
            }
            case 'cancel-login':
                this.pendingGoogle = null
                if (this.pendingGitHub) { this.pendingGitHub = false; await this.github.logout() }
                break
            case 'switch': {
                const account = vault.accounts.find(a => a.id === request.id)
                if (!account || expired(account.expiresAt)) throw Error('This account has expired. Sign in again.')
                this.pendingGitHub = false
                this.pendingGoogle = null
                const previousId = vault.activeId
                vault.activeId = account.id
                try { await this.save(); await this.backend.adoptSession(account) }
                catch (error) { vault.activeId = previousId; await this.backend.clearSession(); throw error }
                break
            }
            case 'logout':
                this.pendingGoogle = null
                const loggedOut = vault.accounts.find(a => a.id === vault.activeId)
                if (loggedOut) vault.rememberedAccounts = [...(vault.rememberedAccounts ?? []).filter(a => a.id !== loggedOut.id), identity(loggedOut)]
                vault.accounts = vault.accounts.filter(a => a.id !== vault.activeId)
                vault.activeId = null
                this.pendingGitHub = false
                await this.github.logout()
                await this.backend.clearSession()
                await this.save()
                break
            case 'complete':
                if (!this.snapshot().activeId) throw Error('Sign in before continuing.')
                vault.onboardingComplete = true
                await this.save()
                break
            case 'microphone':
                if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone')
                break
            case 'accessibility':
                if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true)
                break
            case 'permissions': break
            default: throw Error('Unknown account action.')
        }
        const status = this.snapshot()
        if (['permissions', 'microphone', 'accessibility'].includes(request.action)) {
            status.microphone = process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') === 'granted'
            status.accessibility = process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false)
        }
        return status
    }
}
