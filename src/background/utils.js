import { DEFAULT_COLOR, VALUE_FORMATS } from "../common/constants";
import { VIEWABLE_PROPERTIES } from "../common/viewableProperties";
import { findApiResponsePropertyName } from "../common/utils";

export function selectDefaultProperties({ reason }) {
  if (reason === "install") {
    chrome.storage.sync.set({
      neighbourhoodName: true,
      meanIncomePerResident: true,
    });
  }
}

export function getProperties(neighbourhoodApiResponse, userSettings) {
  const tableProperties = getTableProperties(neighbourhoodApiResponse);

  const badgeProperties = getBadgeProperties(tableProperties, userSettings);

  const cardProperties = filterTableByUserSettings(tableProperties, userSettings);

  return {
    badgeProperties,
    tableProperties,
    cardProperties,
  };
}

function getTableProperties(apiResponseProperties) {
  const nonApiProperties = VIEWABLE_PROPERTIES.filter(({ group }) => group === "doNotShowInTable");

  const apiProperties = VIEWABLE_PROPERTIES.filter(viewableProperty => {
    // Use only properties that exist in response
    const apiResponsePropertyName = findApiResponsePropertyName(apiResponseProperties, viewableProperty.apiField);
    return apiResponsePropertyName;
  });

  // Properties without apiField but present in aggregated response (extras)
  const computedProperties = VIEWABLE_PROPERTIES.filter(viewableProperty => {
    return !viewableProperty.apiField && viewableProperty.group !== 'doNotShowInTable' && apiResponseProperties.hasOwnProperty(viewableProperty.name);
  });

  const nonImmigrants = VIEWABLE_PROPERTIES.filter(({ name }) => name === "nonImmigrants");

  return [...nonApiProperties, ...apiProperties, ...computedProperties, ...nonImmigrants].map(viewableProperty =>
    getNeighbourhoodProperty(viewableProperty, apiResponseProperties)
  );
}

function getPropertyValue(propertyConfig, apiResponsePropertyName, properties) {
  const { name, apiField, valueFormat } = propertyConfig;

  if (typeof valueFormat === "function") {
    try {
      return valueFormat(apiResponsePropertyName, properties);
    } catch (e) {
      try { return chrome.i18n.getMessage("noInfo"); } catch { return "No info"; }
    }
  }

  if (valueFormat === VALUE_FORMATS.PERCENTAGE) {
    const obj = apiResponsePropertyName && properties[apiResponsePropertyName];
    const v = obj && typeof obj.value === 'number' ? obj.value : null;
    if (!isFinite(v)) { try { return chrome.i18n.getMessage("noInfo"); } catch { return "No info"; } }
    return v + "%";
  }

  if (valueFormat === VALUE_FORMATS.CONVERT_RESIDENTS_COUNT_TO_PERCENTAGE) {
    const residentsKey = findApiResponsePropertyName(properties, "AantalInwoners");
    const residentsObj = residentsKey && properties[residentsKey];
    const numeratorObj = apiResponsePropertyName && properties[apiResponsePropertyName];
    const residentsCount = residentsObj && typeof residentsObj.value === 'number' ? residentsObj.value : null;
    const numerator = numeratorObj && typeof numeratorObj.value === 'number' ? numeratorObj.value : null;
    if (!isFinite(residentsCount) || !isFinite(numerator) || residentsCount <= 0) {
      try { return chrome.i18n.getMessage("noInfo"); } catch { return "No info"; }
    }
    const shareOfResidents = numerator / residentsCount;
    const integerPercentage = Math.round(shareOfResidents * 100);
    return integerPercentage + "%";
  }

  if (apiResponsePropertyName && properties[apiResponsePropertyName] && properties[apiResponsePropertyName].hasOwnProperty('value')) {
    return properties[apiResponsePropertyName].value;
  }

  if (properties[name] && properties[name].hasOwnProperty('value')) {
    return properties[name].value;
  }
  try { return chrome.i18n.getMessage("noInfo"); } catch { return "No info"; }
}

function getNeighbourhoodProperty(propertyConfig, apiResponseProperties) {
  const { name, apiField, valueFormat, group, getColor } = propertyConfig;

  const label = chrome.i18n.getMessage(name);
  const shortLabel = chrome.i18n.getMessage(name + "Short");

  const apiResponsePropertyName = findApiResponsePropertyName(apiResponseProperties, apiField);
  let year;
  try {
    if (apiField && apiResponsePropertyName && apiResponseProperties[apiResponsePropertyName]) {
      year = apiResponseProperties[apiResponsePropertyName].year;
    }
  } catch (_) {}
  if (!year && apiResponseProperties && apiResponseProperties[name] && apiResponseProperties[name].year) {
    year = apiResponseProperties[name].year;
  }

  const value = getPropertyValue(propertyConfig, apiResponsePropertyName, apiResponseProperties);

  const color = getColor ? getColor(apiResponsePropertyName, apiResponseProperties) : DEFAULT_COLOR;

  return {
    name,
    label,
    shortLabel,
    value,
    group,
    color,
    year,
  };
}

function getBadgeProperties(tableProperties, userSettings) {
  return tableProperties.filter(({ name }) => userSettings[name] === true);
}

function filterTableByUserSettings(tableProperties, userSettings) {
  const selected = tableProperties.filter(({ name }) => userSettings[name] === true);
  // Hide non-table items like neighbourhoodName/municipalityName
  return selected.filter(p => p.group !== 'doNotShowInTable');
}
