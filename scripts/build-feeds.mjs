import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Parser from "rss-parser";

const ROOT = process.cwd();
const FEEDS_PATH = path.join(ROOT, "feeds.json");
const OUT_PATH = path.join(ROOT, "output", "dj-news.json");

// How many items to publish in the json (your page can show 12 and paginate).
const MAX_ITEMS = 200;

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

function normalizeUrl(u = "") {
  try {
    return new URL(u).toString();
  } catch {
    return (u || "").trim();
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

async function fetchXml(url) {
  // Some feeds block “unknown” clients. These headers help.
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
    throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}${body ? `: ${body.slice(0, 160)}` : ""}`);
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

        const categories = pickCategories(it);
        const image = pickImage(it);
        const excerpt = pickExcerpt(it);

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
      console.error(`Error parsing ${feed.name}:`, e?.message || e);
    }
  }

  // Dedupe by link
  const byLink = new Map();
  for (const it of items) {
    if (!byLink.has(it.link)) byLink.set(it.link, it);
  }

  const merged = Array.from(byLink.values())
    .sort((a, b) => (b.publishedTs || 0) - (a.publishedTs || 0))
    .slice(0, MAX_ITEMS);

  const payload = {
    generatedAt: new Date().toISOString(),
    total: merged.length,
    sources: feeds,
    errors,
    items: merged
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Wrote ${merged.length} items to ${OUT_PATH}`);
  if (errors.length) {
    console.log(`Completed with ${errors.length} source error(s). See payload.errors.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

