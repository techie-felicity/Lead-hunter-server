const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");
const webpush = require("web-push");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());
app.use(express.json({ limit: "10mb" }));

// ── VAPID keys for Web Push ───────────────────────────────────────────────────
// These MUST stay the same across restarts or existing push subscriptions break.
// Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT as Railway env vars
// to pin them permanently. Falls back to a generated default otherwise.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "BCWKOl5sntMhA-VH_xytcF81-xj_teAO7vdDf2OItEcrIRstktuwJF3sfpg9D4rCMO_L1yptx8msxI7H5_sb3AU";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "3ddKt2LoSRlCSZ6r_01UjHq9mHRA-HeDtuRCHYZwfsU";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

if (!process.env.VAPID_PUBLIC_KEY) {
  console.warn("⚠️  Using default VAPID keys. Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars on Railway to keep push subscriptions valid across redeploys.");
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ── Serve the frontend itself (needs to be a real HTTPS origin for Push API) ──
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/diagnostics", async (req, res) => {
  const result = { chromiumLaunch: null, error: null, nodeVersion: process.version, memory: process.memoryUsage() };
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: 60000,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer"],
    });
    const version = browser.version();
    result.chromiumLaunch = "ok";
    result.chromiumVersion = version;
  } catch (e) {
    result.chromiumLaunch = "failed";
    result.error = e.message;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  res.json(result);
});
app.get("/push/vapid-public-key", (req, res) => res.json({ key: VAPID_PUBLIC_KEY }));

// ── Push subscriptions (in-memory; cleared on restart) ───────────────────────
const pushSubscriptions = new Map(); // endpoint -> subscription object

app.post("/push/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "invalid subscription" });
  pushSubscriptions.set(sub.endpoint, sub);
  res.json({ ok: true });
});

app.post("/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) pushSubscriptions.delete(endpoint);
  res.json({ ok: true });
});

async function notifyAll(payload) {
  const body = JSON.stringify(payload);
  const dead = [];
  for (const [endpoint, sub] of pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, body);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(endpoint);
    }
  }
  dead.forEach(e => pushSubscriptions.delete(e));
}

function phoneToWA(phone) {
  if (!phone) return "";
  const d = phone.replace(/\D/g, "");
  const n = d.startsWith("0") ? "234" + d.slice(1) : d;
  return n.length >= 10 ? `https://wa.me/${n}` : "";
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Density presets ────────────────────────────────────────────────────────────
const DENSITY_PRESETS = {
  light:    { targetPoints: 40 },
  standard: { targetPoints: 90 },
  dense:    { targetPoints: 170 },
};

// ── Geocoding ──────────────────────────────────────────────────────────────────
function bboxAreaKm2(bbox) {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const latKm = (bbox.maxLat - bbox.minLat) * 111;
  const lonKm = (bbox.maxLon - bbox.minLon) * 111 * Math.cos((midLat * Math.PI) / 180);
  return Math.max(latKm * lonKm, 0);
}

async function geocodeLocation(location) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=8&addressdetails=1&q=${encodeURIComponent(location)}`;
  const res = await fetch(url, { headers: { "User-Agent": "LeadHunterPro/1.0 (lead-gen scraping tool)" } });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const data = await res.json();
  if (!data || !data.length) throw new Error(`Could not find location "${location}"`);

  const candidates = data.map(hit => {
    const [minLat, maxLat, minLon, maxLon] = hit.boundingbox.map(Number);
    const bbox = { minLat, maxLat, minLon, maxLon };
    return {
      lat: Number(hit.lat), lon: Number(hit.lon),
      displayName: hit.display_name, bbox,
      area: bboxAreaKm2(bbox),
      isBroadType: hit.class === "boundary" || ["city", "state", "town", "administrative", "county"].includes(hit.type),
    };
  });

  const broad = candidates.filter(c => c.isBroadType).sort((a, b) => b.area - a.area);
  return broad[0] || candidates.sort((a, b) => b.area - a.area)[0];
}

function buildGrid(bbox, targetPoints) {
  const { minLat, maxLat, minLon, maxLon } = bbox;
  const midLat = (minLat + maxLat) / 2;
  const latSpanKm = (maxLat - minLat) * 111;
  const lonSpanKm = (maxLon - minLon) * 111 * Math.cos((midLat * Math.PI) / 180);
  const areaKm2 = Math.max(latSpanKm * lonSpanKm, 1);

  let stepKm = Math.sqrt(areaKm2 / targetPoints);
  stepKm = Math.max(stepKm, 0.8);

  const latStepDeg = stepKm / 111;
  const lonStepDeg = stepKm / (111 * Math.cos((midLat * Math.PI) / 180) || 1);

  const points = [];
  for (let lat = minLat + latStepDeg / 2; lat <= maxLat; lat += latStepDeg) {
    for (let lon = minLon + lonStepDeg / 2; lon <= maxLon; lon += lonStepDeg) {
      points.push({ lat, lon });
    }
  }
  const capped = points.length > targetPoints * 2.5 ? points.slice(0, Math.ceil(targetPoints * 2.5)) : points;
  const zoom = stepKm <= 1.2 ? 16 : stepKm <= 2.2 ? 15 : stepKm <= 4 ? 14 : stepKm <= 7 ? 13 : 12;
  return { points: capped, stepKm, zoom };
}

// ── Browser helpers ────────────────────────────────────────────────────────────
function shortLaunchError(e) {
  // Playwright bakes the full command line + raw stderr into e.message, which is
  // useless (and huge) to show a user. Pull out just the actual error line.
  const msg = e.message || String(e);
  const dbusLine = /Failed to connect to the bus/i.test(msg);
  const lines = msg.split("\n").map(l => l.trim()).filter(Boolean);
  const meaningful = lines.find(l =>
    /error|failed|denied|enoent|enomem|timeout/i.test(l) &&
    !/^--|^\[pid=|^<launched>|dbus\/bus\.cc/i.test(l)
  );
  if (meaningful) return meaningful.slice(0, 200);
  if (dbusLine) return "Browser environment issue (dbus) — usually harmless on its own; check Railway logs for the real cause below it.";
  return lines[0]?.slice(0, 200) || "Browser failed to launch";
}

async function launchBrowser() {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: 60000,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-blink-features=AutomationControlled",
        "--lang=en-US",
        "--window-size=1366,900",
      ],
    });
  } catch (e) {
    console.error("Chromium launch failed — full detail:\n", e.message);
    throw new Error(`Chromium launch failed: ${shortLaunchError(e)} (see Railway logs for full detail)`);
  }
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
  });
  await context.route("**/*.{woff,woff2,ttf,otf,eot}", r => r.abort());
  return { browser, context };
}

async function dismissDialogs(page) {
  for (const txt of ["Accept all", "Accept", "Agree", "Reject all"]) {
    try {
      const btn = page.locator(`button:has-text("${txt}")`).first();
      if (await btn.isVisible({ timeout: 2000 })) { await btn.click(); await sleep(1000); return; }
    } catch (_) {}
  }
}

async function gotoWithRetry(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(4000);
    }
  }
}

async function deepScroll(page, cellCap) {
  try {
    await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 12000 });
  } catch (_) {
    return [];
  }
  await sleep(800);

  const feedHandle = await page.evaluateHandle(() => {
    const selectors = ['div[role="feed"]', '[aria-label*="Results for"]', '[aria-label*="Search results"]', '.m6QErb[aria-label]', '.m6QErb'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight) return el;
    }
    let best = null, bestH = 0;
    document.querySelectorAll('div').forEach(el => {
      if (el.scrollHeight > el.clientHeight + 100 && el.scrollHeight > bestH) { best = el; bestH = el.scrollHeight; }
    });
    return best;
  });

  let lastCount = 0, staleRounds = 0;
  const MAX_STALE = 6;

  while (true) {
    const count = await page.evaluate(() => new Set(
      Array.from(document.querySelectorAll('a[href*="/maps/place/"]')).map(a => a.href.split("?")[0])
    ).size);

    if (count >= cellCap) break;

    if (count === lastCount) {
      staleRounds++;
      if (staleRounds >= 3) {
        const ended = await page.evaluate(() => {
          const body = document.body.innerText || "";
          return body.includes("You've reached the end of the list") || body.includes("reached the end") || !!document.querySelector('[class*="PbZDve"]');
        });
        if (ended) break;
      }
      if (staleRounds >= MAX_STALE) break;
    } else {
      staleRounds = 0;
    }
    lastCount = count;

    await page.evaluate((el) => { if (el) el.scrollBy(0, 4000); else window.scrollBy(0, 4000); }, feedHandle);
    await sleep(1500);
  }

  return await page.evaluate(() => {
    const seen = new Set();
    const results = [];
    document.querySelectorAll('a[href*="/maps/place/"]').forEach(a => {
      const key = a.href.split("?")[0];
      if (seen.has(key)) return;
      seen.add(key);

      let card = a;
      for (let i = 0; i < 10; i++) {
        if (!card.parentElement) break;
        card = card.parentElement;
        if (card.tagName === 'LI' || (card.getAttribute('role') === 'article')) break;
      }

      let name = a.getAttribute("aria-label") || "";
      if (!name) {
        const h = card.querySelector('h3, h2, [class*="fontHeadline"]');
        if (h) name = h.textContent.trim();
      }
      if (!name) {
        const lines = (card.innerText || "").split("\n").map(l => l.trim()).filter(l => l.length > 1);
        name = lines[0] || "";
      }
      name = name.replace(/\s+/g, " ").trim();
      if (!name || name.length < 2) return;

      let address = "";
      const allText = (card.innerText || "").split("\n").map(l => l.trim()).filter(Boolean);
      for (let i = 1; i < allText.length; i++) {
        const line = allText[i];
        if (/^\d+\.\d+$/.test(line)) continue;
        if (/^\(\d+\)$/.test(line)) continue;
        if (line.length < 4) continue;
        address = line;
        break;
      }

      let category = "";
      const catEl = card.querySelector('[class*="DkEaL"], [class*="category"]');
      if (catEl) category = catEl.textContent.trim();

      results.push({ name, address, category, mapsUrl: a.href });
    });
    return results;
  });
}

function placeKey(listing) {
  try {
    const decoded = decodeURIComponent(listing.mapsUrl || "");
    const m = decoded.match(/!1s(0x[0-9a-fA-F]+:0x[0-9a-fA-F]+)/);
    if (m) return "cid:" + m[1];
  } catch (_) {}
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return "na:" + norm(listing.name) + "|" + norm(listing.address).slice(0, 30);
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const SKIP_EMAIL_DOMAINS = /\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i;

async function getPlacePhone(page, mapsUrl) {
  try {
    await gotoWithRetry(page, mapsUrl);
    await sleep(1800);
    return await page.evaluate(() => {
      let phone = "";
      const telLink = document.querySelector('a[href^="tel:"]');
      if (telLink) phone = telLink.href.replace("tel:", "").trim();
      if (!phone) {
        for (const el of document.querySelectorAll('[aria-label]')) {
          const lbl = el.getAttribute("aria-label") || "";
          const m = lbl.match(/(\+?[\d][\d\s\-().]{5,14}[\d])/);
          if (m) {
            const digits = m[1].replace(/\D/g, "");
            if (digits.length >= 7 && digits.length <= 15) { phone = m[1].trim(); break; }
          }
        }
      }
      if (!phone) {
        for (const el of document.querySelectorAll('button, [role="button"]')) {
          const t = (el.textContent || "").trim();
          if (/^[\+\d][\d\s\-().]{6,14}[\d]$/.test(t)) {
            const d = t.replace(/\D/g, "");
            if (d.length >= 7 && d.length <= 15) { phone = t; break; }
          }
        }
      }

      let website = "";
      const authorityLink = document.querySelector('a[data-item-id="authority"]');
      if (authorityLink) website = authorityLink.href;
      if (!website) {
        for (const el of document.querySelectorAll('a[aria-label]')) {
          const lbl = el.getAttribute("aria-label") || "";
          if (/^website:/i.test(lbl) && el.href) { website = el.href; break; }
        }
      }

      return { phone, website };
    });
  } catch {
    return { phone: "", website: "" };
  }
}

// Visits a business's own website (in a fresh tab) and looks for a contact
// email — mailto: links first, then a plain-text email pattern on the page.
// Best-effort only: failures (site down, blocks bots, no email listed, etc.)
// just result in an empty string rather than failing the whole lead.
async function getEmailFromWebsite(context, website) {
  if (!website) return "";
  let page;
  try {
    page = await context.newPage();
    await page.goto(website, { waitUntil: "domcontentloaded", timeout: 15000 });
    await sleep(500);
    let email = await page.evaluate((skipRe) => {
      const mailLink = document.querySelector('a[href^="mailto:"]');
      if (mailLink) {
        const addr = mailLink.href.replace("mailto:", "").split("?")[0].trim();
        if (addr) return addr;
      }
      const text = document.body ? document.body.innerText : "";
      const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      return m ? m[0] : "";
    }, SKIP_EMAIL_DOMAINS.source);
    if (email && SKIP_EMAIL_DOMAINS.test(email)) email = "";

    // A lot of sites tuck the email away on a /contact page instead of the homepage.
    if (!email) {
      try {
        const contactHref = await page.evaluate(() => {
          const link = Array.from(document.querySelectorAll("a")).find(a =>
            /contact/i.test(a.href || "") || /contact us/i.test(a.textContent || "")
          );
          return link ? link.href : "";
        });
        if (contactHref) {
          await page.goto(contactHref, { waitUntil: "domcontentloaded", timeout: 12000 });
          await sleep(500);
          email = await page.evaluate(() => {
            const mailLink = document.querySelector('a[href^="mailto:"]');
            if (mailLink) return mailLink.href.replace("mailto:", "").split("?")[0].trim();
            const text = document.body ? document.body.innerText : "";
            const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            return m ? m[0] : "";
          });
        }
      } catch (_) {}
    }
    return email || "";
  } catch {
    return "";
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ── Job store ──────────────────────────────────────────────────────────────────
// In-memory. A job keeps running on the server regardless of whether any
// browser/client is connected — the client just polls for progress and can
// disconnect/reconnect (or switch apps) freely without affecting the job.
const jobs = new Map();

function newJob(params) {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: "running", // running | done | error
    params,
    logs: [],       // { msg, ts }
    results: [],    // listing objects
    progress: { zonesDone: 0, zonesTotal: 0, uniqueTotal: 0, detailsDone: 0, detailsTotal: 0 },
    error: null,
    cancelled: false,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}
function jlog(job, msg) { job.logs.push({ msg, ts: Date.now() }); }

// Clean up old jobs after 2 hours to avoid unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
}, 15 * 60 * 1000);

async function runScrapeJob(job) {
  const { searchTerm, location, density, maxResults, fetchDetails } = job.params;
  let browser;
  try {
    const preset = DENSITY_PRESETS[density] || DENSITY_PRESETS.standard;
    let gridPoints = [{ lat: null, lon: null }];
    let zoom = null;

    if (location) {
      jlog(job, `📍 Locating "${location}"…`);
      try {
        const geo = await geocodeLocation(location);
        const grid = buildGrid(geo.bbox, preset.targetPoints);
        gridPoints = grid.points;
        zoom = grid.zoom;
        jlog(job, `✅ Found: ${geo.displayName} (~${Math.round(geo.area).toLocaleString()} km²)`);
        jlog(job, `🗺️ Covering the area with ${gridPoints.length} search zones (~${grid.stepKm.toFixed(1)}km spacing, zoom ${zoom}z).`);
      } catch (e) {
        jlog(job, `⚠️ Couldn't geocode "${location}" (${e.message}). Falling back to a single search.`);
      }
    } else {
      jlog(job, `⚠️ No location given — running a single search (capped at ~120 results).`);
    }
    job.progress.zonesTotal = gridPoints.length;

    jlog(job, `🚀 Launching browser…`);
    const { browser: b, context } = await launchBrowser();
    browser = b;
    const page = await context.newPage();

    const seen = new Map();
    let consentHandled = false;
    const cellCap = 130;

    for (let i = 0; i < gridPoints.length; i++) {
      if (job.cancelled) { jlog(job, `🛑 Cancelled — stopping.`); break; }
      if (seen.size >= maxResults) { jlog(job, `🎯 Reached target of ${maxResults} — stopping early.`); break; }

      const { lat, lon } = gridPoints[i];
      const searchUrl = lat != null
        ? `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}/@${lat},${lon},${zoom}z`
        : `https://www.google.com/maps/search/${encodeURIComponent(searchTerm + (location ? " in " + location : ""))}`;

      try {
        await gotoWithRetry(page, searchUrl);
        await sleep(1500);
        if (!consentHandled) { await dismissDialogs(page); consentHandled = true; await sleep(800); }

        const listings = await deepScroll(page, cellCap);
        let added = 0;
        for (const l of listings) {
          const key = placeKey(l);
          if (!seen.has(key)) { seen.set(key, l); added++; }
        }
        job.progress.zonesDone = i + 1;
        job.progress.uniqueTotal = seen.size;
        jlog(job, `   🔎 Zone ${i + 1}/${gridPoints.length}: ${listings.length} found, ${added} new · total unique: ${seen.size}`);
      } catch (e) {
        job.progress.zonesDone = i + 1;
        jlog(job, `   ⚠️ Zone ${i + 1}/${gridPoints.length} failed (${e.message}) — skipping.`);
      }
      await sleep(500 + Math.random() * 500);
    }

    const allListings = Array.from(seen.values());
    jlog(job, `✅ Coverage complete — ${allListings.length} unique listings found.`);

    if (allListings.length === 0) {
      jlog(job, `⚠️ No results. Google may have shown a CAPTCHA, or the search returned nothing.`);
      job.status = "done";
      await notifyAll({ title: "LeadHunter Pro", body: `Search finished — 0 leads found for "${searchTerm}".`, jobId: job.id });
      return;
    }

    if (fetchDetails && !job.cancelled) {
      jlog(job, `📞 Fetching phone, website & email for ${allListings.length} places…`);
      job.progress.detailsTotal = allListings.length;
      let withPhone = 0, withWebsite = 0, withEmail = 0;

      for (let i = 0; i < allListings.length; i++) {
        if (job.cancelled) { jlog(job, `🛑 Cancelled — stopping contact lookups.`); break; }
        const listing = allListings[i];
        let phone = "", website = "", email = "";
        try {
          const d = await getPlacePhone(page, listing.mapsUrl);
          phone = d.phone || "";
          website = d.website || "";
        } catch (_) {}
        if (website) {
          try { email = await getEmailFromWebsite(context, website); } catch (_) {}
        }
        if (phone) withPhone++;
        if (website) withWebsite++;
        if (email) withEmail++;
        job.results.push({
          name: listing.name, address: listing.address, category: listing.category,
          phone, whatsapp: phoneToWA(phone), website, email, mapsUrl: listing.mapsUrl,
        });
        job.progress.detailsDone = i + 1;
        if ((i + 1) % 25 === 0) jlog(job, `   📋 ${i + 1}/${allListings.length} · ${withPhone} phones · ${withWebsite} websites · ${withEmail} emails`);
        await sleep(300);
      }
      jlog(job, `✅ Done — ${allListings.length} total · ${withPhone} with phone · ${withWebsite} with website · ${withEmail} with email`);
    } else {
      job.results.push(...allListings.map(l => ({ ...l, phone: "", whatsapp: "", website: "", email: "" })));
    }

    job.status = "done";
    await notifyAll({
      title: "LeadHunter Pro — Results Ready 🎯",
      body: `${job.results.length} leads found for "${searchTerm}"${location ? " in " + location : ""}.`,
      jobId: job.id,
    });

  } catch (err) {
    const shortMsg = (err.message || String(err)).split("\n")[0].slice(0, 250);
    job.status = "error";
    job.error = shortMsg;
    console.error("Job failed — full detail:\n", err.message);
    jlog(job, `❌ Error: ${shortMsg}`);
    await notifyAll({ title: "LeadHunter Pro", body: `Search failed: ${shortMsg}`, jobId: job.id });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── API: start a job, poll its status ─────────────────────────────────────────
app.post("/scrape/start", (req, res) => {
  let { query = "", searchTerm = "", location = "", maxResults = 5000, fetchDetails = true, density = "standard" } = req.body;

  if ((!searchTerm || !location) && query) {
    const m = query.match(/^(.+?)\s+(?:in|near|around)\s+(.+)$/i);
    if (m) { searchTerm = searchTerm || m[1].trim(); location = location || m[2].trim(); }
    else { searchTerm = searchTerm || query; }
  }
  if (!searchTerm) return res.status(400).json({ error: "searchTerm (or query) is required" });

  const job = newJob({ searchTerm, location, density, maxResults, fetchDetails });
  runScrapeJob(job); // fire-and-forget — keeps running even if nobody polls it
  res.json({ jobId: job.id });
});

app.get("/scrape/status/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });

  const sinceLog = parseInt(req.query.sinceLog || "0", 10);
  const sinceResult = parseInt(req.query.sinceResult || "0", 10);

  res.json({
    status: job.status,
    error: job.error,
    progress: job.progress,
    newLogs: job.logs.slice(sinceLog).map(l => l.msg),
    logCount: job.logs.length,
    newResults: job.results.slice(sinceResult),
    resultCount: job.results.length,
  });
});

app.post("/scrape/cancel/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (job && job.status === "running") job.cancelled = true;
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`LeadHunter server on port ${PORT}`));
