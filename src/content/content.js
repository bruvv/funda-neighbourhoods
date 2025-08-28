import { wrapTableWithTitle, makeTableHtml } from "./table";
import { makeBadgesHtml, makeSettingsButtonHtml } from "./badges";

// Try to initialize multiple times, since Funda pages can be hydrated dynamically.
const MAX_TRIES = 30;
const TRY_DELAY_MS = 1000;
let tries = 0;

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
  chrome.runtime.sendMessage({ zipCode, addressQuery }, ({ badgeProperties, tableProperties, error }) => {
    console.log({ badgeProperties, tableProperties });
    console.log("[FundaNeighbourhoods][content] Response from background", { hasError: !!error });

    const badgesContainerElement = getBadgesContainerElement();

    if (!badgesContainerElement) {
      console.log("No badges container on this page");
      return;
    }

    if (error) {
      console.warn('Funda Neighbourhoods: background error', error);
      addGenericErrorMessage(badgesContainerElement);
      addSettingsButton(badgesContainerElement);
    } else {
      addBadges(badgesContainerElement, badgeProperties);
      addSettingsButton(badgesContainerElement);
      addNeighbourhoodTable(tableProperties);
    }

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
      addressText = el.innerText.trim();
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
  if (addressText && zip) return `${addressText} ${zip}`;
  return addressText;
}

function addNeighbourhoodTable(tableProperties) {
  const tableHtml = makeTableHtml(tableProperties);

  const neighbourhoodNameElement = document.querySelector(".object-buurt__title ~ [data-local-insights-entry-point]");

  if (neighbourhoodNameElement) {
    neighbourhoodNameElement.insertAdjacentHTML("afterend", tableHtml);
  }

  const agentElement = document.querySelector(".object-detail-verkocht__makelaars-header");

  if (agentElement) {
    const tableWithTitle = wrapTableWithTitle(tableProperties, tableHtml);
    agentElement.insertAdjacentHTML("beforebegin", tableWithTitle);
  }
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

  badgesContainerElement.addEventListener("click", event => {
    const clickedElement = event.target;
    const isBadgeClick =
      clickedElement.classList.contains("funda-neighbourhoods-badge") ||
      clickedElement.classList.contains("funda-neighbourhoods-configure-badge-clickable-area");

    if (isBadgeClick) {
      chrome.runtime.sendMessage({ action: "openOptionsPage" });
    }
  });
}
