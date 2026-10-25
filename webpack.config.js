/*
 * Builds the app into dist/ and packs it into an IPK with @webosbrew/webos-packager-plugin.
 * The plugin packs every emitted asset, so everything the TV needs must pass through webpack:
 * JS is bundled, the rest is copied. package.json is the single source of the version.
 */
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const { hoc } = require('@webosbrew/webos-packager-plugin');
const pkg = require('./package.json');
const appinfo = require('./app/appinfo.json');

module.exports = hoc({
  id: appinfo.id,
  version: pkg.version,
  options: {
    // <id>.manifest.json (with the IPK's sha256) for a self-hosted Homebrew Channel repo.
    emitManifest: true,
    manifest: {
      title: appinfo.title,
      description: pkg.description,
      iconUrl: '',
      sourceUrl: '',
    },
  },
  app: (env, argv) => ({
    id: appinfo.id,
    mode: argv.mode || 'production',
    // Old webOS Chromium (38 on webOS 3.x): keep webpack's runtime and minifier output ES5.
    target: ['web', 'es5'],
    devtool: false,
    entry: { main: './app/js/app.js' },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'js/[name].js',
      clean: true,
    },
    performance: { hints: false },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: 'app/index.html' },
          { from: 'app/css', to: 'css' },
          { from: 'app/*.png', to: '[name][ext]' },
          // webOS injects this file by path, so it's copied as-is rather than bundled.
          { from: 'app/webOSUserScripts', to: 'webOSUserScripts' },
          // Root CA fix, run as root via Homebrew Channel from Settings (see js/rootca.js).
          { from: 'ca/cathode-ca.sh', to: 'ca/' },
          { from: 'ca/mozilla-roots.pem', to: 'ca/' },
          { from: 'ca/diagnose.sh', to: 'ca/' },
          {
            from: 'app/appinfo.json',
            transform: (content) => JSON.stringify(
              Object.assign(JSON.parse(content.toString()), { version: pkg.version }), null, 2),
          },
        ],
      }),
    ],
  }),
});
