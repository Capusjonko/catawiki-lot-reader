import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== Auth (Bearer token) =====
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  const auth = req.headers.authorization || "";
  if (!API_KEY) return res.status(500).json({ ok: false, error: "Server misconfigured: API_KEY missing" });
  if (!auth.startsWith("Bearer ")) return res.status(401).json({ ok: false, error: "Missing Bearer token" });
  const token = auth.replace("Bearer ", "").trim();
  if (token !== API_KEY) return res.status(403).json({ ok: false, error: "Invalid API key" });
  next();
});

function isLikelyCatawikiLotUrl(url) {
  try {
    const u = new URL(url);
    return /catawiki\./i.test(u.hostname) && /\/l\/|\/lot\/|\/lots\//i.test(u.pathname);
  } catch {
    return false;
  }
}

function parseMoney(text) {
  if (!text) return { currency: null, amount: null, amount_text: null };
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/(€|\$|£)\s?([\d.,]+)/);
  if (!m) return { currency: null, amount: null, amount_text: t };
  const currency = m[1] === "€" ? "EUR" : m[1] === "$" ? "USD" : "GBP";
  const raw = m[2];
  const normalized =
    raw.includes(",") && raw.lastIndexOf(",") > raw.lastIndexOf(".")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, "");
  const amount = Number(normalized);
  return { currency, amount: Number.isFinite(amount) ? amount : null, amount_text: t };
}

const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

function textOrNull($el) {
  if (!$el || $el.length === 0) return null;
  const t = $el.text().replace(/\s+/g, " ").trim();
  return t || null;
}

function extractImages($) {
  const og = $('meta[property="og:image"]').attr("content");
  const imgs = [];
  if (og) imgs.push(og);
  $("img").each((_, img) => {
    const $img = $(img);
    const src = $img.attr("src") || $img.attr("data-src") || $img.attr("data-lazy-src");
    if (src && /^https?:\/\//i.test(src)) imgs.push(src);
  });
  return uniq(imgs);
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

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  const currentBidMatch = bodyText.match(/(Current bid|Huidig bod|Bid now|Bied nu).{0,80}(€\s?[\d.,]+)/i);
  const current_bid = currentBidMatch ? parseMoney(currentBidMatch[2]) : { currency: null, amount: null, amount_text: null };

  const estimateMatch = bodyText.match(/(Estimated value|Geschatte waarde).{0,120}(€\s?[\d.,]+)\s?[-–]\s?(€\s?[\d.,]+)/i);
  const estimate = estimateMatch
    ? { currency: "EUR", low: parseMoney(estimateMatch[2]).amount, high: parseMoney(estimateMatch[3]).amount, text: `${estimateMatch[2]} - ${estimateMatch[3]}` }
    : { currency: null, low: null, high: null, text: null };

  // Shipping: niet gokken. Alleen invullen als we iets concreets kunnen isoleren.
  const shippingCosts = [];
  const shippingBlockMatch = bodyText.match(/(Shipping costs|Verzendkosten).{0,400}/i);
  if (shippingBlockMatch) {
    const money = shippingBlockMatch[0].match(/€\s?[\d.,]+/);
    if (money) {
      const pm = parseMoney(money[0]);
      shippingCosts.push({ destination: null, amount: pm.amount, amount_text: pm.amount_text });
    }
  }

  const shipping = { currency: shippingCosts[0]?.amount != null ? "EUR" : null, costs: shippingCosts };

  const image_urls = extractImages($);
  const warnings = [];
  if (shipping.costs.length === 0) warnings.push("Shipping costs not confidently detected; ask user for screenshot of shipping costs section.");
  if (image_urls.length === 0) warnings.push("No image URLs detected; ask user to upload photos.");

  return { title, subtitle, description_text, category: null, seller_location: null, shipping, current_bid, estimate, end_time_iso, image_urls, warnings };
}

app.post("/v1/catawiki/lot", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string") return res.status(400).json({ ok: false, error: "Missing url" });
    if (!isLikelyCatawikiLotUrl(url)) return res.status(400).json({ ok: false, error: "URL does not look like a Catawiki lot URL" });

    const r = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; LotReader/1.0)",
        "accept": "text/html,application/xhtml+xml"
      }
    });

    if (!r.ok) return res.status(500).json({ ok: false, error: `Fetch failed with status ${r.status}` });

    const html = await r.text();
    const $ = cheerio.load(html);
    const parsed = bestEffortParse($);

    res.json({ ok: true, url, fetched_at_iso: new Date().toISOString(), ...parsed });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Lot reader listening on :${port}`));
