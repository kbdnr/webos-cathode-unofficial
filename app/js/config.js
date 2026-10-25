/* App-wide settings. Edit `fallback` when the site switches hosts and discovery can't keep up. */
module.exports = {
  siteUrl: 'https://cathodetv.com/',

  // Used only when live discovery and the cache both come up empty.
  fallback: {
    player: 'https://ok.ru/videoembed/15845833842384?nochat=1',
    chat: 'https://minnit.chat/CATHODETV?embed&dark&nickname='
  },

  fetchTimeoutMs: 8000,     // direct XHR of the site
  tlsCheckTimeoutMs: 8000,  // per-host certificate preflight; on timeout the host is loaded anyway
  probeTimeoutMs: 20000,    // hidden-iframe fallback (page has to load + userscript reply)
  recheckMinutes: 30,       // re-run discovery in the background to catch host switches
  hintSeconds: 6,
  startPromptSeconds: 12    // prompt to click the player if its userscript never reports in
};
