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
    const response = await fetch(url);
    cachedMessages = await response.json();
    chrome.i18n.getMessage = key => (cachedMessages[key] && cachedMessages[key].message) || "";
    cachedLanguage = language;
  }
  return language;
}
