/**
 * game.js  –  テスコデル
 *
 * Daily UK food price guessing game (Japanese yen edition).
 * Products are sourced from products.json (run enrich.py first).
 * Japanese names are translated client-side via MyMemory API and cached
 * in localStorage. Images use the URL from products.json with fallback
 * chains (Open Food Facts → emoji placeholder).
 */

"use strict";

/* ================================================================
   CONFIG
   ================================================================ */
const GAME_EPOCH  = Date.UTC(2026, 0, 1); // 1 Jan 2026 = day 0 (JST)
const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // UTC+9

/* Closeness thresholds (% diff from actual; anything ≥50% = ice) */
const THRESHOLDS = { yellow: 10, orange: 25, red: 49 };

/* ================================================================
   DOM refs
   ================================================================ */
const $  = id => document.getElementById(id);
const loadingSection   = $("loading-section");
const loadingMsg       = $("loading-msg");
const gameSection      = $("game-section");
const productImg       = $("product-img");
const productPlaceholder = $("product-placeholder");
const productNameJa    = $("product-name-ja");
const productNameEn    = $("product-name-en");
const productPriceYen  = $("product-price-yen");
const guessNumEl       = $("guess-num");
const guessesList      = $("guesses-list");
const guessInput       = $("guess-input");
const submitBtn        = $("submit-btn");
const howBtn           = $("how-btn");
const howModal         = $("how-modal");
const howClose         = $("how-close");
const resultModal      = $("result-modal");
const resultTitle      = $("result-title");
const resultMessage    = $("result-message");
const revealImg        = $("reveal-img");
const revealPlaceholder = $("reveal-placeholder");
const revealNameJa     = $("reveal-name-ja");
const revealNameEn     = $("reveal-name-en");
const revealPriceUk    = $("reveal-price-uk");
const revealPriceYen   = $("reveal-price-yen");
const nextInfo         = $("next-info");

/* ================================================================
   STATE
   ================================================================ */
let state = {
  product:    null,   // current product object
  titleJa:    "",     // Japanese translation
  guesses:    [],     // array of { amount, temp, direction }
  gameOver:   false,
  won:        false,
  dateStr:    "",     // "YYYY-M-D"
};

/* ================================================================
   DATE / PRODUCT SELECTION
   ================================================================ */
function todayUTC() {
  // Shift to JST (UTC+9) before extracting the calendar date so the
  // daily rollover happens at midnight Japan time, not midnight UTC.
  const jst   = new Date(Date.now() + JST_OFFSET_MS);
  const dayMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return { dayMs, gameDay: Math.floor((dayMs - GAME_EPOCH) / 86_400_000) };
}

function dateStr(dayMs) {
  const d = new Date(dayMs);
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

function pickProduct(products) {
  const { gameDay } = todayUTC();
  const idx = ((gameDay % products.length) + products.length) % products.length;
  return products[idx];
}

/* ================================================================
   SAVE / LOAD SESSION
   ================================================================ */
function storageKey() {
  const { dayMs } = todayUTC();
  const d = new Date(dayMs);
  return `tescodle_${d.getUTCFullYear()}_${d.getUTCMonth()}_${d.getUTCDate()}`;
}

function saveState() {
  const { guesses, gameOver, won, titleJa } = state;
  localStorage.setItem(storageKey(), JSON.stringify({ guesses, gameOver, won, titleJa }));
}

function loadSavedState() {
  const raw = localStorage.getItem(storageKey());
  if (!raw) return false;
  try {
    const saved = JSON.parse(raw);
    state.guesses  = saved.guesses  || [];
    state.gameOver = saved.gameOver || false;
    state.won      = saved.won      || false;
    state.titleJa  = saved.titleJa  || "";
    return true;
  } catch { return false; }
}

/* ================================================================
   TRANSLATION  (MyMemory free API)
   ================================================================ */
async function translateToJapanese(text) {
  const cacheKey = `tl2_${text}`;
  const cached   = localStorage.getItem(cacheKey);
  if (cached) return cached;

  try {
    const url  = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ja`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error("network");
    const data = await resp.json();
    if (data.responseStatus === 200) {
      const ja = data.responseData.translatedText;
      localStorage.setItem(cacheKey, ja);
      return ja;
    }
  } catch (_) { /* fall through */ }

  return text; // fallback: keep English
}

/* ================================================================
   IMAGE LOADING
   ================================================================ */
function showImagePlaceholder(imgEl, placeholderEl) {
  imgEl.classList.add("hidden");
  placeholderEl.classList.remove("hidden");
}

function loadImage(imgEl, placeholderEl, product) {
  let attempts = 0;
  const urls = buildImageUrls(product);

  function tryNext() {
    if (attempts >= urls.length) {
      showImagePlaceholder(imgEl, placeholderEl);
      return;
    }
    imgEl.src = urls[attempts++];
  }

  imgEl.onload  = () => { placeholderEl.classList.add("hidden"); imgEl.classList.remove("hidden"); };
  imgEl.onerror = () => tryNext();
  tryNext();
}

function buildImageUrls(product) {
  const pid = product.id;
  const urls = [];

  // 1. Locally uploaded image (saved by upload_server.py into /images/)
  //    These are stored as /images/<pid>.jpg|png|webp in products.json
  //    Strip the leading slash to get a relative path that works on GitHub Pages
  //    (/images/x.jpg → images/x.jpg prevents the /tescodle/ subpath being lost)
  if (product.image_url && product.image_url.startsWith("/images/")) {
    urls.push(product.image_url.replace(/^\//, ""));
    return urls; // local image is definitive — no need to try CDN
  }

  // 2. URL stored in products.json (e.g. from fetch_images.py)
  if (product.image_url) urls.push(product.image_url);

  // 3. Alternative Tesco CDN patterns (usually 404, but worth a try)
  urls.push(`https://digitalcontent.api.tesco.com/v2/media/ghs/${pid}/${pid}.jpeg`);
  urls.push(`https://digitalcontent.api.tesco.com/v2/media/ghs/${pid}/hero.jpeg`);

  return urls.filter(Boolean);
}

/**
 * After the synchronous fallback chain fails we try Open Food Facts.
 * Attaches a new src to imgEl if a match is found.
 */
async function tryOpenFoodFacts(imgEl, placeholderEl, title) {
  // Only bother if placeholder is currently showing (image already failed)
  if (placeholderEl.classList.contains("hidden")) return;

  try {
    const q    = encodeURIComponent(title.split(" ").slice(0, 4).join(" "));
    const url  = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&action=process&json=1&page_size=1&fields=image_front_url,image_url`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const data = await resp.json();
    const imgUrl = data?.products?.[0]?.image_front_url || data?.products?.[0]?.image_url;
    if (imgUrl) {
      imgEl.onload  = () => { placeholderEl.classList.add("hidden"); imgEl.classList.remove("hidden"); };
      imgEl.onerror = () => { /* already in placeholder state, leave it */ };
      imgEl.src = imgUrl;
    }
  } catch (_) { /* silent */ }
}

/* ================================================================
   TEMPERATURE LOGIC
   ================================================================ */
function getTemperature(guess, actual) {
  const pct = Math.abs(guess - actual) / actual * 100;
  if (pct <= 5)  return "exact";
  if (pct <= THRESHOLDS.yellow) return "yellow";
  if (pct <= THRESHOLDS.orange) return "orange";
  if (pct <  50)                return "red";
  return "ice";
}

function getDirection(guess, actual) {
  const pct = Math.abs(guess - actual) / actual * 100;
  if (pct <= 5) return "✓";
  return guess < actual ? "▲" : "▼";
}

const TEMP_LABELS = { exact: "ピッタリ！", yellow: "🟡 近い！", orange: "🟠 まあまあ", red: "🔴 遠い", ice: "🧤 かなり遠い" };

/* ================================================================
   RENDERING
   ================================================================ */
function renderGuesses() {
  guessesList.innerHTML = "";
  state.guesses.forEach(g => {
    const li = document.createElement("li");
    li.className = `guess-row ${g.temp}`;
    li.innerHTML = `
      <span class="direction">${g.direction}</span>
      <span class="amount">¥${g.amount.toLocaleString("ja-JP")}</span>
      <span class="temp-badge">${TEMP_LABELS[g.temp]}</span>
    `;
    guessesList.appendChild(li);
  });
  guessNumEl.textContent = state.guesses.length + 1;

  // Scroll to latest guess after paint
  requestAnimationFrame(() => {
    const section = guessesList.parentElement;
    section.scrollTo({ top: section.scrollHeight, behavior: "smooth" });
  });
}

function renderNameJa(text) {
  productNameJa.textContent = text;
  if (productNameEn) productNameEn.textContent = state.product?.title || "";
}

/* ================================================================
   GAME OVER
   ================================================================ */
function endGame() {
  const p       = state.product;
  const priceGbp = p.price_actual.toFixed(2);
  const priceYen = (p.price_yen ?? Math.round(p.price_actual * 196)).toLocaleString("ja-JP");

  // Fill result modal
  resultTitle.textContent   = state.won ? "🎉 正解！" : "😢 残念…";
  resultMessage.textContent = state.won
    ? `${state.guesses.length}回で正解しました！`
    : "正解は…";

  // Image (same fallback logic)
  loadImage(revealImg, revealPlaceholder, p);

  revealNameJa.textContent  = state.titleJa || p.title;
  revealNameEn.textContent  = p.title;
  revealPriceUk.textContent = `英国 Tesco 実売価格: £${priceGbp}`;
  revealPriceYen.textContent = `¥${priceYen}`;

  const { dayMs } = todayUTC();
  const tomorrow  = new Date(dayMs + 86_400_000);
  nextInfo.textContent = `次の商品: ${tomorrow.getUTCFullYear()}年${tomorrow.getUTCMonth()+1}月${tomorrow.getUTCDate()}日`;

  resultModal.classList.remove("hidden");

  // Disable input
  guessInput.disabled = true;
  submitBtn.disabled  = true;

  // Reveal yen price in product card
  if (productPriceYen) {
    productPriceYen.textContent = `¥${priceYen}`;
    productPriceYen.style.opacity = "1";
  }
}

/* ================================================================
   SUBMIT GUESS
   ================================================================ */
function submitGuess() {
  if (state.gameOver) return;

  const raw = guessInput.value.trim();
  if (!raw) return;
  const amount = parseInt(raw, 10);
  if (isNaN(amount) || amount < 1) return;

  const actual    = state.product.price_yen ?? Math.round(state.product.price_actual * 196);
  const temp      = getTemperature(amount, actual);
  const direction = getDirection(amount, actual);

  state.guesses.push({ amount, temp, direction });
  guessInput.value = "";

  if (temp === "exact") {
    state.gameOver = true;
    state.won      = true;
  }

  renderGuesses();
  saveState();

  // Keep input focused for next guess
  if (!state.gameOver) {
    guessInput.focus();
  }

  if (state.gameOver) {
    setTimeout(endGame, 600);
  }
}

/* ================================================================
   INIT
   ================================================================ */
async function init() {
  /* 1. Load products.json */
  loadingMsg.textContent = "商品データを読み込み中…";
  let products;
  try {
    const resp = await fetch("products.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    products = await resp.json();
  } catch (err) {
    loadingMsg.textContent = `データの読み込みに失敗しました: ${err.message}`;
    return;
  }

  /* 2. Filter to products with local images, then pick today's product */
  const pool = products.filter(p => p.image_url && p.image_url.startsWith("/images/"));
  const product = pickProduct(pool.length > 0 ? pool : products);
  state.product   = product;

  /* 3. Restore saved state for today (if any) */
  const { dayMs } = todayUTC();
  state.dateStr   = dateStr(dayMs);
  const restored  = loadSavedState();

  /* 4. Get Japanese translation */
  if (state.titleJa) {
    /* restored from localStorage */
  } else if (product.title_ja) {
    state.titleJa = product.title_ja;
  } else {
    loadingMsg.textContent = "日本語に翻訳中…";
    state.titleJa = await translateToJapanese(product.title);
    saveState(); // cache the translation
  }

  /* 5. Render initial UI */
  loadingSection.classList.add("hidden");
  gameSection.classList.remove("hidden");

  loadImage(productImg, productPlaceholder, product);
  // Also try Open Food Facts in background if placeholder is showing
  setTimeout(() => tryOpenFoodFacts(productImg, productPlaceholder, product.title), 2000);

  renderNameJa(state.titleJa);
  renderGuesses();

  /* 6. If game was already finished today, show result immediately */
  if (state.gameOver) {
    submitBtn.disabled = true;
    guessInput.disabled = true;
    endGame();
  }
}

/* ================================================================
   EVENT LISTENERS
   ================================================================ */
submitBtn.addEventListener("click", submitGuess);

guessInput.addEventListener("keydown", e => {
  if (e.key === "Enter") submitGuess();
});

howBtn.addEventListener("click", () => howModal.classList.remove("hidden"));
howClose.addEventListener("click", () => howModal.classList.add("hidden"));
howModal.addEventListener("click", e => { if (e.target === howModal) howModal.classList.add("hidden"); });

resultModal.addEventListener("click", e => {
  if (e.target === resultModal) resultModal.classList.add("hidden");
});



/* ================================================================
   START
   ================================================================ */
init();
