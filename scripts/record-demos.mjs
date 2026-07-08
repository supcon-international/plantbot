#!/usr/bin/env node
/**
 * Records one demo video per module against the running dev server
 * (http://localhost:5173) using system Chrome (H264-capable) and
 * Playwright's context video recorder. Output: demos/<name>.webm
 */
import { chromium } from 'playwright'
import { mkdirSync, renameSync, existsSync, rmSync } from 'node:fs'
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

async function record(name, fn) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: RAW, size: { width: W, height: H } },
  })
  const page = await ctx.newPage()
  page.setDefaultTimeout(20000)
  try {
    console.log(`▶ ${name}`)
    await fn(page)
    const video = page.video()
    await page.close()
    await ctx.close()
    const p = await video.path()
    renameSync(p, join(OUT, `${name}.webm`))
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

// ---------- 01 · OPS dashboard ----------
await record('01-ops-dashboard', async (page) => {
  await page.goto(`${BASE}/`)
  await page.waitForSelector('text=LIVE OPERATIONS', { timeout: 15000 })
  await sleep(page, 6000) // map + telemetry settle, robots move
  // hover the fleet strip cells
  const cells = page.locator('.panel.panel-hover')
  const n = Math.min(await cells.count(), 3)
  for (let i = 0; i < n; i++) {
    await cells.nth(i).hover()
    await sleep(page, 1200)
  }
  await sleep(page, 5000)
  // glance at the detection feed
  await page.mouse.move(1300, 400)
  await sleep(page, 4000)
})

// ---------- 02 · Live video wall ----------
await record('02-live-video', async (page) => {
  await page.goto(`${BASE}/live`)
  await page.waitForSelector('video-stream')
  await sleep(page, 7000) // MSE first frames
  // switch to thermal
  await page.click('button:has(img[alt*="Thermal"])').catch(() => {})
  await sleep(page, 6000)
  // switch to the public live perimeter cam
  await page.click('button:has(img[alt*="Perimeter"])').catch(() => {})
  await sleep(page, 7000)
  // OGI channel
  await page.click('button:has(img[alt*="OGI"])').catch(() => {})
  await sleep(page, 6000)
  // wall mode — all channels at once
  await page.click('button:has-text("Wall")')
  await sleep(page, 12000)
})

// ---------- 03 · Missions ----------
await record('03-missions', async (page) => {
  await page.goto(`${BASE}/missions`)
  await page.waitForSelector('text=MISSION CONTROL')
  await sleep(page, 3000)
  // open an active/history mission to show plan + timeline
  const rows = page.locator('button:has-text("M-1")')
  if ((await rows.count()) > 1) {
    await rows.nth(1).click()
    await sleep(page, 3500)
  }
  // create a new mission
  await page.click('button:has-text("NEW MISSION")')
  await page.waitForSelector('text=Tap waypoints')
  await sleep(page, 1200)
  await page.fill('input[placeholder*="Valve run"]', 'Demo — east gauge loop')
  await sleep(page, 600)
  // click waypoints on the wizard's embedded map (scope to the modal)
  const modal = page.locator('div.fixed.z-50')
  for (const wp of ['W02', 'W03', 'W10']) {
    await modal.locator(`svg text:text-is("${wp}")`).first().click({ force: true })
    await sleep(page, 900)
  }
  // add a thermal scan to stop 2
  await modal.locator('button:has-text("Thermal scan")').nth(1).click()
  await sleep(page, 800)
  // priority P1
  await modal.locator('button:text-is("P1")').click()
  await sleep(page, 800)
  await modal.locator('button:has-text("QUEUE MISSION")').click()
  await sleep(page, 2500)
  // watch it sit in queue / get dispatched
  await sleep(page, 6000)
})

// ---------- 04 · Fleet + digital twins ----------
await record('04-fleet', async (page) => {
  await page.goto(`${BASE}/robots`)
  await page.waitForSelector('text=SENSOR COVERAGE MATRIX')
  await sleep(page, 3000)
  await page.mouse.wheel(0, 500)
  await sleep(page, 2500)
  await page.mouse.wheel(0, -500)
  await sleep(page, 1500)
  // Lite3 digital twin
  await page.click('text=JY·L3-01')
  await page.waitForSelector('canvas')
  await sleep(page, 6000) // urdf load + gait
  const c1 = await page.locator('canvas').boundingBox()
  if (c1) {
    await smoothDrag(page, { x: c1.x + c1.width / 2, y: c1.y + c1.height / 2 }, { x: c1.x + c1.width / 2 + 240, y: c1.y + c1.height / 2 - 60 })
  }
  await sleep(page, 4000)
  // Husky UGV twin
  await page.goto(`${BASE}/robots/agx-w1`)
  await page.waitForSelector('canvas')
  await sleep(page, 6000)
  const c2 = await page.locator('canvas').boundingBox()
  if (c2) {
    await smoothDrag(page, { x: c2.x + c2.width / 2, y: c2.y + c2.height / 2 }, { x: c2.x + c2.width / 2 - 260, y: c2.y + c2.height / 2 - 40 })
  }
  await sleep(page, 5000)
})

// ---------- 05 · Ops map (2D) + waypoint teleop ----------
await record('05-map-2d', async (page) => {
  await page.goto(`${BASE}/map`)
  await page.waitForSelector('svg text')
  await sleep(page, 4000)
  // select a robot to show live card + path
  await page.click('button:has-text("JY·L3-01")')
  await sleep(page, 3500)
  // waypoint teleop: dispatch L3 to W11
  await page.locator('svg text:text-is("W11")').first().click({ force: true })
  await sleep(page, 1500)
  await page.locator('.panel button:has-text("JY·L3-01")').first().click()
  await sleep(page, 8000) // watch it navigate along planned path
  // select the UGV
  await page.click('button:has-text("HSK·W1")')
  await sleep(page, 5000)
})

// ---------- 06 · 3D splat scan ----------
await record('06-map-3d', async (page) => {
  await page.goto(`${BASE}/map?mode=splat`)
  await page.waitForSelector('canvas')
  await sleep(page, 12000) // splat streaming
  const c = await page.locator('canvas').boundingBox()
  if (c) {
    const cx = c.x + c.width / 2
    const cy = c.y + c.height / 2
    await smoothDrag(page, { x: cx, y: cy }, { x: cx + 300, y: cy - 40 }, 30)
    await sleep(page, 2000)
    await smoothDrag(page, { x: cx, y: cy }, { x: cx - 200, y: cy + 60 }, 30)
  }
  await sleep(page, 2500)
  // follow a robot
  await page.click('button:has-text("JY·X30-01")')
  await sleep(page, 1500)
  await page.click('button:has-text("FOLLOW")').catch(() => {})
  await sleep(page, 7000)
})

// ---------- 07 · Events board + rules ----------
await record('07-events', async (page) => {
  await page.goto(`${BASE}/events`)
  await page.waitForSelector('text=DETECTION CENTER')
  await sleep(page, 3500)
  // open a detail modal from the board
  await page.locator('.cursor-pointer.border.border-line').first().click()
  await sleep(page, 3000)
  const ack = page.locator('button:has-text("ACKNOWLEDGE")')
  if (await ack.count()) await ack.click()
  await sleep(page, 1500)
  // table view
  await page.click('button:has-text("Table")')
  await sleep(page, 3000)
  await page.mouse.wheel(0, 400)
  await sleep(page, 2000)
  // rules view — tune a threshold, toggle a rule, create a new one
  await page.click('button:has-text("Rules")')
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
  await page.click('button:has-text("NEW RULE")')
  await page.waitForSelector('text=Define detection rule')
  await page.fill('input[placeholder*="Forklift"]', 'Forklift in walkway')
  await page.selectOption('select >> nth=0', 'motion')
  await page.selectOption('select >> nth=1', { index: 1 })
  await sleep(page, 800)
  await page.click('button:has-text("ACTIVATE RULE")')
  await sleep(page, 3000)
  await page.mouse.wheel(0, 300)
  await sleep(page, 2500)
})

await browser.close()

// cleanup raw dir if empty
try {
  rmSync(RAW, { recursive: true })
} catch {}
console.log('\nAll recordings in demos/')
