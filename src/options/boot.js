// Classic bootstrap to load the ES module options.js even in environments
// where the page might not treat <script type="module"> correctly.
(async () => {
  try {
    await import('./options.js');
  } catch (e) {
    console.error('Failed to load options module', e);
  }
})();

