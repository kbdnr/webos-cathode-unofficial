// Fetches the live site and prints what discovery would pick. Run with: npm run check-live
'use strict';

var https = require('https');
var D = require('../app/js/discover.js');

https.get('https://cathodetv.com/', { headers: { 'User-Agent': 'Mozilla/5.0' } }, function (res) {
  var body = '';
  res.setEncoding('utf8');
  res.on('data', function (c) { body += c; });
  res.on('end', function () {
    var r = D.parse(body);
    console.log('HTTP   ' + res.statusCode);
    console.log('player ' + r.player);
    console.log('chat   ' + r.chat);
    console.log('frames ' + JSON.stringify(r.frames));
    process.exit(r.player ? 0 : 1);
  });
}).on('error', function (e) { console.error(e.message); process.exit(1); });
