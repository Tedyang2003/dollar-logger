/* Client settings. Nothing here is a secret - all of it ships to the browser
   and is visible in page source, which is why a Google CLIENT ID is safe to
   commit and a client SECRET would not be. See README.md.

   The API URL is chosen by where the page is served from, so the same committed
   file works locally and in production without editing it each time. */
(function () {
  var host = location.hostname;
  var isLocal = (host === 'localhost' || host === '127.0.0.1' || host === '');

  window.DOLLAR_CONFIG = {
    API_BASE_URL: isLocal
      ? 'http://127.0.0.1:8787'
      : 'https://dollar-logger-api.awsy2003.workers.dev',   // <- from `wrangler deploy`

    GOOGLE_CLIENT_ID: '530673590797-5m85o2agsr8n5ssol738fsf8u3ebrqo8.apps.googleusercontent.com'
  };
})();
