import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Parser from "rss-parser";

const ROOT = process.cwd();
const FEEDS_PATH = path.join(ROOT, "feeds.json");
const OUT_PATH = path.join(ROOT, "output", "dj-news.json");

// Publish up to this many items in the json
const MAX_ITEMS = 200;

// Only scrape pages (og:image / published_time) for this many newest items
// Keeps the workflow fast and avoids hammering sites.
const ENRICH_LIMIT = 120;

// Max concurrent page fetches for enrichment
const ENRICH_CONCURRENCY = 4;

// Per-page fetch timeout (ms)
const FETCH_TIMEOUT = 9000;

const parser = new Parser({
  customFields: {
    item: [
      ["media:content", "mediaContent"],
      ["media:thumbnail", "mediaThumbnail"],
      ["content:encoded", "contentEncoded"],
      ["enclosure", "enclosure"],
      ["dc:creator", "dcCreator"],
      ["category", "category"]
    ]
  }
});

function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function stripHtml(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstImageFromHtml(html = "") {
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m?.[1] || "";
}

function decodeUrlEntities(u = "") {
  // Feeds often html-escape query params (&amp; / &#038;)
  return String(u)
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/&#x26;/gi, "&");
}

function normalizeUrl(u = "") {
  const cleaned = decodeUrlEntities((u || "").trim());
  try {
    return new URL(cleaned).toString();
  } catch {
    return cleaned;
  }
}

function toTimestamp(dateStr) {
  const t = Date.parse(dateStr || "");
  return Number.isFinite(t) ? t : 0;
}

function pickCategories(item) {
  const raw = item?.categories || item?.category || [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((c) => String(c || "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

function isJunkImage(url = "") {
  const u = String(url || "").toLowerCase();
  // Common junk: wordpress emoji images showing up as “thumbnail”
  if (u.includes("s.w.org/images/core/emoji")) return true;
  // You can add more patterns here if you see other “fake thumbnails”
  return false;
}

function pickImage(item) {
  // 1) media:content
  if (item?.mediaContent?.$?.url) return normalizeUrl(item.mediaContent.$.url);
  if (typeof item?.mediaContent?.url === "string") return normalizeUrl(item.mediaContent.url);

  // 2) media:thumbnail
  if (item?.mediaThumbnail?.$?.url) return normalizeUrl(item.mediaThumbnail.$.url);
  if (typeof item?.mediaThumbnail?.url === "string") return normalizeUrl(item.mediaThumbnail.url);

  // 3) enclosure
  if (item?.enclosure?.url) return normalizeUrl(item.enclosure.url);

  // 4) first <img> in content html
  const html =
    item?.contentEncoded ||
    item?.["content:encoded"] ||
    item?.content ||
    item?.summary ||
    "";
  const img = firstImageFromHtml(html);
  if (img) return normalizeUrl(img);

  return "";
}

function pickExcerpt(item) {
  const html =
    item?.contentEncoded ||
    item?.["content:encoded"] ||
    item?.content ||
    item?.summary ||
    "";
  const text = stripHtml(html);
  if (!text) return "";
  return text.length > 240 ? text.slice(0, 237) + "…" : text;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AlbashNewswireBot/1.0; +https://albash.es)",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractMeta(html, key) {
  // Matches: <meta property="og:image" content="...">
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const m = String(html).match(re);
  return m?.[1] || "";
}

function absolutizeMaybe(relativeOrAbs, pageUrl) {
  const u = normalizeUrl(relativeOrAbs);
  if (!u) return "";
  try {
    return new URL(u, pageUrl).toString();
  } catch {
    return u;
  }
}

async function enrichOne(item) {
  // Only enrich if we need something
  const needsImage = !item.image || isJunkImage(item.image);
  const needsDate = !item.publishedTs || item.publishedTs === 0;

  if (!needsImage && !needsDate) return item;

  try {
    const html = await fetchText(item.link);

    // Image enrichment
    if (needsImage) {
      const og =
        extractMeta(html, "og:image") ||
        extractMeta(html, "og:image:url") ||
        extractMeta(html, "twitter:image") ||
        extractMeta(html, "twitter:image:src");

      const img = absolutizeMaybe(og, item.link);
      if (img && !isJunkImage(img)) item.image = img;
    }

    // Date enrichment
    if (needsDate) {
      const ptime =
        extractMeta(html, "article:published_time") ||
        extractMeta(html, "og:updated_time") ||
        extractMeta(html, "article:modified_time");

      const ts = toTimestamp(ptime);
      if (ts) {
        item.published = ptime;
        item.publishedTs = ts;
      }
    }
  } catch {
    // Silent fail: keep original item
  }

  return item;
}

async function asyncPool(limit, arr, fn) {
  const ret = [];
  const executing = [];

  for (const item of arr) {
    const p = Promise.resolve().then(() => fn(item));
    ret.push(p);

    if (limit <= arr.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) await Promise.race(executing);
    }
  }

  return Promise.all(ret);
}

async function fetchXml(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; AlbashNewswireBot/1.0; +https://albash.es)",
      "Accept":
        "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Fetch failed ${res.status} ${res.statusText} for ${url}${
        body ? `: ${body.slice(0, 160)}` : ""
      }`
    );
  }

  return res.text();
}

async function parseFeedFromUrl(url) {
  const xml = await fetchXml(url);
  return parser.parseString(xml);
}

async function main() {
  const feeds = JSON.parse(await fs.readFile(FEEDS_PATH, "utf8"));
  const items = [];
  const errors = [];

  for (const feed of feeds) {
    try {
      const parsed = await parseFeedFromUrl(feed.url);

      for (const it of parsed.items || []) {
        const link = normalizeUrl(it.link || it.guid || "");
        if (!link) continue;

        const title = String(it.title || "").trim();
        const published = it.isoDate || it.pubDate || it.published || "";
        const publishedTs = toTimestamp(published);

        let image = pickImage(it);
        if (isJunkImage(image)) image = "";

        const categories = pickCategories(it);
        const excerpt = pickExcerpt(it);
if (feed.id === "mondosonoro") {
  const hasDiscosCategory = categories.some(c => c.toLowerCase() === "discos");
  if (!hasDiscosCategory) continue;
}

        items.push({
          id: sha1(`${feed.id}|${link}`),
          title,
          link,
          published,
          publishedTs,
          sourceId: feed.id,
          sourceName: feed.name,
          categories,
          image,
          excerpt
        });
      }
    } catch (e) {
      errors.push({
        sourceId: feed.id,
        sourceName: feed.name,
        url: feed.url,
        error: String(e?.message || e)
      });
    }
  }

  // Dedupe by link
  const byLink = new Map();
  for (const it of items) {
    if (!byLink.has(it.link)) byLink.set(it.link, it);
  }

  // Sort before enrichment so we enrich the newest items
  let merged = Array.from(byLink.values()).sort(
    (a, b) => (b.publishedTs || 0) - (a.publishedTs || 0)
  );

  const toEnrich = merged.slice(0, ENRICH_LIMIT);
  const rest = merged.slice(ENRICH_LIMIT);

  const enriched = await asyncPool(ENRICH_CONCURRENCY, toEnrich, enrichOne);

  // Re-sort after enrichment (helps sources like Mixmag where feed date is missing)
  merged = enriched.concat(rest).sort(
    (a, b) => (b.publishedTs || 0) - (a.publishedTs || 0)
  );

  merged = merged.slice(0, MAX_ITEMS);

  const payload = {
    generatedAt: new Date().toISOString(),
    total: merged.length,
    sources: feeds,
    errors,
    items: merged
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
