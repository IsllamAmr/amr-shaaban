const crypto = require('crypto');

function verifyPasswordHash(input, passwordHash) {
  const [algorithm, nValue, rValue, pValue, saltValue, expectedKeyValue] = passwordHash.split('$');
  const options = {
    N: Number(nValue),
    r: Number(rValue),
    p: Number(pValue),
    maxmem: 128 * 1024 * 1024
  };
  const saltBuffer = Buffer.from(saltValue, 'base64url');
  const expectedKeyBuffer = Buffer.from(expectedKeyValue, 'base64url');
  const derivedKeyBuffer = crypto.scryptSync(String(input || ''), saltBuffer, expectedKeyBuffer.length, options);
  return crypto.timingSafeEqual(derivedKeyBuffer, expectedKeyBuffer);
}

const hash = 'scrypt$16384$8$1$fGCPy4Itq4Kb41iSMmCsfA$AVKgQ9ZSyOO74FnOk6Mo2z-c0nkMEdT9aTlcz8a2QtMSk6PsIvc_EO1qYzMMTLKYcn2xFKmumL86XeSICZVP6A';
const passwords = ['Amr@2026!', 'admin', 'password', '12345678'];

passwords.forEach(pw => {
    console.log(`Password: ${pw}, Match: ${verifyPasswordHash(pw, hash)}`);
});
