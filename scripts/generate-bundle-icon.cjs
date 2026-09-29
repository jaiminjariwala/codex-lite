// The Finder/launch icon uses the same Classic artwork and sizing as Dock frame 00.
// Run with: node_modules/.bin/electron scripts/generate-bundle-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
    try {
        await window.loadURL('data:text/html,<html></html>')
        const build = path.join(__dirname, '../build')
        const source = 'data:image/png;base64,' + fs.readFileSync(path.join(build, 'app-icons/atlas.png')).toString('base64')
        const images = await window.webContents.executeJavaScript(`(async () => {
            const img = new Image(); img.src = ${JSON.stringify(source)}; await img.decode();
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
            const context = canvas.getContext('2d');
            context.drawImage(img, img.width / 3, 0, img.width / 3, img.height, 0, 0, 512, 512);
            const pixels = context.getImageData(0, 0, 512, 512).data;
            let left = 512, top = 512, right = 0, bottom = 0;
            for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
                if (pixels[(y * 512 + x) * 4 + 3] > 128) {
                    left = Math.min(left, x); right = Math.max(right, x);
                    top = Math.min(top, y); bottom = Math.max(bottom, y);
                }
            }
            const images = {};
            for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
                const output = document.createElement('canvas'); output.width = output.height = size;
                const scale = size * (120 / 128) / Math.max(right - left, bottom - top);
                const width = (right - left) * scale, height = (bottom - top) * scale;
                output.getContext('2d').drawImage(canvas, left, top, right - left, bottom - top,
                    (size - width) / 2, (size - height) / 2, width, height);
                images[size] = output.toDataURL().split(',')[1];
            }
            return images;
        })()`)
        const iconset = path.join(build, 'icon.iconset')
        fs.mkdirSync(iconset, { recursive: true })
        for (const size of [16, 32, 128, 256, 512]) {
            fs.writeFileSync(path.join(iconset, `icon_${size}x${size}.png`), Buffer.from(images[size], 'base64'))
            fs.writeFileSync(path.join(iconset, `icon_${size}x${size}@2x.png`), Buffer.from(images[size * 2], 'base64'))
        }
        fs.writeFileSync(path.join(build, 'icon-1024.png'), Buffer.from(images[1024], 'base64'))
        execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(build, 'icon.icns')])
        console.log('Generated Finder and launch icons matching the Classic Dock artwork.')
    } finally {
        window.destroy()
        app.quit()
    }
}).catch(error => { console.error(error); app.exit(1) })
