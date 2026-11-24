const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { format } = require('node:util');
const { chromium } = require('playwright');

const limit = 8000;
const result = { stdout: '', stderr: '', console: [], page_errors: [], truncated: false };
const mime = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.wasm': 'application/wasm',
};
const root = process.cwd();
const server = http.createServer((req, res) => {
  let filename;
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    filename = path.resolve(root, '.' + pathname);
    if (!filename.startsWith(root + path.sep)) throw new Error('outside root');
    const actual = fs.realpathSync(filename);
    if (!actual.startsWith(root + path.sep) || !fs.statSync(actual).isFile()) throw new Error('not a file');
    res.setHeader('Content-Type', mime[path.extname(actual)] || 'application/octet-stream');
    const stream = fs.createReadStream(actual);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch {
    res.writeHead(404).end();
  }
});

function clip(text) {
  if (text.length <= limit) return text;
  result.truncated = true;
  return text.slice(0, limit);
}

let logChars = 0;
function collect(list, item) {
  const length = typeof item === 'string' ? item.length : item.text.length;
  if (list.length === 200 || logChars + length > 32000) {
    result.truncated = true;
  } else {
    list.push(item);
    logChars += length;
  }
}

async function run() {
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const executablePath = fs.existsSync('/opt/runner/chromium') ? '/opt/runner/chromium' : undefined;
    browser = await chromium.launch({ executablePath, args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.on('console', msg => {
      const level = msg.type() === 'warning' ? 'warn' : msg.type();
      collect(result.console, { level: ['log', 'info', 'warn', 'error'].includes(level) ? level : 'log', text: clip(msg.text()) });
    });
    page.on('pageerror', err => collect(result.page_errors, clip(err.message)));
    const entry = process.argv[2].slice(2).split('/').map(encodeURIComponent).join('/');
    await page.goto('http://127.0.0.1:' + server.address().port + '/' + entry);
    const test = fs.readFileSync(process.argv[3], 'utf8');
    if (test) {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await new AsyncFunction('page', 'sleep', test)(page, sleep);
    }
  } catch (err) {
    process.exitCode = 1;
    result.stderr = clip(result.stderr + String(err));
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

const write = process.stdout.write.bind(process.stdout);
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => {
    const key = level === 'warn' || level === 'error' ? 'stderr' : 'stdout';
    if (result[key].length < limit) result[key] = clip(result[key] + format(...args) + '\n');
    else result.truncated = true;
  };
}
run().finally(() => write(JSON.stringify(result)));
