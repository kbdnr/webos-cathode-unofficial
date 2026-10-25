/*
 * Runs ca/cathode-ca.sh (shipped in the IPK) as root through Homebrew Channel's exec service,
 * to add newer root CAs on TVs whose firmware store predates a stream host's certificate.
 * ES5 only.
 */
(function () {
  'use strict';

  var HBCHANNEL = 'luna://org.webosbrew.hbchannel.service/';
  var ACTIONS = { install: 1, status: 1, uninstall: 1, 'restart-web-engine': 1 };
  var inFlight = [];  // PalmServiceBridge instances must stay referenced until they answer

  function available() {
    return typeof window.PalmServiceBridge === 'function';
  }

  function luna(method, params, cb) {
    if (!available()) return cb(new Error('Not running on webOS'));
    var bridge = new window.PalmServiceBridge();
    inFlight.push(bridge);
    bridge.onservicecallback = function (raw) {
      inFlight.splice(inFlight.indexOf(bridge), 1);
      var res;
      try { res = JSON.parse(raw); } catch (e) { return cb(e); }
      cb(res.returnValue === false ? new Error(res.errorText || method + ' failed') : null, res);
    };
    bridge.call(HBCHANNEL + method, JSON.stringify(params || {}));
  }

  // Directory the app is installed in, e.g. /media/developer/apps/usr/palm/applications/<id>
  function appDir() {
    var dir = decodeURIComponent(window.location.pathname).replace(/\/[^\/]*$/, '');
    return /^\/[A-Za-z0-9_.\/-]+$/.test(dir) ? dir : null;
  }

  // cb(err, output) with the script's combined stdout/stderr.
  function run(action, cb) {
    var dir = appDir();
    if (!ACTIONS[action]) return cb(new Error('unknown action ' + action), '');
    if (!dir) return cb(new Error('cannot determine app directory'), '');
    luna('exec', { command: "/bin/sh '" + dir + "/ca/cathode-ca.sh' " + action + ' 2>&1' }, function (err, res) {
      var output = res ? (res.stdoutString || '') + (res.stderrString || '') : '';
      cb(err, output.replace(/\s+$/, ''));
    });
  }

  module.exports = { available: available, run: run };
})();
