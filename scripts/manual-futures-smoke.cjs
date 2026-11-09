const { chromium } = require('C:/Users/Michael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [], calls = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async r => {
      const u = new URL(r.request().url());
      if (u.pathname.includes('/api/')) {
        calls.push({ path: u.pathname, body: r.request().postDataJSON() });
        if (u.pathname.endsWith('/context')) return r.fulfill({ json: { available: 1000, price: 60000, positions: [{ symbol: 'BTCUSDT', holdSide: 'long', total: '0.002' }] } });
        if (u.pathname.endsWith('/preview')) return r.fulfill({ json: { preview: { ...r.request().postDataJSON(), id: 'p1', limit: 60000, stop: 58800, target: 62400, expiresAt: Date.now() + 60000 } } });
        return r.fulfill({ json: { entry: { status: 'submitted' } } });
      }
      try {
        let body = await fs.readFile(path.join(process.cwd(), 'app/frontend/terminal', u.pathname === '/' ? 'index.html' : u.pathname.slice(1)), 'utf8');
        if (u.pathname === '/') body = body.replace('<script type="module" src="./main.js"></script>', `<script type="module">
          import './workspace.js'; import {createManualFuturesPanel} from './manual-futures.js';
          window.auth='fixture'; createManualFuturesPanel(()=>window.auth,async()=>{});
          window.state={connections:{demo:{configured:true,revision:'d1'},live:{configured:true,revision:'l1'}},journal:{entries:[]},stale:false};
          document.dispatchEvent(new CustomEvent('terminal-trading',{detail:window.state}));
          </script>`);
        return r.fulfill({ contentType: u.pathname.endsWith('.js') ? 'text/javascript' : u.pathname.endsWith('.css') ? 'text/css' : 'text/html', body });
      } catch { return r.fulfill({ status: 404, body: '' }); }
    });
    await page.goto('http://fixture.test/');
    await page.getByRole('button', { name: 'Manual', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#manual-limit').value === '60000');
    await page.locator('#manual-quantity').fill('0.001');
    await page.locator('#manual-leverage').fill('20');
    assert.equal(calls.filter(c => c.path.endsWith('/confirm')).length, 0);
    await page.locator('#manual-preview').click();
    await page.locator('#manual-review').waitFor({ state: 'visible' });
    assert.match(await page.locator('#manual-review-prices').innerText(), /margin 3 USDT/);
    await page.locator('#manual-confirm').click();
    await page.locator('#manual-review').waitFor({ state: 'hidden' });
    assert.equal(calls.filter(c => c.path.endsWith('/confirm')).length, 1);
    await page.locator('#manual-environment').selectOption('live');
    await page.locator('#manual-action').selectOption('close');
    await page.locator('#manual-orderType').selectOption('market');
    await page.locator('#manual-preview').click();
    await page.locator('#manual-review').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#manual-confirm').isDisabled(), true);
    await page.locator('#manual-live-ack').fill('PLACE LIVE ORDER');
    assert.equal(await page.locator('#manual-confirm').isDisabled(), false);
    const close = calls.filter(c => c.path.endsWith('/preview')).at(-1).body;
    assert.equal(close.action, 'close'); assert.equal(close.symbol, 'BTC/USDT:USDT'); assert.equal(close.orderType, 'market');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('terminal-market-select', { detail: { symbol: 'SOLUSDT' } })));
    assert.equal(await page.locator('#manual-review').isVisible(), false);
    assert.equal(await page.locator('#manual-quantity').inputValue(), '');
    assert.equal(calls.filter(c => c.path.endsWith('/confirm')).length, 1);
    await page.evaluate(() => {
      window.state.journal.entries = [{ id: 'resting1', source: 'manual', environment: 'live', symbol: 'SOLUSDT', side: 'short', status: 'partially-filled', orderType: 'limit', filled: 0.1, quantity: 1 }];
      document.dispatchEvent(new CustomEvent('terminal-trading', { detail: window.state }));
    });
    page.once('dialog', d => d.accept());
    await page.getByRole('button', { name: 'Cancel remaining limit' }).click();
    await page.waitForFunction(() => document.querySelector('#manual-status').textContent.includes('Cancellation queued'));
    assert.deepEqual(calls.find(c => c.path.endsWith('/cancel')).body, { entryId: 'resting1' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => { window.auth = null; document.dispatchEvent(new CustomEvent('terminal-trading', { detail: null })); });
    assert.equal(await page.locator('#manual-quantity').isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: preview/confirm; no orders from edits; live acknowledgement; close-market contract; pair invalidation; mobile width; sign-out; no page errors. All exchange routes mocked.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
