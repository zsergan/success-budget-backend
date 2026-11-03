// Runs on /invite. Reads the token from the URL fragment, which never
// reaches the server, and only points the Open button at the app: nothing
// is sent anywhere and nothing opens on its own.
(function () {
  'use strict';

  var TOKEN_PATTERN = /^[1-9][0-9]{0,9}\.[A-Za-z0-9_-]{43}$/;
  // The scheme the iOS app registers: Safari does not follow a Universal
  // Link to the page's own domain.
  var APP_URL = 'successbudget://invite#token=';

  function readToken(hash) {
    var pairs = String(hash || '')
      .replace(/^#/, '')
      .split('&');

    for (var i = 0; i < pairs.length; i++) {
      if (pairs[i].indexOf('token=') === 0) {
        var token = pairs[i].slice('token='.length);

        return TOKEN_PATTERN.test(token) ? token : null;
      }
    }

    return null;
  }

  var token = readToken(window.location.hash);
  var openApp = document.getElementById('open-app');
  var incomplete = document.getElementById('link-incomplete');

  if (token) {
    openApp.setAttribute('href', APP_URL + token);
    openApp.hidden = false;
  } else {
    incomplete.hidden = false;
  }
})();
