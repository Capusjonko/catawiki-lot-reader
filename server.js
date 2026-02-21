// server.js
// Catawiki lot reader (best-effort) with:
// - Bearer token auth (API_KEY env var)
// - Image filtering to avoid expert/avatar/UI images
// - Improved image extraction (img/srcset/source + raw HTML scan)
//
// Note: Shipping extraction removed (unreliable). Shipping is returned as { currency: null, costs: [] }.

import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json({ limit: "1mb" }));

// =====================
// Auth (Bearer token)
// =====================
const API_KEY = process.env.API_KEY;

app.use((req, res, next) => {
  const auth = req.headers.authorization || "";

  if (!API_KEY) {
    return res
      .status(500)
      .json({ ok: false, error: "Server misconfigured: API_KEY missing" });
  }

  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Missing Bearer token" });
  }

  const token = auth.slice("Bearer ".length).trim();
  if (token !== API_KEY) {
    return res.status(403).json({ ok: false, error: "Invalid API key" });
  }

  next();
});

// =====================
// Helpers
// =====================
function isLikelyCatawikiLotUrl(url) {
  try {
    const u = new URL(url);
    return (
      /catawiki\./i.test(u.hostname) &&
      /\/l\/|\/lot\/|\/lots\//i.test(u.pathname)
    );
  } catch {
    return false;
  }
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function textOrNull($el) {
  if (!$el || $el.length === 0) return null;
  const t = $el.text().replace(/\s+/g, " ").trim();
  return t || null;
}

function parseMoney(text) {
  // Returns { currency, amount, amount_text }
  if (!text) return { currency: null, amount: null, amount_text: null };
  const t = String(text).replace(/\s+/g, " ").trim();

  const m = t.match(/(€|\$|£)\s?([\d.,]+)/);
  if (!m) return { currency: null, amount: null, amount_text: t };

  const currency = m[1] === "€" ? "EUR" : m[1] === "$" ? "USD" : "GBP";
  const raw = m[2];

  // normalize "1.234,56" -> 1234.56 ; "1,234.56" -> 1234.56
  const normalized =
    raw.includes(",") && raw.lastIndexOf(",") > raw.lastIndexOf(".")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, "");

  const amount = Number(normalized);
  return {
    currency,
    amount: Number.isFinite(amount) ? amount : null,
    amount_text: `${m[1]} ${raw}`.trim(),
  };
}

// Prefer only "lot-like" images, not avatars/icons.
function looksLikeLotImageUrl(url) {
  if (!url) return false;
  const lower = String(url).toLowerCase();

  // Must be absolute http(s)
  if (!/^https?:\/\//i.test(lower)) return false;
  if (lower.endsWith(".svg")) return false;

  // Negative signals
  const negative =
    lower.includes("avatar") ||
    lower.includes("profile") ||
    lower.includes("icon") ||
    lower.includes("logo") ||
    lower.includes("trustpilot") ||
    lower.includes("payment") ||
    lower.includes("badge");

  if (negative) return false;

  // Positive signals (broader than before)
  // Catawiki lot images commonly appear on assets/media/images.*
  const positive =
    lower.includes("assets.catawiki") ||
    lower.includes("media.catawiki") ||
    lower.includes("images.catawiki") ||
    lower.includes("catawiki.");

  return positive;
}

function extractUrlsFromSrcset(srcset) {
  if (!srcset) return [];
  // "url1 320w, url2 640w" -> ["url1", "url2"]
  return String(srcset)
    .split(",")
    .map((s) => s.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function extractImagesFromRawHtml(html) {
  // Some lot gallery URLs are embedded in scripts/data and not present as <img>.
  // Best-effort: scan the raw HTML for known CDN image URLs.
  const out = [];
  if (!html) return out;

  // Matches e.g. https://assets.catawiki.com/image/...jpg@webp
  const re =
    /https?:\/\/assets\.catawiki\.com\/image\/[^"'\\\s]+?\.(?:jpg|jpeg|png)(?:%40webp|@webp)?/gi;

  const hits = html.match(re) || [];
  for (const u of hits) {
    if (looksLikeLotImageUrl(u)) out.push(u);
  }
  return uniq(out);
}

function extractImages($) {
  const images = [];

  // OpenGraph image is often the main lot image
  const og = $('meta[property="og:image"]').attr("content");
  if (looksLikeLotImageUrl(og)) images.push(og);

  // Collect images that look like lot media
  $("img").each((_, img) => {
    const $img = $(img);

    const candidates = [
      $img.attr("src"),
      $img.attr("data-src"),
      $img.attr("data-lazy-src"),
      ...extractUrlsFromSrcset($img.attr("srcset")),
      ...extractUrlsFromSrcset($img.attr("data-srcset")),
    ];

    for (const u of candidates) {
      if (looksLikeLotImageUrl(u)) images.push(u);
    }
  });

  // <picture><source srcset=...>
  $("source").each((_, s) => {
    const $s = $(s);
    const candidates = [
      ...extractUrlsFromSrcset($s.attr("srcset")),
      ...extractUrlsFromSrcset($s.attr("data-srcset")),
    ];

    for (const u of candidates) {
      if (looksLikeLotImageUrl(u)) images.push(u);
    }
  });

  return uniq(images);
}

function bestEffortParse($) {
  // Title
  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    textOrNull($("h1").first()) ||
    null;

  // Subtitle / short description
  const subtitle =
    $('meta[property="og:description"]').attr("content")?.trim() ||
    $('meta[name="description"]').attr("content")?.trim() ||
    null;

  // Best-effort longer description: try common description containers, else null
  const description_text =
    textOrNull($('[data-testid*="description"], [class*="description"]').first()) ||
    null;

  // End time (best-effort)
  const end_time_iso =
    $('meta[property="product:expiration_time"]').attr("content")?.trim() ||
    $('meta[property="og:updated_time"]').attr("content")?.trim() ||
    null;

  // Current bid (best-effort, keyword based)
  const bodyFlat = ($("body").text() || "").replace(/\s+/g, " ").trim();
  const currentBidMatch = bodyFlat.match(
    /(Current bid|Huidig bod|Bid now|Bied nu).{0,140}(€\s?[\d.,]+)/i
  );
  const current_bid = currentBidMatch
    ? parseMoney(currentBidMatch[2])
    : { currency: null, amount: null, amount_text: null };

  // Estimate (best-effort)
  const estimateMatch = bodyFlat.match(
    /(Estimated value|Geschatte waarde).{0,200}(€\s?[\d.,]+)\s?[-–]\s?(€\s?[\d.,]+)/i
  );
  const estimate = estimateMatch
    ? {
        currency: "EUR",
        low: parseMoney(estimateMatch[2]).amount,
        high: parseMoney(estimateMatch[3]).amount,
        text: `${estimateMatch[2]} - ${estimateMatch[3]}`,
      }
    : { currency: null, low: null, high: null, text: null };

  // Shipping intentionally disabled
  const shipping = { currency: null, costs: [] };

  // Images (filtered)
  const image_urls = extractImages($);

  const warnings = [];
  if (image_urls.length === 0) {
    warnings.push("No lot image URLs detected; ask user to upload photos.");
  }

  return {
    title,
    subtitle,
    description_text,
    category: null,
    seller_location: null,
    shipping,
    current_bid,
    estimate,
    end_time_iso,
    image_urls,
    warnings,
  };
}

// =====================
// Endpoint
// =====================
app.post("/v1/catawiki/lot", async (req, res) => {
  try {
    const { url } = req.body || {};

    if (!url || typeof url !== "string") {
      return res.status(400).json({ ok: false, error: "Missing url" });
    }

    if (!isLikelyCatawikiLotUrl(url)) {
      return res
        .status(400)
        .json({ ok: false, error: "URL does not look like a Catawiki lot URL" });
    }

    const r = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LotReader/1.1)",
        accept: "text/html,application/xhtml+xml",
      },
    });

    if (!r.ok) {
      return res
        .status(500)
        .json({ ok: false, error: `Fetch failed with status ${r.status}` });
    }

    const html = await r.text();
    const $ = cheerio.load(html);
    const parsed = bestEffortParse($);

    // Extra: scan raw HTML for image URLs embedded in scripts/data
    const rawImages = extractImagesFromRawHtml(html);

    const mergedImages = uniq([...(parsed.image_urls || []), ...rawImages]);
    parsed.image_urls = mergedImages;

    // Optional warning if still low
    if (parsed.image_urls.length < 6) {
      parsed.warnings = uniq([...(parsed.warnings || []), "Only a few images found; gallery may be JS-loaded."]);
    }

    return res.json({
      ok: true,
      url,
      fetched_at_iso: new Date().toISOString(),
      ...parsed,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "Unknown error" });
  }
});

// =====================
// Listen
// =====================
const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Lot reader listening on :${port}`));
