import { wrapTableWithTitle, makeTableHtml } from "./table";
import { makeBadgesHtml, makeSettingsButtonHtml } from "./badges";

// Try to initialize multiple times, since Funda pages can be hydrated dynamically.
const MAX_TRIES = 30;
const TRY_DELAY_MS = 1000;
let tries = 0;
const CARD_ID = 'funda-neighbourhoods-card';
const CARD_CONTENT_ID = 'funda-neighbourhoods-card-content';
const LOADING_WRAP_ID = 'funda-neighbourhoods-loading-wrap';
const LOADING_BAR_ID = 'funda-neighbourhoods-loading-bar';
let lastContentHTML = '';
let observerStarted = false;
let observerRef = null;
let isApplyingDom = false;
let ensureTimer = null;
let lastRenderedProperties = [];
let pendingRender = null;
// no placeholder injection

function init() {
  try { console.debug('[FundaNeighbourhoods][content] init', location.pathname, location.href); } catch {}
  if (!isEligiblePropertyDetailPage()) {
    console.debug('[FundaNeighbourhoods][content] Not a property detail page; skipping');
    return;
  }
  const zipCode = getZipCode();
  if (!zipCode) {
    console.warn("[FundaNeighbourhoods][content] Zip code not found yet. Will retry.");
  } else {
    console.log("[FundaNeighbourhoods][content] Zip code detected", zipCode, location.href);
  }

  if (!zipCode) {
    tries += 1;
    if (tries <= MAX_TRIES) {
      setTimeout(init, TRY_DELAY_MS);
    } else {
      console.warn("Funda Neighbourhoods: zip code not found after retries, aborting");
    }
    return;
  }

  const addressQuery = getAddressQuery();
  // Removed loading bar (was flaky on dynamic pages)
  console.log("Funda Neighbourhoods extension:", { zipCode, addressQuery });
  const debugMode = location.hash.includes('fn-debug');
  chrome.runtime.sendMessage({ zipCode, addressQuery, debug: debugMode }, ({ badgeProperties, tableProperties, cardProperties, error, debugInfo }) => {
    console.log({ badgeProperties, tableProperties, cardProperties });
    console.log("[FundaNeighbourhoods][content] Response from background", { hasError: !!error });
    if (debugMode && debugInfo) {
      try { console.groupCollapsed('[FundaNeighbourhoods][diag] initial'); debugInfo.forEach(l => console.log(l)); console.groupEnd(); } catch {}
    }

    // Decide which properties to show in the card: prefer background-filtered list; otherwise, filter by selection on the client.
    let propertiesForCard = Array.isArray(cardProperties) ? cardProperties.slice() : [];
    if (!propertiesForCard.length) {
      const selectedNames = new Set((badgeProperties || []).map(p => p.name));
      propertiesForCard = (tableProperties || []).filter(p => selectedNames.has(p.name) && p.group !== 'doNotShowInTable');
    }
    // Final fallback to full table if nothing selected
    if (!propertiesForCard.length) {
      propertiesForCard = (tableProperties || []).filter(p => p.group !== 'doNotShowInTable');
      console.debug('[FundaNeighbourhoods][content] No selected rows; showing full table', propertiesForCard.length);
    } else {
      console.debug('[FundaNeighbourhoods][content] Rendering selected rows', propertiesForCard.length);
    }

    // Defer rendering until anchors exist
    if (!anchorsReady()) {
      pendingRender = { tableProperties: propertiesForCard, error };
      startObserverOnce();
      console.debug('[FundaNeighbourhoods][content] Deferring render until anchors are ready');
    } else {
      addNeighbourhoodCard({ tableProperties: propertiesForCard, error });
    }
    // no loading bar

    subscribeToBadgeClicks();
  });

// Listen for late updates from background (extras resolved)
try {
  chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    if (msg && msg.action === 'neighbourhoodUpdate') {
      console.debug('[FundaNeighbourhoods][content] Received late update');
      const props = Array.isArray(msg.cardProperties) ? msg.cardProperties : [];
      if (props.length) {
        if (!anchorsReady()) { pendingRender = { tableProperties: props, error: false }; startObserverOnce(); }
        else { addNeighbourhoodCard({ tableProperties: props, error: false }); }
      }
      const debugMode = location.hash.includes('fn-debug');
      if (debugMode && msg.debugInfo) {
        try { console.groupCollapsed('[FundaNeighbourhoods][diag] late'); msg.debugInfo.forEach(l => console.log(l)); console.groupEnd(); } catch {}
      }
    }
  });
} catch (_) {}
}

init();

function isEligiblePropertyDetailPage() {
  // Be permissive: accept detail pages (koop/huur) and classic koop slugs,
  // or when header markers exist in the DOM (dynamic hydration/new layouts).
  try {
    const path = location.pathname.replace(/\/+$/, '/');
    const isDetailAny = /^\/detail\//.test(path);
    const isClassicKoop = /^\/koop\//.test(path) && /\/(huis-|woning-|appartement-|woonhuis-)/.test(path);
    const hasHeader = !!(document.querySelector("[data-test-id='object-header-title']") || document.querySelector('.object-header__title') || document.querySelector("[data-test-id='object-header']"));
    return isDetailAny || isClassicKoop || hasHeader;
  } catch {
    return true; // fail-open to avoid skipping injection
  }
}

function getZipCode() {
  // Primary selector (legacy Funda layout)
  const zipCodeElement =
    document.querySelector(".object-header__subtitle") ||
    document.querySelector("[class*='object-header'] [class*='subtitle']") ||
    document.querySelector("[data-test-id='object-header']");

  const zipCodeRe = /\b(\d{4})\s*([A-Z]{2})\b/;

  if (zipCodeElement && typeof zipCodeElement.innerText === "string") {
    const match = zipCodeElement.innerText.match(zipCodeRe);
    if (match) {
      console.debug("[FundaNeighbourhoods][content] Zip from header/subtitle", match[0]);
      return `${match[1]}${match[2]}`;
    }
  }

  // Fallback: try meta description
  const metaDesc = document.querySelector('meta[name="description"], meta[property="og:description"]');
  if (metaDesc && metaDesc.content) {
    const match = metaDesc.content.match(zipCodeRe);
    if (match) {
      console.debug("[FundaNeighbourhoods][content] Zip from meta description", match[0]);
      return `${match[1]}${match[2]}`;
    }
  }

  // Last resort: scan page text (may be heavy but reliable)
  const bodyText = document.body && document.body.innerText;
  if (typeof bodyText === "string") {
    const match = bodyText.match(zipCodeRe);
    if (match) {
      console.debug("[FundaNeighbourhoods][content] Zip from body text", match[0]);
      return `${match[1]}${match[2]}`;
    }
  }

  return null;
}

function getBadgesContainerElement() {
  let badgesContainerElement = document.querySelector(".object-header__details .object-header__labels ul");

  if (!badgesContainerElement) {
    badgesContainerElement = document.createElement("ul");
    badgesContainerElement.classList.add(
      "fd-color-white",
      "fd-flex",
      "fd-list--none",
      "fd-m-bottom-xs",
      "fd-p-none",
      "fd-text--emphasis",
      "fd-text-size-s"
    );

    const headerLabelsElement = document.createElement("div");
    headerLabelsElement.classList.add("object-header__labels");
    headerLabelsElement.appendChild(badgesContainerElement);

    const headerDetailsElement =
      document.querySelector(".object-header__details") ||
      document.querySelector(".object-header") ||
      document.body;

    if (!headerDetailsElement) {
      console.warn("[FundaNeighbourhoods][content] No header container to inject badges into");
      return null;
    }

    console.debug("[FundaNeighbourhoods][content] Injecting badges container");
    headerDetailsElement.insertAdjacentElement("afterbegin", headerLabelsElement);
  }

  return badgesContainerElement;
}

function getAddressQuery() {
  const candidates = [
    ".object-header__title",
    "[data-test-id='object-header-title']",
    "[class*='object-header'] h1",
    "h1",
  ];

  let addressText = null;
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && typeof el.innerText === "string" && el.innerText.trim()) {
      // Split lines and pick line that looks like a street + house number
      const lines = el.innerText
        .split(/\n|\r/)
        .map(s => s.trim())
        .filter(Boolean);
      const zipRe = /\b\d{4}\s*[A-Z]{2}\b/;
      const lineWithNumber = lines.find(
        s => /\d/.test(s) && !zipRe.test(s)
      );
      addressText = (lineWithNumber || lines[0]).trim();
      console.debug("[FundaNeighbourhoods][content] Address from DOM", sel, addressText);
      break;
    }
  }

  if (!addressText) {
    // Try to parse from URL slug, e.g., huis-biest-106-c
    const parts = location.pathname.split("/").filter(Boolean);
    const seg = parts.find(p => /\d/.test(p) && p.includes("-"));
    if (seg) {
      const cleaned = seg
        .replace(/^(huis|appartement|woning|woonhuis|villa|tussenwoning|hoekwoning|bovenwoning|benedenwoning|boerderij|penthouse|stadswoning|portiekflat|galerijflat|bouwgrond|kavel|eengezinswoning)-/i, "")
        .replace(/-/g, " ")
        .trim();
      if (cleaned) {
        addressText = cleaned;
        console.debug("[FundaNeighbourhoods][content] Address from URL", cleaned);
      }
    }
  }

  const zip = getZipCode();
  if (addressText && zip) {
    // Normalize house number hyphens and whitespace
    const normalized = addressText.replace(/\s*-\s*/g, "-").replace(/\s+/g, " ");
    return `${normalized} ${zip}`;
  }
  return addressText;
}

function addNeighbourhoodCard({ tableProperties, badgeProperties = [], error }) {
  if (!anchorsReady()) {
    pendingRender = { tableProperties, error };
    startObserverOnce();
    return;
  }
  const title = chrome.i18n.getMessage("neighbourhood");
  const tableHtml = error
    ? `<div class="funda-neighbourhoods-generic-error-message">${chrome.i18n.getMessage("genericErrorMessage")}</div>`
    : makeTableHtml(tableProperties);

  const gear = `
    <button class="funda-neighbourhoods-configure-card-button" title="${chrome.i18n.getMessage("configureBadges")}" aria-label="${chrome.i18n.getMessage("configureBadges")}">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M0 0h24v24H0V0z" fill="none"></path>
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"></path>
      </svg>
    </button>`;

  lastRenderedProperties = tableProperties || [];

  const innerHtml = `
    <div class="funda-neighbourhoods-card__header">
      <h2 class="funda-neighbourhoods-card__title">${title}</h2>
      ${gear}
    </div>
    ${tableHtml}
    <div class="funda-neighbourhoods-graph">
      <span class="funda-neighbourhoods-graph-toggle" data-fn-action="toggleGraph">${chrome.i18n.getMessage('amenities')}: ${chrome.i18n.getMessage('avgDistanceToSchools')} — klik om grafiek te tonen</span>
      <div id="funda-neighbourhoods-graph-canvas" style="display:none"></div>
    </div>
  `;

  lastContentHTML = innerHtml;

  let card = document.getElementById(CARD_ID);
  if (!card) {
    card = document.createElement('section');
    card.id = CARD_ID;
    card.className = 'funda-neighbourhoods-card';
    const content = document.createElement('div');
    content.id = CARD_CONTENT_ID;
    content.innerHTML = innerHtml;
    card.appendChild(content);
  } else {
    const content = card.querySelector('#' + CARD_CONTENT_ID) || (() => { const n = document.createElement('div'); n.id = CARD_CONTENT_ID; card.appendChild(n); return n; })();
    content.innerHTML = innerHtml;
  }

  const placed = placeCard(card);
  // Keep observer running to survive re-renders
  startObserverOnce();
  wireGraphToggle();
}

// placeholder removed

function findOmschrijvingSection() {
  // Look for a section with an H2 that equals "Omschrijving"
  const headings = Array.from(document.querySelectorAll('section h2'));
  const target = headings.find(h => h.textContent && h.textContent.trim().toLowerCase().startsWith('omschrijving'));
  return target ? target.closest('section') : null;
}

function findAboutHeader() {
  // New layout: a header block with id="about" sits right above the description section
  try {
    return document.querySelector('#about');
  } catch {
    return null;
  }
}

function anchorsReady() {
  return !!(findAboutHeader() || findOmschrijvingSection());
}

function showLoadingBar() {
  if (document.getElementById(LOADING_WRAP_ID)) return;
  const wrap = document.createElement('div');
  wrap.id = LOADING_WRAP_ID;
  wrap.className = 'funda-neighbourhoods-loading-wrap';
  const bar = document.createElement('div');
  bar.id = LOADING_BAR_ID;
  bar.className = 'funda-neighbourhoods-loading-bar';
  const fill = document.createElement('div');
  fill.className = 'funda-neighbourhoods-loading-fill';
  bar.appendChild(fill);
  wrap.appendChild(bar);

  // Place before Omschrijving if possible, else at top of main
  const descriptionSection = findOmschrijvingSection();
  if (descriptionSection && descriptionSection.parentNode) {
    descriptionSection.parentNode.insertBefore(wrap, descriptionSection);
    try { console.debug('[FundaNeighbourhoods][content] Loading bar inserted before Omschrijving'); } catch {}
  } else {
    const main = document.querySelector('main') || document.body;
    main.insertAdjacentElement('afterbegin', wrap);
    try { console.debug('[FundaNeighbourhoods][content] Loading bar inserted at top of main'); } catch {}
  }
}

function removeLoadingBar() {
  const wrap = document.getElementById(LOADING_WRAP_ID);
  if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
}

function ensureCardPlacement() {
  if (isApplyingDom) return;
  isApplyingDom = true;
  try {
    const card = document.getElementById(CARD_ID);
    if (!card) {
      if (pendingRender && anchorsReady()) {
        const pr = pendingRender; pendingRender = null;
        addNeighbourhoodCard(pr);
      }
      return;
    }
    const placed = placeCard(card);
    const content = card.querySelector('#' + CARD_CONTENT_ID);
    if (content && lastContentHTML && content.innerHTML !== lastContentHTML) {
      content.innerHTML = lastContentHTML;
    }
    if (placed && observerRef) { try { observerRef.disconnect(); } catch {} observerStarted = false; }
  } finally {
    isApplyingDom = false;
  }
}

function placeCard(card) {
  const about = findAboutHeader();
  const descriptionSection = findOmschrijvingSection();
  if (about && (!descriptionSection || about.compareDocumentPosition(descriptionSection) & Node.DOCUMENT_POSITION_FOLLOWING)) {
    // Insert immediately after the #about header block
    if (card.previousSibling !== about) {
      about.insertAdjacentElement('afterend', card);
    }
    return true;
  }
  if (descriptionSection) {
    if (card.parentNode !== descriptionSection.parentNode || card.nextSibling !== descriptionSection) {
      descriptionSection.parentNode.insertBefore(card, descriptionSection);
    }
    return true;
  }
  return false;
}

function wireGraphToggle() {
  const container = document.getElementById('funda-neighbourhoods-graph-canvas');
  const toggle = document.querySelector('[data-fn-action="toggleGraph"]');
  if (!container || !toggle) return;

  toggle.addEventListener('click', () => {
    const visible = container.style.display !== 'none';
    if (visible) {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'block';
    renderGraph(container, lastRenderedProperties);
  }, { once: false });
}

function renderGraph(container, properties) {
  // Build dataset from any amenities avg distance properties
  const items = properties
    .filter(p => p.group === 'amenities' && p.name.indexOf('avgDistance') === 0)
    .map(p => ({ label: chrome.i18n.getMessage(p.name) || p.label || p.name, value: parseDistance(getTextValue(p)) }));

  if (!items.length) {
    container.innerHTML = `<div style="color:#6b7280">${chrome.i18n.getMessage('noInfo') || 'No info'}</div>`;
    return;
  }

  const max = Math.max(...items.map(i => i.value));
  const width = container.clientWidth || 600;
  const barH = 16, gap = 8, leftPad = 140, rightPad = 40, topPad = 10, bottomPad = 10;
  const height = topPad + bottomPad + items.length * (barH + gap) - gap;

  const scale = v => (v / (max || 1)) * (width - leftPad - rightPad);

  const bars = items.map((i, idx) => {
    const y = topPad + idx * (barH + gap);
    const w = Math.max(2, Math.round(scale(i.value)));
    const label = i.label.replace(/^Avg\.\s*/i, '');
    const display = formatMeters(i.value);
    return `<g>
      <text x="0" y="${y + barH - 3}" fill="#4b5563" font-size="12">${escapeXml(label)}</text>
      <rect x="${leftPad}" y="${y}" width="${w}" height="${barH}" fill="#60a5fa" rx="3"/>
      <text x="${leftPad + w + 6}" y="${y + barH - 3}" fill="#111827" font-size="12">${display}</text>
    </g>`;
  }).join('');

  container.innerHTML = `<svg width="100%" viewBox="0 0 ${width} ${height}" role="img" aria-label="Amenities distances">${bars}</svg>`;
}

function getTextValue(p) {
  // p.value is formatted already (e.g., "1.5 km" or "700 m")
  return p && p.value ? String(p.value) : '';
}

function parseDistance(text) {
  // Accept "1.2 km" or "700 m"
  if (!text) return 0;
  const km = text.match(/([0-9]+(?:\.[0-9]+)?)\s*km/i);
  if (km) return Math.round(parseFloat(km[1]) * 1000);
  const m = text.match(/([0-9]+)\s*m/i);
  if (m) return parseInt(m[1], 10);
  const num = parseFloat(text);
  return isFinite(num) ? num : 0;
}

function formatMeters(m) {
  if (!isFinite(m) || m === null) return chrome.i18n.getMessage('noInfo') || 'No info';
  if (m >= 1000) return `${(m/1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

function escapeXml(s){
  return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}

function startObserverOnce() {
  if (observerStarted) return;
  observerStarted = true;
  observerRef = new MutationObserver(mutations => {
    // Ignore mutations coming from inside our card
    for (const m of mutations) {
      const t = m.target;
      if (t && (t.id === CARD_ID || (t.closest && t.closest('#' + CARD_ID)))) continue;
      if (ensureTimer) clearTimeout(ensureTimer);
      ensureTimer = setTimeout(ensureCardPlacement, 150);
      break;
    }
  });
  const root = document.body || document.documentElement;
  observerRef.observe(root, { childList: true, subtree: true });
}

function addBadges(badgesContainerElement, badgeProperties) {
  badgesContainerElement.classList.add("badges-container");

  const badgesHtml = makeBadgesHtml(badgeProperties);
  badgesContainerElement.insertAdjacentHTML("beforeend", badgesHtml);
}

function addSettingsButton(badgesContainerElement) {
  const settingsButtonHtml = makeSettingsButtonHtml();
  badgesContainerElement.insertAdjacentHTML("beforeend", settingsButtonHtml);
}

function addGenericErrorMessage(badgesContainerElement) {
  const message = `<span class="funda-neighbourhoods-generic-error-message">${chrome.i18n.getMessage(
    "genericErrorMessage"
  )}</span>`;
  badgesContainerElement.insertAdjacentHTML("beforeend", message);
}

function subscribeToBadgeClicks() {
  const badgesContainerElement = getBadgesContainerElement();

  const openOptions = () => {
    const logPrefix = '[FundaNeighbourhoods][content]';
    try {
      console.debug(`${logPrefix} Opening options page (direct)`);
      if (chrome.runtime && typeof chrome.runtime.openOptionsPage === 'function') {
        chrome.runtime.openOptionsPage();
        return;
      }
    } catch (e) {
      console.warn('[FundaNeighbourhoods][content] openOptionsPage failed, will fallback', e);
    }

    try {
      console.debug(`${logPrefix} Opening options page (message)`);
      chrome.runtime.sendMessage({ action: 'openOptionsPage' });
      return;
    } catch (e) {
      console.warn('[FundaNeighbourhoods][content] sendMessage openOptionsPage failed, will fallback to URL', e);
    }

    try {
      const url = chrome.runtime.getURL('options.html');
      console.debug(`${logPrefix} Opening options page (URL)`, url);
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      console.error('[FundaNeighbourhoods][content] All options opening methods failed', e);
    }
  };

  // Container-level delegation (works when container persists)
  if (badgesContainerElement) {
    badgesContainerElement.addEventListener('click', event => {
      const target = event.target;
      const configureBadge = target.closest && target.closest('.funda-neighbourhoods-configure-badge');
      if (configureBadge) {
        event.preventDefault();
        openOptions();
      }
    });

    badgesContainerElement.addEventListener('keydown', event => {
      const target = event.target;
      if ((event.key === 'Enter' || event.key === ' ') && target && target.classList && target.classList.contains('funda-neighbourhoods-configure-badge')) {
        event.preventDefault();
        openOptions();
      }
    });
  }

  // Document-level capture (survives React/DOM re-renders that replace the container)
  document.addEventListener('click', event => {
    const target = event.target;
    const configureBadge = target && target.closest && (target.closest('.funda-neighbourhoods-configure-badge') || target.closest('.funda-neighbourhoods-configure-card-button'));
    if (configureBadge) {
      event.preventDefault();
      openOptions();
    }
  }, true);

  document.addEventListener('keydown', event => {
    const target = event.target;
    if ((event.key === 'Enter' || event.key === ' ') && target && target.classList && target.classList.contains('funda-neighbourhoods-configure-badge')) {
      event.preventDefault();
      openOptions();
    }
  }, true);
}
