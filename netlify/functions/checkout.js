// Netlify Function wrapper: adapts the WAO Burgers checkout server
// (plain Node http server in ../../server.js) to Netlify's Lambda-style
// handler. No dependencies.
//
// Netlify routes every path to this function (see netlify.toml), so
// event.path is the original request path (e.g. /checkout) and
// event.queryStringParameters carries Meta's ?products=... redirect params.
//
// Mapping bundling: server.js reads meta-to-square-mapping.json from disk,
// which may not exist inside Netlify's esbuild bundle. So the mapping is
// loaded here via require() (the bundler traces/inlines it) and injected
// through global.__WAO_MAPPING__ before server.js loads. netlify.toml also
// lists the JSON under [functions] included_files as a second mechanism.
global.__WAO_MAPPING__ = require('../../meta-to-square-mapping.json');

const server = require('../../server.js');

exports.handler = async (event) => {
  // Prefer rawQuery (exact query string Meta sent); fall back to rebuilding
  // it from the decoded queryStringParameters.
  const qs = event.rawQuery
    || new URLSearchParams(event.queryStringParameters || {}).toString();
  const url = qs ? `${event.path}?${qs}` : event.path;
  return new Promise((resolve) => {
    const reqHeaders = {};
    for (const [k, v] of Object.entries(event.headers || {})) {
      reqHeaders[String(k).toLowerCase()] = v;
    }
    if (!reqHeaders.host) reqHeaders.host = 'localhost';
    const req = {
      url,
      method: event.httpMethod || 'GET',
      headers: reqHeaders,
    };
    let statusCode = 200;
    const headers = {};
    const chunks = [];
    let sent = false;
    const res = {
      get headersSent() { return sent; },
      writeHead(code, h) {
        statusCode = code;
        sent = true;
        for (const [k, v] of Object.entries(h || {})) headers[String(k).toLowerCase()] = v;
      },
      setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
      getHeader(k) { return headers[String(k).toLowerCase()]; },
      write(data) {
        if (data != null) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        return true;
      },
      end(data) {
        if (data != null) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        sent = true;
        resolve({ statusCode, headers, body: Buffer.concat(chunks).toString('utf8') });
      },
    };
    server.emit('request', req, res);
  });
};
