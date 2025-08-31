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

// CBS Politie monthly crimes dataset (via StatLine Open Data hosted on dataderden)
const CBS_ODATA3_BASE = 'https://dataderden.cbs.nl/ODataApi/odata';
const POLICE_DATASET_ID = '47022NED'; // Geregistreerde misdrijven; wijk/buurt; maandcijfers

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

export async function fetchNeighbourhoodStats(neighbourhoodCode, diag = null) {
  const neighbourhoodStatsWithYears = await getNeighbourhoodStatsWithYears(neighbourhoodCode);

  const merged = mergeYearlyData(neighbourhoodStatsWithYears);

  // Fetch up-to-date crime total for latest month and compute a safety score
  try {
    const latestPeriod = await getLatestCrimePeriodKey(diag || undefined);
    if (diag) diag.push(`[Crime] latest period ${latestPeriod || 'unknown'}`);
    dbg('Crime latest period', latestPeriod);
    if (latestPeriod) {
      const totalCrimes = await fetchLatestCrimeTotalForBuurt(neighbourhoodCode, latestPeriod, diag || undefined);
      if (typeof totalCrimes === 'number' && totalCrimes >= 0) {
        // Try to normalize by population if available
        const residentsKey = Object.keys(merged).find(k => k && k.indexOf('AantalInwoners') === 0);
        const residents = residentsKey && merged[residentsKey] && typeof merged[residentsKey].value === 'number'
          ? merged[residentsKey].value
          : null;
        const perThousand = residents && residents > 0 ? (totalCrimes / residents) * 1000 : null;
        const score = computeCrimeScoreFromMonthly(perThousand, totalCrimes);
        const periodLabel = toPeriodLabel(latestPeriod);
        if (typeof score === 'number') {
          merged.crimeScore = { value: score, year: periodLabel };
          if (diag) diag.push(`[Crime] crimes=${totalCrimes} residents=${residents} per1000=${perThousand && perThousand.toFixed ? perThousand.toFixed(2) : perThousand} score=${score}`);
          dbg('Crime computed', { totalCrimes, residents, perThousand, score, periodLabel });
        } else {
          // Ensure property exists to render 'no info' with period
          merged.crimeScore = { value: null, year: periodLabel };
        }
      }
      // If request succeeded but didn't yield a number, ensure the property exists with period
      if (!merged.crimeScore) { merged.crimeScore = { value: null, year: toPeriodLabel(latestPeriod) }; }
    }
  } catch (e) {
    try { if (diag) diag.push(`[Crime] error ${e && e.message}`); } catch (_) {}
    dbg('Crime error', e && e.message);
  }

  // Historical fallback if monthly query didn’t provide a score
  if (!merged.crimeScore || typeof merged.crimeScore.value !== 'number') {
    try {
      const hist = computeCrimeScoreFromHistorical(merged, diag || undefined);
      if (hist && typeof hist.value === 'number') {
        merged.crimeScore = hist; // { value, year }
        if (diag) diag.push(`[Crime] fallback historical score ${hist.value} (${hist.year})`);
        dbg('Crime fallback (historical)', hist);
      }
    } catch (e) {
      dbg('Crime historical compute error', e && e.message);
    }
  }

  return merged;
}

// --- Extra data: PDOK WFS polygon -> centroid, Overpass amenities (schools) ---
async function fetchBuurtCentroid(neighbourhoodCode, diag = []) {
  // cache first
  const cacheKey = `centroid:${neighbourhoodCode}`;
  const cached = await getFromStorage(cacheKey);
  if (cached && cached.t && (nowMs() - cached.t) < 7 * 24 * 60 * 60 * 1000) {
    dbg('WFS centroid cache hit');
    diag.push(`[WFS] centroid cache hit for ${neighbourhoodCode}`);
    return cached.v;
  }

  // Try CBS buurt 2021 WFS layer
  const url = `https://geodata.nationaalgeoregister.nl/wijkenbuurten2021/wfs?service=WFS&version=2.0.0&request=GetFeature&typeName=wijkenbuurten:buurt_2021&srsName=EPSG:4326&outputFormat=application/json&cql_filter=buurtcode='${encodeURIComponent(
    neighbourhoodCode
  )}'`;
  try {
    dbg('WFS centroid request', url);
    diag.push(`[WFS] request ${url}`);
    const res = await fetchWithTimeout(url, { timeout: 5000 });
    if (!res.ok) { diag.push(`[WFS] status ${res.status}`); return null; }
    const gj = await res.json();
    const feat = gj && gj.features && gj.features[0];
    if (!feat || !feat.geometry) { diag.push('[WFS] no features'); return null; }
    let centroid = geometryCentroid(feat.geometry);
    // If the numbers look like RD New (EPSG:28992), convert to WGS84
    if (centroid && (Math.abs(centroid.lon) > 180 || Math.abs(centroid.lat) > 90)) {
      diag.push('[WFS] centroid looked like RD; converted to WGS84');
      centroid = rdToWgs(centroid.lon, centroid.lat);
    }
    dbg('WFS centroid', centroid);
    diag.push(`[WFS] centroid ${JSON.stringify(centroid)}`);
    await setInStorage(cacheKey, { t: nowMs(), v: centroid });
    return centroid; // {lat, lon}
  } catch (e) {
    dbg('WFS centroid error', e);
    diag.push(`[WFS] error ${e && e.message}`);
    return null;
  }
}

function geometryCentroid(geom) {
  // Very simple centroid for Polygon/MultiPolygon
  const coordsList = [];
  if (geom.type === 'Polygon') {
    coordsList.push(...geom.coordinates[0]);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) coordsList.push(...poly[0]);
  } else {
    return null;
  }
  let sx = 0,
    sy = 0;
  for (const [x, y] of coordsList) {
    sx += x;
    sy += y;
  }
  const n = coordsList.length || 1;
  return { lon: sx / n, lat: sy / n };
}

// Convert RD New (EPSG:28992) to WGS84 (EPSG:4326)
// Based on Rijksdriehoeksstelsel formulas (approximate, sufficient for centroid positioning)
function rdToWgs(x, y) {
  // Reference point Amersfoort
  const x0 = 155000.0;
  const y0 = 463000.0;
  const dx = (x - x0) * 1e-5;
  const dy = (y - y0) * 1e-5;

  const lat = 52.15517440 +
    (3235.65389 * dy + -32.58297 * dx*dx + -0.24750 * dy*dy + -0.84978 * dx*dx*dy + -0.06550 * dy*dy*dy) / 3600.0;
  const lon = 5.38720621 +
    (0.01199 * dx + 0.09364 * dx*dy + -0.11877 * dx*dy*dy + 0.00026 * dx*dx*dx) / 3600.0 * 1000; // scale small terms

  return { lat, lon };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

async function fetchAmenityStatsAround(centroid, amenity, diag = [], radius = 3000) {
  const bases = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
  ];
  // Include nodes, ways, relations; consider related amenities (kindergarten/college) for schools view
  const extra = amenity === 'school' ? `
    node["amenity"="kindergarten"](around:${radius},${centroid.lat},${centroid.lon});
    node["amenity"="college"](around:${radius},${centroid.lat},${centroid.lon});
    way["amenity"="school"](around:${radius},${centroid.lat},${centroid.lon});
    relation["amenity"="school"](around:${radius},${centroid.lat},${centroid.lon});
  ` : '';
  const query = `data=[out:json][timeout:25];(
    node["amenity"="${amenity}"](around:${radius},${centroid.lat},${centroid.lon});
    ${extra}
  );out center;`;
  for (const base of bases) {
    const url = `${base}?${query}`;
    try {
      dbg('Overpass request', { amenity, url });
      diag.push(`[Overpass] try ${base}`);
      const res = await fetchWithTimeout(url, { method: 'GET', timeout: 6000 });
      if (!res.ok) { diag.push(`[Overpass] ${base} status ${res.status}`); continue; }
      const json = await res.json();
      const elements = json && json.elements ? json.elements : [];
      const distances = elements
        .map(el => {
          const lat = el.lat || (el.center && el.center.lat);
          const lon = el.lon || (el.center && el.center.lon);
          if (typeof lat !== 'number' || typeof lon !== 'number') return null;
          return haversineMeters(centroid.lat, centroid.lon, lat, lon);
        })
        .filter(v => typeof v === 'number');
      const count = distances.length;
      const avgDistance = count ? Math.round(distances.reduce((a, b) => a + b, 0) / count) : null;
      dbg('Overpass stats', { amenity, count, avgDistance, base });
      diag.push(`[Overpass] ok ${base} count ${count} avg ${avgDistance}`);
      return { count, avgDistance };
    } catch (e) {
      dbg('Overpass error', { base, error: e && e.message });
      diag.push(`[Overpass] error ${base} ${e && e.message}`);
      continue;
    }
  }
  return { count: 0, avgDistance: null };
}

export async function fetchAmenitiesExtras(neighbourhoodCode, diag = [], addressQuery) {
  const cacheKey = `amenities:${neighbourhoodCode}`;
  const cached = await getFromStorage(cacheKey);
  if (cached && cached.t && (nowMs() - cached.t) < 7 * 24 * 60 * 60 * 1000) {
    dbg('Amenities cache hit');
    diag.push('[Amenities] cache hit');
    return cached.v;
  }

  let centroid = await fetchBuurtCentroid(neighbourhoodCode, diag);
  if (!centroid && addressQuery) {
    diag.push('[Amenities] fallback: geocoding address centroid');
    centroid = await geocodeAddressCentroid(addressQuery, diag);
  }
  if (!centroid) { diag.push('[Amenities] no centroid'); return {}; }

  const amenityConfigs = [
    { amenity: 'school', countKey: 'schoolsInNeighbourhood', distKey: 'avgDistanceToSchools' },
    { amenity: 'doctors', countKey: 'gpsInNeighbourhood', distKey: 'avgDistanceToGps' },
    { amenity: 'childcare', countKey: 'afterSchoolCareInNeighbourhood', distKey: 'avgDistanceToAfterSchoolCare' },
    { amenity: 'kindergarten', countKey: 'daycareInNeighbourhood', distKey: 'avgDistanceToDaycare' },
    { amenity: 'restaurant', countKey: 'restaurantsInNeighbourhood', distKey: 'avgDistanceToRestaurants' },
    { amenity: 'supermarket', countKey: 'supermarketsInNeighbourhood', distKey: 'avgDistanceToSupermarkets' },
    { amenity: 'cafe', countKey: 'cafesInNeighbourhood', distKey: 'avgDistanceToCafes' },
  ];

  const v = {};
  for (const cfg of amenityConfigs) {
    const stats = await fetchAmenityStatsAround(centroid, cfg.amenity, diag);
    v[cfg.countKey] = { value: stats.count };
    v[cfg.distKey] = { value: stats.avgDistance };
  }

  await setInStorage(cacheKey, { t: nowMs(), v });
  return v;
}

async function geocodeAddressCentroid(addressQuery, diag = []) {
  try {
    const suggestUrl = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest?q=${encodeURIComponent(addressQuery)}`;
    diag.push(`[Geo] suggest ${suggestUrl}`);
    const sres = await fetchWithTimeout(suggestUrl, { timeout: 5000 });
    if (!sres.ok) { diag.push(`[Geo] suggest status ${sres.status}`); return null; }
    const sjson = await sres.json();
    const doc = (sjson && sjson.response && sjson.response.docs || []).find(d => d.type === 'adres');
    if (!doc || !doc.id) { diag.push('[Geo] suggest no adres doc'); return null; }
    const lookupUrl = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/lookup?id=${encodeURIComponent(doc.id)}`;
    diag.push(`[Geo] lookup ${lookupUrl}`);
    const lres = await fetchWithTimeout(lookupUrl, { timeout: 5000 });
    if (!lres.ok) { diag.push(`[Geo] lookup status ${lres.status}`); return null; }
    const ljson = await lres.json();
    const ldoc = (ljson && ljson.response && ljson.response.docs || [])[0];
    const wkt = ldoc && (ldoc.centroide_ll || ldoc.geometrie_ll);
    if (!wkt || typeof wkt !== 'string') { diag.push('[Geo] no centroide_ll'); return null; }
    const m = wkt.match(/POINT\s*\(([-0-9.]+)\s+([-0-9.]+)\)/);
    if (!m) { diag.push('[Geo] invalid WKT'); return null; }
    const lon = parseFloat(m[1]);
    const lat = parseFloat(m[2]);
    if (!isFinite(lat) || !isFinite(lon)) { diag.push('[Geo] NaN centroid'); return null; }
    const c = { lat, lon };
    diag.push(`[Geo] centroid from address ${JSON.stringify(c)}`);
    return c;
  } catch (e) {
    diag.push(`[Geo] error ${e && e.message}`);
    return null;
  }
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

// --- Crime (CBS Politie monthly) ---
async function getLatestCrimePeriodKey(diag = undefined) {
  // Try current year, else fallback up to 4 previous years
  const y0 = new Date().getFullYear();
  for (let y = y0; y >= y0 - 4; y--) {
    const url = `${CBS_ODATA3_BASE}/${POLICE_DATASET_ID}/Perioden?$select=Key&$filter=substring(Key,0,4)%20eq%20'${y}'&$format=json`;
    try {
      const res = await fetchWithTimeout(url, { timeout: 6000 });
      if (!res.ok) { if (diag) diag.push(`[Crime] period ${y} status ${res.status}`); continue; }
      const json = await res.json();
      const keys = (json && json.value || []).map(r => r.Key).filter(Boolean);
      if (keys.length) {
        // Keys are lexical; pick the max for latest month
        keys.sort();
        return keys[keys.length - 1];
      }
    } catch (e) {
      if (diag) diag.push(`[Crime] period fetch error ${y} ${e && e.message}`);
      continue;
    }
  }
  return null;
}

async function fetchLatestCrimeTotalForBuurt(neighbourhoodCode, periodKey, diag = undefined) {
  // Total misdrijven key in SoortMisdrijf dimension is '0.0.0'
  const smKey = encodeURIComponent("0.0.0");
  const filter = `$filter=WijkenEnBuurten%20eq%20'${encodeURIComponent(neighbourhoodCode)}'%20and%20SoortMisdrijf%20eq%20'${smKey}'%20and%20Perioden%20eq%20'${encodeURIComponent(periodKey)}'`;
  const select = `$select=GeregistreerdeMisdrijven_1`;
  const url = `${CBS_ODATA3_BASE}/${POLICE_DATASET_ID}/TypedDataSet?${filter}&${select}&$top=1&$format=json`;
  try {
    dbg('Crime fetch URL', url);
    const res = await fetchWithTimeout(url, { timeout: 6000 });
    if (!res.ok) { if (diag) diag.push(`[Crime] data status ${res.status}`); return null; }
    const json = await res.json();
    const v0 = json && json.value && json.value[0];
    const n = v0 && (typeof v0.GeregistreerdeMisdrijven_1 === 'number' ? v0.GeregistreerdeMisdrijven_1 : null);
    if (diag) diag.push(`[Crime] total ${n}`);
    dbg('Crime total', n);
    return typeof n === 'number' ? n : null;
  } catch (e) {
    if (diag) diag.push(`[Crime] data error ${e && e.message}`);
    dbg('Crime data error', e && e.message);
    return null;
  }
}

function computeCrimeScoreFromMonthly(perThousand, rawTotal) {
  // If population unknown, fallback to raw total thresholding (less ideal)
  if (typeof perThousand === 'number' && isFinite(perThousand)) {
    // Simple mapping: 0/1000 -> 100; 10/1000 -> 0
    const unsafe = Math.max(0, Math.min(100, Math.round(perThousand * 10)));
    return 100 - unsafe;
  }
  // Fallback: 0 -> 100, >=40 incidents -> 0 (for a month in a buurt)
  if (typeof rawTotal === 'number' && isFinite(rawTotal)) {
    const unsafe = Math.max(0, Math.min(100, Math.round(rawTotal * 2.5)));
    return 100 - unsafe;
  }
  return null;
}

function toPeriodLabel(periodKey) {
  // Convert 'YYYYMMXX' to 'YYYY-MM' (month), ignore XX suffix
  if (!periodKey || typeof periodKey !== 'string' || periodKey.length < 6) return periodKey;
  const y = periodKey.slice(0, 4);
  const m = periodKey.slice(4, 6).replace(/^MM/, '');
  const mm = /^\d+$/.test(m) ? m : periodKey.slice(4, 6);
  return `${y}-${mm}`;
}

// Historical indicators (2016–2018) fallback computation
function computeCrimeScoreFromHistorical(props, diag) {
  if (!props || typeof props !== 'object') return null;
  const keys = Object.keys(props);
  function latestFor(base) {
    const matches = keys
      .filter(k => k && (k === base || k.startsWith(base + '_')))
      .map(k => ({ key: k, year: props[k] && props[k].year, value: props[k] && props[k].value }))
      .filter(r => r && typeof r.value === 'number' && isFinite(r.value));
    if (!matches.length) return null;
    matches.sort((a, b) => (b.year || 0) - (a.year || 0));
    return matches[0];
  }
  const a = latestFor('GeweldsEnSeksueleMisdrijven');
  const b = latestFor('VernielingMisdrijfTegenOpenbareOrde');
  const picks = [a, b].filter(Boolean);
  if (diag) diag.push(`[Crime] hist indicators ${picks.map(i => `${i.key}:${i.value}@${i.year}`).join(', ') || 'none'}`);
  if (!picks.length) return null;
  const sum = picks.reduce((acc, i) => acc + (typeof i.value === 'number' ? i.value : 0), 0);
  const unsafe = Math.max(0, Math.min(100, Math.round(sum * 5)));
  return { value: 100 - unsafe, year: (picks[0].year || '').toString() };
}

// --- helpers (timeouts + simple storage cache) ---
async function fetchWithTimeout(url, { method = 'GET', headers, body, timeout = 5000 } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function nowMs() { return Date.now(); }

function getFromStorage(key) {
  return new Promise(resolve => {
    try { chrome.storage && chrome.storage.local && chrome.storage.local.get(key, obj => resolve(obj && obj[key])); }
    catch (e) { resolve(null); }
  });
}

function setInStorage(key, value) {
  return new Promise(resolve => {
    try { chrome.storage && chrome.storage.local && chrome.storage.local.set({ [key]: value }, () => resolve()); }
    catch (e) { resolve(); }
  });
}
