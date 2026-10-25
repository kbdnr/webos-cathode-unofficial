/*
 * Finds the current player and chat embeds in the Cathode page HTML.
 * Regex-based (no DOM) so it runs in node tests and on any webOS Chromium. ES5 only.
 */
(function () {
  'use strict';

  // Keep CHAT_HOSTS in sync with webOSUserScripts/userScript.js.
  var CHAT_HOSTS = /(^|\.)(minnit\.chat|chatango\.com|deadsimplechat\.com|tlk\.io|chatwee\.com|discord\.com|widgetbot\.io)$/i;
  var IGNORE_HOSTS = /(^|\.)(framer\.com|framerusercontent\.com|google\.com|googletagmanager\.com|gofund\.me|dice\.fm|linktr\.ee|instagram\.com)$/i;
  var IFRAME_SRC = /<iframe\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  var STREAM_URL = /https?:\/\/[^"'\s<>\\]+?\.(?:m3u8|mpd)(?:\?[^"'\s<>\\]*)?/i;

  function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
  }

  // Handles "//host/x" and Framer's occasional "https:////host/x". Relative URLs are dropped.
  function normalizeUrl(src) {
    src = decodeEntities(String(src || '').replace(/^\s+|\s+$/g, ''));
    src = src.replace(/^(https?:)?\/{2,}/i, function (m, scheme) { return (scheme || 'https:') + '//'; });
    return /^https?:\/\/[^\/]/i.test(src) ? src : null;
  }

  function hostOf(url) {
    var m = /^[a-z]+:\/\/([^\/?#:]+)/i.exec(url || '');
    return m ? m[1].toLowerCase() : null;
  }

  function isChatUrl(url) {
    var host = hostOf(url);
    return !!host && CHAT_HOSTS.test(host);
  }

  // Returns { player, chat, stream, frames }. `player` falls back to a bare stream URL if no player iframe exists.
  function parse(html) {
    var result = { player: null, chat: null, stream: null, frames: [] };
    var m, url, host, s;
    html = String(html || '');
    IFRAME_SRC.lastIndex = 0;
    while ((m = IFRAME_SRC.exec(html))) {
      url = normalizeUrl(m[1] || m[2]);
      host = hostOf(url);
      if (!host || IGNORE_HOSTS.test(host) || result.frames.indexOf(url) >= 0) continue;
      result.frames.push(url);
      if (CHAT_HOSTS.test(host)) {
        if (!result.chat) result.chat = url;
      } else if (!result.player) {
        result.player = url;
      }
    }
    s = STREAM_URL.exec(html);
    if (s) result.stream = decodeEntities(s[0]);
    if (!result.player) result.player = result.stream;
    return result;
  }

  function isDirectMedia(url) {
    return /\.(m3u8|mpd|mp4|webm|mkv|ts)(\?|#|$)/i.test(url || '');
  }

  var api = {
    parse: parse,
    normalizeUrl: normalizeUrl,
    hostOf: hostOf,
    isChatUrl: isChatUrl,
    isDirectMedia: isDirectMedia
  };

  module.exports = api;
})();
