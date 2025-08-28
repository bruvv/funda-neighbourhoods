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

// PDOK search base (v3_1 is current)
const PDOK_SEARCH_BASE = "https://api.pdok.nl/bzk/locatieserver/search/v3_1";

async function pdokSuggest(q) {
  const url = `${PDOK_SEARCH_BASE}/suggest?q=${encodeURIComponent(q)}`;
  dbg("PDOK suggest", url);
  try {
    const res = await fetch(url);
    dbg("PDOK suggest status", { ok: res.ok, status: res.status });
    if (!res.ok) return [];
    const json = await res.json();
    const docs = (json && json.response && json.response.docs) || [];
    dbg("PDOK suggest docs", docs.length);
    return docs;
  } catch (e) {
    dbg("PDOK suggest error", e);
    return [];
  }
}

async function pdokLookup(id) {
  const url = `${PDOK_SEARCH_BASE}/lookup?id=${encodeURIComponent(id)}`;
  dbg("PDOK lookup", url);
  try {
    const res = await fetch(url);
    dbg("PDOK lookup status", { ok: res.ok, status: res.status });
    if (!res.ok) return null;
    const json = await res.json();
    const docs = (json && json.response && json.response.docs) || [];
    return docs[0] || null;
  } catch (e) {
    dbg("PDOK lookup error", e);
    return null;
  }
}

function extractMetaFromDoc(doc) {
  if (!doc) return {};
  const neighbourhoodCode = doc.buurtcode || doc.buurt_code || doc.BU_CODE;
  const neighbourhoodName = doc.buurtnaam || doc.buurt_naam || doc.BU_NAAM || doc.buurtnaam_nn;
  const municipalityName = doc.gemeentenaam || doc.GM_NAAM || doc.gemeente || doc.gemeente_naam || doc.woonplaatsnaam;
  return { neighbourhoodCode, neighbourhoodName, municipalityName };
}

function makeAddressVariants(addressQuery, zipCode) {
  const base = (addressQuery || "").trim();
  const normalized = base.replace(/\s*-\s*/g, "-").replace(/\s+/g, " ");
  const removedDash = normalized.replace(/(\d+)-([A-Za-z])\b/, "$1 $2");
  const withoutZip = normalized.replace(new RegExp(zipCode + "$"), "").trim();
  const frontZip = `${zipCode} ${withoutZip}`.trim();
  const variants = [normalized, removedDash, withoutZip, frontZip].filter(Boolean);
  return Array.from(new Set(variants));
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
    // 1) Try suggest + lookup using address variants when available
    if (addressQuery) {
      const variants = makeAddressVariants(addressQuery, zipCode);
      for (const v of variants) {
        const sdocs = await pdokSuggest(v);
        const candidates = sdocs.filter(d => d && d.type === "adres");
        dbg("PDOK suggest candidates", candidates.length, v);
        for (const cand of candidates) {
          if (!cand.id) continue;
          // If cand has postcode, prefer match
          if (cand.postcode && cand.postcode.replace(/\s/g, "") !== zipCode) continue;
          const full = await pdokLookup(cand.id);
          const meta = extractMetaFromDoc(full);
          dbg("PDOK lookup meta", meta);
          if (meta.neighbourhoodCode) {
            return meta;
          }
        }
      }
    }

    const baseUrls = [
      // PDOK new platform (recommended)
      "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free",
      // Legacy NGR endpoint (still widely used)
      "https://geodata.nationaalgeoregister.nl/locatieserver/v3/free",
    ];

    for (const params of attempts) {
      // Also ask for the fields we need when possible
      const urlParametersString = getParametersString({ ...params, fl: "id,buurtcode,buurtnaam,gemeentenaam,weergavenaam,type,postcode" });

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

        // Prefer type:adres
        let selected = docs.find(doc => doc && doc.type === "adres");
        if (!selected) selected = docs[0];

        if (!selected) {
          dbg("Locatieserver: no docs for attempt", params.note, "base", base);
          // Try next base URL for same params
          continue;
        }

        let { neighbourhoodCode, neighbourhoodName, municipalityName } = extractMetaFromDoc(selected);

        // If fields missing, do a lookup by id to get full record
        if ((!neighbourhoodCode || !neighbourhoodName || !municipalityName) && selected.id) {
          const lookupBase = base.includes("search/") ? base.replace(/free$/, "lookup") : base.replace(/\/v3\/free$/, "/v3/lookup");
          const lookupUrl = `${lookupBase}?id=${encodeURIComponent(selected.id)}`;
          dbg("Locatieserver lookup", { lookupUrl });
          try {
            const lookupRes = await fetch(lookupUrl);
            dbg("Locatieserver lookup response", { ok: lookupRes.ok, status: lookupRes.status, statusText: lookupRes.statusText });
            if (lookupRes.ok) {
              const lookupJson = await lookupRes.json();
              const ldocs = (lookupJson && lookupJson.response && lookupJson.response.docs) || [];
              if (ldocs.length) {
                const full = ldocs[0];
                neighbourhoodCode = neighbourhoodCode || full.buurtcode || full.buurt_code || full.BU_CODE;
                neighbourhoodName = neighbourhoodName || full.buurtnaam || full.buurt_naam || full.BU_NAAM || full.buurtnaam_nn;
                municipalityName = municipalityName || full.gemeentenaam || full.GM_NAAM || full.gemeente || full.gemeente_naam;
              }
            }
          } catch (lookupErr) {
            dbg("Locatieserver lookup error", lookupErr);
          }
        }

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
