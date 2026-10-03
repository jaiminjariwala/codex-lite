import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({
    app: { getPath: () => tmpdir() },
    shell: { openExternal: vi.fn(async () => undefined) },
    systemPreferences: { askForMediaAccess: vi.fn(async () => true), getMediaAccessStatus: vi.fn(() => 'granted'), isTrustedAccessibilityClient: vi.fn(() => false) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }
}))
import { AccountService } from './accounts'
import { systemPreferences } from 'electron'
import type { ManagedBackendClient } from './managed-backend'
import type { GitHubAuthService } from './github-auth'
const dirs: string[] = []
afterEach(async () => { vi.clearAllMocks(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, {recursive:true,force:true}))) })
async function fixture() {
    const dir = await fs.mkdtemp(join(tmpdir(),'codex-accounts-')); dirs.push(dir)
    const codec = { isEncryptionAvailable: () => true, encryptString: (s:string) => Buffer.from(Buffer.from(s).map(v=>v^42)), decryptString: (b:Buffer) => Buffer.from(b.map(v=>v^42)).toString() }
    const backend = {
        clearSession: vi.fn(async () => undefined), adoptSession: vi.fn(async () => undefined),
        startGoogleLogin: vi.fn(async () => ({authorization_url:'https://accounts.google.com/o/oauth2/v2/auth',state:'state',poll_token:'poll-secret'})),
        pollGoogleLogin: vi.fn(async () => ({session_token:'secret-one@example.com', expires_at:new Date(Date.now()+86400000).toISOString(), user:{id:'google_one@example.com',email:'one@example.com'}})),
        status: vi.fn(async () => ({authenticated:true,user:{id:'gh_42',email:'github@example.com',name:'Github'}})),
        savedSession: vi.fn(async () => ({token:'github-secret',expiresAt:new Date(Date.now()+86400000).toISOString()}))
    }
    const github = {getStatus:vi.fn(async () => ({state:'signed-out'})),logout:vi.fn(async()=>undefined),startLogin:vi.fn(async()=>({userCode:'',verificationUri:'https://github.com/login/oauth/authorize',expiresAt:''}))}
    const create = () => new AccountService(backend as unknown as ManagedBackendClient,github as unknown as GitHubAuthService,codec,dir)
    const service = create()
    const login = async (email: string) => {
        backend.pollGoogleLogin.mockResolvedValueOnce({session_token:'secret-'+email, expires_at:new Date(Date.now()+86400000).toISOString(), user:{id:'google_'+email,email}})
        await service.run({action:'google'})
        return service.run({action:'google-poll'})
    }
    return {service,create,dir,backend,github,codec,login}
}
describe('encrypted desktop accounts', () => {
    it('does not request microphone access or start a login during startup', async () => {
        const f = await fixture()
        expect((await f.service.run({action:'status'})).auth.state).toBe('signed-out')
        expect(systemPreferences.askForMediaAccess).not.toHaveBeenCalled()
        expect(f.github.startLogin).not.toHaveBeenCalled()
        await expect(f.service.run({action:'complete'})).rejects.toThrow('Sign in')
    })
    it('lists and switches verified accounts without leaking tokens, and persists them encrypted', async () => {
        const f = await fixture()
        await f.login('one@example.com')
        const status = await f.login('two@example.com')
        expect(status.accounts).toHaveLength(2)
        expect(JSON.stringify(status)).not.toContain('secret-')
        const switched = await f.service.run({action:'switch',id:'google_one@example.com'})
        expect(switched.auth.user?.login).toBe('one@example.com')
        expect(f.backend.adoptSession).toHaveBeenLastCalledWith(expect.objectContaining({token:'secret-one@example.com'}))
        await f.service.run({action:'complete'})
        const saved = await f.create().run({action:'status'})
        expect(saved.activeId).toBe('google_one@example.com')
        expect(saved.onboardingComplete).toBe(true)
        expect((await fs.readFile(join(f.dir,'accounts.enc'))).toString()).not.toContain('secret-one')
    })
    it('does not authorize a failed verification or arbitrary account ID', async () => {
        const f = await fixture()
        f.backend.pollGoogleLogin.mockRejectedValueOnce(Error('Invalid Google identity'))
        await f.service.run({action:'google'})
        await expect(f.service.run({action:'google-poll'})).rejects.toThrow('Invalid Google identity')
        await expect(f.service.run({action:'switch',id:'unverified'})).rejects.toThrow('expired')
        expect((await f.service.run({action:'status'})).activeId).toBeNull()
    })
    it('keeps other sessions and remembers only the logged-out identity without its token', async () => {
        const f = await fixture()
        await f.login('one@example.com')
        await f.login('two@example.com')
        const status = await f.service.run({action:'logout'})
        expect(status.activeId).toBeNull()
        expect(status.accounts.map(a=>a.email)).toEqual(['one@example.com','two@example.com'])
        expect(status.accounts.find(a=>a.email==='two@example.com')).toMatchObject({signedOut:true,expired:true})
        expect(status.auth.state).toBe('signed-out')
        const stored = JSON.parse(f.codec.decryptString(await fs.readFile(join(f.dir,'accounts.enc'))))
        expect(stored.accounts.map((a:{email:string})=>a.email)).toEqual(['one@example.com'])
        expect(JSON.stringify(stored)).not.toContain('secret-two@example.com')
        expect(stored.rememberedAccounts[0]).not.toHaveProperty('token')
        expect(stored.rememberedAccounts[0]).not.toHaveProperty('expiresAt')
        expect(f.backend.clearSession).toHaveBeenCalled()
        expect(f.github.logout).toHaveBeenCalled()
        const restarted = f.create()
        const restored = await restarted.run({action:'status'})
        expect(restored.activeId).toBeNull()
        expect(restored.accounts.find(a=>a.email==='two@example.com')?.signedOut).toBe(true)
        const adopted = f.backend.adoptSession.mock.calls.length
        await expect(restarted.run({action:'switch',id:'google_two@example.com'})).rejects.toThrow('Sign in again')
        expect(f.backend.adoptSession).toHaveBeenCalledTimes(adopted)
        expect((await restarted.run({action:'switch',id:'google_one@example.com'})).activeId).toBe('google_one@example.com')
        await f.login('two@example.com')
        const signedIn = await f.service.run({action:'status'})
        expect(signedIn.accounts.filter(a=>a.email==='two@example.com')).toHaveLength(1)
        expect(signedIn.accounts.find(a=>a.email==='two@example.com')?.signedOut).toBe(false)
    })
    it('retains the chooser after the only account logs out without restoring authentication on restart', async () => {
        const f = await fixture()
        await f.login('one@example.com')
        const status = await f.service.run({action:'logout'})
        expect(status.accounts).toHaveLength(1)
        expect(status.accounts[0]).toMatchObject({email:'one@example.com',provider:'google',signedOut:true})
        expect((await f.create().run({action:'status'})).auth.state).toBe('signed-out')
        await expect(f.service.run({action:'complete'})).rejects.toThrow('Sign in')
    })
    it('removes GitHub session tokens while remembering its provider for reauthentication', async () => {
        const f = await fixture()
        f.github.getStatus.mockResolvedValueOnce({state:'signed-in'})
        await f.service.run({action:'status'})
        const status = await f.service.run({action:'logout'})
        expect(status.accounts[0]).toMatchObject({id:'gh_42',provider:'github',signedOut:true})
        expect(f.codec.decryptString(await fs.readFile(join(f.dir,'accounts.enc')))).not.toContain('github-secret')
        await expect(f.service.run({action:'switch',id:'gh_42'})).rejects.toThrow('Sign in again')
    })
    it('imports GitHub once and can switch it independently from Google', async () => {
        const f = await fixture()
        f.github.getStatus.mockResolvedValue({state:'signed-in'})
        expect((await f.service.run({action:'status'})).activeId).toBe('gh_42')
        await f.login('one@example.com')
        expect((await f.service.run({action:'status'})).activeId).toBe('google_one@example.com')
        expect(f.backend.status).toHaveBeenCalledTimes(1)
    })
    it('fails closed when secure storage is unavailable or the vault is corrupt', async () => {
        const f = await fixture()
        f.codec.isEncryptionAvailable = () => false
        await expect(f.login('one@example.com')).rejects.toThrow('Secure storage')
        expect((await f.service.run({action:'status'})).activeId).toBeNull()
        await fs.writeFile(join(f.dir,'accounts.enc'),Buffer.from('corrupt'))
        await expect(f.create().run({action:'status'})).rejects.toThrow('Keychain')
    })
})
