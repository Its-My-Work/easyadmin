import asyncio
import os
import subprocess
import time
from playwright.async_api import async_playwright

async def capture_all():
    port = '3195'
    env = {
        **os.environ,
        'PORT': port,
        'DEMO_BACKUPS': '1',
        'DEMO_NAMES': 'en',
        'EASYADMIN_NO_RATE_LIMIT': '1'
    }
    
    proc = subprocess.Popen(
        ['node', 'scripts/demo.js'],
        cwd='/opt/data/workspace/easyadmin',
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )
    for line in proc.stdout:
        print("DEMO:", line.strip())
        if "Демо запущено:" in line:
            break
            
    out_dir = '/opt/data/workspace/easyadmin/docs/screenshots'
    os.makedirs(out_dir, exist_ok=True)
    
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                executable_path='/opt/hermes/tools/chromium-1208/chrome-linux64/chrome',
                args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            )
            context = await browser.new_context(
                viewport={'width': 1360, 'height': 860},
                device_scale_factor=2,
                locale='en-US'
            )
            page = await context.new_page()
            
            # Setup language to English
            await page.goto(f'http://127.0.0.1:{port}/')
            await page.evaluate("localStorage.setItem('ea-lang', 'en')")
            await page.reload()
            await asyncio.sleep(0.5)
            
            # Login
            await page.fill('input[autocomplete="username"]', 'admin')
            await page.fill('input[autocomplete="current-password"]', 'demo12345')
            await page.click('button[type="submit"]')
            await page.wait_for_selector('.topbar', timeout=6000)
            await asyncio.sleep(1)
            
            # 1. Overview
            await page.goto(f'http://127.0.0.1:{port}/#/')
            await asyncio.sleep(1)
            await page.screenshot(path=f'{out_dir}/overview.png')
            print("✓ 1. overview.png")
            
            # 2. Files (IDE Split View with file tree, editor and find bar)
            await page.goto(f'http://127.0.0.1:{port}/#/files')
            await asyncio.sleep(0.8)
            await page.evaluate("""async () => {
                const { editorView } = await import('./js/files-editor.js');
                const { clear } = await import('./js/dom.js');
                const root = document.querySelector('.content .view');
                const composeContent = `version: '3.8'\\n\\nservices:\\n  web:\\n    image: ghcr.io/acme/shop:1.8.2\\n    restart: always\\n    environment:\\n      - NODE_ENV=production\\n      - PORT=3000\\n      - DATABASE_URL=postgres://app:secret@db:5432/shop\\n    ports:\\n      - "3000:3000"\\n    depends_on:\\n      - db\\n      - cache\\n\\n  db:\\n    image: postgres:16-alpine\\n    restart: always\\n    volumes:\\n      - db_data:/var/lib/postgresql/data\\n    environment:\\n      - POSTGRES_DB=shop\\n      - POSTGRES_USER=app\\n      - POSTGRES_PASSWORD=secret\\n\\n  cache:\\n    image: redis:7-alpine\\n    restart: always\\n\\nvolumes:\\n  db_data:\\n`;
                const items = [
                  { name: '..', type: 'dir', parent: true },
                  { name: 'src', type: 'dir' },
                  { name: 'public', type: 'dir' },
                  { name: '.env', type: 'file', size: 312 },
                  { name: 'docker-compose.yml', type: 'file', size: composeContent.length },
                  { name: 'Dockerfile', type: 'file', size: 850 },
                  { name: 'package.json', type: 'file', size: 1240 },
                  { name: 'README.md', type: 'file', size: 4890 }
                ];
                const ed = editorView({
                  panelId: 1,
                  path: '/etc/easypanel/projects/main/shop/docker-compose.yml',
                  data: { size: composeContent.length, content: composeContent, path: '/etc/easypanel/projects/main/shop/docker-compose.yml' },
                  onClose: () => {},
                  listDir: async (p) => ({ path: '/etc/easypanel/projects/main/shop', items, parent: '/etc/easypanel/projects/main' }),
                  onOpen: () => {}
                });
                clear(root).append(ed);
                
                // Open search bar
                view.querySelector('button[title*="Ctrl+F"]')?.click();
            }""")
            await asyncio.sleep(0.5)
            await page.fill('.fm-find input', 'image')
            await asyncio.sleep(0.5)
            await page.screenshot(path=f'{out_dir}/files.png')
            print("✓ 2. files.png")
            
            # 3. Server Doctor
            await page.goto(f'http://127.0.0.1:{port}/#/')
            await page.goto(f'http://127.0.0.1:{port}/#/doctor')
            await asyncio.sleep(1.2)
            await page.screenshot(path=f'{out_dir}/server-doctor.png')
            print("✓ 3. server-doctor.png")
            
            # 4. Command Palette
            await page.goto(f'http://127.0.0.1:{port}/#/')
            await asyncio.sleep(0.5)
            await page.evaluate("window.openPalette ? window.openPalette() : document.querySelector('.search-trigger')?.click()")
            await asyncio.sleep(0.5)
            await page.keyboard.type('>')
            await asyncio.sleep(0.5)
            await page.screenshot(path=f'{out_dir}/palette.png')
            print("✓ 4. palette.png")
            
            # 5. Public Status Page
            await page.goto(f'http://127.0.0.1:{port}/status')
            await asyncio.sleep(1.2)
            await page.screenshot(path=f'{out_dir}/status-page.png')
            print("✓ 5. status-page.png")
            
            # 6. AI Doctor
            await page.goto(f'http://127.0.0.1:{port}/#/')
            await page.goto(f'http://127.0.0.1:{port}/#/ai-doctor')
            await asyncio.sleep(1.2)
            await page.screenshot(path=f'{out_dir}/ai-doctor.png')
            print("✓ 6. ai-doctor.png")
            
            # 7. Migration Modal
            await page.goto(f'http://127.0.0.1:{port}/#/')
            await asyncio.sleep(0.8)
            await page.evaluate("""async () => {
                const m = await import('./js/migration-modal.js');
                await m.migrationModal();
            }""")
            await asyncio.sleep(0.8)
            await page.screenshot(path=f'{out_dir}/migration.png')
            print("✓ 7. migration.png")
            
            # 8. Themes Modal
            await page.keyboard.press('Escape')
            await asyncio.sleep(0.5)
            await page.evaluate("""async () => {
                const m = await import('./js/theme-picker.js');
                m.themePickerModal();
            }""")
            await asyncio.sleep(0.8)
            await page.screenshot(path=f'{out_dir}/themes.png')
            print("✓ 8. themes.png")
            
            # 9. Backups Page
            await page.keyboard.press('Escape')
            await asyncio.sleep(0.5)
            await page.goto(f'http://127.0.0.1:{port}/#/backups')
            await asyncio.sleep(1.2)
            await page.screenshot(path=f'{out_dir}/backups.png')
            print("✓ 9. backups.png")
            
            # 10. Load Tab
            await page.goto(f'http://127.0.0.1:{port}/#/panels/1?tab=load')
            await asyncio.sleep(1.5)
            await page.screenshot(path=f'{out_dir}/load.png')
            print("✓ 10. load.png")
            
            await browser.close()
    finally:
        proc.terminate()
        proc.wait()
    print("ALL 10 SCREENSHOTS COMPLETED SUCCESSFULLY!")

if __name__ == '__main__':
    asyncio.run(capture_all())
