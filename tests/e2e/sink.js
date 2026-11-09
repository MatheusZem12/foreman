// A webhook receiver for the tests: POST /ok/<tag> stores the body, POST /fail/<tag>
// answers 500 and GET /received returns everything received.
const http = require('http');
const got = [];
http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(got));
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body); } catch {}
    got.push({ path: req.url, body: json });
    res.statusCode = req.url.startsWith('/fail') ? 500 : 200;
    res.end('{}');
  });
}).listen(8790);
