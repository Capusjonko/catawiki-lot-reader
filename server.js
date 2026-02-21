// server.js
// Catawiki lot reader (best-effort) with:
// - Bearer token auth (API_KEY env var)
// - Robust-ish shipping extraction (handles lines like "€ 17 vanuit Italië, levertijd 6–12 dagen")
// - Image filtering to avoid expert/avatar/UI images

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

  // Support €, $, £
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
  const u = url.toLowerCase();

  // Common Catawiki media domains/patterns; keep broad but avoid svg/icons
  const isHttp = /^https?:\/\//i.test(url);
  if (!isHttp) return false;
  if (u.endsWith(".svg")) return false;

  // Positive signals
  const positive =
    u.includes("media.catawiki") ||
    u.includes("catawiki") && (u.includes("/image/") || u.includes("/lot/"));

  // Negative signals (avatars, icons, logos)
  const negative =
    u.includes("avatar") ||
    u.includes("profile") ||
    u.includes("icon") ||
    u.includes("logo") ||
    u.includes("trustpilot") ||
    u.includes("payment") ||
    u.includes("badge");

  return positive && !negative;
}

function extractImages($) {
  const images = [];

  // OG image is often the main lot image
  const og = $('meta[property="og:image"]').attr("content");
  if (looksLikeLotImageUrl(og)) images.push(og);

  // Collect images that look like lot media
  $("img").each((_, img) => {
    const $img = $(img);
    const src =
      $img.attr("src") || $img.attr("data-src") || $img.attr("data-lazy-src");
    if (looksLikeLotImageUrl(src)) images.push(src);
  });

  return uniq(images);
}

/**
 * Robust-ish shipping extraction that can catch:
 * "€ 17 vanuit Italië, levertijd 6–12 dagen"
 * It searches line-by-line for:
 * - a € amount
 * - and shipping context words near it
 *
 * Note: It’s still best-effort and does NOT guess if nothing matches.
 */
function extractShippingFromText(bodyTextRaw) {
  const bodyText = (bodyTextRaw || "")
    .replace(/\u00a0/g, " ") // NBSP
    .replace(/\s+/g, " ")
    .trim();

  if (!bodyText) {
    return { currency: null, costs: [], warning: "Empty body text" };
  }

  // Try to preserve “line-like” separators by also splitting on common punctuation boundaries.
  // We do a simple split to get smaller chunks, increasing match chances.
  const chunks = uniq(
    bodyText
      .split(/[\n\r]+|•|\|/g)
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const ctxRe =
    /(\bverzend|\bverzending\b|\bbezorg|\blevertijd\b|\bdagen\b|\bvanuit\b|\bshipping\b|\bdelivery\b|\bdays\b|\bfrom\b)/i;

  const candidates = [];

  for (const chunk of chunks) {
    const moneyMatch = chunk.match(/€\s?[\d.,]+/);
    if (!moneyMatch) continue;

    // must have some shipping-ish context in same chunk
    if (!ctxRe.test(chunk)) continue;

    const pm = parseMoney(moneyMatch[0]);
    if (pm.currency !== "EUR" || pm.amount == null) continue;

    candidates.push({
      destination: chunk,
      amount: pm.amount,
      amount_text: pm.amount_text,
    });
  }

  if (candidates.length === 0) {
    // Fallback: scan the entire text for a pattern "... €xx ... vanuit/levertijd ..."
    const fallback = bodyText.match(
      /(€\s?[\d.,]+).{0,80}(\bvanuit\b|\blevertijd\b|\bdagen\b|\bverzend|\bshipping\b|\bdelivery\b|\bfrom\b)/i
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
          warning: "Shipping detected via fallback pattern; verify against UI if critical.",
        };
      }
    }

    return { currency: null, costs: [], warning: "Shipping not detected" };
  }

  // If multiple candidates, choose lowest conservatively and warn.
  candidates.sort((a, b) => a.amount - b.amount);
  const chosen = candidates[0];

  return {
    currency: "EUR",
    costs: [chosen],
    warning:
      candidates.length > 1
        ? "Multiple shipping-like lines found; chose lowest amount conservatively."
        : null,
  };
}

function bestEffortParse($) {
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

  // Current bid (best-effort, keyword based)
  const bodyFlat = (bodyTextRaw || "").replace(/\s+/g, " ").trim();
  const currentBidMatch = bodyFlat.match(
    /(Current bid|Huidig bod|Bid now|Bied nu).{0,120}(€\s?[\d.,]+)/i
  );
  const current_bid = currentBidMatch
    ? parseMoney(currentBidMatch[2])
    : { currency: null, amount: null, amount_text: null };

  // Estimate (best-effort)
  const estimateMatch = bodyFlat.match(
    /(Estimated value|Geschatte waarde).{0,160}(€\s?[\d.,]+)\s?[-–]\s?(€\s?[\d.,]+)/i
  );
  const estimate = estimateMatch
    ? {
        currency: "EUR",
        low: parseMoney(estimateMatch[2]).amount,
        high: parseMoney(estimateMatch[3]).amount,
        text: `${estimateMatch[2]} - ${estimateMatch[3]}`,
      }
    : { currency: null, low: null, high: null, text: null };

  // Shipping (robust-ish)
  const shippingParsed = extractShippingFromText(bodyTextRaw);
  const shipping = { currency: shippingParsed.currency, costs: shippingParsed.costs };

  // Images (filtered)
  const image_urls = extractImages($);

  const warnings = [];
  if (shipping.costs.length === 0) {
    warnings.push(
      "Shipping costs not confidently detected; ask user for screenshot of shipping costs section."
    );
  }
  if (shippingParsed.warning) warnings.push(shippingParsed.warning);
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
