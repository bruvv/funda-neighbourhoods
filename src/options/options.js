import { readUserSettings } from "../common/readUserSettings";
import { VIEWABLE_PROPERTIES } from "../common/viewableProperties";
import { groupProperties } from "../common/utils";
import { applySelectedLanguage } from "../common/i18n";

initializePage();

async function initializePage() {
  const userSettings = await readUserSettings();

  const selectedLanguage = await applySelectedLanguage(userSettings.language);

  const headerHtml = makeHeaderHtml();
  const languageSwitchHtml = makeLanguageSwitchHtml(selectedLanguage);
  const optionsTableHtml = makeOptionsTableHtml(userSettings);

  document
    .getElementById("header")
    .insertAdjacentHTML("afterbegin", headerHtml);

  document
    .getElementById("language-switch")
    .insertAdjacentHTML("afterbegin", languageSwitchHtml);

  document
    .getElementById("options-table")
    .insertAdjacentHTML("afterbegin", optionsTableHtml);

  document.addEventListener("click", handleClicks);

  document
    .getElementById("language-switch-select")
    .addEventListener("change", handleLanguageChange);
}

function makeHeaderHtml() {
  return `<h3>${chrome.i18n.getMessage("selectBadges")}</h3>`;
}

function makeLanguageSwitchHtml(selectedLanguage) {
  const languageLabel = chrome.i18n.getMessage("selectLanguage");
  const englishLabel = chrome.i18n.getMessage("english");
  const dutchLabel = chrome.i18n.getMessage("dutch");
  const enSelected = selectedLanguage === "en" ? "selected" : "";
  const nlSelected = selectedLanguage === "nl" ? "selected" : "";

  return `
    <div class="options-page-row">
      <div class="options-page-label-container">
        <label class="options-page-label" for="language-switch-select">
          ${languageLabel}
        </label>
      </div>
      <div class="options-page-select-container">
        <select id="language-switch-select" data-test="languageSelect">
          <option value="en" ${enSelected}>${englishLabel}</option>
          <option value="nl" ${nlSelected}>${dutchLabel}</option>
        </select>
      </div>
    </div>
  `;
}

function makeOptionsTableHtml(userSettings) {
  const groupedProperties = groupProperties(VIEWABLE_PROPERTIES);
  const groupNames = Object.keys(groupedProperties);

  return groupNames
    .map(groupName => {
      const headerHtml = makeSectionHeaderHtml(groupName);

      const group = groupedProperties[groupName];
      const optionsSectionHtml = makeOptionsSectionHtml(group, userSettings);

      return headerHtml + optionsSectionHtml;
    })
    .join("");
}

function makeOptionHtml(optionName, userSettings) {
  const label = chrome.i18n.getMessage(optionName);
  const checked = userSettings[optionName] ? "checked" : "";

  return `
    <div class="options-page-row">
        <div class="options-page-checkbox-container">
          <input
            ${checked}
            id="${optionName}"
            class="options-page-checkbox"
            type="checkbox"
            data-option-name="${optionName}"
            data-test="optionsPagePropertyCheckbox-${optionName}"
          />
        </div>
        <div class="options-page-label-container">
          <label
            class="options-page-label"
            for="${optionName}"
            data-test="optionsPagePropertyLabel-${optionName}"
          >
            ${label}
          </label>
        </div>
    </div>
  `;
}

function handleClicks(event) {
  const clickedElement = event.target;
  const clickedOptionName = clickedElement.dataset.optionName;
  const isOptionClick = clickedOptionName !== undefined;

  if (isOptionClick) {
    chrome.storage.sync.set({ [clickedOptionName]: clickedElement.checked });
  }
}

function handleLanguageChange(event) {
  chrome.storage.sync.set({ language: event.target.value }, () => {
    location.reload();
  });
}

function makeSectionHeaderHtml(groupName) {
  const headerText = chrome.i18n.getMessage(groupName);

  return `
    <div class="options-page-section-header" data-test="optionsPageGroupHeader-${groupName}">
      ${headerText}
    </div>
  `;
}

function makeOptionsSectionHtml(group, userSettings) {
  return group
    .map(option => makeOptionHtml(option.name, userSettings))
    .join("");
}
