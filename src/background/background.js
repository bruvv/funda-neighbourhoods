import { readUserSettings } from "../common/readUserSettings";
import { fetchNeighbourhoodStats, fetchNeighbourhoodMeta, fetchAmenitiesExtras } from "./api";

import { getProperties, selectDefaultProperties } from "./utils";
import { applySelectedLanguage } from "../common/i18n";

chrome.runtime.onInstalled.addListener(selectDefaultProperties);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("[FundaNeighbourhoods][bg] onMessage", request);
  if (request.action === "openOptionsPage") {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (request.action === 'getLocaleMessages' && request.language) {
    const url = chrome.runtime.getURL(`_locales/${request.language}/messages.json`);
    fetch(url)
      .then(r => (r && r.ok ? r.json() : Promise.reject(new Error(`status ${r && r.status}`))))
      .then(json => sendResponse({ messages: json }))
      .catch(err => {
        console.warn('[FundaNeighbourhoods][bg] getLocaleMessages failed', err && err.message);
        sendResponse({ error: err && err.message });
      });
    return true;
  }

  const { zipCode, addressQuery, debug: debugRequested } = request;
  const diag = debugRequested ? [] : null;

  const requestTabId = sender && sender.tab && sender.tab.id;

  fetchNeighbourhoodMeta(zipCode, addressQuery).then(async neighbourhoodMeta => {
    if (neighbourhoodMeta.error) {
      console.error("[FundaNeighbourhoods][bg] Meta error", neighbourhoodMeta.error);
      sendResponse({ error: neighbourhoodMeta.error });
      return;
    }

    const { neighbourhoodCode, neighbourhoodName, municipalityName } = neighbourhoodMeta;
    console.log("[FundaNeighbourhoods][bg] Meta", { neighbourhoodCode, neighbourhoodName, municipalityName });

    const neighbourhood = await fetchNeighbourhoodStats(neighbourhoodCode, diag || []);
    // Fetch extras with a soft timeout so main response isn't blocked for long
    const extrasPromise = fetchAmenitiesExtras(neighbourhoodCode, diag || [], addressQuery);
    const extrasTimeout = new Promise(resolve => setTimeout(() => resolve({}), 3000));
    const extras = await Promise.race([extrasPromise, extrasTimeout]);
    console.log("[FundaNeighbourhoods][bg] Stats keys", neighbourhood ? Object.keys(neighbourhood).length : 0);

    const neighbourhoodWithMeta = {
      neighbourhoodName: { value: neighbourhoodName },
      municipalityName: { value: municipalityName },
      ...neighbourhood,
      ...extras,
    };

    const userSettings = await readUserSettings();
    await applySelectedLanguage(userSettings.language);
    console.log("[FundaNeighbourhoods][bg] User settings", userSettings);

    const { badgeProperties, tableProperties, cardProperties } = getProperties(neighbourhoodWithMeta, userSettings);
    console.log("[FundaNeighbourhoods][bg] Computed properties", {
      badgeCount: Object.keys(badgeProperties || {}).length,
      tableCount: (tableProperties || []).length,
      cardCount: (cardProperties || []).length,
    });

    sendResponse({ badgeProperties, tableProperties, cardProperties, debugInfo: diag || undefined });

    // If extras were not ready, recompute and push an update to the same tab when they arrive
    extrasPromise.then(async lateExtras => {
      if (!lateExtras || Object.keys(lateExtras).length === 0) return;
      try {
        const nw2 = { ...neighbourhoodWithMeta, ...lateExtras };
        const props2 = getProperties(nw2, userSettings);
        if (requestTabId) {
          chrome.tabs && chrome.tabs.sendMessage(requestTabId, {
            action: 'neighbourhoodUpdate',
            badgeProperties: props2.badgeProperties,
            tableProperties: props2.tableProperties,
            cardProperties: props2.cardProperties,
            debugInfo: diag || undefined,
          });
        }
      } catch (e) {
        console.warn('[FundaNeighbourhoods][bg] Failed to push late update', e);
      }
    });
  });

  return true;
});
