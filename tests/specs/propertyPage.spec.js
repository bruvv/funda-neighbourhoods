const { dummyHousePageUrl, dummySoldHousePageUrl, getExtensionBackgroundPage } = require("../utils");
const { allPropertyNames, allGroupNames } = require("../groupAndPropertyNames");

describe("Property page", () => {
  beforeAll(async () => {
    const browserVersion = await page.browser().version();
    console.log({ browserVersion });

    await page.goto(dummyHousePageUrl);
    await page.waitForSelector("[data-test^=badge]");
  });

  it("User should see default badges", async () => {
    const badgeNames = await page.$$eval("[data-test^=badge]", badges => {
      const badgeNames = badges.map(badge => badge.dataset.test).map(testHook => testHook.match(/badge-(.*)/)[1]);

      return badgeNames;
    });

    expect(badgeNames).toEqual(["neighbourhoodName", "meanIncomePerResident"]);
  });

  it("User should see a table with all available neighbourhood properties", async () => {
    const { renderedGroupNames, renderedPropertyNames } = await page.$eval(
      "[data-test=tableContainer]",
      tableContainerElement => {
        const renderedGroups = Array.from(tableContainerElement.querySelectorAll("[data-test^=propertiesGroup]"));

        const renderedGroupNames = renderedGroups
          .map(groupHeaderElement => groupHeaderElement.dataset.test)
          .map(testHook => testHook.match(/propertiesGroup-(.*)/)[1]);

        const renderedProperties = Array.from(tableContainerElement.querySelectorAll("[data-test^=propertyRowLabel]"));

        const renderedPropertyNames = renderedProperties
          .map(propertyElement => propertyElement.dataset.test)
          .map(testHook => testHook.match(/propertyRowLabel-(.*)/)[1]);

        return {
          renderedGroupNames,
          renderedPropertyNames,
        };
      }
    );

    // Check that all groups are rendered
    const visibleGroupNames = allGroupNames.filter(groupName => groupName !== "doNotShowInTable");
    expect(visibleGroupNames).toEqual(renderedGroupNames);

    // Check that all property rows are rendered
    const visiblePropertyNames = allPropertyNames.filter(
      propertyName => propertyName !== "neighbourhoodName" && propertyName !== "municipalityName"
    );
    expect(visiblePropertyNames).toEqual(renderedPropertyNames);
  });
});

describe("Sold property page", () => {
  beforeAll(async () => {
    await page.goto(dummySoldHousePageUrl);
    await page.waitForSelector("[data-test^=badge]");
  });

  it("User should see a table with all available neighbourhood properties", async () => {
    const { renderedGroupNames, renderedPropertyNames } = await page.$eval(
      "[data-test=tableContainer]",
      tableContainerElement => {
        const renderedGroups = Array.from(tableContainerElement.querySelectorAll("[data-test^=propertiesGroup]"));

        const renderedGroupNames = renderedGroups
          .map(groupHeaderElement => groupHeaderElement.dataset.test)
          .map(testHook => testHook.match(/propertiesGroup-(.*)/)[1]);

        const renderedProperties = Array.from(tableContainerElement.querySelectorAll("[data-test^=propertyRowLabel]"));

        const renderedPropertyNames = renderedProperties
          .map(propertyElement => propertyElement.dataset.test)
          .map(testHook => testHook.match(/propertyRowLabel-(.*)/)[1]);

        return {
          renderedGroupNames,
          renderedPropertyNames,
        };
      }
    );

    // Check that all groups are rendered
    const visibleGroupNames = allGroupNames.filter(groupName => groupName !== "doNotShowInTable");
    expect(visibleGroupNames).toEqual(renderedGroupNames);

    // Check that all property rows are rendered
    const visiblePropertyNames = allPropertyNames.filter(
      propertyName => propertyName !== "neighbourhoodName" && propertyName !== "municipalityName"
    );
    expect(visiblePropertyNames).toEqual(renderedPropertyNames);
  });
});

describe("Going to options page", () => {
  it("User should be able to go to options page by clicking on a badge", async () => {
    await page.goto(dummyHousePageUrl);

    await page.waitForSelector("[data-test^=badge]");

    const browserContext = page.browserContext();

    const targetCreatedPromise = new Promise(resolve => {
      browserContext.on("targetcreated", resolve);
    });

    await page.click("[data-test=badge-neighbourhoodName]");

    const target = await targetCreatedPromise;
    const targetUrl = target.url();

    const extensionBackgroundPage = await getExtensionBackgroundPage(browser);

    const optionsPageUrl = await extensionBackgroundPage.evaluate(() => chrome.runtime.getURL("options.html"));

    expect(targetUrl).toMatch(optionsPageUrl);
  });
});

describe("Options page", () => {
  beforeAll(async () => {
    const extensionBackgroundPage = await getExtensionBackgroundPage(browser);

    const optionsPageUrl = await extensionBackgroundPage.evaluate(() => chrome.runtime.getURL("options.html"));

    await page.goto(optionsPageUrl);
    await page.waitFor("[data-test^=optionsPagePropertyCheckbox]");
  });

  it("User should see all the properties on the options page", async () => {
    const { renderedGroupNames, renderedPropertyNames } = await page.$eval("#options-table", tableContainerElement => {
      const renderedGroups = Array.from(tableContainerElement.querySelectorAll("[data-test^=optionsPageGroupHeader]"));

      const renderedGroupNames = renderedGroups
        .map(groupHeaderElement => groupHeaderElement.dataset.test)
        .map(testHook => testHook.match(/optionsPageGroupHeader-(.*)/)[1]);

      const renderedProperties = Array.from(
        tableContainerElement.querySelectorAll("[data-test^=optionsPagePropertyLabel]")
      );

      const renderedPropertyNames = renderedProperties
        .map(propertyElement => propertyElement.dataset.test)
        .map(testHook => testHook.match(/optionsPagePropertyLabel-(.*)/)[1]);

      return {
        renderedGroupNames,
        renderedPropertyNames,
      };
    });

    // Check that all groups are rendered
    expect(allGroupNames).toEqual(renderedGroupNames);

    // Check that all property rows are rendered
    expect(allPropertyNames).toEqual(renderedPropertyNames);
  });

    it("Default options should be selected", async () => {
      const selectedOptions = await page.$$eval("[data-test^=optionsPagePropertyCheckbox]", checkboxElements => {
        const selectedCheckboxElements = checkboxElements.filter(({ checked }) => checked);

      const selectedCheckboxNames = selectedCheckboxElements
        .map(({ dataset }) => dataset.test)
        .map(testHook => testHook.match(/optionsPagePropertyCheckbox-(.*)/)[1]);

      return selectedCheckboxNames;
    });

      expect(selectedOptions).toEqual(["neighbourhoodName", "meanIncomePerResident"]);
    });

    it("Options page has language selector", async () => {
      const options = await page.$$eval(
        "[data-test=languageSelect] option",
        optionElements => optionElements.map(({ value }) => value)
      );
      expect(options).toEqual(["en", "nl"]);

      const defaultLanguage = await page.evaluate(() =>
        chrome.i18n.getUILanguage().startsWith("nl") ? "nl" : "en"
      );

      const otherLanguage = defaultLanguage === "en" ? "nl" : "en";
      await Promise.all([
        page.waitForNavigation(),
        page.select("[data-test=languageSelect]", otherLanguage),
      ]);

      const labelText = await page.$eval(
        "label[for='language-switch-select']",
        el => el.textContent.trim()
      );
      const expectedText = otherLanguage === "nl" ? "Selecteer taal" : "Select language";
      expect(labelText).toBe(expectedText);

      await Promise.all([
        page.waitForNavigation(),
        page.select("[data-test=languageSelect]", defaultLanguage),
      ]);
    });

  it("User should see selected badges", async () => {
    // Un-select default "neighbourhood name" badge
    await page.$eval("[data-test=optionsPagePropertyCheckbox-neighbourhoodName]", checkboxElement =>
      checkboxElement.click()
    );

    // Select "married"
    await page.$eval("[data-test=optionsPagePropertyCheckbox-married]", checkboxElement => checkboxElement.click());

    // Select "residents over 65 years old"
    await page.$eval("[data-test=optionsPagePropertyCheckbox-residentsAge65AndOlder]", checkboxElement =>
      checkboxElement.click()
    );

    await page.goto(dummyHousePageUrl);

    await page.waitForSelector("[data-test^=badge]");

    const badgeNames = await page.$$eval("[data-test^=badge]", badges => {
      const badgeNames = badges.map(badge => badge.dataset.test).map(testHook => testHook.match(/badge-(.*)/)[1]);

      return badgeNames;
    });

    expect(badgeNames).toEqual(["meanIncomePerResident", "residentsAge65AndOlder", "married"]);
  });
});
