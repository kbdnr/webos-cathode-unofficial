/*
 * webOS injects this file into the app and into every frame it loads, including cross-origin
 * ones. It's what lets the shell reach inside third-party player/chat embeds. ES5 only.
 *
 * Frame roles (by hostname):
 *   top window (the app)        -> nothing
 *   about:blank and other non-http frames -> nothing
 *   cathodetv.com (probe frame) -> post the page HTML to the app for discovery
 *   anything nested in probe    -> nothing (keeps the hidden page from playing)
 *   chat host                   -> forward remote keys, scroll on request
 *   anything else               -> treated as the player
 */
(function () {
  'use strict';

  if (window.__cathodeUserScript) return;
  window.__cathodeUserScript = true;
  if (window === window.top) return;
  // Empty frames (about:blank) inherit the app's origin; only real pages get a role.
  if (!/^https?:$/.test(location.protocol)) return;

  var SITE_HOST = /(^|\.)cathodetv\.com$/i;
  // Keep in sync with CHAT_HOSTS in js/discover.js.
  var CHAT_HOST = /(^|\.)(minnit\.chat|chatango\.com|deadsimplechat\.com|tlk\.io|chatwee\.com|discord\.com|widgetbot\.io)$/i;
  // Keys the app must see even when a frame has focus (back, colour keys, info).
  var FORWARD_KEYS = [461, 403, 404, 405, 406, 457];
  // The player takes focus once it starts, so it also hands over OK, play/pause and the chat
  // scroll keys. The chat frame keeps those for typing.
  var PLAYER_FORWARD_KEYS = FORWARD_KEYS.concat([13, 415, 19, 38, 40]);

  // Per-host tweaks, keyed by hostname suffix. Add an entry when a new host needs help:
  //   startSelector: element to click to start playback from the host's poster/landing card
  //                  (default: whatever is in the middle of the frame)
  //   css:           extra CSS injected into the player frame (hide banners, overlays, etc.)
  var HOST_HOOKS = {
    // The poster card's click handler is on the card; its centre is an SVG play icon.
    'ok.ru': { startSelector: '.vid-card_cnt_w, .vid_play' }
  };

  // Applied inline, since a stylesheet can't reach a <video> inside a shadow root.
  var FILL_STYLE = {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    'max-width': 'none', 'max-height': 'none', 'object-fit': 'contain',
    'z-index': '2147483646', background: '#000', transform: 'none'
  };

  // Auto-start retries, since the host's player script may attach its handlers after load.
  var AUTOSTART_DELAY_MS = 1500;
  var AUTOSTART_INTERVAL_MS = 2500;
  var AUTOSTART_TRIES = 5;          // then tell the app to prompt for OK

  var host = location.hostname;

  if (SITE_HOST.test(host)) {
    if (window.parent === window.top) probe();
    return;
  }
  if (insideSite()) return;

  var isPlayer = window.parent === window.top && !CHAT_HOST.test(host);
  forwardKeys(isPlayer ? PLAYER_FORWARD_KEYS : FORWARD_KEYS);
  if (window.parent !== window.top) return;  // e.g. ad frames nested inside the player embed
  if (isPlayer) player();
  else chat();

  // ---------- shared ----------

  function insideSite() {
    var a = location.ancestorOrigins;
    if (!a) return false;
    for (var i = 0; i < a.length; i++) {
      var m = /^[a-z]+:\/\/([^\/:]+)/i.exec(a[i]);
      if (m && SITE_HOST.test(m[1])) return true;
    }
    return false;
  }

  function post(msg) {
    try { window.top.postMessage(msg, '*'); } catch (e) {}
  }

  function onCommand(handler) {
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (d && d.type === 'cathode:cmd') handler(d.cmd, d);
    });
  }

  function forwardKeys(keys) {
    document.addEventListener('keydown', function (e) {
      if (keys.indexOf(e.keyCode) < 0) return;
      post({ type: 'cathode:key', keyCode: e.keyCode });
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function whenLoaded(fn) {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn);
  }

  function injectStyle(css) {
    whenReady(function () {
      var s = document.createElement('style');
      s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
    });
  }

  function hookFor(h) {
    for (var key in HOST_HOOKS) {
      if (h === key || h.slice(-(key.length + 1)) === '.' + key) return HOST_HOOKS[key];
    }
    return {};
  }

  // ---------- probe ----------

  function probe() {
    whenReady(function () {
      var html = document.documentElement.outerHTML;
      var frames = document.getElementsByTagName('iframe');
      for (var i = 0; i < frames.length; i++) frames[i].src = 'about:blank';
      window.parent.postMessage({ type: 'cathode:page', html: html }, '*');
    });
  }

  // ---------- chat ----------

  function chat() {
    var scroller = null;

    function findScroller() {
      var best = null, bestArea = 0, all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.scrollHeight - el.clientHeight < 20) continue;
        var oy = getComputedStyle(el).overflowY;
        if (oy !== 'auto' && oy !== 'scroll') continue;
        var area = el.clientWidth * el.clientHeight;
        if (area > bestArea) { best = el; bestArea = area; }
      }
      return best || document.scrollingElement || document.body;
    }

    onCommand(function (cmd, d) {
      if (cmd !== 'scroll') return;
      if (!scroller || !document.contains(scroller)) scroller = findScroller();
      scroller.scrollTop += d.by || 0;
    });
  }

  // ---------- player ----------

  function player() {
    var hook = hookFor(host);
    var video = null;
    var fill = readFill();
    var reported = '';

    if (hook.css) injectStyle(hook.css);
    report('ready');

    function readFill() {
      try { return localStorage.getItem('cathode.fill') === '1'; } catch (e) { return false; }
    }

    function report(event) {
      var v = video || {};
      post({ type: 'cathode:player', event: event, host: host,
             width: v.videoWidth || 0, height: v.videoHeight || 0, muted: !!v.muted });
    }

    // Web-component players (ok.ru's vk-video-player) keep their <video> in an open shadow root.
    function collectVideos(root, out) {
      var i, all = root.querySelectorAll('*');
      for (i = 0; i < all.length; i++) {
        if (all[i].tagName === 'VIDEO') out.push(all[i]);
        if (all[i].shadowRoot) collectVideos(all[i].shadowRoot, out);
      }
      return out;
    }

    function largestVideo() {
      var vids = collectVideos(document, []), best = null, bestArea = -1;
      for (var i = 0; i < vids.length; i++) {
        var r = vids[i].getBoundingClientRect(), area = r.width * r.height;
        if (area > bestArea) { best = vids[i]; bestArea = area; }
      }
      return best;
    }

    function hasSource(v) { return !!(v && (v.currentSrc || v.src)); }
    function isPlaying() { check(); return hasSource(video) && !video.paused; }

    function applyFill() {
      if (!video) return;
      if (fill) {
        if (video.cathodeStyle == null) video.cathodeStyle = video.style.cssText;
        for (var k in FILL_STYLE) video.style.setProperty(k, FILL_STYLE[k], 'important');
      } else if (video.cathodeStyle != null) {
        video.style.cssText = video.cathodeStyle;
        video.cathodeStyle = null;
      }
    }

    function tryPlay() {
      var p;
      try { p = video.play(); } catch (e) {}
      if (p && p.catch) {
        p.catch(function (err) {
          // Only an autoplay block warrants muting; other rejections are races with the player.
          if (!err || err.name !== 'NotAllowedError') return;
          video.muted = true;
          var p2 = video.play();
          if (p2 && p2.catch) p2.catch(function () {});
          report('muted');
        });
      }
    }

    function adopt(v) {
      video = v;
      applyFill();
      v.addEventListener('playing', function () {
        var size = v.videoWidth + 'x' + v.videoHeight;
        if (size !== reported) { reported = size; report('playing'); }
      });
      v.addEventListener('error', function () { report('error'); });
      if (hasSource(v) && v.paused) tryPlay();
    }

    function check() {
      var v = largestVideo();
      if (v && v !== video) adopt(v);
    }

    // Synthetic mouse events rather than el.click(): SVG play icons have no click(), and some
    // players listen for mousedown/mouseup.
    function clickElement(el) {
      if (!el) return;
      var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      var types = ['mousedown', 'mouseup', 'click'];
      for (var i = 0; i < types.length; i++) {
        var ev = document.createEvent('MouseEvents');
        ev.initMouseEvent(types[i], true, true, window, 1, x, y, x, y, false, false, false, false, 0, null);
        el.dispatchEvent(ev);
      }
    }

    // Most embeds show a poster/landing card until clicked.
    function start() {
      var el = hook.startSelector && document.querySelector(hook.startSelector);
      clickElement(el || document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2));
    }

    onCommand(function (cmd) {
      if (cmd === 'toggle') {
        check();
        if (!hasSource(video)) return start();
        if (video.muted) video.muted = false;
        else if (video.paused) tryPlay();
        else video.pause();
      } else if (cmd === 'fill') {
        fill = !fill;
        try { localStorage.setItem('cathode.fill', fill ? '1' : '0'); } catch (e) {}
        applyFill();
      }
    });

    // Click the poster until the host creates a video, then nudge it with play(). If a click
    // ever lands on a started player and pauses it, the next round resumes it.
    function autostart(attempt) {
      if (isPlaying()) return;
      if (attempt >= AUTOSTART_TRIES) return report('needs-start');
      if (!hasSource(video)) start();
      else if (video.paused) tryPlay();
      setTimeout(function () { autostart(attempt + 1); }, AUTOSTART_INTERVAL_MS);
    }

    whenReady(function () { setInterval(check, 1500); });
    whenLoaded(function () {
      setTimeout(function () { autostart(0); }, AUTOSTART_DELAY_MS);
    });
  }
})();
