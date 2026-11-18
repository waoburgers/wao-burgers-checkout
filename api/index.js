// Vercel serverless entry point: forwards every request to the checkout
// server defined in ../server.js (zero-dependency Node http server).
// vercel.json rewrites all paths here so Meta can call /checkout directly.
const server = require('../server.js');

module.exports = (req, res) => {
  server.emit('request', req, res);
};
