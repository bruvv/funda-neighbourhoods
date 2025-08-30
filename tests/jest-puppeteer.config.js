const path = require("path");

const pathToExtension = path.resolve("./build");

module.exports = {
  launch: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      `--disable-extensions-except=${pathToExtension}`,
      `--load-extension=${pathToExtension}`,
    ],
    /* "executablePath" - set by Docker container on CI, not used locally */
    executablePath: process.env.PUPPETEER_EXEC_PATH,
  },
};
