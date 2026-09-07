// Run the checked-in page's model in Node so the collector and page cannot drift.
// Browser startup is deliberately excluded; no remote scripts are evaluated.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createRuntime(extra = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'bid-compass.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const marker = '// Browser startup';
  if (!source.includes(marker)) throw new Error('Missing browser startup boundary');
  const elements = new Map(), storage = new Map();
  const context = vm.createContext({
    console, URL, AbortController, setTimeout, clearTimeout, structuredClone,
    fetch: globalThis.fetch,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', style: {}, classList: { toggle() {} } });
        return elements.get(id);
      },
      querySelectorAll: () => [],
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    ...extra,
  });
  vm.runInContext(source.slice(0, source.indexOf(marker)), context, { filename: 'bid-compass.html' });
  return { context, elements, storage, run: code => vm.runInContext(code, context) };
}

module.exports = { createRuntime };
