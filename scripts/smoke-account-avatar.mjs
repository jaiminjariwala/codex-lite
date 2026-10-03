// Mock image responses only. No real accounts or profile pictures are requested.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const csp = readFileSync('src/renderer/sidebar/index.html', 'utf8').match(/content="([^"]+)"/)[1]
const entry = resolve('scripts/__avatar-smoke.tsx')
const fixture = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { AccountAvatar } from '/src/renderer/sidebar/AccountAvatar';
function Fixture(){const [url,setUrl]=React.useState('https://lh3.googleusercontent.com/photo');
window.changeAvatar=setUrl; return <div id="avatar"><AccountAvatar url={url} initial="J" /></div>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`
const server = await createServer({ configFile: false,
    resolve: { alias: { '@shared': resolve('src/shared'), '@op-shared': resolve('src/main/operator/shared') } },
    plugins: [react(), {
    name: 'avatar-smoke',
    resolveId(id) { if (id === '/__avatar-smoke.tsx') return entry },
    load(id) { if (id === entry) return fixture },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/avatar-smoke.html') return next()
        res.setHeader('Content-Type', 'text/html')
        res.end(await server.transformIndexHtml(req.url, `<html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><div id="root"></div><script type="module" src="/__avatar-smoke.tsx"></script></body></html>`))
    }) }
}], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
let browser
try {
    await server.listen()
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const page = await browser.newPage()
    await page.route('https://lh3.googleusercontent.com/**', route => route.request().url().endsWith('/broken')
        ? route.fulfill({ status: 404, body: '' })
        : route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ZsAAAAASUVORK5CYII=', 'base64') }))
    await page.goto(server.resolvedUrls.local[0] + 'avatar-smoke.html')
    await page.waitForFunction(() => document.querySelector('#avatar img')?.naturalWidth === 1)
    assert.equal(await page.locator('#avatar img').getAttribute('referrerpolicy'), 'no-referrer')
    await page.evaluate(() => window.changeAvatar('https://lh3.googleusercontent.com/broken'))
    await page.waitForFunction(() => document.querySelector('#avatar')?.textContent === 'J')
    assert.equal(await page.locator('#avatar img').count(), 0)
    await page.evaluate(() => window.changeAvatar('https://lh3.googleusercontent.com/other-account'))
    await page.waitForFunction(() => document.querySelector('#avatar img')?.naturalWidth === 1)
    await page.evaluate(() => window.changeAvatar(undefined))
    await page.waitForFunction(() => document.querySelector('#avatar')?.textContent === 'J')
    console.log('Avatar smoke passed: Google images load under the production CSP, failures show initials, and switching accounts loads the new image.')
} finally { await browser?.close(); await server.close() }
