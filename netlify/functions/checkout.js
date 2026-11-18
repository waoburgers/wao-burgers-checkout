// Netlify Function wrapper: adapts the WAO Burgers checkout server
// (plain Node http server in ../../server.js) to Netlify's Lambda-style
// handler. No dependencies.
//
// Netlify routes every path to this function (see netlify.toml), so
// event.path is the original request path (e.g. /checkout) and
// event.queryStringParameters carries Meta's ?products=... redirect params.
const server = require('../../server.js');

exports.handler = async (event) => {
  const qs = new URLSearchParams(event.queryStringParameters || {}).toString();
  const url = qs ? `${event.path}?${qs}` : event.path;
  return new Promise((resolve) => {
    const req = {
      url,
      method: event.httpMethod || 'GET',
      headers: event.headers || {},
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
        Object.assign(headers, h || {});
      },
      setHeader(k, v) { headers[k] = v; },
      getHeader(k) { return headers[k]; },
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
