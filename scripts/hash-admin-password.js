const crypto = require('crypto');

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const options = { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
  const derivedKey = crypto.scryptSync(password, salt, 64, options);
  return `scrypt$${options.N}$${options.r}$${options.p}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

function printUsageAndExit() {
  console.error('Usage: node scripts/hash-admin-password.js "YourStrongPassword"');
  process.exit(1);
}

const password = process.argv[2];

if (!password || password.length < 8) {
  printUsageAndExit();
}

process.stdout.write(`${createPasswordHash(password)}\n`);
