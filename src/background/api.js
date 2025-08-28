const STATS_API_ID_BY_YEAR = {
  2015: "83220NED",
  2016: "83487NED",
  2017: "83765NED",
  2018: "84286NED",
  2019: "84583NED",
  2020: "84799NED",
  2021: "85039NED",
};

function dbg(...args) {
  // Background/service worker console
  try {
    console.log("[FundaNeighbourhoods][bg][api]", ...args);
  } catch (_) {}
}

export async function fetchNeighbourhoodMeta(zipCode, addressQuery) {
  // Try a targeted postcode search first, then fall back to a generic search
  const attempts = [
    ...(addressQuery
      ? [{ q: addressQuery, fq: `type:adres`, rows: 10, note: "address+postcode" }]
      : []),
    { q: zipCode, fq: `type:adres AND postcode:${zipCode}`, rows: 5, note: "adres+postcode" },
    { q: zipCode, fq: `postcode:${zipCode}`, rows: 5, note: "postcode-only" },
    { q: zipCode, fq: "type:adres", rows: 5, note: "adres-generic" },
  ];

  try {
    const baseUrls = [
      "https://geodata.nationaalgeoregister.nl/locatieserver/v3/free",
      "https://api.pdok.nl/bzk/locatieserver/v3/free",
      "https://api.pdok.nl/bzk/locatieserver/search/v3/free",
    ];

    for (const params of attempts) {
      const urlParametersString = getParametersString(params);

      for (const base of baseUrls) {
        const requestUrl = `${base}?${urlParametersString}`;

        dbg("Locatieserver request", { zipCode, params, requestUrl });

        let response;
        try {
          response = await fetch(requestUrl);
        } catch (networkErr) {
          dbg("Locatieserver network error", networkErr);
          continue; // try next base
        }

        dbg("Locatieserver response", { ok: response.ok, status: response.status, statusText: response.statusText });

        if (!response.ok) {
          // Try next base URL for this attempt
          continue;
        }

        const responseJson = await response.json().catch(err => {
          dbg("Locatieserver JSON parse error", err);
          throw err;
        });

        const docs = (responseJson && responseJson.response && responseJson.response.docs) || [];
        dbg("Locatieserver docs count", docs.length);
        if (docs.length > 0) {
          const sample = docs[0];
          dbg("Locatieserver first doc keys", Object.keys(sample || {}));
        }

        const selected = docs.find(doc => doc && (doc.buurtcode || doc.buurt_code || doc.BU_CODE)) || docs[0];

        if (!selected) {
          dbg("Locatieserver: no docs for attempt", params.note, "base", base);
          // Try next base URL for same params
          continue;
        }

        const neighbourhoodCode = selected.buurtcode || selected.buurt_code || selected.BU_CODE;
        const neighbourhoodName = selected.buurtnaam || selected.buurt_naam || selected.BU_NAAM || selected.buurtnaam_nn;
        const municipalityName = selected.gemeentenaam || selected.GM_NAAM || selected.gemeente || selected.gemeente_naam;

        dbg("Locatieserver selected", { neighbourhoodCode, neighbourhoodName, municipalityName });

        if (neighbourhoodCode) {
          return { neighbourhoodCode, neighbourhoodName, municipalityName };
        }
        // If selected without code, fall through to next base/attempt
      }
    }

    const msg = `No buurtcode found for zipCode ${zipCode} in Locatieserver response`;
    dbg(msg);
    return { error: msg };
  } catch (error) {
    const msg = `Failed to fetch neighbourhood meta for zipCode ${zipCode}. Additional info: ${error.message}`;
    dbg(msg, error && error.stack ? error.stack : error);
    return { error: msg };
  }
}

export async function fetchNeighbourhoodStats(neighbourhoodCode) {
  const neighbourhoodStatsWithYears = await getNeighbourhoodStatsWithYears(neighbourhoodCode);

  return mergeYearlyData(neighbourhoodStatsWithYears);
}

async function getNeighbourhoodStatsWithYears(neighbourhoodCode) {
  const years = Object.keys(STATS_API_ID_BY_YEAR);

  const requests = years.map(async year => {
    const apiId = STATS_API_ID_BY_YEAR[year];

    dbg("CBS fetch start", { year, apiId, neighbourhoodCode });
    const neighbourhoodDataForYear = await fetchDataForYear(apiId, neighbourhoodCode);

    if (!neighbourhoodDataForYear) {
      console.error("[FundaNeighbourhoods][bg][api] Failed to fetch neighbourhood stats", { year, apiId, neighbourhoodCode });
      return null;
    }

    return processNeighbourhoodDataFromApi(year, neighbourhoodDataForYear);
  });

  const yearlyDataForNeighbourhood = await Promise.all(requests);

  return yearlyDataForNeighbourhood.filter(dataForYear => dataForYear !== null);
}

async function fetchDataForYear(apiId, neighbourhoodCode) {
  const parameters = `$filter=WijkenEnBuurten eq '${neighbourhoodCode}'`;
  const requestUrl = `https://opendata.cbs.nl/ODataApi/odata/${apiId}/TypedDataSet?${parameters}`;

  try {
    dbg("CBS request", { requestUrl });
    const response = await fetch(requestUrl);
    dbg("CBS response", { ok: response.ok, status: response.status, statusText: response.statusText });
    const responseJson = await response.json().catch(err => {
      dbg("CBS JSON parse error", err);
      throw err;
    });
    const len = Array.isArray(responseJson.value) ? responseJson.value.length : 0;
    dbg("CBS value length", len);
    const first = len > 0 ? Object.keys(responseJson.value[0] || {}).slice(0, 10) : [];
    dbg("CBS first record keys", first);
    return responseJson.value && responseJson.value[0] ? responseJson.value[0] : null;
  } catch (error) {
    console.error("[FundaNeighbourhoods][bg][api] CBS fetch error", { apiId, neighbourhoodCode, requestUrl, error });
    return null;
  }
}

function mergeYearlyData(yearlyData) {
  return Object.assign({}, ...yearlyData);
}

function removeEmptyFields(dataForYear) {
  const entries = Object.entries(dataForYear);
  const nonEmptyEntries = entries.filter(([, value]) => value !== null);
  return Object.fromEntries(nonEmptyEntries);
}

function addYearToEveryField(dataForYear, year) {
  const entries = Object.entries(dataForYear);
  const entriesWithYears = entries.map(([fieldName, fieldValue]) => [
    fieldName,
    { year: Number(year), value: fieldValue },
  ]);
  return Object.fromEntries(entriesWithYears);
}

function processNeighbourhoodDataFromApi(year, dataForYear) {
  const withoutEmptyFields = removeEmptyFields(dataForYear);
  const withYears = addYearToEveryField(withoutEmptyFields, year);
  return withYears;
}

function getParametersString(parameters) {
  return Object.entries(parameters)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");
}
