#!/usr/bin/env node
/*
 Quick connectivity and payload checks for external URLs used by the extension.
 Works on Node 12+ (uses https module, no deps). Follow redirects and report status.
*/

const https = require('https');
const { URL } = require('url');

function httpGet(url, { maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const makeRequest = (currentUrl, redirectsLeft) => {
      const u = new URL(currentUrl);
      const req = https.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: 'GET',
          headers: { 'User-Agent': 'funda-neighbourhoods-check/1.0' },
        },
        res => {
          const { statusCode, headers } = res;
          const loc = headers.location;
          if (statusCode >= 300 && statusCode < 400 && loc && redirectsLeft > 0) {
            // Follow redirect
            const nextUrl = new URL(loc, currentUrl).toString();
            res.resume();
            makeRequest(nextUrl, redirectsLeft - 1);
            return;
          }

          let data = Buffer.alloc(0);
          res.on('data', chunk => (data = Buffer.concat([data, chunk])));
          res.on('end', () => resolve({ statusCode, headers, body: data }));
        }
      );
      req.on('error', reject);
      req.end();
    };
    makeRequest(url, maxRedirects);
  });
}

async function getJson(url) {
  const res = await httpGet(url);
  const ct = (res.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    throw new Error(`Expected JSON but got content-type: ${ct} (status ${res.statusCode})`);
  }
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch (err) {
    err.message = `Failed to parse JSON from ${url}: ${err.message}`;
    throw err;
  }
}

function logStatus(name, ok, extra = '') {
  const emoji = ok ? '✅' : '❌';
  const suffix = extra ? ` — ${extra}` : '';
  console.log(`${emoji} ${name}${suffix}`);
}

(async () => {
  console.log('Checking external URLs used by the extension...\n');

  // 1) PDOK Locatieserver (current geocoder backing geodata.nationaalgeoregister.nl)
  const sampleZip = process.env.CHECK_ZIP || '1011AB';
  try {
    // Old domain still in code
    const geoUrl = `https://geodata.nationaalgeoregister.nl/locatieserver/v3/free?q=${encodeURIComponent(
      sampleZip
    )}&fq=type:adres&rows=1`;
    const geoJson = await getJson(geoUrl);
    const doc = geoJson && geoJson.response && geoJson.response.docs && geoJson.response.docs[0];
    const buurtcode = doc && (doc.buurtcode || doc.buurt_code || doc.BU_CODE);
    logStatus('Locatieserver (NGR) free', Boolean(buurtcode), `buurtcode: ${buurtcode || 'n/a'}`);
  } catch (e) {
    logStatus('Locatieserver (NGR) free', false, e.message);
  }

  // 2) CBS OData API for a single year using the code above (if available)
  const STATS_API_ID_BY_YEAR = {
    2015: '83220NED',
    2016: '83487NED',
    2017: '83765NED',
    2018: '84286NED',
    2019: '84583NED',
    2020: '84799NED',
    2021: '85039NED',
  };

  const anyYear = Object.keys(STATS_API_ID_BY_YEAR).slice(-1)[0];
  const anyApi = STATS_API_ID_BY_YEAR[anyYear];
  try {
    // If the previous request failed, fall back to a known code for Amsterdam-Centrum (may differ by year)
    const fallbackBuurt = process.env.CHECK_BUURT || 'BU036301';
    const buurt = process.env.CHECK_BUURT || fallbackBuurt;
    const cbsUrl = `https://opendata.cbs.nl/ODataApi/odata/${anyApi}/TypedDataSet?$filter=WijkenEnBuurten%20eq%20'${encodeURIComponent(
      buurt
    )}'`;
    const cbsJson = await getJson(cbsUrl);
    const ok = Array.isArray(cbsJson.value) && cbsJson.value.length > 0;
    const firstKeys = ok ? Object.keys(cbsJson.value[0]).slice(0, 5).join(', ') : 'n/a';
    logStatus(`CBS OData (${anyApi})`, ok, `fields: ${firstKeys}`);
  } catch (e) {
    logStatus(`CBS OData (${anyApi})`, false, e.message);
  }

  // 3) Store listing URLs in README (basic status only)
  const urls = [
    { name: 'Chrome Web Store', url: 'https://chrome.google.com/webstore/detail/funda-neighbourhoods/jibdjhaojkpiagiccmolddmlhllancgj' },
    { name: 'Edge Add-ons', url: 'https://microsoftedge.microsoft.com/addons/detail/ndloapdppofpipoclcpehfijapbfbpip' },
    { name: 'Firefox Add-ons', url: 'https://addons.mozilla.org/en-US/firefox/addon/funda-neighbourhoods/' },
    { name: 'Funda domain', url: 'https://www.funda.nl/' },
  ];

  for (const { name, url } of urls) {
    try {
      const res = await httpGet(url);
      const ok = res.statusCode >= 200 && res.statusCode < 400;
      logStatus(name, ok, `HTTP ${res.statusCode}`);
    } catch (e) {
      logStatus(name, false, e.message);
    }
  }

  console.log('\nDone.');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});

