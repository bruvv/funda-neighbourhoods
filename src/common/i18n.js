import { readUserSettings } from "./readUserSettings";

let cachedLanguage;
let cachedMessages;

export async function applySelectedLanguage(preferredLanguage) {
  const browserLanguage = chrome.i18n.getUILanguage().startsWith("nl") ? "nl" : "en";
  let language = preferredLanguage;
  if (!language) {
    const { language: storedLanguage } = await readUserSettings();
    language = storedLanguage || browserLanguage;
  }
  if (language !== browserLanguage && language !== cachedLanguage) {
    const url = chrome.runtime.getURL(`_locales/${language}/messages.json`);
    try {
      const response = await fetch(url);
      cachedMessages = await response.json();
      chrome.i18n.getMessage = key => (cachedMessages[key] && cachedMessages[key].message) || "";
      cachedLanguage = language;
    } catch (e) {
      try { console.warn('[FundaNeighbourhoods][i18n] Failed to load locale messages directly; trying background', language, e && e.message); } catch {}
      // Fallback: ask background to provide messages (it can fetch extension URLs)
      try {
        const bgResp = await new Promise(resolve => {
          try { chrome.runtime.sendMessage({ action: 'getLocaleMessages', language }, resolve); }
          catch (_) { resolve(null); }
        });
        if (bgResp && bgResp.messages) {
          cachedMessages = bgResp.messages;
          chrome.i18n.getMessage = key => (cachedMessages[key] && cachedMessages[key].message) || "";
          cachedLanguage = language;
        } else {
          cachedLanguage = browserLanguage; // use default UI language
        }
      } catch (_) {
        // Final fallback: keep default chrome.i18n messages (browser UI language)
        cachedLanguage = browserLanguage;
      }
    }
  }
  return language;
}
