import { readUserSettings } from "../common/readUserSettings";
import { fetchNeighbourhoodStats, fetchNeighbourhoodMeta } from "./api";

import { getProperties, selectDefaultProperties } from "./utils";

chrome.runtime.onInstalled.addListener(selectDefaultProperties);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("[FundaNeighbourhoods][bg] onMessage", request);
  if (request.action === "openOptionsPage") {
    chrome.runtime.openOptionsPage();
    return;
  }

  const { zipCode, addressQuery } = request;

  fetchNeighbourhoodMeta(zipCode, addressQuery).then(async neighbourhoodMeta => {
    if (neighbourhoodMeta.error) {
      console.error("[FundaNeighbourhoods][bg] Meta error", neighbourhoodMeta.error);
      sendResponse({ error: neighbourhoodMeta.error });
      return;
    }

    const { neighbourhoodCode, neighbourhoodName, municipalityName } = neighbourhoodMeta;
    console.log("[FundaNeighbourhoods][bg] Meta", { neighbourhoodCode, neighbourhoodName, municipalityName });

    const neighbourhood = await fetchNeighbourhoodStats(neighbourhoodCode);
    console.log("[FundaNeighbourhoods][bg] Stats keys", neighbourhood ? Object.keys(neighbourhood).length : 0);

    const neighbourhoodWithMeta = {
      neighbourhoodName: { value: neighbourhoodName },
      municipalityName: { value: municipalityName },
      ...neighbourhood,
    };

    const userSettings = await readUserSettings();
    console.log("[FundaNeighbourhoods][bg] User settings", userSettings);

    const { badgeProperties, tableProperties, cardProperties } = getProperties(neighbourhoodWithMeta, userSettings);
    console.log("[FundaNeighbourhoods][bg] Computed properties", {
      badgeCount: Object.keys(badgeProperties || {}).length,
      tableCount: (tableProperties || []).length,
      cardCount: (cardProperties || []).length,
    });

    sendResponse({ badgeProperties, tableProperties, cardProperties });
  });

  return true;
});
