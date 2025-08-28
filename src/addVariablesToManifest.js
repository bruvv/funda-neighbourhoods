const path = require("path");
const packageJson = require("../package.json");
const { dummyHousePageUrl, dummySoldHousePageUrl } = require("../tests/utils.js");

// Transform src/manifest.json (which points to nested src files)
// into a build-ready manifest (which points to webpack output files in build root).
const addVariablesToManifest = isTestMode => manifestContent => {
  const manifest = JSON.parse(manifestContent);

  // Ensure version comes from package.json for builds
  manifest.version = packageJson.version;

  // Rewrite background service worker to root output filename and drop ESM type for bundle
  if (manifest.background) {
    if (manifest.background.service_worker) {
      manifest.background.service_worker = "background.js";
    }
    if (manifest.background.type) {
      delete manifest.background.type;
    }
  }

  // Rewrite content script file paths to built filenames in root
  if (Array.isArray(manifest.content_scripts)) {
    manifest.content_scripts = manifest.content_scripts.map(cs => {
      const rewrite = p => {
        // Only strip directories; webpack outputs root-level filenames
        const base = path.basename(p);
        return base;
      };
      const next = { ...cs };
      if (Array.isArray(next.js)) next.js = next.js.map(rewrite);
      if (Array.isArray(next.css)) next.css = next.css.map(rewrite);
      return next;
    });
  }

  // Rewrite options page to built filename in root
  if (manifest.options_ui && manifest.options_ui.page) {
    manifest.options_ui.page = path.basename(manifest.options_ui.page);
  }

  // Rewrite icons from src path (assets/icons/...) to build path (icons/...)
  if (manifest.icons && typeof manifest.icons === 'object') {
    const rewritten = {};
    for (const [size, iconPath] of Object.entries(manifest.icons)) {
      const base = path.basename(iconPath);
      rewritten[size] = path.posix.join('icons', base);
    }
    manifest.icons = rewritten;
  }

  if (isTestMode) {
    // Add permission to run extension on a dummy house page (file:// URLs)
    manifest.content_scripts[0].matches.push(dummyHousePageUrl, dummySoldHousePageUrl);
  }

  return JSON.stringify(manifest, null, 2);
};

module.exports = addVariablesToManifest;
