// Specs that take the shared schema back and forth: only for the disposable
// database of scripts/test-migration-e2e.sh (`npm run test:e2e:migrations`).
// jest-e2e.json ignores them.
const base = require('./jest-e2e.json');

module.exports = {
  ...base,
  testRegex: 'transaction-ownership-migration\\.e2e-spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/'],
};
