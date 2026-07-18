#!/usr/bin/env node
/**
 * Records one demo per module against http://localhost:5173 using system
 * Chrome (H264-capable) + Playwright video capture. Each segment opens on
 * a dark title card. Output: demos/<name>.webm — post-process & merge with
 * scripts/build-demo.sh
 */
import { chromium } from 'playwright'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'demos')
const RAW = join(OUT, 'raw')
mkdirSync(RAW, { recursive: true })

const BASE = 'http://localhost:5173'
const W = 1600
const H = 900

const browser = await chromium.launch({ channel: 'chrome', headless: true })

function titleCard(no, en, zh, es, big = false) {
  return `<!doctype html><html><body style="margin:0;background:#0c0d0f;height:100vh;display:flex;flex-direction:column;justify-content:center;padding-left:110px;font-family:ui-monospace,Menlo,monospace">
    <div style="color:#5d646c;font-size:13px;letter-spacing:.32em">${no}</div>
    <div style="color:#e6e8ea;font-size:${big ? 54 : 42}px;margin-top:18px;letter-spacing:.04em;font-weight:600;font-family:-apple-system,'IBM Plex Sans',sans-serif">${en}</div>
    <div style="color:#9aa2ab;font-size:16px;margin-top:12px;letter-spacing:.08em">${zh}&nbsp;&nbsp;·&nbsp;&nbsp;${es}</div>
    <div style="position:fixed;left:110px;bottom:60px;width:44px;height:2px;background:#2f353c"></div>
  </body></html>`
}

async function record(name, card, fn) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: RAW, size: { width: W, height: H } },
  })
  const page = await ctx.newPage()
  page.setDefaultTimeout(25000)
  try {
    console.log(`▶ ${name}`)
    await page.setContent(card)
    await page.waitForTimeout(2100)
    await fn(page)
    const video = page.video()
    await page.close()
    await ctx.close()
    renameSync(await video.path(), join(OUT, `${name}.webm`))
    console.log(`  ✓ ${name}.webm`)
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`)
    await ctx.close().catch(() => {})
  }
}

const sleep = (page, ms) => page.waitForTimeout(ms)

async function smoothDrag(page, from, to, steps = 24, holdMs = 8) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    await page.waitForTimeout(holdMs)
  }
  await page.mouse.up()
}

const setLang = (page, l) =>
  page.evaluate((lang) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === lang)
    btn && btn.click()
  }, l)

// ---------- 01 · dashboard + trilingual ----------
await record(
  '01-ops-dashboard',
  titleCard('PLANTBOT · ROBOTICS OPERATIONS', 'Operations Dashboard', '实时作业总览 · 中英西三语', 'Panel de operaciones · trilingüe', true),
  async (page) => {
    await page.goto(`${BASE}/`)
    await page.waitForSelector('canvas, svg', { timeout: 15000 })
    await sleep(page, 6000)
    // trilingual tour: zh → es → en
    await setLang(page, '中')
    await sleep(page, 3200)
    await setLang(page, 'ES')
    await sleep(page, 3200)
    await setLang(page, 'EN')
    await sleep(page, 1500)
    // hover fleet strip
    const cells = page.locator('.panel.panel-hover')
    const n = Math.min(await cells.count(), 3)
    for (let i = 0; i < n; i++) {
      await cells.nth(i).hover()
      await sleep(page, 1100)
    }
    await page.mouse.move(1300, 400)
    await sleep(page, 5000)
  },
)

// ---------- 02 · live video (recorded long, trimmed later) ----------
await record(
  '02-live-video',
  titleCard('MODULE 02', 'Live Video Wall', 'RTSP 视频墙 · 含公网实况与 OGI', 'Muro de vídeo RTSP · OGI'),
  async (page) => {
    const waitFrames = (t) =>
      page
        .waitForFunction(
          () => {
            const el = document.querySelector('video-stream')
            return el && el.video && el.video.readyState >= 2 && el.video.videoWidth > 0
          },
          { timeout: t },
        )
        .catch(() => {})
    await page.goto(`${BASE}/live`)
    await page.waitForSelector('video-stream')
    await waitFrames(15000)
    await sleep(page, 7000)
    await page.click('button:has(img[alt*="Thermal"])')
    await waitFrames(14000)
    await sleep(page, 6000)
    await page.click('button:has(img[alt*="OGI"])')
    await waitFrames(14000)
    await sleep(page, 6000)
    await page.click('button:has-text("Wall")')
    await sleep(page, 14000)
  },
)

// ---------- 03 · missions ----------
await record(
  '03-missions',
  titleCard('MODULE 03', 'Mission Control', '任务编排 · 航点 + 动作 · 自动调度', 'Misiones · waypoints + acciones'),
  async (page) => {
    await page.goto(`${BASE}/missions`)
    await page.waitForSelector('button:has-text("M-1")')
    await sleep(page, 3200)
    const rows = page.locator('button:has-text("M-1")')
    if ((await rows.count()) > 1) {
      await rows.nth(1).click()
      await sleep(page, 3200)
    }
    // open the full-page planner
    await page.locator('button').filter({ hasText: /NEW MISSION/i }).first().click()
    await page.waitForSelector('.touch-none svg')
    await sleep(page, 1500)
    await page.locator('input[placeholder]').first().fill('Demo — east gauge loop')
    await sleep(page, 700)
    for (const wp of ['W02', 'W03', 'W10']) {
      await page.locator(`.touch-none svg text:text-is("${wp}")`).first().click({ force: true })
      await sleep(page, 1000)
    }
    // add a thermal scan on stop 2
    const stop2 = page.locator('.border.border-line.bg-surface-2').nth(1)
    await stop2.locator('button').filter({ hasText: /Thermal|热成像|térmico/i }).click()
    await sleep(page, 900)
    await page.locator('button:text-is("P1")').click()
    await sleep(page, 900)
    await page.locator('button').filter({ hasText: /QUEUE|入队|ENCOLAR/i }).first().click()
    await sleep(page, 2800)
    await sleep(page, 6000)
  },
)

// ---------- 04 · fleet + digital twins ----------
await record(
  '04-fleet',
  titleCard('MODULE 04', 'Fleet & Digital Twins', '机队管理 · 四足 + 轮式 · URDF 孪生', 'Flota · cuadrúpedos + UGV'),
  async (page) => {
    await page.goto(`${BASE}/robots`)
    await page.waitForSelector('table')
    await sleep(page, 3200)
    await page.mouse.wheel(0, 500)
    await sleep(page, 2600)
    await page.mouse.wheel(0, -500)
    await sleep(page, 1400)
    await page.click('text=JY·L3-01')
    await page.waitForSelector('canvas')
    await sleep(page, 6000)
    const c1 = await page.locator('canvas').boundingBox()
    if (c1) await smoothDrag(page, { x: c1.x + c1.width / 2, y: c1.y + c1.height / 2 }, { x: c1.x + c1.width / 2 + 240, y: c1.y + c1.height / 2 - 60 })
    await sleep(page, 4200)
    await page.goto(`${BASE}/robots/agx-w1`)
    await page.waitForSelector('canvas')
    await sleep(page, 6000)
    const c2 = await page.locator('canvas').boundingBox()
    if (c2) await smoothDrag(page, { x: c2.x + c2.width / 2, y: c2.y + c2.height / 2 }, { x: c2.x + c2.width / 2 - 260, y: c2.y + c2.height / 2 - 40 })
    await sleep(page, 4600)
  },
)

// ---------- 05 · ops map + teleop ----------
await record(
  '05-map-2d',
  titleCard('MODULE 05', 'Operations Map', 'SLAM 栅格 + 矢量图层 · 航点遥操作', 'Mapa de operaciones · teleop'),
  async (page) => {
    await page.goto(`${BASE}/map`)
    await page.waitForSelector('svg text')
    await sleep(page, 4200)
    await page.click('button:has-text("JY·L3-01")')
    await sleep(page, 3400)
    await page.locator('svg text:text-is("W11")').first().click({ force: true })
    await sleep(page, 1600)
    await page.locator('.panel button:has-text("JY·L3-01")').first().click()
    await sleep(page, 8000)
    await page.click('button:has-text("HSK·W1")')
    await sleep(page, 5000)
  },
)

// ---------- 07 · events + rules ----------
await record(
  '07-events',
  titleCard('MODULE 07', 'Detections & Rules', '检测看板 · 规则定义', 'Detecciones y reglas'),
  async (page) => {
    await page.goto(`${BASE}/events`)
    await page.waitForSelector('.cursor-pointer.border.border-line')
    await sleep(page, 3400)
    await page.locator('.cursor-pointer.border.border-line').first().click()
    await sleep(page, 3000)
    const ack = page.locator('button').filter({ hasText: /ACKNOWLEDGE|确认处理|CONFIRMAR/i })
    if (await ack.count()) await ack.click()
    await sleep(page, 1500)
    await page.locator('button').filter({ hasText: /^Table$|^表格$|^Tabla$/ }).click()
    await sleep(page, 3000)
    await page.mouse.wheel(0, 400)
    await sleep(page, 2000)
    await page.locator('button').filter({ hasText: /^Rules$|^规则$|^Reglas$/ }).click()
    await sleep(page, 2000)
    const slider = page.locator('input[type="range"]').first()
    await slider.evaluate((el) => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(el, '0.85')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await sleep(page, 1500)
    await page.locator('button[title="disable"]').first().click()
    await sleep(page, 1500)
    await page.locator('button').filter({ hasText: /NEW RULE|新建规则|NUEVA REGLA/i }).click()
    await page.waitForSelector('div.fixed.z-50')
    const modal = page.locator('div.fixed.z-50')
    await modal.locator('input').first().fill('Forklift in walkway')
    await modal.locator('select').nth(0).selectOption('motion')
    await modal.locator('select').nth(1).selectOption({ index: 1 })
    await sleep(page, 900)
    await modal.locator('button').filter({ hasText: /ACTIVATE|启用规则|ACTIVAR/i }).click()
    await sleep(page, 3200)
    await page.mouse.wheel(0, 300)
    await sleep(page, 2400)
  },
)

await browser.close()
try {
  rmSync(RAW, { recursive: true })
} catch {}
console.log('\nSegments in demos/ — run scripts/build-demo.sh to trim & merge')
