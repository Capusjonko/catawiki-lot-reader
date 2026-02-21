// server.js
// Catawiki lot reader (best-effort) with:
// - Bearer token auth (API_KEY env var)
// - Better shipping extraction using BOTH rendered body text and HTML-derived lines
// - Lot-image filtering (avoids expert/avatar/UI images)
// - Optional debug output (set DEBUG=1)

import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json({ limit: "1mb" }));

// =====================
// Auth (Bearer token)
// =====================
const API_KEY = process.env.API_KEY;
const DEBUG = process.env.DEBUG === "1";

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
  const token = auth.replace("Bearer ", "").trim();
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
  const t = text.replace(/\s+/g, " ").trim();

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

// =====================
// Image extraction (filter out expert/profile/UI images)
// =====================
function looksLikeLotImageUrl(url) {
  if (!url) return false;
  const isHttp = /^https?:\/\//i.test(url);
  if (!isHttp) return false;

  const u = url.toLowerCase();
  if (u.endsWith(".svg")) return false;

  // Positive signals (keep broad)
  const positive =
    u.includes("media.catawiki") ||
    (u.includes("catawiki") && (u.includes("/image/") || u.includes("/lot/")));

  // Negative signals (avatars, icons, logos etc.)
  const negative =
    u.includes("avatar") ||
    u.includes("profile") ||
    u.includes("icon") ||
    u.includes("logo") ||
    u.includes("badge") ||
    u.includes("payment") ||
    u.includes("trustpilot") ||
    u.includes("expert");

  return positive && !negative;
}

function extractImages($) {
  const images = [];

  // OG image is often the main lot image
  const og = $('meta[property="og:image"]').attr("content");
  if (looksLikeLotImageUrl(og)) images.push(og);

  $("img").each((_, img) => {
    const $img = $(img);
    const src =
      $img.attr("src") || $img.attr("data-src") || $img.attr("data-lazy-src");
    if (looksLikeLotImageUrl(src)) images.push(src);
  });

  return uniq(images);
}

// =====================
// Shipping extraction (better)
// =====================
function htmlToTextLines(html) {
  // Convert HTML into line-ish text to preserve some block boundaries
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(div|p|li|br|tr|td|th|section|article|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ");
}

function extractShippingBestEffort(html, bodyTextRaw) {
  // Context words that often appear near shipping in NL/EN
  const ctxRe =
    /(\bvanuit\b|\blevertijd\b|\bdagen\b|\bbezorg\b|\bverzend|\bverzending\b|\bshipping\b|\bdelivery\b|\bdays\b|\bfrom\b)/i;

  // Two sources:
  // - raw body text (cheerio text)
  // - HTML-derived "line text" (often keeps more structure)
  const srcs = [
    (bodyTextRaw || "").replace(/\u00a0/g, " "),
    htmlToTextLines(html),
  ];

  const candidates = [];

  for (const src of srcs) {
    const lines = src
      .split(/\n+/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (const line of lines) {
      // must contain a € amount
      const moneyMatch = line.match(/€\s?[\d.,]+/);
      if (!moneyMatch) continue;

      // must contain shipping-ish context
      if (!ctxRe.test(line)) continue;

      const pm = parseMoney(moneyMatch[0]);
      if (pm.currency === "EUR" && pm.amount != null) {
        candidates.push({
          destination: line,
          amount: pm.amount,
          amount_text: pm.amount_text,
        });
      }
    }
  }

  // If still nothing, do a fallback "window" scan on the whole HTML-derived text:
  if (candidates.length === 0) {
    const big = htmlToTextLines(html).replace(/\s+/g, " ").trim();
    const fallback = big.match(
      /(€\s?[\d.,]+).{0,120}(\bvanuit\b|\blevertijd\b|\bdagen\b|\bverzend|\bshipping\b|\bdelivery\b|\bfrom\b)/i
    );
    if (fallback) {
      const pm = parseMoney(fallback[1]);
      if (pm.currency === "EUR" && pm.amount != null) {
        return {
          currency: "EUR",
          costs: [
            {
              destination: "Detected via fallback pattern",
              amount: pm.amount,
              amount_text: pm.amount_text,
            },
          ],
          warning:
            "Shipping detected via fallback pattern; verify if multiple destinations exist.",
          debug_candidates: DEBUG ? [] : undefined,
        };
      }
    }

    return {
      currency: null,
      costs: [],
      warning: "Shipping not detected",
      debug_candidates: DEBUG ? [] : undefined,
    };
  }

  // Choose lowest amount conservatively if multiple matches
  candidates.sort((a, b) => a.amount - b.amount);
  const chosen = candidates[0];

  return {
    currency: "EUR",
    costs: [chosen],
    warning:
      candidates.length > 1
        ? "Multiple shipping-like lines found; chose lowest amount conservatively."
        : null,
    debug_candidates: DEBUG ? candidates.slice(0, 8) : undefined,
  };
}

// =====================
// Main parse
// =====================
function bestEffortParse($, html) {
  const title =
    textOrNull($("h1")) ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    null;

  const subtitle = textOrNull($("h2")) || null;

  const description_text =
    textOrNull($('[data-testid="lot-description"]')) ||
    textOrNull($(".lot-description")) ||
    null;

  const end_time_iso =
    $('meta[property="product:availability:end_date"]').attr("content")?.trim() ||
    $('meta[property="og:updated_time"]').attr("content")?.trim() ||
    null;

  const bodyTextRaw = $("body").text();
  const bodyFlat = (bodyTextRaw || "").replace(/\s+/g, " ").trim();

  // Current bid (keyword-based)
  const currentBidMatch = bodyFlat.match(
    /(Current bid|Huidig bod|Bid now|Bied nu).{0,160}(€\s?[\d.,]+)/i
  );
  const current_bid = currentBidMatch
    ? parseMoney(currentBidMatch[2])
    : { currency: null, amount: null, amount_text: null };

  // Estimate (keyword-based)
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

  // Shipping (improved)
  const shippingParsed = extractShippingBestEffort(html, bodyTextRaw);
  const shipping = {
    currency: shippingParsed.currency,
    costs: shippingParsed.costs,
  };

  // Images
  const image_urls = extractImages($);

  // Warnings
  const warnings = [];
  if (shipping.costs.length === 0) {
    warnings.push(
      "Shipping costs not confidently detected; ask user for screenshot of shipping section."
    );
  }
  if (shippingParsed.warning) warnings.push(shippingParsed.warning);
  if (image_urls.length === 0) {
    warnings.push("No lot image URLs detected; ask user to upload photos.");
  }

  const result = {
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

  if (DEBUG) {
    result.debug = {
      shipping_candidates: shippingParsed.debug_candidates || [],
    };
  }

  return result;
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
        "user-agent": "Mozilla/5.0 (compatible; LotReader/1.2)",
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
    const parsed = bestEffortParse($, html);

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
