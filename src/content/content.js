import { wrapTableWithTitle, makeTableHtml } from "./table";
import { makeBadgesHtml, makeSettingsButtonHtml } from "./badges";

// Try to initialize multiple times, since Funda pages can be hydrated dynamically.
const MAX_TRIES = 30;
const TRY_DELAY_MS = 1000;
let tries = 0;
const CARD_ID = 'funda-neighbourhoods-card';
let lastCardHTML = '';
let observerStarted = false;

function init() {
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
  console.log("Funda Neighbourhoods extension:", { zipCode, addressQuery });
  chrome.runtime.sendMessage({ zipCode, addressQuery }, ({ badgeProperties, tableProperties, cardProperties, error }) => {
    console.log({ badgeProperties, tableProperties, cardProperties });
    console.log("[FundaNeighbourhoods][content] Response from background", { hasError: !!error });

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

    addNeighbourhoodCard({ tableProperties: propertiesForCard, error });

    subscribeToBadgeClicks();
  });
}

init();

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

  const cardHtml = `
    <section id="${CARD_ID}" class="funda-neighbourhoods-card">
      <div class="funda-neighbourhoods-card__header">
        <h2 class="funda-neighbourhoods-card__title">${title}</h2>
        ${gear}
      </div>
      ${tableHtml}
    </section>
  `;
  lastCardHTML = cardHtml;
  ensureCardPlacement();
  startObserverOnce();
}

function findOmschrijvingSection() {
  // Look for a section with an H2 that equals "Omschrijving"
  const headings = Array.from(document.querySelectorAll('section h2'));
  const target = headings.find(h => h.textContent && h.textContent.trim().toLowerCase().startsWith('omschrijving'));
  return target ? target.closest('section') : null;
}

function ensureCardPlacement() {
  const card = document.getElementById(CARD_ID);
  const descriptionSection = findOmschrijvingSection();
  if (descriptionSection) {
    if (card) {
      // Make sure card is placed before description section
      const rel = card.compareDocumentPosition(descriptionSection);
      const cardBefore = (rel & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      if (!cardBefore) {
        descriptionSection.parentNode.insertBefore(card, descriptionSection);
      }
    } else if (lastCardHTML) {
      descriptionSection.insertAdjacentHTML('beforebegin', lastCardHTML);
    }
    return;
  }

  // Fallbacks for legacy pages
  const agentElement = document.querySelector('.object-detail-verkocht__makelaars-header');
  if (agentElement) {
    if (!card && lastCardHTML) agentElement.insertAdjacentHTML('beforebegin', lastCardHTML);
    return;
  }

  // As last resort, append near top of main content
  if (!card && lastCardHTML) {
    const main = document.querySelector('main') || document.body;
    main.insertAdjacentHTML('afterbegin', lastCardHTML);
  }
}

function startObserverOnce() {
  if (observerStarted) return;
  observerStarted = true;
  const mo = new MutationObserver(() => {
    // Re-ensure placement if Funda re-hydrates and replaces nodes
    ensureCardPlacement();
  });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
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
