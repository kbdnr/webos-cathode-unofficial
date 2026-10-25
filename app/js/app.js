/*
 * TV shell for Cathode Cinema: discovers the current player/chat embeds, lays them out
 * for 1080p, and maps the remote. Bundle entry point (see webpack.config.js).
 * ES5 only (webOS 3.x ships Chromium 38).
 */
(function () {
  'use strict';

  var cfg = require('./config');
  var Discovery = require('./discover');
  var RootCA = require('./rootca');

  var KEY = {
    ENTER: 13, ESC: 27, UP: 38, DOWN: 40,
    BACK: 461, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    PLAY: 415, PAUSE: 19, INFO: 457
  };
  var SETTINGS_KEY = 'cathode.settings';
  var SOURCES_KEY = 'cathode.sources';
  var SITE_HOST = Discovery.hostOf(cfg.siteUrl);

  var settings = loadJSON(SETTINGS_KEY, {
    override: '', nickname: '', chatWidth: 28, chatScale: 1.25, layout: 'side', lastVisibleLayout: 'side'
  });
  var current = { player: null, chat: null, origin: null, checkedAt: null, playerScript: null };
  var lastFound = null;
  var lastOrigin = null;
  var discovering = false;
  var hintTimer, toastTimer, startPromptTimer;
  var els = {};

  // ---------- storage ----------

  function loadJSON(key, defaults) {
    var out = {}, stored = null, k;
    try { stored = JSON.parse(localStorage.getItem(key)); } catch (e) {}
    for (k in defaults) out[k] = defaults[k];
    if (stored && typeof stored === 'object') for (k in stored) out[k] = stored[k];
    return out;
  }

  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function isSiteHost(host) {
    return !!host && (host === SITE_HOST || host.slice(-(SITE_HOST.length + 1)) === '.' + SITE_HOST);
  }

  // ---------- discovery ----------

  function fetchPage(cb) {
    var xhr = new XMLHttpRequest(), done = false;
    function finish(err, text) { if (!done) { done = true; cb(err, text); } }
    try {
      xhr.open('GET', cfg.siteUrl + (cfg.siteUrl.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now(), true);
      xhr.timeout = cfg.fetchTimeoutMs;
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) finish(null, xhr.responseText);
        else finish(new Error('HTTP ' + xhr.status));
      };
      xhr.onerror = function () { finish(new Error('network or CORS error')); };
      xhr.ontimeout = function () { finish(new Error('timeout')); };
      xhr.send();
    } catch (e) {
      finish(e);
    }
  }

  // ---------- certificate preflight ----------
  // Older TVs ship stale root CA stores, and pointing a frame at a host the TV doesn't trust
  // brings up webOS's own "-501 certificate" error. Each origin is checked with a quiet
  // no-cors fetch first, which just rejects on a TLS failure.

  var trust = {};  // origin -> 'ok' | 'failed' | 'unchecked' | [callbacks while pending]

  function originOf(url) {
    var m = /^https?:\/\/[^\/?#]+/i.exec(url || '');
    return m ? m[0].toLowerCase() : null;
  }

  function checkTrust(url, cb) {
    var origin = originOf(url), entry = trust[origin], waiting, timer;
    if (!origin || origin.indexOf('https:') !== 0) return cb(true);
    if (entry === 'ok' || entry === 'unchecked') return cb(true);
    if (entry === 'failed') return cb(false);
    if (entry) return entry.push(cb);

    waiting = trust[origin] = [cb];
    function finish(result) {
      clearTimeout(timer);
      if (trust[origin] !== waiting) return;
      trust[origin] = result;
      for (var i = 0; i < waiting.length; i++) waiting[i](result !== 'failed');
    }
    // Chromium < 42 (webOS 3.x) has no fetch, and XHR can't tell a TLS failure from CORS.
    if (!window.fetch) return finish('unchecked');
    timer = setTimeout(function () { finish('unchecked'); }, cfg.tlsCheckTimeoutMs);
    window.fetch(origin + '/', { mode: 'no-cors', credentials: 'omit', cache: 'no-store' }).then(
      function () { finish('ok'); },
      function () { finish('failed'); });
  }

  // Lets a retry (green key) re-test hosts that failed, e.g. after fixing the TV's clock.
  function forgetTrustFailures() {
    for (var origin in trust) if (trust[origin] !== 'ok') delete trust[origin];
  }

  function untrustedMessage(url) {
    return 'Can\'t connect securely to ' + Discovery.hostOf(url) +
      '. This TV may not trust its certificate, or its clock may be wrong. Press blue for details.';
  }

  // Loads the site in a hidden iframe; the userscript posts the page HTML back.
  function probePage(cb) {
    checkTrust(cfg.siteUrl, function (trusted) {
      if (trusted) loadProbe(cb);
      else cb(new Error('certificate check failed for ' + cfg.siteUrl));
    });
  }

  function loadProbe(cb) {
    var done = false, timer;
    function finish(err, html) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      els.probe.src = 'about:blank';
      cb(err, html);
    }
    function onMessage(e) {
      var d = e.data;
      if (d && d.type === 'cathode:page' && isSiteHost(Discovery.hostOf(e.origin))) finish(null, d.html);
    }
    window.addEventListener('message', onMessage);
    timer = setTimeout(function () { finish(new Error('probe timeout')); }, cfg.probeTimeoutMs);
    els.probe.src = cfg.siteUrl;
  }

  // Calls cb(sources, origin) where origin is 'live' | 'probe' | 'cache' | 'fallback'.
  function discover(cb) {
    fetchPage(function (err, html) {
      var found = err ? null : Discovery.parse(html);
      if (found && found.player) return cb(found, 'live');
      console.log('[cathode] direct fetch: ' + (err ? err.message : 'no player found'));

      probePage(function (err2, html2) {
        var probed = err2 ? null : Discovery.parse(html2);
        if (probed && probed.player) return cb(probed, 'probe');
        console.log('[cathode] probe: ' + (err2 ? err2.message : 'no player found'));

        var cached = loadJSON(SOURCES_KEY, {});
        if (cached.player) return cb(cached, 'cache');
        cb({ player: cfg.fallback.player, chat: cfg.fallback.chat }, 'fallback');
      });
    });
  }

  function rediscover(opts) {
    opts = opts || {};
    if (discovering) return;
    discovering = true;
    if (!opts.silent) toast('Looking for the current stream…');
    discover(function (found, origin) {
      discovering = false;
      current.checkedAt = new Date();
      // Background checks only act on fresh results, never on cache/fallback.
      if (opts.silent && origin !== 'live' && origin !== 'probe') return;
      var changed = applySources(found, origin, opts.force);
      if (changed || !opts.silent) {
        toast((changed ? 'Stream: ' : 'No change: ') + Discovery.hostOf(current.player) + ' (' + current.origin + ')');
      }
    });
  }

  // ---------- player & chat ----------

  function withNickname(url, nick) {
    if (!url || !nick) return url;
    var enc = encodeURIComponent(nick);
    if (/[?&]nickname=[^&]*/.test(url)) return url.replace(/([?&])nickname=[^&]*/, '$1nickname=' + enc);
    return url + (url.indexOf('?') < 0 ? '?' : '&') + 'nickname=' + enc;
  }

  function applySources(found, origin, force) {
    lastFound = found;
    lastOrigin = origin;
    if (origin === 'live' || origin === 'probe') {
      saveJSON(SOURCES_KEY, { player: found.player, chat: found.chat, at: Date.now() });
    }
    current.origin = settings.override ? 'manual' : origin;
    var playerChanged = setPlayer(settings.override || found.player, force);
    var chatChanged = setChat(withNickname(found.chat || cfg.fallback.chat, settings.nickname), force);
    return playerChanged || chatChanged;
  }

  function setPlayer(url, force) {
    if (!url || (url === current.player && !force)) return false;
    current.player = url;
    current.playerScript = null;  // set again by the userscript's 'ready' from the new frame
    showStatus('Tuning in…');
    checkTrust(url, function (trusted) {
      if (current.player !== url) return;
      if (trusted && Discovery.isDirectMedia(url)) {
        els.player.src = 'about:blank';
        els.player.style.display = 'none';
        els.video.style.display = 'block';
        els.video.src = url;
        playVideo();
        return;
      }
      els.video.pause();
      els.video.removeAttribute('src');
      els.video.load();
      els.video.style.display = 'none';
      els.player.style.display = 'block';
      els.player.src = trusted ? url : 'about:blank';
      if (!trusted) showStatus(untrustedMessage(url));
    });
    return true;
  }

  function setChat(url, force) {
    if (!url || (url === current.chat && !force)) return false;
    current.chat = url;
    els.chatStatus.textContent = '';
    checkTrust(url, function (trusted) {
      if (current.chat !== url) return;
      els.chat.src = trusted ? url : 'about:blank';
      if (!trusted) els.chatStatus.textContent = untrustedMessage(url);
    });
    return true;
  }

  // Commands are handled by the userscript running inside the player/chat frames.
  function sendToFrame(frame, cmd, extra) {
    var msg = { type: 'cathode:cmd', cmd: cmd }, k;
    for (k in extra || {}) msg[k] = extra[k];
    try { frame.contentWindow.postMessage(msg, '*'); } catch (e) {}
  }

  function togglePlayback() {
    if (els.video.style.display === 'block') {
      if (els.video.paused) playVideo(); else els.video.pause();
    } else if (current.playerScript) {
      sendToFrame(els.player, 'toggle');
    } else {
      // Without the userscript there's no way into a cross-origin frame.
      toast('The remote can\'t control this player. Point at it and click instead.');
    }
  }

  function playVideo() {
    var p = els.video.play();
    if (p && p.catch) p.catch(function (e) { toast('Playback blocked: ' + e.message); });
  }

  function showStatus(text) {
    els.status.textContent = text;
    els.status.className = text ? '' : 'hidden';
  }

  function onFrameMessage(e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'cathode:key') {
      handleKey(d.keyCode);
    } else if (d.type === 'cathode:player') {
      if (d.event === 'ready') {
        current.playerScript = d.host;
        clearTimeout(startPromptTimer);
      } else if (d.event === 'needs-start') {
        showStatus('Press OK to start the stream');
      } else if (d.event === 'playing') {
        clearTimeout(startPromptTimer);
        showStatus('');
        if (d.width) toast('Playing ' + d.width + '×' + d.height + ' from ' + d.host);
      } else if (d.event === 'muted') {
        toast('Autoplay was blocked, so the stream is muted. Press OK to unmute.');
      } else if (d.event === 'error') {
        toast('Player error on ' + d.host + '. Press green to rediscover.');
      }
    }
  }

  // ---------- layout ----------

  function applyLayout() {
    var w = clamp(+settings.chatWidth || 28, 15, 50);
    var s = clamp(+settings.chatScale || 1, 0.75, 2);
    document.body.className = 'layout-' + settings.layout;
    els.playerWrap.style.right = settings.layout === 'side' ? w + '%' : '0';
    els.chatWrap.style.width = w + '%';
    // Shrink the iframe viewport and scale it back up so chat text is readable from the couch.
    els.chat.style.width = (100 / s) + '%';
    els.chat.style.height = (100 / s) + '%';
    els.chat.style.webkitTransform = els.chat.style.transform = 'scale(' + s + ')';
  }

  function setLayout(layout) {
    settings.layout = layout;
    if (layout !== 'hidden') settings.lastVisibleLayout = layout;
    saveJSON(SETTINGS_KEY, settings);
    applyLayout();
  }

  // ---------- UI feedback ----------

  function toast(text) {
    els.toast.textContent = text;
    els.toast.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.className = ''; }, 4000);
  }

  function showHint() {
    els.hint.className = 'show';
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { els.hint.className = ''; }, cfg.hintSeconds * 1000);
  }

  // ---------- settings ----------

  function isSettingsOpen() { return !els.settings.hidden; }

  function openSettings() {
    els.setOverride.value = settings.override;
    els.setNickname.value = settings.nickname;
    els.setWidth.value = settings.chatWidth;
    els.setScale.value = settings.chatScale;
    els.setInfo.textContent =
      'Player: ' + (current.player || '-') + '\n' +
      'Chat:   ' + (current.chat || '-') + '\n' +
      'Source: ' + (current.origin || '-') +
      (current.checkedAt ? '   Last check: ' + current.checkedAt.toLocaleTimeString() : '') + '\n' +
      'TLS:    ' + trustSummary() + '\n' +
      'Script: ' + (current.playerScript ? 'active in ' + current.playerScript : 'not detected in player') + '\n' +
      'Clock:  ' + new Date().toString() + '\n' +
      'Engine: ' + navigator.userAgent +
      (hasTrustFailures() ? '\n\nOn a rooted TV, "Install certificate fix" adds newer root certificates.' : '');
    els.settings.hidden = false;
    els.setOverride.focus();
  }

  function trustSummary() {
    var parts = [], origin, state;
    for (origin in trust) {
      state = trust[origin];
      parts.push(Discovery.hostOf(origin) + ' ' + (typeof state === 'string' ? state : 'checking'));
    }
    return parts.join(', ') || '-';
  }

  function hasTrustFailures() {
    for (var origin in trust) if (trust[origin] === 'failed') return true;
    return false;
  }

  function showInfo(text) {
    els.setInfo.textContent = text;
    els.setInfo.scrollTop = els.setInfo.scrollHeight;  // keep the end of long script output visible
  }

  // install | uninstall | restart-web-engine via ca/cathode-ca.sh as root (see js/rootca.js).
  function runCertFix(action) {
    if (!RootCA.available()) {
      return showInfo('The certificate fix needs a rooted webOS TV with Homebrew Channel.');
    }
    showInfo('Running certificate fix (' + action + ')…');
    RootCA.run(action, function (err, output) {
      // WebAppMgr only reads the certificate stores at startup, so a restart is always needed.
      showInfo((err ? 'Failed: ' + err.message + '\n\n' : '') + output +
        (err || action === 'restart-web-engine' ? ''
          : '\n\nChoose "Restart web engine" to finish. This app will close; reopen it.'));
    });
  }

  function closeSettings() {
    els.settings.hidden = true;
    if (document.activeElement) document.activeElement.blur();
  }

  function saveSettings() {
    settings.override = els.setOverride.value.replace(/^\s+|\s+$/g, '');
    settings.nickname = els.setNickname.value.replace(/^\s+|\s+$/g, '');
    settings.chatWidth = clamp(+els.setWidth.value || 28, 15, 50);
    settings.chatScale = clamp(+els.setScale.value || 1.25, 0.75, 2);
    saveJSON(SETTINGS_KEY, settings);
    closeSettings();
    applyLayout();
    if (lastFound) applySources(lastFound, lastOrigin);
    toast('Settings saved');
  }

  function handleSettingsKey(code) {
    var fields = els.settings.querySelectorAll('input, button');
    var i = Array.prototype.indexOf.call(fields, document.activeElement);
    if (code === KEY.UP || code === KEY.DOWN) {
      fields[clamp(i + (code === KEY.DOWN ? 1 : -1), 0, fields.length - 1)].focus();
      return true;
    }
    if (code === KEY.BACK || code === KEY.BLUE || code === KEY.ESC) {
      closeSettings();
      return true;
    }
    return false;
  }

  // ---------- remote ----------

  function exitApp() {
    if (window.webOS && typeof window.webOS.platformBack === 'function') window.webOS.platformBack();
    else window.close();
  }

  // Returns true when the key was consumed.
  function handleKey(code) {
    if (isSettingsOpen()) return handleSettingsKey(code);
    showHint();
    switch (code) {
      case KEY.RED:
        setLayout(settings.layout === 'hidden' ? settings.lastVisibleLayout : 'hidden');
        return true;
      case KEY.GREEN:
        forgetTrustFailures();
        rediscover({ force: true });
        return true;
      case KEY.YELLOW:
        setLayout(settings.layout === 'overlay' ? 'side' : 'overlay');
        return true;
      case KEY.BLUE:
        openSettings();
        return true;
      case KEY.INFO:
        sendToFrame(els.player, 'fill');
        return true;
      case KEY.ENTER: case KEY.PLAY: case KEY.PAUSE:
        togglePlayback();
        return true;
      case KEY.UP: case KEY.DOWN:
        if (settings.layout === 'hidden') return false;
        sendToFrame(els.chat, 'scroll', { by: code === KEY.UP ? -300 : 300 });
        return true;
      case KEY.BACK: case KEY.ESC:
        exitApp();
        return true;
    }
    return false;
  }

  // ---------- boot ----------

  function init() {
    var ids = {
      playerWrap: 'player-wrap', player: 'player', video: 'video', status: 'status',
      chatWrap: 'chat-wrap', chat: 'chat', chatStatus: 'chat-status', hint: 'hint', toast: 'toast', probe: 'probe',
      settings: 'settings', setOverride: 'set-override', setNickname: 'set-nickname',
      setWidth: 'set-width', setScale: 'set-scale', setInfo: 'set-info'
    };
    for (var k in ids) els[k] = document.getElementById(ids[k]);

    els.video.addEventListener('playing', function () {
      showStatus('');
      toast('Playing ' + els.video.videoWidth + '×' + els.video.videoHeight);
    });
    els.video.addEventListener('error', function () { toast('Could not play ' + current.player); });

    els.settings.addEventListener('submit', function (e) { e.preventDefault(); saveSettings(); });
    document.getElementById('set-cancel').addEventListener('click', closeSettings);
    document.getElementById('ca-install').addEventListener('click', function () { runCertFix('install'); });
    document.getElementById('ca-uninstall').addEventListener('click', function () { runCertFix('uninstall'); });
    document.getElementById('ca-restart').addEventListener('click', function () { runCertFix('restart-web-engine'); });
    document.getElementById('set-rediscover').addEventListener('click', function () {
      try { localStorage.removeItem(SOURCES_KEY); } catch (e) {}
      closeSettings();
      rediscover({ force: true });
    });

    document.addEventListener('keydown', function (e) {
      if (handleKey(e.keyCode)) e.preventDefault();
    });
    window.addEventListener('message', onFrameMessage);

    // A pointer click into the player moves focus into its frame, and the app loses focus.
    // That's the only sign of a click we get when the userscript isn't running there.
    window.addEventListener('blur', function () {
      setTimeout(function () {
        if (document.activeElement !== els.player) return;
        clearTimeout(startPromptTimer);
        if (els.status.textContent.indexOf('point at it') >= 0) showStatus('');
        // With no script to forward keys, take focus back so Back and the colour keys still work.
        if (!current.playerScript) { els.player.blur(); window.focus(); }
      }, 0);
    });

    els.player.addEventListener('load', function () {
      if (els.player.src === 'about:blank') return;
      showStatus('');
      // The userscript auto-starts the stream and reports back; if it never does (script not
      // injected, or a host it can't drive), fall back to asking for the Magic Remote pointer.
      clearTimeout(startPromptTimer);
      startPromptTimer = setTimeout(function () {
        if (!current.playerScript) showStatus('If the stream hasn\'t started, point at it and click');
      }, cfg.startPromptSeconds * 1000);
    });

    applyLayout();
    showHint();
    // Start on the last known stream immediately; discovery swaps it if the host has changed.
    var cached = loadJSON(SOURCES_KEY, {});
    applySources(cached.player ? cached : cfg.fallback, cached.player ? 'cache' : 'fallback');
    rediscover();
    setInterval(function () { rediscover({ silent: true }); }, cfg.recheckMinutes * 60000);
  }

  init();
})();
