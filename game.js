/**
 * game.js  –  テスコデル
 *
 * Daily UK food price guessing game (Japanese yen edition).
 * Products come from products.json (only ones with a local image are used).
 * Japanese names come from names_ja.js first; if a product is missing there,
 * it falls back to the MyMemory translation API (cached in localStorage).
 */

"use strict";

/* ================================================================
   CONFIG
   ================================================================ */
const GAME_EPOCH    = Date.UTC(2026, 0, 1); // 1 Jan 2026 = day 0 (JST)
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;   // UTC+9
const DEFAULT_RATE  = 212;                  // £1 → ¥ (matches price_yen in products.json)
const MAX_GUESS     = 99999;

/* Closeness thresholds (% difference from the real price) */
const THRESHOLDS = { exact: 5, yellow: 10, orange: 25, red: 50 };

const NAMES_JA = window.NAMES_JA || {};

/* ================================================================
   DOM refs
   ================================================================ */
const $ = id => document.getElementById(id);
const loadingSection     = $("loading-section");
const loadingMsg         = $("loading-msg");
const gameSection        = $("game-section");
const productImg         = $("product-img");
const productPlaceholder = $("product-placeholder");
const productNameJa      = $("product-name-ja");
const productNameEn      = $("product-name-en");
const productPriceYen    = $("product-price-yen");
const guessNumEl         = $("guess-num");
const guessesList        = $("guesses-list");
const guessesSection     = $("guesses-section");
const emptyGuesses       = $("empty-guesses");
const guessInput         = $("guess-input");
const submitBtn          = $("submit-btn");
const inputRow           = $("input-row");
const inputError         = $("input-error");
const rangeLow           = $("range-low");
const rangeHigh          = $("range-high");
const rangeFill          = $("range-fill");
const rangeText          = $("range-text");
const modeBadge          = $("mode-badge");
const doneRow            = $("done-row");
const howBtn             = $("how-btn");
const howModal           = $("how-modal");
const howClose           = $("how-close");
const howStart           = $("how-start");
const soundBtn           = $("sound-btn");
const resultModal        = $("result-modal");
const resultClose        = $("result-close");
const resultTitle        = $("result-title");
const resultMessage      = $("result-message");
const revealImg          = $("reveal-img");
const revealPlaceholder  = $("reveal-placeholder");
const revealNameJa       = $("reveal-name-ja");
const revealNameEn       = $("reveal-name-en");
const revealPriceUk      = $("reveal-price-uk");
const revealPriceYen     = $("reveal-price-yen");
const nextInfo           = $("next-info");

/* ================================================================
   STATE
   ================================================================ */
let pool = [];          // playable products
let soundOn = safeGet("tescodle_sound") !== "off";

let state = {
  product:  null,
  titleJa:  "",
  guesses:  [],         // [{ amount, temp, direction }]
  gameOver: false,
  won:      false,
  practice: false,
};

/* ================================================================
   STORAGE (never crash if storage is blocked)
   ================================================================ */
function safeGet(k)    { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

/* ================================================================
   DATE / PRODUCT SELECTION
   ================================================================ */
function todayJST() {
  // Shift to JST before reading the calendar date so the daily rollover
  // happens at midnight Japan time.
  const jst   = new Date(Date.now() + JST_OFFSET_MS);
  const dayMs = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return { dayMs, gameDay: Math.floor((dayMs - GAME_EPOCH) / 86_400_000) };
}

function pickDailyProduct() {
  const { gameDay } = todayJST();
  const idx = ((gameDay % pool.length) + pool.length) % pool.length;
  return pool[idx];
}

function storageKey() {
  const d = new Date(todayJST().dayMs);
  return `tescodle_${d.getUTCFullYear()}_${d.getUTCMonth()}_${d.getUTCDate()}`;
}

function saveState() {
  if (state.practice) return;
  const { guesses, gameOver, won, titleJa } = state;
  safeSet(storageKey(), JSON.stringify({ guesses, gameOver, won, titleJa }));
}

function loadSavedState() {
  try {
    const saved = JSON.parse(safeGet(storageKey()));
    if (!saved) return false;
    state.guesses  = Array.isArray(saved.guesses) ? saved.guesses : [];
    state.gameOver = !!saved.gameOver;
    state.won      = !!saved.won;
    state.titleJa  = saved.titleJa || "";
    return true;
  } catch { return false; }
}

/* ================================================================
   PRICES
   ================================================================ */
function actualYen(p) {
  return p.price_yen ?? Math.round(p.price_actual * DEFAULT_RATE);
}
function yen(n) { return `¥${Number(n).toLocaleString("ja-JP")}`; }

/* ================================================================
   JAPANESE NAMES
   ================================================================ */
async function japaneseName(product) {
  if (NAMES_JA[product.id]) return NAMES_JA[product.id];
  if (product.title_ja) return product.title_ja;
  return translateToJapanese(product.title);
}

async function translateToJapanese(text) {
  const cacheKey = `tl2_${text}`;
  const cached   = safeGet(cacheKey);
  if (cached) return cached;
  try {
    const url  = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ja`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error("network");
    const data = await resp.json();
    if (data.responseStatus === 200) {
      const ja = data.responseData.translatedText;
      safeSet(cacheKey, ja);
      return ja;
    }
  } catch (_) { /* fall through */ }
  return text; // fallback: keep English
}

/* ================================================================
   IMAGES
   ================================================================ */
function loadImage(imgEl, placeholderEl, product) {
  const urls = buildImageUrls(product);
  let attempt = 0;
  imgEl.classList.add("hidden");
  placeholderEl.classList.remove("hidden");

  function tryNext() {
    if (attempt >= urls.length) return; // keep the 🛒 placeholder
    imgEl.src = urls[attempt++];
  }
  imgEl.onload  = () => { placeholderEl.classList.add("hidden"); imgEl.classList.remove("hidden"); };
  imgEl.onerror = tryNext;
  tryNext();
}

function buildImageUrls(product) {
  // Local images (/images/<pid>.jpg) are definitive. Strip the leading
  // slash so the path works on GitHub Pages under /tescodle/.
  if (product.image_url && product.image_url.startsWith("/images/")) {
    return [product.image_url.replace(/^\//, "")];
  }
  const pid = product.id;
  return [
    product.image_url,
    `https://digitalcontent.api.tesco.com/v2/media/ghs/${pid}/${pid}.jpeg`,
  ].filter(Boolean);
}

/* ================================================================
   TEMPERATURE LOGIC
   ================================================================ */
function percentOff(guess, actual) { return Math.abs(guess - actual) / actual * 100; }

function getTemperature(guess, actual) {
  const pct = percentOff(guess, actual);
  if (pct <= THRESHOLDS.exact)  return "exact";
  if (pct <= THRESHOLDS.yellow) return "yellow";
  if (pct <= THRESHOLDS.orange) return "orange";
  if (pct <  THRESHOLDS.red)    return "red";
  return "ice";
}

function getDirection(guess, actual) {
  if (percentOff(guess, actual) <= THRESHOLDS.exact) return "✓";
  return guess < actual ? "▲" : "▼";
}

const TEMP_LABELS = {
  exact:  "🎯 せいかい！",
  yellow: "🔥 あと すこし！",
  orange: "😊 ちかい！",
  red:    "🤔 まだ とおい",
  ice:    "🧊 すごく とおい",
};
const DIRECTION_TEXT = { "▲": "もっと たかい", "▼": "もっと やすい", "✓": "ピッタリ！" };

/* ================================================================
   RENDERING
   ================================================================ */
function renderGuesses(animateLast = false) {
  guessesList.innerHTML = "";
  state.guesses.forEach((g, i) => {
    const li = document.createElement("li");
    const isLast = i === state.guesses.length - 1;
    li.className = `guess-row ${g.temp}` + (animateLast && isLast ? " new" : "");
    li.innerHTML = `
      <span class="guess-no">${i + 1}</span>
      <span class="amount">${yen(g.amount)}</span>
      <span class="direction">${g.direction === "✓" ? "✓" : g.direction === "▲" ? "⬆" : "⬇"} ${DIRECTION_TEXT[g.direction]}</span>
      <span class="temp-badge">${TEMP_LABELS[g.temp]}</span>
    `;
    guessesList.appendChild(li);
  });
  emptyGuesses.classList.toggle("hidden", state.guesses.length > 0);
  guessNumEl.textContent = state.guesses.length + 1;
  renderRange();

  requestAnimationFrame(() => {
    guessesSection.scrollTo({ top: guessesSection.scrollHeight, behavior: "smooth" });
  });
}

/* The "price is between ¥A and ¥B" helper */
function renderRange() {
  const actual = actualYen(state.product);
  let low = 0, high = null;
  state.guesses.forEach(g => {
    if (g.direction === "▲") low  = Math.max(low, g.amount);
    if (g.direction === "▼") high = high === null ? g.amount : Math.min(high, g.amount);
  });

  if (state.gameOver) {
    rangeText.innerHTML = `せいかいは <b>${yen(actual)}</b>`;
    rangeLow.textContent = "";
    rangeHigh.textContent = "";
    rangeFill.style.left = "0%";
    rangeFill.style.width = "100%";
    rangeFill.className = "range-fill done";
    return;
  }
  rangeFill.className = "range-fill";

  if (!state.guesses.length) {
    rangeText.textContent = "いくら かな？ よそう してみよう！";
    rangeLow.textContent = "¥0";
    rangeHigh.textContent = "？";
    rangeFill.style.left = "0%";
    rangeFill.style.width = "100%";
    return;
  }

  // Draw the known window on a scale from 0 to a bit above the highest guess
  const maxGuess = Math.max(...state.guesses.map(g => g.amount));
  const scaleMax = Math.max(maxGuess * 1.25, 100);
  const left  = (low / scaleMax) * 100;
  const right = high === null ? 100 : (high / scaleMax) * 100;
  rangeFill.style.left  = `${left}%`;
  rangeFill.style.width = `${Math.max(2, right - left)}%`;
  // Labels show the scale of the bar, not the bounds (those are in the text)
  rangeLow.textContent  = "¥0";
  rangeHigh.textContent = yen(Math.round(scaleMax / 10) * 10);

  if (high === null) rangeText.innerHTML = `<b>${yen(low)}</b> より たかい！`;
  else if (low === 0) rangeText.innerHTML = `<b>${yen(high)}</b> より やすい！`;
  else rangeText.innerHTML = `<b>${yen(low)}</b> と <b>${yen(high)}</b> の あいだ！`;
}

function renderProduct() {
  const p = state.product;
  productNameJa.textContent = state.titleJa || p.title;
  productNameEn.textContent = p.title;
  productPriceYen.textContent = "";
  productPriceYen.classList.remove("show");
  loadImage(productImg, productPlaceholder, p);

  modeBadge.textContent = state.practice ? "🎯 れんしゅう" : "📅 きょうの しょうひん";
  modeBadge.className = "mode-badge " + (state.practice ? "practice" : "daily");
}

function setInputEnabled(on) {
  guessInput.disabled = !on;
  submitBtn.disabled  = !on;
  inputRow.classList.toggle("hidden", !on);
  doneRow.classList.toggle("hidden", on);
}

/* ================================================================
   GAME OVER
   ================================================================ */
function praise(n) {
  if (n === 1) return "🤯 1かいで せいかい！ てんさい！";
  if (n <= 3)  return `🌟 ${n}かいで せいかい！ すごい！`;
  if (n <= 6)  return `🎉 ${n}かいで せいかい！`;
  return `👏 ${n}かいで せいかい！ がんばったね！`;
}

function endGame(celebrate) {
  const p        = state.product;
  const priceYen = actualYen(p);
  const rate     = p.price_actual ? Math.round(priceYen / p.price_actual) : DEFAULT_RATE;

  resultTitle.textContent   = state.won ? "せいかい！" : "ざんねん…";
  resultMessage.textContent = state.won ? praise(state.guesses.length) : "せいかいは…";

  loadImage(revealImg, revealPlaceholder, p);
  revealNameJa.textContent   = state.titleJa || p.title;
  revealNameEn.textContent   = p.title;
  revealPriceUk.innerHTML    = `イギリスの ねだん: <b>£${p.price_actual.toFixed(2)}</b>　（£1 ＝ ¥${rate}）`;
  revealPriceYen.textContent = yen(priceYen);

  if (state.practice) {
    nextInfo.textContent = "れんしゅう モード";
  } else {
    const tomorrow = new Date(todayJST().dayMs + 86_400_000);
    nextInfo.textContent = `つぎの しょうひん: ${tomorrow.getUTCMonth() + 1}がつ ${tomorrow.getUTCDate()}にち`;
  }

  $("daily-btn").classList.toggle("hidden", !state.practice);
  $("done-daily-btn").classList.toggle("hidden", !state.practice);

  productPriceYen.textContent = yen(priceYen);
  productPriceYen.classList.add("show");
  setInputEnabled(false);
  renderRange();

  resultModal.classList.remove("hidden");
  if (celebrate) { confetti(); playSound("win"); }
}

/* ================================================================
   SUBMIT GUESS
   ================================================================ */
function parseYen(raw) {
  // Accept full-width digits (Japanese IME), commas, ¥ and 円
  const half = raw
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[,，、¥￥円\s]/g, "");
  if (!/^\d+$/.test(half)) return NaN;
  return parseInt(half, 10);
}

function showInputError(msg) {
  inputError.textContent = msg;
  inputError.classList.add("show");
  inputRow.classList.remove("shake");
  void inputRow.offsetWidth;
  inputRow.classList.add("shake");
  playSound("bad");
  clearTimeout(showInputError.t);
  showInputError.t = setTimeout(() => inputError.classList.remove("show"), 2000);
}

function submitGuess() {
  if (state.gameOver) return;
  const raw = guessInput.value.trim();
  if (!raw) { showInputError("すうじを いれてね"); return; }
  const amount = parseYen(raw);
  if (isNaN(amount))      { showInputError("すうじ だけ いれてね（れい: 300）"); return; }
  if (amount < 1)         { showInputError("1えん いじょうで いれてね"); return; }
  if (amount > MAX_GUESS) { showInputError("たかすぎるよ！ 99999えん まで"); return; }
  if (state.guesses.some(g => g.amount === amount)) {
    showInputError("その ねだんは もう いれたよ");
    guessInput.select();
    return;
  }

  const actual    = actualYen(state.product);
  const temp      = getTemperature(amount, actual);
  const direction = getDirection(amount, actual);

  state.guesses.push({ amount, temp, direction });
  guessInput.value = "";
  inputError.classList.remove("show");

  if (temp === "exact") {
    state.gameOver = true;
    state.won      = true;
  }

  renderGuesses(true);
  saveState();
  playSound(temp);

  if (state.gameOver) {
    setInputEnabled(false);
    setTimeout(() => endGame(true), 700);
  } else {
    guessInput.focus();
  }
}

/* ================================================================
   MODES
   ================================================================ */
async function startDaily() {
  state = { product: pickDailyProduct(), titleJa: "", guesses: [], gameOver: false, won: false, practice: false };
  loadSavedState();
  // Hand-written names always win over an old cached machine translation
  if (NAMES_JA[state.product.id]) state.titleJa = NAMES_JA[state.product.id];
  if (!state.titleJa) {
    loadingMsg.textContent = "にほんごに ほんやく ちゅう…";
    state.titleJa = await japaneseName(state.product);
    saveState();
  }
  showGame();
}

async function startPractice() {
  const daily = pickDailyProduct();
  const choices = pool.filter(p => p !== daily && p !== state.product);
  const product = choices[Math.floor(Math.random() * choices.length)];
  state = { product, titleJa: "", guesses: [], gameOver: false, won: false, practice: true };
  resultModal.classList.add("hidden");
  state.titleJa = await japaneseName(product);
  showGame();
  guessInput.focus();
}

function showGame() {
  loadingSection.classList.add("hidden");
  gameSection.classList.remove("hidden");
  renderProduct();
  renderGuesses();
  setInputEnabled(!state.gameOver);
  if (state.gameOver) endGame(false);
}

/* ================================================================
   INIT
   ================================================================ */
async function init() {
  loadingMsg.textContent = "しょうひんを よみこみ ちゅう…";
  let products;
  try {
    const resp = await fetch("products.json");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    products = await resp.json();
  } catch (err) {
    loadingMsg.textContent = `よみこみに しっぱい しました。ページを こうしん してね。（${err.message}）`;
    return;
  }

  pool = products.filter(p => p.image_url && p.image_url.startsWith("/images/") && p.price_actual > 0);
  if (!pool.length) pool = products;

  await startDaily();

  if (!safeGet("tescodle_seen_help")) {
    safeSet("tescodle_seen_help", "1");
    howModal.classList.remove("hidden");
  } else if (!state.gameOver) {
    guessInput.focus();
  }

  // If the day changes while the page is open, load the new product
  let lastKey = storageKey();
  setInterval(() => {
    const key = storageKey();
    if (key !== lastKey) {
      lastKey = key;
      if (!state.practice) startDaily();
    }
  }, 30_000);
}

/* ================================================================
   CONFETTI + SOUND
   ================================================================ */
function confetti() {
  const canvas = $("confetti");
  const ctx = canvas.getContext("2d");
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  const colors = ["#EE1C25", "#004990", "#ffd600", "#16a34a", "#00b4ff", "#ff6d00"];
  const bits = Array.from({ length: 140 }, () => ({
    x: canvas.width / 2 + (Math.random() - 0.5) * 240, y: canvas.height / 3,
    vx: (Math.random() - 0.5) * 14, vy: Math.random() * -14 - 4,
    s: 6 + Math.random() * 6, c: colors[Math.floor(Math.random() * colors.length)],
    r: Math.random() * 360, vr: (Math.random() - 0.5) * 12,
  }));
  let f = 0;
  (function tick() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    bits.forEach(b => {
      b.vy += 0.35; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r * Math.PI / 180);
      ctx.fillStyle = b.c; ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2); ctx.restore();
    });
    if (++f < 180) requestAnimationFrame(tick); else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })();
}

let audioCtx = null;
function tone(freq, start, dur, type = "sine", vol = 0.08) {
  const t = audioCtx.currentTime + start;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + dur);
}
function playSound(kind) {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    switch (kind) {
      case "yellow": tone(880, 0, 0.12); tone(990, 0.1, 0.15); break;
      case "orange": tone(700, 0, 0.18); break;
      case "red":    tone(500, 0, 0.18, "triangle"); break;
      case "ice":    tone(300, 0, 0.22, "triangle"); break;
      case "bad":    tone(200, 0, 0.18, "square", 0.04); break;
      case "win":    [523, 659, 784, 1047].forEach((fq, i) => tone(fq, i * 0.12, 0.3)); break;
    }
  } catch (_) { /* no audio */ }
}
function updateSoundBtn() { soundBtn.textContent = soundOn ? "🔊" : "🔇"; }

/* ================================================================
   EVENT LISTENERS
   ================================================================ */
submitBtn.addEventListener("click", submitGuess);
guessInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submitGuess(); }
});

howBtn.addEventListener("click", () => howModal.classList.remove("hidden"));
howClose.addEventListener("click", () => howModal.classList.add("hidden"));
howStart.addEventListener("click", () => { howModal.classList.add("hidden"); if (!state.gameOver) guessInput.focus(); });
howModal.addEventListener("click", e => { if (e.target === howModal) howModal.classList.add("hidden"); });

resultClose.addEventListener("click", () => resultModal.classList.add("hidden"));
resultModal.addEventListener("click", e => { if (e.target === resultModal) resultModal.classList.add("hidden"); });

$("practice-btn").addEventListener("click", startPractice);
$("done-practice-btn").addEventListener("click", startPractice);
$("show-result-btn").addEventListener("click", () => resultModal.classList.remove("hidden"));
$("daily-btn").addEventListener("click", () => { resultModal.classList.add("hidden"); startDaily(); });
$("done-daily-btn").addEventListener("click", () => startDaily());

soundBtn.addEventListener("click", () => {
  soundOn = !soundOn;
  safeSet("tescodle_sound", soundOn ? "on" : "off");
  updateSoundBtn();
  if (soundOn) playSound("yellow");
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") { howModal.classList.add("hidden"); resultModal.classList.add("hidden"); }
});

updateSoundBtn();
init();
