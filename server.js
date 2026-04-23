const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const hpp = require('hpp');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const HTML_FILE = 'index.html';
const STYLE_FILE = 'style.css';
const SCRIPT_FILE = 'script.js';
const APP_CONFIG_FILE = 'app-config.js';
const SESSION_COOKIE = '__session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const ATTEMPT_TOKEN_TTL_MS = 1000 * 60 * 60 * 8;
const RESULT_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 180;
const STUDENT_ATTEMPT_TOKEN_GRACE_MS = 10 * 60 * 1000;
const STUDENT_SUBMIT_GRACE_MS = 3 * 60 * 1000;
const MAX_JSON_BODY_SIZE = 10 * 1024 * 1024;
const MAX_ATTACHMENT_SIZE = 2 * 1024 * 1024;
const DIFFICULTY_LEVELS = new Set(['easy', 'medium', 'hard', 'impossible']);
const STORAGE_ROOT = (process.env.STORAGE_ROOT || 'exam-platform').replace(/^\/+|\/+$/g, '');
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  '.pdf',
  '.txt',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp'
]);
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
]);

loadEnvFile(path.join(ROOT_DIR, '.env'));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const LEGACY_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').trim();
const ADMIN_DISPLAY_NAME = String(process.env.ADMIN_DISPLAY_NAME || '').trim();
const ADMIN_PASSWORD_HASH = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
const ADMIN_USERS_JSON = String(process.env.ADMIN_USERS_JSON || '').trim();
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const FIREBASE_SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const FIREBASE_ROOT = (process.env.FIREBASE_ROOT || 'examPlatform').replace(/^\/+|\/+$/g, '');
const FIREBASE_STORAGE_BUCKET = String(process.env.FIREBASE_STORAGE_BUCKET || '').trim();
const ALLOWED_ORIGINS = new Set(
  String(
    process.env.ALLOWED_ORIGINS
    || 'http://localhost:3000,http://127.0.0.1:3000,https://amr-shaaban.web.app,https://amr-shaaban.firebaseapp.com'
  )
    .split(',')
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean)
);
const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
const ADMIN_ACCOUNTS = loadAdminAccountsConfig();
const ADMIN_ACCOUNT_MAP = new Map(ADMIN_ACCOUNTS.map((account) => [account.username, account]));

let database;
let storageBucket;

try {
  validateServerConfiguration();
  warnAboutLegacyConfiguration();
} catch (error) {
  console.error('Server configuration failed.');
  console.error(error.message);
  process.exit(1);
}

try {
  ({ database, storageBucket } = initializeFirebaseServices());
} catch (error) {
  console.error('Firebase initialization failed.');
  console.error(error.message);
  process.exit(1);
}
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadAdminAccountsConfig() {
  const configuredAccounts = [];

  if (ADMIN_USERS_JSON) {
    let parsedAccounts;
    try {
      parsedAccounts = JSON.parse(ADMIN_USERS_JSON);
    } catch (error) {
      throw new Error('ADMIN_USERS_JSON must be valid JSON.');
    }

    const accountList = Array.isArray(parsedAccounts) ? parsedAccounts : [parsedAccounts];
    configuredAccounts.push(...accountList);
  }

  if (ADMIN_USERNAME || ADMIN_PASSWORD_HASH || ADMIN_DISPLAY_NAME) {
    configuredAccounts.push({
      username: ADMIN_USERNAME,
      displayName: ADMIN_DISPLAY_NAME,
      passwordHash: ADMIN_PASSWORD_HASH
    });
  }

  return configuredAccounts.map((account, index) => normalizeAdminAccount(account, index));
}

function normalizeAdminUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeAdminAccount(account, index) {
  const username = normalizeAdminUsername(account?.username || account?.email || account?.user);
  const displayName = String(account?.displayName || account?.name || username).trim();
  const passwordHash = String(account?.passwordHash || '').trim();

  if (!username) {
    throw new Error(`Admin account #${index + 1} is missing a username.`);
  }

  if (!/^[\p{L}\p{N}._@-]{3,64}$/u.test(username)) {
    throw new Error(`Admin username "${username}" contains unsupported characters.`);
  }

  if (!passwordHash) {
    throw new Error(`Admin account "${username}" is missing passwordHash.`);
  }

  if (!isSupportedPasswordHash(passwordHash)) {
    throw new Error(`Admin account "${username}" has an unsupported password hash format.`);
  }

  return {
    username,
    displayName: displayName || username,
    passwordHash
  };
}

function validateServerConfiguration() {
  const issues = [];

  if (!SESSION_SECRET || SESSION_SECRET.length < 32 || /^change-this-secret$/i.test(SESSION_SECRET)) {
    issues.push('SESSION_SECRET must be explicitly configured to a strong random value with at least 32 characters.');
  }

  if (!ADMIN_ACCOUNTS.length) {
    issues.push('Configure at least one admin account using ADMIN_USERNAME + ADMIN_PASSWORD_HASH, or ADMIN_USERS_JSON.');
  }

  const duplicateUsernames = new Set();
  for (const account of ADMIN_ACCOUNTS) {
    if (duplicateUsernames.has(account.username)) {
      issues.push(`Admin username "${account.username}" is duplicated.`);
      continue;
    }
    duplicateUsernames.add(account.username);
  }

  if (!ADMIN_ACCOUNTS.length && LEGACY_ADMIN_PASSWORD) {
    issues.push('ADMIN_PASSWORD is no longer accepted. Migrate to ADMIN_USERNAME + ADMIN_PASSWORD_HASH.');
  }

  if (issues.length) {
    throw new Error(issues.map((issue) => `- ${issue}`).join('\n'));
  }
}

function warnAboutLegacyConfiguration() {
  if (LEGACY_ADMIN_PASSWORD) {
    console.warn('Legacy ADMIN_PASSWORD is present in .env but ignored. Remove it after confirming the new admin account login works.');
  }
}

function isSupportedPasswordHash(passwordHash) {
  return /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(passwordHash);
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyPasswordHash(input, passwordHash) {
  if (!isSupportedPasswordHash(passwordHash)) {
    return false;
  }

  const [algorithm, nValue, rValue, pValue, saltValue, expectedKeyValue] = passwordHash.split('$');

  if (algorithm !== 'scrypt') {
    return false;
  }

  const options = {
    N: Number(nValue),
    r: Number(rValue),
    p: Number(pValue),
    maxmem: 128 * 1024 * 1024
  };

  if (!Number.isFinite(options.N) || !Number.isFinite(options.r) || !Number.isFinite(options.p)) {
    return false;
  }

  const saltBuffer = Buffer.from(saltValue, 'base64url');
  const expectedKeyBuffer = Buffer.from(expectedKeyValue, 'base64url');
  const derivedKeyBuffer = crypto.scryptSync(String(input || ''), saltBuffer, expectedKeyBuffer.length, options);

  if (derivedKeyBuffer.length !== expectedKeyBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(derivedKeyBuffer, expectedKeyBuffer);
}

function getAdminAccount(username) {
  return ADMIN_ACCOUNT_MAP.get(normalizeAdminUsername(username)) || null;
}

function resolveStorageBucketName(serviceAccount) {
  if (FIREBASE_STORAGE_BUCKET) {
    return FIREBASE_STORAGE_BUCKET;
  }

  const projectId = serviceAccount?.project_id || process.env.FIREBASE_PROJECT_ID;

  if (!projectId) {
    return '';
  }

  return `${projectId}.firebasestorage.app`;
}

function initializeFirebaseServices() {
  if (!FIREBASE_DATABASE_URL) {
    throw new Error('Missing FIREBASE_DATABASE_URL in .env');
  }

  const serviceAccount = loadFirebaseServiceAccount();
  const storageBucketName = resolveStorageBucketName(serviceAccount);

  const appOptions = {
    databaseURL: FIREBASE_DATABASE_URL
  };

  if (storageBucketName) {
    appOptions.storageBucket = storageBucketName;
  }

  appOptions.credential = serviceAccount
    ? admin.credential.cert(serviceAccount)
    : admin.credential.applicationDefault();

  admin.initializeApp(appOptions);

  return {
    database: admin.database(),
    storageBucket: storageBucketName ? admin.storage().bucket(storageBucketName) : null
  };
}

function loadFirebaseServiceAccount() {
  if (FIREBASE_SERVICE_ACCOUNT_PATH) {
    const resolvedPath = path.isAbsolute(FIREBASE_SERVICE_ACCOUNT_PATH)
      ? FIREBASE_SERVICE_ACCOUNT_PATH
      : path.join(ROOT_DIR, FIREBASE_SERVICE_ACCOUNT_PATH);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Firebase service account file not found: ${resolvedPath}`);
    }

    return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  }

  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (inlineJson) {
    return JSON.parse(inlineJson);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    return {
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, '\n')
    };
  }

  return null;
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createDebugRequestId(prefix = 'req') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function summarizeQuestionBankPayload(body = {}) {
  const questions = Array.isArray(body?.questions) ? body.questions : [];

  return {
    title: typeof body?.title === 'string' ? body.title : '',
    descriptionLength: typeof body?.description === 'string' ? body.description.length : 0,
    questionCount: questions.length,
    questionIds: questions.map((question) => question?.id).filter(Boolean)
  };
}

function logQuestionBankOp(event, payload = {}) {
  logAudit('QuestionBank', event, payload);
}

function normalizeOrigin(origin) {
  if (!origin) {
    return '';
  }

  try {
    return new URL(String(origin).trim()).origin;
  } catch (error) {
    return '';
  }
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(text);
}

function parseCookies(request) {
  const cookieHeader = request.headers.cookie;

  if (!cookieHeader) {
    return {};
  }

  return cookieHeader.split(';').reduce((accumulator, item) => {
    const separatorIndex = item.indexOf('=');

    if (separatorIndex === -1) {
      return accumulator;
    }

    const key = item.slice(0, separatorIndex).trim();
    const value = decodeURIComponent(item.slice(separatorIndex + 1).trim());
    accumulator[key] = value;
    return accumulator;
  }, {});
}

function createSessionSignature(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function createSignedSessionCookieValue(user) {
  const payload = Buffer.from(JSON.stringify({
    role: user.role, // 'super_admin', 'teacher', or 'student'
    uid: user.username || user.uid,
    name: user.displayName || user.name,
    exp: Date.now() + SESSION_TTL_MS
  })).toString('base64url');
  const signature = createSessionSignature(payload);
  return `${payload}.${signature}`;
}

function readSessionFromRequest(request) {
  const cookies = parseCookies(request);
  const rawCookie = cookies[SESSION_COOKIE];

  if (!rawCookie) {
    return null;
  }

  const [payload, signature] = rawCookie.split('.');

  if (!payload || !signature) {
    return null;
  }

  const expectedSignature = createSessionSignature(payload);

  if (!timingSafeStringEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    if (
      !['super_admin', 'teacher', 'student'].includes(parsed.role)
      || typeof parsed.uid !== 'string'
      || typeof parsed.exp !== 'number'
      || parsed.exp <= Date.now()
    ) {
      return null;
    }

    return parsed;
  } catch (error) {
    return null;
  }
}

function requireAuth(request) {
  const session = readSessionFromRequest(request);
  if (!session) {
    throw createHttpError(401, 'يجب تسجيل الدخول أولاً.');
  }
  return session;
}

function requireRole(role) {
  return (request, response, next) => {
    try {
      const session = requireAuth(request);
      if (session.role !== role) {
        throw createHttpError(403, 'غير مسموح لك بالوصول لهذا الجزء.');
      }
      request.session = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireSuperAdmin(request) {
  const session = readSessionFromRequest(request);
  if (!session || session.role !== 'super_admin') {
    throw createHttpError(403, 'هذه البوابة مخصصة للإدارة العليا فقط');
  }
  return session;
}

function requireAdmin(request) {
  return requireSuperAdmin(request);
}

async function getUserPermissions(uid) {
  const snapshot = await database.ref(firebasePath('users', uid, 'permissions')).get();
  return snapshot.exists() ? snapshot.val() : {};
}

async function requireTeacher(request, permission = null) {
  const session = readSessionFromRequest(request);
  
  if (!session) {
    throw createHttpError(401, 'دخول المدرس مطلوب.');
  }

  if (session.role !== 'teacher') {
    throw createHttpError(403, 'هذه البوابة مخصصة للمعلمين فقط.');
  }

  if (permission) {
    const perms = await getUserPermissions(session.uid);
    if (perms[permission] === false) {
      throw createHttpError(403, 'ليس لديك صلاحية لهذه العملية. يرجى مراجعة المسؤول.');
    }
  }

  return session;
}

function requireStudent(request) {
  const session = readSessionFromRequest(request);
  if (!session || session.role !== 'student') {
    throw createHttpError(401, 'دخول الطالب مطلوب.');
  }
  return session;
}


function getRequestProtocol(request) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  if (forwardedProto) {
    return forwardedProto;
  }

  return request.socket.encrypted ? 'https' : 'http';
}

function getRequestHost(request) {
  return String(request.headers['x-forwarded-host'] || request.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
}

function getRequestOrigin(request) {
  const protocol = getRequestProtocol(request);
  const host = getRequestHost(request);
  return protocol && host ? `${protocol}://${host}` : '';
}

function getAllowedRequestOrigin(request) {
  const requestOrigin = normalizeOrigin(request.headers.origin);

  if (!requestOrigin) {
    return '';
  }

  if (requestOrigin === getRequestOrigin(request)) {
    return requestOrigin;
  }

  return ALLOWED_ORIGINS.has(requestOrigin) ? requestOrigin : '';
}

function appendVaryHeader(response, value) {
  const currentValue = String(response.getHeader('Vary') || '').trim();

  if (!currentValue) {
    response.setHeader('Vary', value);
    return;
  }

  const parts = currentValue.split(',').map((item) => item.trim().toLowerCase());

  if (!parts.includes(value.toLowerCase())) {
    response.setHeader('Vary', `${currentValue}, ${value}`);
  }
}

function applyCorsHeaders(request, response) {
  const allowedOrigin = getAllowedRequestOrigin(request);

  if (!allowedOrigin) {
    return false;
  }

  response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Upload-Filename, X-Upload-Content-Type');
  response.setHeader('Access-Control-Max-Age', '86400');
  appendVaryHeader(response, 'Origin');
  return true;
}

function getSessionCookiePolicy(request) {
  const requestOrigin = getRequestOrigin(request);
  const browserOrigin = getAllowedRequestOrigin(request);
  const isCrossOrigin = Boolean(browserOrigin && requestOrigin && browserOrigin !== requestOrigin);
  const isSecure = getRequestProtocol(request) === 'https';

  return {
    sameSite: isCrossOrigin ? 'None' : 'Lax',
    secure: isCrossOrigin || isSecure
  };
}

function createSessionCookie(request, value) {
  const cookiePolicy = getSessionCookiePolicy(request);
  const securePart = cookiePolicy.secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=${cookiePolicy.sameSite}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${securePart}`;
}

function clearSessionCookie(request) {
  const cookiePolicy = getSessionCookiePolicy(request);
  const securePart = cookiePolicy.secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=${cookiePolicy.sameSite}; Path=/; Max-Age=0${securePart}`;
}

function firebasePath(...segments) {
  return [FIREBASE_ROOT, ...segments].join('/');
}

function requireStorageBucket() {
  if (!storageBucket) {
    throw createHttpError(500, 'خدمة تخزين الملفات غير مهيأة على الخادم.');
  }

  return storageBucket;
}

function sanitizeFileName(fileName) {
  const normalizedName = path.basename(String(fileName || '').trim()).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
  const collapsed = normalizedName.replace(/\s+/g, ' ').trim();

  if (!collapsed) {
    throw createHttpError(400, 'اسم الملف غير صالح.');
  }

  const extension = path.extname(collapsed).toLowerCase();
  const baseName = path.basename(collapsed, extension).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const safeBaseName = baseName || 'file';
  const safeExtension = ALLOWED_ATTACHMENT_EXTENSIONS.has(extension) ? extension : '';
  return `${safeBaseName}${safeExtension}`;
}

function buildSafeAttachmentFileName(fileName, contentType) {
  const safeName = sanitizeFileName(fileName);
  const extension = path.extname(safeName).toLowerCase();

  if (extension) {
    return safeName;
  }

  if (contentType === 'application/pdf') {
    return `${safeName}.pdf`;
  }

  if (contentType === 'text/plain') {
    return `${safeName}.txt`;
  }

  if (contentType.startsWith('image/')) {
    const imageExtension = contentType.split('/')[1]?.toLowerCase() || 'bin';
    return `${safeName}.${imageExtension === 'jpeg' ? 'jpg' : imageExtension}`;
  }

  return `${safeName}.bin`;
}

function getAttachmentKind(contentType, fileName) {
  const normalizedType = String(contentType || '').trim().toLowerCase();
  const extension = path.extname(String(fileName || '')).toLowerCase();

  if (normalizedType.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) {
    return 'image';
  }

  return 'file';
}

function ensureAllowedAttachment(fileName, contentType, size) {
  const normalizedType = String(contentType || '').trim().toLowerCase();
  const normalizedSize = Number(size || 0);
  const extension = path.extname(String(fileName || '')).toLowerCase();
  const hasAllowedExtension = extension ? ALLOWED_ATTACHMENT_EXTENSIONS.has(extension) : true;
  const hasAllowedMime = normalizedType
    ? (ALLOWED_ATTACHMENT_MIME_TYPES.has(normalizedType) || normalizedType.startsWith('image/'))
    : true;

  if (!normalizedSize || normalizedSize > MAX_ATTACHMENT_SIZE) {
    throw createHttpError(400, 'حجم الملف غير مسموح به.');
  }

  if (!hasAllowedExtension || !hasAllowedMime) {
    throw createHttpError(400, 'نوع الملف غير مدعوم.');
  }
}

function decodeUploadHeader(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  try {
    return decodeURIComponent(value);
  } catch (error) {
    return value;
  }
}

function createStorageDownloadUrl(bucketName, storagePath, downloadToken) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;
}

function buildAttachmentMetadata({
  id,
  fileName,
  contentType,
  size,
  storagePath,
  downloadToken,
  uploadedAt,
  kind,
  temporary = false
}) {
  const bucket = requireStorageBucket();

  return {
    id,
    fileName,
    contentType,
    size,
    storagePath,
    downloadUrl: createStorageDownloadUrl(bucket.name, storagePath, downloadToken),
    uploadedAt,
    kind,
    temporary
  };
}

function getTemporaryAttachmentPrefix() {
  return `${STORAGE_ROOT}/uploads/temp/`;
}

function isTemporaryAttachmentPath(storagePath) {
  return typeof storagePath === 'string' && storagePath.startsWith(getTemporaryAttachmentPrefix());
}

function getQuestionAttachmentPrefix(ownerType, ownerId, questionId) {
  return `${STORAGE_ROOT}/${ownerType}/${ownerId}/questions/${questionId}`;
}

function getQuestionAttachmentStoragePath(ownerType, ownerId, questionId, attachmentId, fileName) {
  return `${getQuestionAttachmentPrefix(ownerType, ownerId, questionId)}/${attachmentId}-${fileName}`;
}

function getAttachmentStoragePath(attachment) {
  return typeof attachment?.storagePath === 'string' && attachment.storagePath.trim()
    ? attachment.storagePath.trim()
    : '';
}

function mapStorageOperationError(error) {
  const message = String(error?.message || '').toLowerCase();

  if (
    message.includes('bucket does not exist')
    || message.includes('billing account')
    || message.includes('storage bucket')
  ) {
    return createHttpError(409, 'Firebase Storage bucket is not available for this project yet.');
  }

  return error;
}

function sanitizeText(value, fieldName, maxLength) {
  if (typeof value !== 'string') {
    throw createHttpError(400, `حقل ${fieldName} غير صالح.`);
  }

  const trimmed = value.replace(/\r\n/g, '\n').trim();

  if (!trimmed) {
    throw createHttpError(400, `حقل ${fieldName} مطلوب.`);
  }

  if (trimmed.length > maxLength) {
    throw createHttpError(400, `حقل ${fieldName} طويل جدًا.`);
  }

  return trimmed;
}

function sanitizeCode(value) {
  const code = sanitizeText(value, 'كود الامتحان', 20).toUpperCase();

  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) {
    throw createHttpError(400, 'كود الامتحان يجب أن يحتوي على حروف إنجليزية كبيرة أو أرقام فقط بدون مسافات.');
  }

  return code;
}

function sanitizeAttachment(attachment, index) {
  if (!attachment) {
    return null;
  }

  if (typeof attachment !== 'object') {
    throw createHttpError(400, `Question attachment ${index + 1} is invalid.`);
  }

  const fileName = sanitizeText(
    attachment.fileName ?? attachment.name,
    `Attachment name ${index + 1}`,
    200
  );
  const contentType = sanitizeOptionalText(
    attachment.contentType ?? attachment.type,
    `Attachment type ${index + 1}`,
    200
  ) || 'application/octet-stream';
  const size = Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : 0;
  const dataUrl = typeof attachment.dataUrl === 'string' ? attachment.dataUrl.trim() : '';
  const storagePath = getAttachmentStoragePath(attachment);
  const downloadUrl = typeof attachment.downloadUrl === 'string' ? attachment.downloadUrl.trim() : '';
  const uploadedAt = Number.isFinite(Number(attachment.uploadedAt)) ? Number(attachment.uploadedAt) : Date.now();
  const id = typeof attachment.id === 'string' && attachment.id.trim() ? attachment.id.trim() : createId('att');
  const kind = getAttachmentKind(contentType, fileName);

  if (!dataUrl && !storagePath) {
    throw createHttpError(400, `Question attachment ${index + 1} is incomplete.`);
  }

  if (dataUrl && !dataUrl.startsWith('data:')) {
    throw createHttpError(400, `Question attachment ${index + 1} must contain a valid Data URL.`);
  }

  if (storagePath && !storagePath.startsWith(`${STORAGE_ROOT}/`)) {
    throw createHttpError(400, `Question attachment path ${index + 1} is invalid.`);
  }

  ensureAllowedAttachment(fileName, contentType, size);

  return {
    id,
    fileName,
    contentType,
    size,
    kind,
    storagePath,
    downloadUrl,
    uploadedAt,
    temporary: Boolean(attachment.temporary),
    ...(dataUrl ? { dataUrl } : {})
  };
}

function sanitizeAdminQuestion(question, index) {
  if (!question || typeof question !== 'object') {
    throw createHttpError(400, `السؤال ${index + 1} غير صالح.`);
  }

  const text = sanitizeText(question.text, `نص السؤال ${index + 1}`, 500);
  const id = typeof question.id === 'string' && question.id.trim()
    ? question.id.trim()
    : `q${index + 1}`;
  const difficulty = DIFFICULTY_LEVELS.has(question.difficulty) ? question.difficulty : 'medium';
  const sourceBankId = typeof question.sourceBankId === 'string' ? question.sourceBankId.trim() : '';
  const sourceBankTitle = typeof question.sourceBankTitle === 'string' ? question.sourceBankTitle.trim() : '';
  const attachment = sanitizeAttachment(question.attachment, index);

  if (!['mcq', 'tf'].includes(question.type)) {
    throw createHttpError(400, `نوع السؤال ${index + 1} غير مدعوم.`);
  }

  const correct = Number.parseInt(question.correct, 10);

  if (question.type === 'mcq') {
    if (!Array.isArray(question.options) || question.options.length !== 4) {
      throw createHttpError(400, `السؤال ${index + 1} يجب أن يحتوي على 4 اختيارات.`);
    }

    const options = question.options.map((option, optionIndex) =>
      sanitizeText(option, `اختيار ${optionIndex + 1} في السؤال ${index + 1}`, 300)
    );

    if (![0, 1, 2, 3].includes(correct)) {
      throw createHttpError(400, `الإجابة الصحيحة للسؤال ${index + 1} غير صالحة.`);
    }

    return {
      id,
      text,
      type: 'mcq',
      options,
      correct,
      attachment,
      difficulty,
      sourceBankId,
      sourceBankTitle
    };
  }

  if (![0, 1].includes(correct)) {
    throw createHttpError(400, `الإجابة الصحيحة للسؤال ${index + 1} غير صالحة.`);
  }

  return {
    id,
    text,
    type: 'tf',
    options: ['صح', 'خطأ'],
    correct,
    attachment,
    difficulty,
    sourceBankId,
    sourceBankTitle
  };
}

function normalizeDifficulty(value) {
  return DIFFICULTY_LEVELS.has(value) ? value : 'medium';
}

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') {
    return null;
  }

  const fileName = typeof attachment.fileName === 'string'
    ? attachment.fileName
    : (typeof attachment.name === 'string' ? attachment.name : '');
  const contentType = typeof attachment.contentType === 'string'
    ? attachment.contentType
    : (typeof attachment.type === 'string' ? attachment.type : '');
  const dataUrl = typeof attachment.dataUrl === 'string' ? attachment.dataUrl : '';
  const downloadUrl = typeof attachment.downloadUrl === 'string' ? attachment.downloadUrl : '';

  if (!fileName || (!dataUrl && !downloadUrl && !attachment.storagePath)) {
    return null;
  }

  return {
    id: typeof attachment.id === 'string' ? attachment.id : '',
    fileName: String(fileName),
    contentType,
    size: Number(attachment.size || 0),
    storagePath: getAttachmentStoragePath(attachment),
    downloadUrl,
    uploadedAt: Number(attachment.uploadedAt || 0),
    kind: getAttachmentKind(contentType, fileName),
    temporary: Boolean(attachment.temporary),
    ...(dataUrl ? { dataUrl } : {})
  };
}

function buildTemporaryAttachmentStoragePath(attachmentId, fileName) {
  return `${STORAGE_ROOT}/uploads/temp/${attachmentId}/${fileName}`;
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(?:;base64)?,([\s\S]+)$/.exec(String(dataUrl || ''));

  if (!match) {
    throw createHttpError(400, 'Attachment payload could not be decoded.');
  }

  return {
    contentType: match[1] || 'application/octet-stream',
    buffer: Buffer.from(match[2], 'base64')
  };
}

async function saveBufferToStorage({ id, storagePath, fileName, contentType, size, buffer, uploadedAt, temporary = false }) {
  const bucket = requireStorageBucket();
  const file = bucket.file(storagePath);
  const downloadToken = crypto.randomUUID();

  try {
    await file.save(buffer, {
      resumable: false,
      metadata: {
        contentType,
        cacheControl: 'public, max-age=31536000',
        metadata: {
          firebaseStorageDownloadTokens: downloadToken
        }
      }
    });
  } catch (error) {
    throw mapStorageOperationError(error);
  }

  return buildAttachmentMetadata({
    id,
    fileName,
    contentType,
    size,
    storagePath,
    downloadToken,
    uploadedAt,
    kind: getAttachmentKind(contentType, fileName),
    temporary
  });
}

async function uploadTemporaryAttachment({ fileName, contentType, size, buffer }) {
  const safeFileName = buildSafeAttachmentFileName(fileName, contentType);
  ensureAllowedAttachment(safeFileName, contentType, size);
  const attachmentId = createId('att');
  const uploadedAt = Date.now();
  const storagePath = buildTemporaryAttachmentStoragePath(attachmentId, safeFileName);

  return saveBufferToStorage({
    id: attachmentId,
    storagePath,
    fileName: safeFileName,
    contentType,
    size,
    buffer,
    uploadedAt,
    temporary: true
  });
}

async function readBinaryBody(request, maxSize = MAX_ATTACHMENT_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    request.on('data', (chunk) => {
      totalSize += chunk.length;

      if (totalSize > maxSize) {
        reject(createHttpError(413, 'Attachment file is larger than the allowed limit.'));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function deleteStorageFile(storagePath) {
  const normalizedPath = typeof storagePath === 'string' ? storagePath.trim() : '';

  if (!normalizedPath || !normalizedPath.startsWith(`${STORAGE_ROOT}/`)) {
    return;
  }

  try {
    await requireStorageBucket().file(normalizedPath).delete({ ignoreNotFound: true });
  } catch (error) {
    if (String(error?.message || '').toLowerCase().includes('bucket')) {
      throw mapStorageOperationError(error);
    }

    if (error.code !== 404) {
      throw error;
    }
  }
}

async function deleteStorageFiles(storagePaths = []) {
  const uniquePaths = [...new Set(storagePaths.filter(Boolean))];
  await Promise.all(uniquePaths.map((storagePath) => deleteStorageFile(storagePath)));
}

function extractAttachmentStoragePathsFromQuestions(questions = []) {
  return questions
    .map((question) => getAttachmentStoragePath(question?.attachment))
    .filter(Boolean);
}

function getRemovedAttachmentStoragePaths(previousQuestions = [], nextQuestions = []) {
  const nextPaths = new Set(extractAttachmentStoragePathsFromQuestions(nextQuestions));
  return extractAttachmentStoragePathsFromQuestions(previousQuestions).filter((storagePath) => !nextPaths.has(storagePath));
}

async function copyStorageObject(sourcePath, targetPath, contentType) {
  const bucket = requireStorageBucket();
  const sourceFile = bucket.file(sourcePath);
  const targetFile = bucket.file(targetPath);
  const downloadToken = crypto.randomUUID();

  try {
    await sourceFile.copy(targetFile);
    await targetFile.setMetadata({
      contentType,
      cacheControl: 'public, max-age=31536000',
      metadata: {
        firebaseStorageDownloadTokens: downloadToken
      }
    });
  } catch (error) {
    throw mapStorageOperationError(error);
  }

  return downloadToken;
}

async function finalizeQuestionAttachment(attachment, { ownerType, ownerId, questionId }) {
  const normalized = normalizeAttachment(attachment);

  if (!normalized) {
    return null;
  }

  const attachmentId = normalized.id || createId('att');
  const fileName = buildSafeAttachmentFileName(normalized.fileName, normalized.contentType);
  const targetPath = getQuestionAttachmentStoragePath(ownerType, ownerId, questionId, attachmentId, fileName);

  if (normalized.dataUrl) {
    const decoded = decodeDataUrl(normalized.dataUrl);
    return saveBufferToStorage({
      id: attachmentId,
      storagePath: targetPath,
      fileName,
      contentType: normalized.contentType || decoded.contentType,
      size: normalized.size || decoded.buffer.length,
      buffer: decoded.buffer,
      uploadedAt: normalized.uploadedAt || Date.now(),
      temporary: false
    });
  }

  if (!normalized.storagePath) {
    throw createHttpError(400, 'Attachment does not contain a valid storage path.');
  }

  if (normalized.storagePath === targetPath && !normalized.temporary) {
    return {
      ...normalized,
      id: attachmentId,
      fileName,
      contentType: normalized.contentType || 'application/octet-stream',
      temporary: false
    };
  }

  const downloadToken = await copyStorageObject(
    normalized.storagePath,
    targetPath,
    normalized.contentType || 'application/octet-stream'
  );

  if (normalized.temporary || isTemporaryAttachmentPath(normalized.storagePath)) {
    await deleteStorageFile(normalized.storagePath);
  }

  return buildAttachmentMetadata({
    id: attachmentId,
    fileName,
    contentType: normalized.contentType || 'application/octet-stream',
    size: normalized.size,
    storagePath: targetPath,
    downloadToken,
    uploadedAt: normalized.uploadedAt || Date.now(),
    kind: normalized.kind,
    temporary: false
  });
}

async function finalizeQuestionAttachments(questions, ownerType, ownerId) {
  const finalizedQuestions = [];

  for (const question of questions) {
    finalizedQuestions.push({
      ...question,
      attachment: await finalizeQuestionAttachment(question.attachment, {
        ownerType,
        ownerId,
        questionId: question.id
      })
    });
  }

  return finalizedQuestions;
}

function normalizeExamQuestions(rawQuestions) {
  if (!rawQuestions) {
    return [];
  }

  const list = Array.isArray(rawQuestions) ? rawQuestions : Object.values(rawQuestions);
  return list.filter(Boolean).map((question, index) => ({
    id: typeof question.id === 'string' && question.id.trim() ? question.id.trim() : `q${index + 1}`,
    type: question.type === 'tf' ? 'tf' : 'mcq',
    text: String(question.text || ''),
    options: Array.isArray(question.options) ? question.options.map((option) => String(option || '')) : [],
    attachment: normalizeAttachment(question.attachment),
    difficulty: normalizeDifficulty(question.difficulty),
    sourceBankId: typeof question.sourceBankId === 'string' ? question.sourceBankId : '',
    sourceBankTitle: typeof question.sourceBankTitle === 'string' ? question.sourceBankTitle : ''
  }));
}

function normalizeLooseAnswers(rawAnswers, total) {
  const expectedLength = Number.isInteger(total) && total > 0 ? total : 0;

  if (Array.isArray(rawAnswers)) {
    return Array.from({ length: Math.max(expectedLength, rawAnswers.length) }, (_, index) => {
      const parsed = Number.parseInt(rawAnswers[index], 10);
      return Number.isFinite(parsed) ? parsed : -1;
    });
  }

  if (rawAnswers && typeof rawAnswers === 'object') {
    const objectKeys = Object.keys(rawAnswers);
    return Array.from({ length: Math.max(expectedLength, objectKeys.length) }, (_, index) => {
      const parsed = Number.parseInt(rawAnswers[index], 10);
      return Number.isFinite(parsed) ? parsed : -1;
    });
  }

  return Array.from({ length: expectedLength }, () => -1);
}

function calculateScore(correctAnswers, answers) {
  return correctAnswers.reduce((score, correctAnswer, index) => (
    answers[index] === correctAnswer ? score + 1 : score
  ), 0);
}

function toNumericValue(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getPassStatus(scorePercent) {
  return scorePercent >= 50 ? 'ناجح' : 'لم يجتز';
}

async function readAdminCollections() {
  const [examsSnapshot, keysSnapshot, submissionsSnapshot] = await Promise.all([
    database.ref(firebasePath('examsPublic')).get(),
    database.ref(firebasePath('examKeys')).get(),
    database.ref(firebasePath('submissions')).get()
  ]);

  return {
    examsMap: examsSnapshot.exists() ? examsSnapshot.val() : {},
    keysMap: keysSnapshot.exists() ? keysSnapshot.val() : {},
    submissionsMap: submissionsSnapshot.exists() ? submissionsSnapshot.val() : {}
  };
}

async function readAdminExamBundle(examId) {
  const [examSnapshot, keySnapshot, submissionsSnapshot] = await Promise.all([
    database.ref(firebasePath('examsPublic', examId)).get(),
    database.ref(firebasePath('examKeys', examId)).get(),
    database.ref(firebasePath('submissions', examId)).get()
  ]);

  if (!examSnapshot.exists()) {
    throw createHttpError(404, 'الامتحان غير موجود.');
  }

  return {
    exam: examSnapshot.val(),
    keyData: keySnapshot.exists() ? keySnapshot.val() : null,
    submissions: submissionsSnapshot.exists() ? submissionsSnapshot.val() : {}
  };
}

function buildSubmissionList(submissionMap, correctAnswers, total) {
  return Object.entries(submissionMap || {})
    .map(([id, item]) => {
      const answers = normalizeLooseAnswers(item.answers, total);
      const score = calculateScore(correctAnswers, answers);
      const answeredCount = toNumericValue(item.answeredCount, answers.filter((answer) => answer >= 0).length);

      return {
        id,
        studentName: sanitizeText(String(item.studentName || 'طالب'), 'اسم الطالب', 120),
        studentGroup: String(item.studentGroup || item.className || item.groupName || 'غير محدد').trim() || 'غير محدد',
        answers,
        at: item.submittedAt || item.at || Date.now(),
        answeredCount,
        score,
        total,
        pct: total ? Math.round((score / total) * 100) : 0
      };
    })
    .sort((first, second) => Number(second.at || 0) - Number(first.at || 0));
}

function buildAdminDashboardPayload(examsMap, keysMap, submissionsMap) {
  const allResults = [];
  const examEntries = Object.entries(examsMap || {}).map(([id, exam]) => {
    const questions = normalizeExamQuestions(exam.questions);
    const correctAnswers = normalizeLooseAnswers(keysMap?.[id]?.correctAnswers, questions.length);
    const results = buildSubmissionList(submissionsMap?.[id], correctAnswers, questions.length);

    results.forEach((result) => {
      // Strip 'answers' array from dashboard payload — not needed for charts, saves bandwidth
      const { answers: _omitted, ...resultWithoutAnswers } = result;
      allResults.push({
        ...resultWithoutAnswers,
        examId: id,
        examTitle: String(exam.title || '')
      });
    });

    return {
      id,
      title: String(exam.title || ''),
      code: String(exam.code || ''),
      duration: Number.parseInt(exam.duration, 10) || 30,
      active: Boolean(exam.active),
      createdAt: exam.createdAt || 0,
      questionCount: questions.length,
      resultCount: results.length,
      averageScore: results.length
        ? Math.round(results.reduce((sum, item) => sum + item.pct, 0) / results.length)
        : 0
    };
  }).sort((first, second) => Number(second.createdAt || 0) - Number(first.createdAt || 0));

  const allPercentages = allResults.map((result) => result.pct);

  return {
    summary: {
      examCount: examEntries.length,
      studentCount: allPercentages.length,
      averageScore: allPercentages.length
        ? Math.round(allPercentages.reduce((sum, value) => sum + value, 0) / allPercentages.length)
        : 0
    },
    exams: examEntries,
    allResults
  };
}

function buildAdminExamPayload(body) {
  const title = sanitizeText(body.title, 'عنوان الامتحان', 120);
  const code = sanitizeCode(body.code);
  const duration = Number.parseInt(body.duration, 10);

  if (!Number.isInteger(duration) || duration < 5 || duration > 180) {
    throw createHttpError(400, 'مدة الامتحان يجب أن تكون بين 5 و180 دقيقة.');
  }

  if (!Array.isArray(body.questions) || !body.questions.length) {
    throw createHttpError(400, 'أدخل سؤالًا واحدًا على الأقل.');
  }

  return {
    title,
    code,
    duration,
    questions: body.questions.map((question, index) => sanitizeAdminQuestion(question, index))
  };
}

async function createAdminExam(body) {
  const payload = buildAdminExamPayload(body);
  const existingCodeSnapshot = await database.ref(firebasePath('examCodeRegistry', payload.code)).get();

  if (existingCodeSnapshot.exists()) {
    throw createHttpError(409, 'كود الامتحان مستخدم بالفعل. اختر كودًا آخر.');
  }

  const examId = database.ref(firebasePath('examsPublic')).push().key || createId('ex');
  const timestamp = admin.database.ServerValue.TIMESTAMP;
  const finalizedQuestions = await finalizeQuestionAttachments(payload.questions, 'exams', examId);

  await database.ref().update({
    [firebasePath('examsPublic', examId)]: {
      id: examId,
      title: payload.title,
      code: payload.code,
      duration: payload.duration,
      active: true,
      questionCount: finalizedQuestions.length,
      createdAt: timestamp,
      questions: finalizedQuestions.map((question) => ({
        id: question.id,
        type: question.type,
        text: question.text,
        options: question.options,
        attachment: question.attachment || null,
        difficulty: question.difficulty,
        sourceBankId: question.sourceBankId,
        sourceBankTitle: question.sourceBankTitle
      }))
    },
    [firebasePath('examKeys', examId)]: {
      correctAnswers: finalizedQuestions.map((question) => question.correct),
      updatedAt: timestamp
    },
    [firebasePath('examCodeRegistry', payload.code)]: examId,
    [firebasePath('publicExamCodes', payload.code)]: examId
  });

  return {
    id: examId,
    title: payload.title,
    code: payload.code,
    duration: payload.duration,
    active: true,
    questionCount: finalizedQuestions.length
  };
}

async function setAdminExamStatus(examId, requestedActive) {
  const examSnapshot = await database.ref(firebasePath('examsPublic', examId)).get();

  if (!examSnapshot.exists()) {
    throw createHttpError(404, 'الامتحان غير موجود.');
  }

  const exam = examSnapshot.val();
  const nextActive = typeof requestedActive === 'boolean' ? requestedActive : !Boolean(exam.active);
  const updates = {
    [firebasePath('examsPublic', examId, 'active')]: nextActive
  };

  updates[firebasePath('publicExamCodes', exam.code)] = nextActive ? examId : null;
  await database.ref().update(updates);
  return nextActive;
}

async function deleteAdminExam(examId) {
  const examSnapshot = await database.ref(firebasePath('examsPublic', examId)).get();

  if (!examSnapshot.exists()) {
    throw createHttpError(404, 'الامتحان غير موجود.');
  }

  const exam = examSnapshot.val();
  const attachmentPaths = extractAttachmentStoragePathsFromQuestions(normalizeExamQuestions(exam.questions));
  await database.ref().update({
    [firebasePath('examsPublic', examId)]: null,
    [firebasePath('examKeys', examId)]: null,
    [firebasePath('submissions', examId)]: null,
    [firebasePath('studentAttempts', examId)]: null,
    [firebasePath('examCodeRegistry', exam.code)]: null,
    [firebasePath('publicExamCodes', exam.code)]: null,
    [firebasePath('publishedResults', exam.code)]: null
  });
  await deleteStorageFiles(attachmentPaths);
}

function buildAdminExamResultsPayload(examId, exam, keyData, submissions) {
  const normalizedExam = {
    ...exam,
    id: examId,
    questions: normalizeExamQuestions(exam.questions)
  };
  const correctAnswers = normalizeLooseAnswers(keyData?.correctAnswers, normalizedExam.questions.length);
  const results = buildSubmissionList(submissions, correctAnswers, normalizedExam.questions.length);

  return {
    exam: normalizedExam,
    correctAnswers,
    results
  };
}

async function publishAdminExamResults(examId) {
  const { exam, keyData, submissions } = await readAdminExamBundle(examId);
  const payload = buildAdminExamResultsPayload(examId, exam, keyData, submissions);

  if (!payload.results.length) {
    throw createHttpError(400, 'لا توجد نتائج لهذا الامتحان بعد.');
  }

  const publishedPayload = Object.fromEntries(payload.results.map((item) => ([
    item.id,
    {
      studentName: item.studentName,
      studentGroup: item.studentGroup,
      examTitle: payload.exam.title,
      score: item.score,
      total: item.total,
      pct: item.pct,
      status: getPassStatus(item.pct),
      publishedAt: admin.database.ServerValue.TIMESTAMP,
      submittedAt: item.at
    }
  ])));

  await database.ref(firebasePath('publishedResults', payload.exam.code)).set(publishedPayload);
  return {
    publishedCount: payload.results.length,
    examCode: payload.exam.code
  };
}

function sanitizeOptionalText(value, fieldName, maxLength) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value !== 'string') {
    throw createHttpError(400, `حقل ${fieldName} غير صالح.`);
  }

  const trimmed = value.replace(/\r\n/g, '\n').trim();

  if (trimmed.length > maxLength) {
    throw createHttpError(400, `حقل ${fieldName} طويل جدًا.`);
  }

  return trimmed;
}

function normalizeQuestionBankQuestions(rawQuestions) {
  if (!rawQuestions) {
    return [];
  }

  const list = Array.isArray(rawQuestions) ? rawQuestions : Object.values(rawQuestions);

  return list
    .filter(Boolean)
    .map((question, index) => {
      const type = question.type === 'tf' ? 'tf' : 'mcq';
      const parsedCorrect = Number.parseInt(question.correct, 10);

      return {
        id: typeof question.id === 'string' && question.id.trim() ? question.id.trim() : `bq${index + 1}`,
        text: String(question.text || ''),
        type,
        options: type === 'tf'
          ? ['صح', 'خطأ']
          : (Array.isArray(question.options) ? question.options.map((option) => String(option || '')) : ['', '', '', '']),
        correct: Number.isFinite(parsedCorrect) ? parsedCorrect : -1,
        attachment: normalizeAttachment(question.attachment),
        difficulty: normalizeDifficulty(question.difficulty),
        sourceBankId: typeof question.sourceBankId === 'string' ? question.sourceBankId.trim() : '',
        sourceBankTitle: typeof question.sourceBankTitle === 'string' ? question.sourceBankTitle.trim() : ''
      };
    });
}

function mapQuestionBankRecord(bankId, bank) {
  const questions = normalizeQuestionBankQuestions(bank?.questions);

  return {
    id: bankId,
    title: String(bank?.title || ''),
    description: String(bank?.description || ''),
    createdAt: bank?.createdAt || 0,
    updatedAt: bank?.updatedAt || 0,
    questionCount: questions.length,
    questions
  };
}

async function getQuestionBankRecord(bankId) {
  const normalizedBankId = sanitizeText(bankId, 'معرف بنك الأسئلة', 120);
  const snapshot = await database.ref(firebasePath('questionBanks', normalizedBankId)).get();

  if (!snapshot.exists()) {
    throw createHttpError(404, 'بنك الأسئلة غير موجود.');
  }

  return mapQuestionBankRecord(normalizedBankId, snapshot.val());
}

async function listQuestionBanks(debugMeta = {}) {
  const snapshot = await database.ref(firebasePath('questionBanks')).get();
  const banksMap = snapshot.exists() ? snapshot.val() : {};
  const banks = Object.entries(banksMap)
    .map(([bankId, bank]) => mapQuestionBankRecord(bankId, bank))
    .sort((first, second) => Number(second.updatedAt || second.createdAt || 0) - Number(first.updatedAt || first.createdAt || 0));

  logQuestionBankOp('list', {
    requestId: debugMeta.requestId || null,
    count: banks.length,
    ids: banks.map((bank) => bank.id)
  });

  return banks;
}

function sanitizeQuestionBankPayload(body = {}) {
  const title = sanitizeText(body.title, 'اسم بنك الأسئلة', 120);
  const description = sanitizeOptionalText(body.description, 'وصف بنك الأسئلة', 500);

  if (!Array.isArray(body.questions)) {
    throw createHttpError(400, 'أدخل أسئلة بنك الأسئلة في صورة قائمة صحيحة.');
  }

  if (!body.questions.length) {
    throw createHttpError(400, 'أضف سؤالًا واحدًا على الأقل داخل بنك الأسئلة.');
  }

  const questions = body.questions.map((question, index) => {
    const sanitizedQuestion = sanitizeAdminQuestion(question, index);

    return {
      ...sanitizedQuestion,
      sourceBankId: '',
      sourceBankTitle: ''
    };
  });

  return {
    title,
    description,
    questions
  };
}

async function createQuestionBank(body, debugMeta = {}) {
  const payload = sanitizeQuestionBankPayload(body);
  const bankId = database.ref(firebasePath('questionBanks')).push().key || createId('bank');
  const timestamp = admin.database.ServerValue.TIMESTAMP;
  const finalizedQuestions = await finalizeQuestionAttachments(payload.questions, 'question-banks', bankId);
  const questionBankRef = database.ref(firebasePath('questionBanks', bankId));

  logQuestionBankOp('create:before-write', {
    requestId: debugMeta.requestId || null,
    bankId,
    payload: summarizeQuestionBankPayload(payload)
  });

  await questionBankRef.set({
    title: payload.title,
    description: payload.description,
    questions: finalizedQuestions,
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const createdBank = await getQuestionBankRecord(bankId);

  logQuestionBankOp('create:after-write', {
    requestId: debugMeta.requestId || null,
    bankId,
    questionCount: createdBank.questionCount,
    updatedAt: createdBank.updatedAt || createdBank.createdAt || null
  });

  return createdBank;
}

async function updateQuestionBank(bankId, body, debugMeta = {}) {
  const existingBank = await getQuestionBankRecord(bankId);
  const payload = sanitizeQuestionBankPayload(body);
  const timestamp = admin.database.ServerValue.TIMESTAMP;
  const finalizedQuestions = await finalizeQuestionAttachments(payload.questions, 'question-banks', existingBank.id);
  const removedAttachmentPaths = getRemovedAttachmentStoragePaths(existingBank.questions, finalizedQuestions);
  const expectedUpdatedAt = Number(body?.expectedUpdatedAt || 0);
  const currentUpdatedAt = Number(existingBank.updatedAt || existingBank.createdAt || 0);

  logQuestionBankOp('update:before-write', {
    requestId: debugMeta.requestId || null,
    bankId: existingBank.id,
    expectedUpdatedAt,
    currentUpdatedAt,
    previousQuestionCount: existingBank.questionCount,
    previousQuestionIds: existingBank.questions.map((question) => question.id),
    payload: summarizeQuestionBankPayload(payload)
  });

  if (expectedUpdatedAt && currentUpdatedAt && expectedUpdatedAt !== currentUpdatedAt) {
    logQuestionBankOp('update:stale-write-blocked', {
      requestId: debugMeta.requestId || null,
      bankId: existingBank.id,
      expectedUpdatedAt,
      currentUpdatedAt
    });
    throw createHttpError(409, 'تم تعديل بنك الأسئلة من جلسة أخرى. أعد تحميل البنوك ثم جرّب الحفظ مرة أخرى.');
  }

  await database.ref(firebasePath('questionBanks', existingBank.id)).update({
    title: payload.title,
    description: payload.description,
    questions: finalizedQuestions,
    updatedAt: timestamp
  });
  await deleteStorageFiles(removedAttachmentPaths);
  const updatedBank = await getQuestionBankRecord(existingBank.id);

  logQuestionBankOp('update:after-write', {
    requestId: debugMeta.requestId || null,
    bankId: existingBank.id,
    previousQuestionCount: existingBank.questionCount,
    nextQuestionCount: updatedBank.questionCount,
    updatedAt: updatedBank.updatedAt || updatedBank.createdAt || null
  });

  return updatedBank;
}

async function deleteQuestionBankRecord(bankId, debugMeta = {}) {
  const existingBank = await getQuestionBankRecord(bankId);
  const attachmentPaths = extractAttachmentStoragePathsFromQuestions(existingBank.questions);

  logQuestionBankOp('delete:before-write', {
    requestId: debugMeta.requestId || null,
    bankId: existingBank.id,
    questionCount: existingBank.questionCount,
    questionIds: existingBank.questions.map((question) => question.id)
  });

  await database.ref(firebasePath('questionBanks', existingBank.id)).remove();
  await deleteStorageFiles(attachmentPaths);

  logQuestionBankOp('delete:after-write', {
    requestId: debugMeta.requestId || null,
    bankId: existingBank.id
  });
}

async function addQuestionToBank(bankId, body = {}) {
  const bank = await getQuestionBankRecord(bankId);
  const questionInput = body.question && typeof body.question === 'object' ? body.question : body;
  const sanitizedQuestion = sanitizeAdminQuestion({
    ...questionInput,
    id: typeof questionInput.id === 'string' && questionInput.id.trim() ? questionInput.id.trim() : createId('bq'),
    sourceBankId: '',
    sourceBankTitle: ''
  }, bank.questions.length);
  const nextQuestions = [...bank.questions, {
    ...sanitizedQuestion,
    sourceBankId: '',
    sourceBankTitle: ''
  }];
  const finalizedQuestions = await finalizeQuestionAttachments(nextQuestions, 'question-banks', bank.id);

  await database.ref(firebasePath('questionBanks', bank.id)).update({
    questions: finalizedQuestions,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });

  return {
    bank: await getQuestionBankRecord(bank.id),
    question: finalizedQuestions[finalizedQuestions.length - 1]
  };
}

async function updateBankQuestion(bankId, questionId, body = {}) {
  const bank = await getQuestionBankRecord(bankId);
  const questionIndex = bank.questions.findIndex((question) => question.id === questionId);

  if (questionIndex === -1) {
    throw createHttpError(404, 'سؤال البنك المطلوب غير موجود.');
  }

  const mergedQuestion = {
    ...bank.questions[questionIndex],
    ...(body.question && typeof body.question === 'object' ? body.question : body),
    id: bank.questions[questionIndex].id,
    sourceBankId: '',
    sourceBankTitle: ''
  };
  const sanitizedQuestion = sanitizeAdminQuestion(mergedQuestion, questionIndex);
  const nextQuestions = [...bank.questions];
  nextQuestions[questionIndex] = {
    ...sanitizedQuestion,
    sourceBankId: '',
    sourceBankTitle: ''
  };
  const finalizedQuestions = await finalizeQuestionAttachments(nextQuestions, 'question-banks', bank.id);
  const removedAttachmentPaths = getRemovedAttachmentStoragePaths(bank.questions, finalizedQuestions);

  await database.ref(firebasePath('questionBanks', bank.id)).update({
    questions: finalizedQuestions,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  await deleteStorageFiles(removedAttachmentPaths);

  return {
    bank: await getQuestionBankRecord(bank.id),
    question: finalizedQuestions[questionIndex]
  };
}

async function deleteBankQuestion(bankId, questionId) {
  const bank = await getQuestionBankRecord(bankId);
  const nextQuestions = bank.questions.filter((question) => question.id !== questionId);

  if (nextQuestions.length === bank.questions.length) {
    throw createHttpError(404, 'سؤال البنك المطلوب غير موجود.');
  }

  await database.ref(firebasePath('questionBanks', bank.id)).update({
    questions: nextQuestions,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
  await deleteStorageFiles(getRemovedAttachmentStoragePaths(bank.questions, nextQuestions));

  return {
    bank: await getQuestionBankRecord(bank.id)
  };
}

async function importQuestionBankQuestions(bankId, body = {}, debugMeta = {}) {
  const bank = await getQuestionBankRecord(bankId);
  const requestedQuestionIds = Array.isArray(body.questionIds)
    ? body.questionIds
      .map((questionId) => (typeof questionId === 'string' ? questionId.trim() : ''))
      .filter(Boolean)
    : [];

  const sourceQuestions = requestedQuestionIds.length
    ? bank.questions.filter((question) => requestedQuestionIds.includes(question.id))
    : bank.questions;

  if (requestedQuestionIds.length && sourceQuestions.length !== requestedQuestionIds.length) {
    throw createHttpError(404, 'بعض أسئلة البنك المطلوبة غير موجودة.');
  }

  if (!sourceQuestions.length) {
    throw createHttpError(400, 'لا توجد أسئلة متاحة للاستيراد من هذا البنك.');
  }

  logQuestionBankOp('import:read-only', {
    requestId: debugMeta.requestId || null,
    bankId: bank.id,
    requestedQuestionIds,
    returnedQuestionIds: sourceQuestions.map((question) => question.id)
  });

  return {
    questions: sourceQuestions.map((question) => ({
      id: createId('q'),
      text: question.text,
      type: question.type,
      options: [...question.options],
      correct: question.correct,
      attachment: question.attachment || null,
      difficulty: question.difficulty,
      sourceBankId: bank.id,
      sourceBankTitle: bank.title
    }))
  };
}

function sanitizeStudentIdentity(body = {}) {
  const studentName = sanitizeText(body.studentName ?? body.name, 'اسم الطالب', 120);
  const studentGroup = sanitizeOptionalText(body.studentGroup ?? body.group, 'الفصل / المجموعة', 120);

  return {
    studentName,
    studentGroup
  };
}

function normalizeStudentIdentityPart(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildStudentIdentityKey(examId, identity) {
  const normalizedName = normalizeStudentIdentityPart(identity?.studentName);
  const normalizedGroup = normalizeStudentIdentityPart(identity?.studentGroup);

  return crypto
    .createHash('sha256')
    .update(`${examId}|${normalizedName}|${normalizedGroup}`)
    .digest('hex');
}

function createSignedStudentToken(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createSessionSignature(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function readSignedStudentToken(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const [encodedPayload, signature] = token.split('.');

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = createSessionSignature(encodedPayload);

  if (!timingSafeStringEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));

    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
      return null;
    }

    return payload;
  } catch (error) {
    return null;
  }
}

function createStudentAttemptToken(attemptRecord) {
  const startedAt = Number(attemptRecord?.startedAt) || Date.now();
  const durationMs = (Number(attemptRecord?.durationMinutes) || 30) * 60 * 1000;
  const exp = startedAt + durationMs + STUDENT_ATTEMPT_TOKEN_GRACE_MS;

  return createSignedStudentToken({
    type: 'student_attempt',
    examId: attemptRecord.examId,
    attemptId: attemptRecord.id,
    identityKey: attemptRecord.identityKey,
    startedAt,
    iat: Date.now(),
    exp
  });
}

function createStudentReceiptToken(examId, submissionId, attemptId) {
  return createSignedStudentToken({
    type: 'student_receipt',
    examId,
    submissionId,
    attemptId,
    exp: Date.now() + ATTEMPT_TOKEN_TTL_MS
  });
}

function createStudentResultToken(examId, submissionId, attemptId) {
  return createSignedStudentToken({
    type: 'student_result',
    examId,
    submissionId,
    attemptId,
    exp: Date.now() + RESULT_TOKEN_TTL_MS
  });
}

function requireValidStudentAttemptToken(token, examId) {
  const payload = readSignedStudentToken(token);

  if (
    !payload
    || payload.type !== 'student_attempt'
    || payload.examId !== examId
    || !payload.attemptId
    || !payload.identityKey
  ) {
    throw createHttpError(401, 'جلسة الامتحان غير صالحة. أعد فتح الامتحان ثم حاول مرة أخرى.');
  }

  return payload;
}

function requireValidStudentReceiptToken(token, examId, submissionId) {
  const payload = readSignedStudentToken(token);

  if (!payload || payload.type !== 'student_receipt' || payload.examId !== examId || payload.submissionId !== submissionId) {
    throw createHttpError(401, 'رابط إيصال التسليم غير صالح.');
  }

  return payload;
}

function requireValidStudentResultToken(token) {
  const payload = readSignedStudentToken(token);

  if (!payload || payload.type !== 'student_result' || !payload.examId || !payload.submissionId || !payload.attemptId) {
    throw createHttpError(401, 'بيانات متابعة النتيجة غير صحيحة.');
  }

  return payload;
}

async function getExamById(examId) {
  const normalizedExamId = sanitizeText(examId, 'معرف الامتحان', 120);
  const snapshot = await database.ref(firebasePath('examsPublic', normalizedExamId)).get();

  if (!snapshot.exists()) {
    throw createHttpError(404, 'الامتحان المطلوب غير موجود.');
  }

  const exam = snapshot.val();

  if (!exam.active) {
    throw createHttpError(403, 'الامتحان غير متاح الآن.');
  }

  return {
    id: normalizedExamId,
    ...exam
  };
}

async function getActiveExamById(examId) {
  return getExamById(examId);
}

async function getExamRecordById(examId) {
  const normalizedExamId = sanitizeText(examId, 'معرف الامتحان', 120);
  const snapshot = await database.ref(firebasePath('examsPublic', normalizedExamId)).get();

  if (!snapshot.exists()) {
    throw createHttpError(404, 'الامتحان المطلوب غير موجود.');
  }

  return {
    id: normalizedExamId,
    ...snapshot.val()
  };
}

async function resolveExamAccess(body = {}) {
  const examIdInput = typeof body.examId === 'string' ? body.examId.trim() : '';
  const codeInput = typeof body.code === 'string' ? body.code.trim() : '';

  if (!examIdInput && !codeInput) {
    throw createHttpError(400, 'أدخل كود الامتحان أو استخدم الرابط المباشر.');
  }

  let examId = examIdInput;

  if (!examId) {
    const code = sanitizeCode(codeInput);
    const codeSnapshot = await database.ref(firebasePath('publicExamCodes', code)).get();

    if (!codeSnapshot.exists()) {
      throw createHttpError(404, 'كود الامتحان غير صحيح أو الامتحان غير متاح الآن.');
    }

    examId = String(codeSnapshot.val());
  }

  return getActiveExamById(examId);
}

function sanitizeExamPreview(examId, exam) {
  const questions = normalizeExamQuestions(exam.questions);

  return {
    id: examId,
    title: String(exam.title || ''),
    code: String(exam.code || ''),
    duration: Number.parseInt(exam.duration, 10) || 30,
    questionCount: questions.length
  };
}

function sanitizeCurrentExamForStudent(examId, exam) {
  const questions = normalizeExamQuestions(exam.questions);

  return {
    id: examId,
    title: String(exam.title || ''),
    code: String(exam.code || ''),
    duration: Number.parseInt(exam.duration, 10) || 30,
    questionCount: questions.length,
    questions: questions.map((question) => ({
      id: question.id,
      text: question.text,
      type: question.type,
      options: question.options,
      attachment: question.attachment
    }))
  };
}

async function readExistingSubmissionByAttemptId(examId, attemptId) {
  const submissionSnapshot = await database.ref(firebasePath('submissions', examId, attemptId)).get();

  if (!submissionSnapshot.exists()) {
    return null;
  }

  return {
    id: attemptId,
    ...submissionSnapshot.val()
  };
}

function buildStudentReceipt(exam, submission, options = {}) {
  const trackingToken = typeof options.trackingToken === 'string' ? options.trackingToken : '';

  return {
    submissionId: submission.id,
    trackingToken,
    examId: submission.examId,
    examCode: String(exam.code || ''),
    examTitle: String(exam.title || ''),
    studentName: String(submission.studentName || ''),
    studentGroup: String(submission.studentGroup || ''),
    answeredCount: toNumericValue(submission.answeredCount, 0),
    totalQuestions: toNumericValue(submission.totalQuestions, 0),
    score: toNumericValue(submission.score, 0),
    pct: toNumericValue(submission.pct, 0),
    status: String(submission.status || getPassStatus(toNumericValue(submission.pct, 0))),
    submittedAt: submission.submittedAt || Date.now()
  };
}

async function startStudentExam(examId, body = {}, request = null) {
  const exam = await getActiveExamById(examId);
  const session = request ? readSessionFromRequest(request) : null;
  
  // Prioritize session identity if available
  const studentName = session?.name || body.studentName || body.name;
  const studentGroup = body.studentGroup || body.group || "";
  
  const identity = { studentName, studentGroup };
  const identityKey = session?.uid || buildStudentIdentityKey(exam.id, identity);
  
  const attemptRef = database.ref(firebasePath('studentAttempts', exam.id, identityKey));
  const initialSnapshot = await attemptRef.get();
  let attemptRecord = initialSnapshot.exists()
    ? { ...initialSnapshot.val(), examId: exam.id, identityKey }
    : null;
  let resumed = initialSnapshot.exists();

  if (!attemptRecord?.id || !attemptRecord?.startedAt) {
    const startedAt = Date.now();
    const initialAttemptRecord = {
      id: createId('atm'),
      examId: exam.id,
      identityKey,
      studentName: identity.studentName,
      studentGroup: identity.studentGroup,
      durationMinutes: Number.parseInt(exam.duration, 10) || 30,
      startedAt,
      createdAt: startedAt,
      lastSeenAt: startedAt,
      status: 'active'
    };
    const transactionResult = await attemptRef.transaction((current) => {
      if (current && typeof current === 'object' && current.id && current.startedAt) {
        return current;
      }

      return initialAttemptRecord;
    });
    attemptRecord = {
      ...transactionResult.snapshot.val(),
      examId: exam.id,
      identityKey
    };
    resumed = attemptRecord.id !== initialAttemptRecord.id;
  }

  const existingSubmission = await readExistingSubmissionByAttemptId(exam.id, attemptRecord.id);

  if (existingSubmission) {
    await attemptRef.update({
      status: 'submitted',
      submittedAt: Number(existingSubmission.submittedAt) || Date.now(),
      submissionId: existingSubmission.id,
      lastSeenAt: Date.now()
    });
    throw createHttpError(409, 'تم تسليم هذا الامتحان بالفعل لهذا الطالب، ولا يمكن بدء محاولة جديدة.');
  }

  const durationMs = (Number(attemptRecord.durationMinutes) || 30) * 60 * 1000;
  const elapsedMs = Date.now() - Number(attemptRecord.startedAt || 0);

  if (elapsedMs > (durationMs + STUDENT_SUBMIT_GRACE_MS)) {
    await attemptRef.update({
      status: 'expired',
      expiredAt: Date.now(),
      lastSeenAt: Date.now()
    });
    throw createHttpError(408, 'بدأت هذه المحاولة بالفعل وانتهى وقتها، ولا يمكن منح وقت جديد لنفس الطالب.');
  }

  await attemptRef.update({
    status: 'active',
    lastSeenAt: Date.now()
  });

  const remainingSeconds = Math.max(0, Math.ceil((durationMs - elapsedMs) / 1000));

  return {
    studentName: String(attemptRecord.studentName || identity.studentName),
    studentGroup: String(attemptRecord.studentGroup || identity.studentGroup),
    exam: sanitizeCurrentExamForStudent(exam.id, {
      ...exam,
      duration: Number(attemptRecord.durationMinutes) || Number.parseInt(exam.duration, 10) || 30
    }),
    attemptId: attemptRecord.id,
    attemptToken: createStudentAttemptToken(attemptRecord),
    remainingSeconds,
    resumed
  };
}

function assertExamWithinAllowedTime(attemptRecord) {
  if (!attemptRecord || !attemptRecord.startedAt) {
    throw createHttpError(403, 'جلسة الامتحان تفتقر إلى وقت البدء. يرجى إعادة بدء الامتحان.');
  }

  const durationMs = (Number(attemptRecord.durationMinutes) || 0) * 60 * 1000;
  const elapsedMs = Date.now() - Number(attemptRecord.startedAt || 0);

  if (elapsedMs > (durationMs + STUDENT_SUBMIT_GRACE_MS)) {
    throw createHttpError(408, 'انتهى وقت المسموح للامتحان ولم يتم التسليم المباشر. عذراً، لا يمكن قبول إجاباتك الآن.');
  }
}

async function submitStudentExam(examId, body = {}, request = null) {
  const exam = await getExamRecordById(examId);
  const session = request ? readSessionFromRequest(request) : null;
  
  // Resolve identity consistently with startStudentExam
  const studentName = session?.name || body.studentName || body.name;
  const studentGroup = body.studentGroup || body.group || "";
  const identity = { studentName, studentGroup };
  const identityKey = session?.uid || buildStudentIdentityKey(exam.id, identity);
  
  const attemptPayload = requireValidStudentAttemptToken(body.attemptToken, exam.id);
  const attemptRef = database.ref(firebasePath('studentAttempts', exam.id, identityKey));
  const attemptSnapshot = await attemptRef.get();

  if (attemptPayload.identityKey !== identityKey) {
    throw createHttpError(403, 'بيانات الطالب لا تطابق المحاولة النشطة لهذا الامتحان.');
  }

  if (!attemptSnapshot.exists()) {
    throw createHttpError(404, 'لا توجد محاولة نشطة لهذا الطالب على هذا الامتحان.');
  }

  const attemptRecord = {
    ...attemptSnapshot.val(),
    examId: exam.id,
    identityKey
  };

  if (!attemptRecord.id || attemptRecord.id !== attemptPayload.attemptId) {
    throw createHttpError(403, 'رمز المحاولة لا يطابق محاولة الطالب الحالية.');
  }

  const existingSubmission = await readExistingSubmissionByAttemptId(exam.id, attemptRecord.id);

  if (existingSubmission) {
    await attemptRef.update({
      status: 'submitted',
      submittedAt: Number(existingSubmission.submittedAt) || Date.now(),
      submissionId: existingSubmission.id,
      lastSeenAt: Date.now()
    });
    return {
      receipt: {
        ...buildStudentReceipt(exam, existingSubmission, {
          trackingToken: createStudentResultToken(exam.id, existingSubmission.id, attemptRecord.id)
        }),
        receiptToken: createStudentReceiptToken(exam.id, existingSubmission.id, attemptRecord.id),
        resultToken: createStudentResultToken(exam.id, existingSubmission.id, attemptRecord.id)
      }
    };
  }

  try {
    assertExamWithinAllowedTime(attemptRecord);
  } catch (error) {
    if (error.status === 408) {
      await attemptRef.update({
        status: 'expired',
        expiredAt: Date.now(),
        lastSeenAt: Date.now()
      });
    }
    throw error;
  }

  const questions = normalizeExamQuestions(exam.questions);
  const answers = normalizeLooseAnswers(body.answers, questions.length);
  const keySnapshot = await database.ref(firebasePath('examKeys', exam.id)).get();

  if (!keySnapshot.exists()) {
    throw createHttpError(500, 'مفاتيح الامتحان غير متاحة على الخادم.');
  }

  const correctAnswers = normalizeLooseAnswers(keySnapshot.val()?.correctAnswers, questions.length);
  const answeredCount = answers.filter((answer) => answer >= 0).length;
  const score = calculateScore(correctAnswers, answers);
  const pct = questions.length ? Math.round((score / questions.length) * 100) : 0;
  const submissionRef = database.ref(firebasePath('submissions', exam.id, attemptRecord.id));
  const submittedAt = Date.now();
  const submissionPayload = {
    id: attemptRecord.id,
    examId: exam.id,
    examCode: String(exam.code || ''),
    studentName: String(attemptRecord.studentName || identity.studentName),
    studentGroup: String(attemptRecord.studentGroup || identity.studentGroup),
    studentUid: session?.uid || null,
    attemptId: attemptRecord.id,
    answers,
    answeredCount,
    totalQuestions: questions.length,
    score,
    pct,
    status: getPassStatus(pct),
    submittedAt
  };

  const transactionResult = await submissionRef.transaction((current) => {
    if (current) {
      return;
    }

    return submissionPayload;
  });
  const storedSubmission = transactionResult.committed
    ? { id: attemptRecord.id, ...transactionResult.snapshot.val() }
    : await readExistingSubmissionByAttemptId(exam.id, attemptRecord.id);

  if (!storedSubmission) {
    throw createHttpError(409, 'تعذر تأكيد تسليم الإجابات. حاول مرة أخرى.');
  }

  await attemptRef.update({
    status: 'submitted',
    submittedAt: Number(storedSubmission.submittedAt) || submittedAt,
    submissionId: storedSubmission.id,
    lastSeenAt: Date.now()
  });

  // Record in student history if authenticated
  if (session?.uid) {
    const historyEntry = {
      examId: exam.id,
      examTitle: exam.title,
      examCode: exam.code,
      submissionId: storedSubmission.id,
      score: storedSubmission.score,
      total: storedSubmission.totalQuestions,
      pct: storedSubmission.pct,
      at: storedSubmission.submittedAt || submittedAt
    };
    await database.ref(firebasePath('studentHistory', session.uid, storedSubmission.id)).set(historyEntry);
  }

  const resultToken = createStudentResultToken(exam.id, storedSubmission.id, attemptRecord.id);

  return {
    receipt: {
      ...buildStudentReceipt(exam, storedSubmission, { trackingToken: resultToken }),
      receiptToken: createStudentReceiptToken(exam.id, storedSubmission.id, attemptRecord.id),
      resultToken
    }
  };
}

async function readStudentReceipt(examId, submissionId, receiptToken) {
  const exam = await getExamRecordById(examId);
  const tokenPayload = requireValidStudentReceiptToken(receiptToken, examId, submissionId);
  const submissionSnapshot = await database.ref(firebasePath('submissions', examId, submissionId)).get();

  if (!submissionSnapshot.exists()) {
    throw createHttpError(404, 'إيصال التسليم غير موجود.');
  }

  const submission = {
    id: submissionId,
    ...submissionSnapshot.val()
  };

  if (submission.attemptId !== tokenPayload.attemptId) {
    throw createHttpError(403, 'هذا الإيصال لا يخص نفس محاولة الطالب.');
  }

  return {
    receipt: {
      ...buildStudentReceipt(exam, submission, {
        trackingToken: createStudentResultToken(examId, submissionId, tokenPayload.attemptId)
      }),
      receiptToken,
      resultToken: createStudentResultToken(examId, submissionId, tokenPayload.attemptId)
    }
  };
}

function buildStudentPublishedResult(exam, publishedResult, trackingToken) {
  const pct = toNumericValue(publishedResult?.pct, 0);

  return {
    examCode: String(exam.code || ''),
    examTitle: String(publishedResult?.examTitle || exam.title || ''),
    studentName: String(publishedResult?.studentName || ''),
    studentGroup: String(publishedResult?.studentGroup || ''),
    score: toNumericValue(publishedResult?.score, 0),
    total: toNumericValue(publishedResult?.total, 0),
    pct,
    status: String(publishedResult?.status || getPassStatus(pct)),
    submittedAt: publishedResult?.submittedAt || null,
    publishedAt: publishedResult?.publishedAt || null,
    trackingToken
  };
}

async function lookupPublishedStudentResult(body = {}) {
  const code = sanitizeCode(body.code);
  const trackingToken = String(body.trackingToken || body.token || '').trim();

  if (!code || !trackingToken) {
    throw createHttpError(400, 'أدخل كود الامتحان ورقم متابعة النتيجة.');
  }

  const tokenPayload = requireValidStudentResultToken(trackingToken);
  const exam = await getExamRecordById(tokenPayload.examId);

  if (sanitizeCode(exam.code) !== code) {
    throw createHttpError(404, 'لم يتم العثور على نتيجة منشورة بهذه البيانات.');
  }

  const [submissionSnapshot, publishedSnapshot] = await Promise.all([
    database.ref(firebasePath('submissions', tokenPayload.examId, tokenPayload.submissionId)).get(),
    database.ref(firebasePath('publishedResults', code, tokenPayload.submissionId)).get()
  ]);

  if (!submissionSnapshot.exists() || !publishedSnapshot.exists()) {
    throw createHttpError(404, 'لم يتم العثور على نتيجة منشورة بهذه البيانات.');
  }

  const submission = submissionSnapshot.val();

  if (!submission || submission.attemptId !== tokenPayload.attemptId) {
    throw createHttpError(403, 'لا تملك صلاحية عرض هذه النتيجة.');
  }

  return {
    result: buildStudentPublishedResult(exam, publishedSnapshot.val(), trackingToken)
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    request.on('data', (chunk) => {
      totalSize += chunk.length;

      if (totalSize > MAX_JSON_BODY_SIZE) {
        reject(createHttpError(413, 'حجم الطلب كبير جدًا.'));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }

      try {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(createHttpError(400, 'تعذر قراءة بيانات الطلب.'));
      }
    });

    request.on('error', reject);
  });
}

function createId(prefix) {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

function getClientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  return request.socket.remoteAddress || 'unknown';
}

function safeStringify(obj) {
  const cache = new Set();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (cache.has(value)) return '[Circular]';
      cache.add(value);
    }
    if (key === 'password' || key === 'answers' || key === 'correctAnswers') return '[HIDDEN]';
    if (key === 'questions') return Array.isArray(value) ? `[Array(${value.length})]` : '[HIDDEN]';
    if (Buffer.isBuffer(value) || value?.type === 'Buffer') return '[Buffer]';
    if (typeof key === 'string' && key.toLowerCase().includes('token') && typeof value === 'string' && value.length > 20) {
      return value.substring(0, 6) + '...' + value.substring(value.length - 6);
    }
    return value;
  });
}

function logMessage(level, category, message, meta = {}) {
  console.log(`[${new Date().toISOString()}] [${level}] [${category}] ${message} | ${safeStringify(meta)}`);
}

function logInfo(category, message, meta = {}) { logMessage('INFO', category, message, meta); }
function logWarn(category, message, meta = {}) { logMessage('WARN', category, message, meta); }
function logSecurity(category, message, meta = {}) { logMessage('SECURITY', category, message, meta); }
function logAudit(category, message, meta = {}) { logMessage('AUDIT', category, message, meta); }
function logError(category, message, meta = {}, err = null) {
  const errDetails = err ? { errorMessage: err.message, stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined } : {};
  console.error(`[${new Date().toISOString()}] [ERROR] [${category}] ${message} | ${safeStringify({ ...meta, ...errDetails })}`);
}

// ============================================================
// EXPRESS APPLICATION
// ============================================================

const app = express();

// Trust proxy if behind a load balancer (e.g. Firebase Hosting, Heroku, etc.)
app.set('trust proxy', 1);

// --- Security Headers (Helmet) ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "img-src": ["'self'", "data:", "https://firebasestorage.googleapis.com"],
      "script-src": ["'self'", "'unsafe-inline'", "https://www.gstatic.com"],
      "connect-src": ["'self'", "https://firebasestorage.googleapis.com", "https://*.firebaseio.com"]
    },
  },
  crossOriginEmbedderPolicy: false // Often needed for Firebase Storage images
}));

// --- Prevent HTTP Parameter Pollution ---
app.use(hpp());

// --- Block access to sensitive files ---
app.use((req, res, next) => {
  const sensitivePatterns = [
    /^\/\.env/i,
    /^\/\.git/i,
    /^\/firebase-service-account/i,
    /^\/package(-lock)?\.json/i,
    /^\/Dockerfile/i,
    /^\/database\.rules\.json/i,
    /^\/firebase\.json/i,
    /^\/node_modules/i,
    /\.(bak|config|sql|log|sh|php)$/i
  ];
  
  if (sensitivePatterns.some(pattern => pattern.test(req.path))) {
    logSecurity('Access Control', 'Blocked attempt to access sensitive file', {
      requestId: req.requestId,
      ip: getClientIp(req),
      path: req.path
    });
    return res.status(403).send('Forbidden');
  }
  next();
});

// --- Request ID Middleware ---
app.use((request, response, next) => {
  request.requestId = createId('req');
  next();
});

// --- Global Rate Limiter ---
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'طلبات كثيرة جداً، يرجى المحاولة لاحقاً.' },
  keyGenerator: (req) => getClientIp(req)
});
app.use(globalLimiter);

// --- Stricter Rate Limiters for sensitive routes ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات دخول كثيرة جداً، يرجى الانتظار 15 دقيقة.' }
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'تجاوزت الحد المسموح لرفع الملفات، يرجى المحاولة لاحقاً.' }
});

const studentAccessLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات وصول كثيرة جداً، يرجى المحاولة لاحقاً.' }
});

const studentSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات تسليم كثيرة جداً، يرجى المحاولة لاحقاً.' }
});

app.use('/api/auth/login', loginLimiter);  // Fix: was incorrectly /api/admin/login
app.use('/api/admin/login', loginLimiter);  // Legacy compat shim
app.use('/api/admin/uploads', uploadLimiter);
app.use('/api/student/exam-access', studentAccessLimiter);
app.use('/api/student/exams/:examId/start', studentAccessLimiter);
app.use('/api/student/exams/:examId/submit', studentSubmitLimiter);
app.use('/api/student/results/lookup', studentAccessLimiter);

// --- CORS Middleware ---
app.use((request, response, next) => {
  const corsApplied = applyCorsHeaders(request, response);

  if (request.method === 'OPTIONS') {
    if (request.headers.origin && !corsApplied) {
      return sendJson(response, 403, { error: 'This origin is not allowed.' });
    }
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.path.startsWith('/api/') && request.headers.origin && !corsApplied) {
    return sendJson(response, 403, { error: 'This origin is not allowed.' });
  }

  next();
});

// --- Logging Middleware ---
app.use((request, response, next) => {
  logInfo('HTTP', 'Incoming Request', { requestId: request.requestId, method: request.method, pathname: request.path, ip: getClientIp(request) });
  next();
});

// --- Static Files & Client App ---
app.use(express.static(PUBLIC_DIR, { 
  index: 'index.html',
  dotfiles: 'deny',
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// JSON body parser for all API routes EXCEPT binary uploads
const parseJsonBody = express.json({ limit: '10mb' });

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api/health', (request, response) => {
  sendJson(response, 200, { status: 'ok', environment: process.env.NODE_ENV || 'production' });
});

// ============================================================
// ADMIN ROUTES — UPLOADS (binary body — no JSON parser)
// ============================================================

app.post('/api/admin/uploads', async (request, response, next) => {
  try {
    await requireTeacher(request, 'canUploadFiles');
    const fileName = decodeUploadHeader(String(request.headers['x-upload-filename'] || ''));
    const contentType = String(request.headers['x-upload-content-type'] || request.headers['content-type'] || 'application/octet-stream')
      .split(';')[0].trim().toLowerCase();

    if (!fileName) throw createHttpError(400, 'اسم الملف المرفوع مطلوب.');

    // Phase 4: Early rejection — check Content-Length before reading into RAM
    const contentLength = Number(request.headers['content-length'] || 0);
    if (contentLength > MAX_ATTACHMENT_SIZE) {
      throw createHttpError(413, 'Attachment file is larger than the allowed limit.');
    }

    const buffer = await readBinaryBody(request, MAX_ATTACHMENT_SIZE);
    const attachment = await uploadTemporaryAttachment({ fileName, contentType, size: buffer.length, buffer });
    sendJson(response, 201, { attachment });
  } catch (err) { next(err); }
});

app.delete('/api/admin/uploads', parseJsonBody, async (request, response, next) => {
  try {
    await requireTeacher(request, 'canUploadFiles');
    const storagePath = typeof request.body?.storagePath === 'string' ? request.body.storagePath.trim() : '';
    if (!isTemporaryAttachmentPath(storagePath)) throw createHttpError(400, 'لا يمكن حذف هذا المرفق من الواجهة مباشرة.');
    await deleteStorageFile(storagePath);
    sendJson(response, 200, { success: true });
  } catch (err) { next(err); }
});

async function findUserByUsername(username) {
  const normalized = normalizeAdminUsername(username);
  // First check static admins (fallback)
  const staticAdmin = getAdminAccount(normalized);
  if (staticAdmin) {
    return { ...staticAdmin, role: 'super_admin', uid: staticAdmin.username, isActive: true };
  }

  // Then check database
  const snapshot = await database.ref(firebasePath('users')).orderByChild('username').equalTo(normalized).get();
  if (!snapshot.exists()) return null;
  const users = snapshot.val();
  const uid = Object.keys(users)[0];
  return { uid, ...users[uid] };
}

async function ensureUsernameUnique(username) {
  const user = await findUserByUsername(username);
  if (user) throw createHttpError(409, 'اسم المستخدم هذا مستخدم بالفعل.');
}

// ============================================================
// AUTH ROUTES — SESSION & LOGIN
// ============================================================

app.get('/api/auth/session', (request, response) => {
  const session = readSessionFromRequest(request);
  if (!session) {
    sendJson(response, 200, { authenticated: false });
    return;
  }
  sendJson(response, 200, {
    authenticated: true,
    uid: session.uid,
    name: session.name,
    role: session.role
  });
});

// Legacy backward compatibility for old admin JS
app.get('/api/admin/session', (request, response) => {
  const session = readSessionFromRequest(request);
  if (!session || !['super_admin', 'teacher'].includes(session.role)) {
    sendJson(response, 200, { authenticated: false });
    return;
  }
  sendJson(response, 200, {
    authenticated: true,
    adminUid: session.uid,
    adminName: session.name
  });
});

app.post('/api/auth/login', parseJsonBody, async (request, response, next) => {
  try {
    const username = normalizeAdminUsername(request.body?.username);
    const password = String(request.body?.password || '');
    
    const user = await findUserByUsername(username);

    if (!user) {
      throw createHttpError(401, 'بيانات الدخول غير صحيحة.');
    }

    if (user.isActive === false) {
      throw createHttpError(403, 'هذا الحساب موقوف حالياً. يرجى مراجعة الإدارة.');
    }

    if (!['super_admin', 'teacher', 'student'].includes(user.role)) {
      throw createHttpError(403, 'نوع الحساب غير مدعوم في بوابات ركائز الحالية.');
    }

    // Verify password
    if (user.passwordHash && !verifyPasswordHash(password, user.passwordHash)) {
       logSecurity('Login', 'Failed login attempt', {
        requestId: request.requestId,
        ip: getClientIp(request),
        username: username || 'unknown'
      });
      throw createHttpError(401, 'بيانات الدخول غير صحيحة.');
    }

    logAudit('Login', 'Successful login', {
      requestId: request.requestId,
      ip: getClientIp(request),
      username: user.username || user.uid,
      role: user.role
    });

    const sessionCookieValue = createSignedSessionCookieValue({
      role: user.role,
      uid: user.uid,
      name: user.displayName || user.name || user.username
    });

    sendJson(
      response,
      200,
      { 
        success: true, 
        uid: user.uid, 
        name: user.displayName || user.name || user.username, 
        role: user.role
      },
      { 'Set-Cookie': createSessionCookie(request, sessionCookieValue) }
    );
  } catch (err) { next(err); }
});

// Legacy backward compatibility
app.post('/api/admin/login', parseJsonBody, async (request, response, next) => {
  request.url = '/api/auth/login';
  app.handle(request, response, next);
});

app.post('/api/auth/logout', (request, response) => {
  sendJson(response, 200, { success: true }, { 'Set-Cookie': clearSessionCookie(request) });
});

app.post('/api/admin/logout', (request, response) => {
  sendJson(response, 200, { success: true }, { 'Set-Cookie': clearSessionCookie(request) });
});

// ============================================================
// TEACHER ROUTES — STUDENT MANAGEMENT
// ============================================================

app.get('/api/teacher/students', async (request, response, next) => {
  try {
    const teacher = await requireTeacher(request, 'canManageStudents');
    const snapshot = await database.ref(firebasePath('users'))
      .orderByChild('createdBy').equalTo(teacher.uid).get();
    
    const students = [];
    if (snapshot.exists()) {
      Object.entries(snapshot.val()).forEach(([uid, user]) => {
        if (user.role === 'student') {
          const { passwordHash: _omit, ...safeUser } = user;
          students.push({ uid, ...safeUser });
        }
      });
    }
    sendJson(response, 200, { students });
  } catch (err) { next(err); }
});

app.post('/api/teacher/students', parseJsonBody, async (request, response, next) => {
  try {
    const teacher = await requireTeacher(request, 'canManageStudents');
    const body = request.body || {};
    const username = normalizeAdminUsername(body.username);
    const password = String(body.password || '');
    const name = sanitizeText(body.name, 'اسم الطالب', 120);

    if (!username || password.length < 6) throw createHttpError(400, 'بيانات الطالب غير كاملة أو كلمة المرور ضعيفة جداً.');
    await ensureUsernameUnique(username);

    // Create password hash using existing scrypt parameters
    const salt = crypto.randomBytes(16);
    const options = { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
    const derivedKey = crypto.scryptSync(password, salt, 64, options);
    const passwordHash = `scrypt$${options.N}$${options.r}$${options.p}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;

    const studentUid = database.ref(firebasePath('users')).push().key || createId('std');
    const studentData = {
      username,
      name,
      passwordHash,
      role: 'student',
      isActive: true,
      createdBy: teacher.uid,
      createdAt: admin.database.ServerValue.TIMESTAMP
    };

    await database.ref(firebasePath('users', studentUid)).set(studentData);
    const { passwordHash: _omit, ...safeResult } = studentData;
    sendJson(response, 201, { student: { uid: studentUid, ...safeResult } });
  } catch (err) { next(err); }
});

app.get('/api/teacher/students/:studentId', async (request, response, next) => {
  try {
    const teacher = await requireTeacher(request, 'canManageStudents');
    const studentSnapshot = await database.ref(firebasePath('users', request.params.studentId)).get();
    
    if (!studentSnapshot.exists() || studentSnapshot.val().createdBy !== teacher.uid) {
      throw createHttpError(404, 'الطالب غير موجود أو لا يتبع لك.');
    }
    
    const { passwordHash: _omit, ...safeUser } = studentSnapshot.val();
    sendJson(response, 200, { student: { uid: request.params.studentId, ...safeUser } });
  } catch (err) { next(err); }
});

app.patch('/api/teacher/students/:studentId', parseJsonBody, async (request, response, next) => {
  try {
    const teacher = await requireTeacher(request, 'canManageStudents');
    const { studentId } = request.params;
    const body = request.body || {};
    const username = normalizeAdminUsername(body.username);
    const name = sanitizeText(body.name, 'اسم الطالب', 120);

    const studentRef = database.ref(firebasePath('users', studentId));
    const snapshot = await studentRef.get();
    const studentData = snapshot.val();

    if (!snapshot.exists() || studentData.createdBy !== teacher.uid || studentData.role !== 'student') {
      throw createHttpError(404, 'الطالب غير موجود أو لا يتبع لك.');
    }

    const updates = { name };
    if (username && username !== studentData.username) {
      await ensureUsernameUnique(username);
      updates.username = username;
    }

    await studentRef.update(updates);
    sendJson(response, 200, { success: true });
  } catch (err) { next(err); }
});

app.patch('/api/teacher/students/:studentId/status', parseJsonBody, async (request, response, next) => {
  try {
    const teacher = await requireTeacher(request, 'canManageStudents');
    const { studentId } = request.params;
    const isActive = Boolean(request.body?.isActive);
    const studentRef = database.ref(firebasePath('users', studentId));
    const snapshot = await studentRef.get();
    const studentData = snapshot.val();

    if (!snapshot.exists() || studentData.createdBy !== teacher.uid || studentData.role !== 'student') {
      throw createHttpError(404, 'الطالب غير موجود أو لا يتبع لك.');
    }

    await studentRef.update({ isActive });
    sendJson(response, 200, { success: true, isActive });
  } catch (err) { next(err); }
});

app.patch('/api/teacher/students/:studentId/reset-password', parseJsonBody, async (request, response, next) => {
  try {
    const teacher = await requireTeacher(request, 'canManageStudents');
    const { studentId } = request.params;
    const newPassword = String(request.body?.password || '');
    if (newPassword.length < 6) throw createHttpError(400, 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.');

    const studentRef = database.ref(firebasePath('users', studentId));
    const snapshot = await studentRef.get();
    const studentData = snapshot.val();

    if (!snapshot.exists() || studentData.createdBy !== teacher.uid || studentData.role !== 'student') {
      throw createHttpError(404, 'الطالب غير موجود أو لا يتبع لك.');
    }

    const salt = crypto.randomBytes(16);
    const options = { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
    const derivedKey = crypto.scryptSync(newPassword, salt, 64, options);
    const passwordHash = `scrypt$${options.N}$${options.r}$${options.p}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;

    await studentRef.update({ passwordHash });
    sendJson(response, 200, { success: true });
  } catch (err) { next(err); }
});

app.delete('/api/teacher/students/:studentId', async (request, response, next) => {
  try {
    const teacher = await requireTeacher(request, 'canManageStudents');
    const { studentId } = request.params;
    const studentRef = database.ref(firebasePath('users', studentId));
    const snapshot = await studentRef.get();
    const studentData = snapshot.val();

    if (!snapshot.exists() || studentData.createdBy !== teacher.uid || studentData.role !== 'student') {
      throw createHttpError(404, 'الطالب غير موجود أو لا يتبع لك.');
    }

    await studentRef.remove();
    sendJson(response, 200, { success: true });
  } catch (err) { next(err); }
});

// ============================================================
// SUPER ADMIN ROUTES — TEACHER MANAGEMENT
// ============================================================

app.get('/api/admin/teachers', async (request, response, next) => {
  try {
    requireSuperAdmin(request);
    const snapshot = await database.ref(firebasePath('users'))
      .orderByChild('role').equalTo('teacher').get();
    const teachers = snapshot.exists() ? Object.entries(snapshot.val()).map(([uid, u]) => {
      const { passwordHash: _omit, ...safe } = u;
      return { uid, ...safe };
    }) : [];
    sendJson(response, 200, { teachers });
  } catch (err) { next(err); }
});

app.post('/api/admin/teachers', parseJsonBody, async (request, response, next) => {
  try {
    const adminUser = requireSuperAdmin(request);
    const body = request.body || {};
    const username = normalizeAdminUsername(body.username);
    const password = String(body.password || '');
    const name = sanitizeText(body.name, 'اسم المدرس', 120);
    const subject = sanitizeOptionalText(body.subject, 'المادة', 100);

    if (!username || password.length < 8) throw createHttpError(400, 'بيانات المدرس غير كاملة أو كلمة المرور ضعيفة.');
    await ensureUsernameUnique(username);

    const salt = crypto.randomBytes(16);
    const scryptOptions = { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
    const derivedKey = crypto.scryptSync(password, salt, 64, scryptOptions);
    const passwordHash = `scrypt$${scryptOptions.N}$${scryptOptions.r}$${scryptOptions.p}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;

    const teacherId = database.ref(firebasePath('users')).push().key || createId('tch');
    const teacherData = {
      username,
      name,
      subject,
      passwordHash,
      role: 'teacher',
      isActive: true,
      permissions: {
        canCreateExam: true,
        canEditExam: true,
        canDeleteExam: true,
        canManageQuestionBank: true,
        canViewResults: true,
        canPublishResults: true,
        canManageStudents: true,
        canUploadFiles: true,
        canAccessReports: true,
        canExportData: true,
        ...(body.permissions || {})
      },
      createdBy: adminUser.uid,
      createdAt: admin.database.ServerValue.TIMESTAMP
    };

    await database.ref(firebasePath('users', teacherId)).set(teacherData);
    const { passwordHash: _omit, ...safeResult } = teacherData;
    sendJson(response, 201, { teacher: { uid: teacherId, ...safeResult } });
  } catch (err) { next(err); }
});

app.patch('/api/admin/teachers/:teacherId', parseJsonBody, async (request, response, next) => {
  try {
    requireSuperAdmin(request);
    const { teacherId } = request.params;
    const body = request.body || {};
    const name = sanitizeText(body.name, 'اسم المدرس', 120);
    const subject = sanitizeOptionalText(body.subject, 'المادة', 100);
    const permissions = body.permissions || {};

    const teacherRef = database.ref(firebasePath('users', teacherId));
    const snapshot = await teacherRef.get();
    const teacherData = snapshot.val();

    if (!snapshot.exists() || teacherData.role !== 'teacher') {
      throw createHttpError(404, 'المدرس غير موجود.');
    }

    const updates = { name, subject, permissions };
    await teacherRef.update(updates);
    sendJson(response, 200, { success: true });
  } catch (err) { next(err); }
});

app.patch('/api/admin/teachers/:teacherId/status', parseJsonBody, async (request, response, next) => {
  try {
    requireSuperAdmin(request);
    const { teacherId } = request.params;
    const isActive = Boolean(request.body?.isActive);
    
    const teacherRef = database.ref(firebasePath('users', teacherId));
    const snapshot = await teacherRef.get();

    if (!snapshot.exists() || snapshot.val().role !== 'teacher') {
      throw createHttpError(404, 'المدرس غير موجود.');
    }

    await teacherRef.update({ isActive });
    sendJson(response, 200, { success: true, isActive });
  } catch (err) { next(err); }
});

app.patch('/api/admin/teachers/:teacherId/reset-password', parseJsonBody, async (request, response, next) => {
  try {
    requireSuperAdmin(request);
    const { teacherId } = request.params;
    const newPassword = String(request.body?.password || '');
    if (newPassword.length < 8) throw createHttpError(400, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.');

    const teacherRef = database.ref(firebasePath('users', teacherId));
    const snapshot = await teacherRef.get();

    if (!snapshot.exists() || snapshot.val().role !== 'teacher') {
      throw createHttpError(404, 'المدرس غير موجود.');
    }

    const salt = crypto.randomBytes(16);
    const options = { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
    const derivedKey = crypto.scryptSync(newPassword, salt, 64, options);
    const passwordHash = `scrypt$${options.N}$${options.r}$${options.p}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;

    await teacherRef.update({ passwordHash });
    sendJson(response, 200, { success: true });
  } catch (err) { next(err); }
});

app.delete('/api/admin/teachers/:teacherId', async (request, response, next) => {
  try {
    requireSuperAdmin(request);
    const { teacherId } = request.params;
    
    const teacherRef = database.ref(firebasePath('users', teacherId));
    const snapshot = await teacherRef.get();

    if (!snapshot.exists() || snapshot.val().role !== 'teacher') {
      throw createHttpError(404, 'المدرس غير موجود.');
    }

    // Note: In a real system, you might want to delete their students/exams too, 
    // or just deactivate the account. For now, we allow deletion.
    await teacherRef.remove();
    sendJson(response, 200, { success: true });
  } catch (err) { next(err); }
});

// ============================================================
// ADMIN ROUTES — DASHBOARD
// ============================================================

app.get('/api/admin/dashboard', async (request, response, next) => {
  try {
    await requireTeacher(request, 'canAccessReports');
    const { examsMap, keysMap, submissionsMap } = await readAdminCollections();
    sendJson(response, 200, buildAdminDashboardPayload(examsMap, keysMap, submissionsMap));
  } catch (err) { next(err); }
});

// ============================================================
// ADMIN ROUTES — EXAMS
// ============================================================

app.post('/api/admin/exams', parseJsonBody, async (request, response, next) => {
  try {
    await requireTeacher(request, 'canCreateExam');
    const createdExam = await createAdminExam(request.body);
    sendJson(response, 201, { exam: createdExam });
  } catch (err) { next(err); }
});

app.patch('/api/admin/exams/:examId/status', parseJsonBody, async (request, response, next) => {
  try {
    await requireTeacher(request, 'canEditExam');
    const active = await setAdminExamStatus(request.params.examId, request.body?.active);
    sendJson(response, 200, { success: true, active });
  } catch (err) { next(err); }
});

app.get('/api/admin/exams/:examId/results', async (request, response, next) => {
  try {
    await requireTeacher(request, 'canViewResults');
    const bundle = await readAdminExamBundle(request.params.examId);
    sendJson(response, 200, buildAdminExamResultsPayload(request.params.examId, bundle.exam, bundle.keyData, bundle.submissions));
  } catch (err) { next(err); }
});

app.post('/api/admin/exams/:examId/publish-results', parseJsonBody, async (request, response, next) => {
  try {
    await requireTeacher(request, 'canPublishResults');
    const result = await publishAdminExamResults(request.params.examId);
    sendJson(response, 200, { success: true, ...result });
  } catch (err) { next(err); }
});

app.delete('/api/admin/exams/:examId', async (request, response, next) => {
  try {
    await requireTeacher(request, 'canDeleteExam');
    await deleteAdminExam(request.params.examId);
    sendJson(response, 200, { success: true });
  } catch (err) { next(err); }
});

// ============================================================
// ADMIN ROUTES — QUESTION BANKS
// ============================================================

app.get('/api/admin/question-banks', async (request, response, next) => {
  try {
    await requireTeacher(request, 'canManageQuestionBank');
    const banks = await listQuestionBanks({ requestId: createDebugRequestId('qb-list') });
    sendJson(response, 200, { banks });
  } catch (err) { next(err); }
});

app.post('/api/admin/question-banks', parseJsonBody, async (request, response, next) => {
  try {
    await requireTeacher(request, 'canManageQuestionBank');
    const body = request.body || {};
    const requestId = typeof body.debugRequestId === 'string' && body.debugRequestId.trim() ? body.debugRequestId.trim() : createDebugRequestId('qb-create');
    logQuestionBankOp('route:create', { requestId, payload: summarizeQuestionBankPayload(body) });
    const bank = await createQuestionBank(body, { requestId });
    sendJson(response, 201, { bank });
  } catch (err) { next(err); }
});

// *** bank sub-routes: must come BEFORE /:bankId to avoid shadowing ***
app.patch('/api/admin/question-banks/:bankId/questions/:questionId', parseJsonBody, async (request, response, next) => {
  try {
    await requireTeacher(request, 'canManageQuestionBank');
    const payload = await updateBankQuestion(request.params.bankId, request.params.questionId, request.body);
    sendJson(response, 200, payload);
  } catch (err) { next(err); }
});

app.delete('/api/admin/question-banks/:bankId/questions/:questionId', async (request, response, next) => {
  try {
    await requireTeacher(request, 'canManageQuestionBank');
    const payload = await deleteBankQuestion(request.params.bankId, request.params.questionId);
    sendJson(response, 200, payload);
  } catch (err) { next(err); }
});

app.get('/api/admin/question-banks/:bankId/questions', async (request, response, next) => {
  try {
    await requireTeacher(request, 'canManageQuestionBank');
    const bank = await getQuestionBankRecord(request.params.bankId);
    sendJson(response, 200, { bank: { id: bank.id, title: bank.title, description: bank.description, createdAt: bank.createdAt, updatedAt: bank.updatedAt, questionCount: bank.questionCount }, questions: bank.questions });
  } catch (err) { next(err); }
});

app.post('/api/admin/question-banks/:bankId/questions', parseJsonBody, async (request, response, next) => {
  try {
    await requireTeacher(request, 'canManageQuestionBank');
    const payload = await addQuestionToBank(request.params.bankId, request.body);
    sendJson(response, 201, payload);
  } catch (err) { next(err); }
});

app.post('/api/admin/question-banks/:bankId/import', parseJsonBody, async (request, response, next) => {
  try {
    await requireTeacher(request, 'canManageQuestionBank');
    const body = request.body || {};
    const requestId = typeof body.debugRequestId === 'string' && body.debugRequestId.trim() ? body.debugRequestId.trim() : createDebugRequestId('qb-import');
    logQuestionBankOp('route:import', { requestId, bankId: request.params.bankId, requestedQuestionIds: Array.isArray(body.questionIds) ? body.questionIds : [] });
    const payload = await importQuestionBankQuestions(request.params.bankId, body, { requestId });
    sendJson(response, 200, payload);
  } catch (err) { next(err); }
});

app.get('/api/admin/question-banks/:bankId', async (request, response, next) => {
  try {
    await requireTeacher(request, 'canManageQuestionBank');
    const bank = await getQuestionBankRecord(request.params.bankId);
    sendJson(response, 200, { bank });
  } catch (err) { next(err); }
});

app.patch('/api/admin/question-banks/:bankId', parseJsonBody, async (request, response, next) => {
  try {
    await requireTeacher(request, 'canManageQuestionBank');
    const body = request.body || {};
    const requestId = typeof body.debugRequestId === 'string' && body.debugRequestId.trim() ? body.debugRequestId.trim() : createDebugRequestId('qb-update');
    logQuestionBankOp('route:update', { requestId, bankId: request.params.bankId, expectedUpdatedAt: Number(body.expectedUpdatedAt || 0), payload: summarizeQuestionBankPayload(body) });
    const bank = await updateQuestionBank(request.params.bankId, body, { requestId });
    sendJson(response, 200, { bank });
  } catch (err) { next(err); }
});

app.delete('/api/admin/question-banks/:bankId', parseJsonBody, async (request, response, next) => {
  try {
    await requireTeacher(request, 'canManageQuestionBank');
    const body = request.body || {};
    const requestId = typeof body.debugRequestId === 'string' && body.debugRequestId.trim() ? body.debugRequestId.trim() : createDebugRequestId('qb-delete');
    logQuestionBankOp('route:delete', { requestId, bankId: request.params.bankId });
    await deleteQuestionBankRecord(request.params.bankId, { requestId });
    sendJson(response, 200, { success: true });
  } catch (err) { next(err); }
});

// ============================================================
// STUDENT ROUTES
// ============================================================

app.post('/api/student/exam-access', parseJsonBody, async (request, response, next) => {
  try {
    const exam = await resolveExamAccess(request.body);
    logInfo('Student', 'Exam Access Accepted', { requestId: request.requestId, examId: exam.id });
    sendJson(response, 200, { exam: sanitizeExamPreview(exam.id, exam) });
  } catch (err) { next(err); }
});

app.post('/api/student/exams/:examId/start', parseJsonBody, async (request, response, next) => {
  try {
    // Allow both authenticated students AND guest flow
    // If session exists and is a student, use it; otherwise proceed as guest
    const session = readSessionFromRequest(request);
    if (session && !['student'].includes(session.role)) {
      // Teachers/admins cannot take exams
      throw createHttpError(403, 'لا يمكن للمدرس أو المسؤول بدء اختبار كطالب.');
    }
    const payload = await startStudentExam(request.params.examId, request.body, request);
    logAudit('Student', 'Exam Started', { requestId: request.requestId, examId: request.params.examId, authenticated: Boolean(session) });
    sendJson(response, 200, payload);
  } catch (err) { next(err); }
});

app.post('/api/student/exams/:examId/submit', parseJsonBody, async (request, response, next) => {
  try {
    // Allow both authenticated students AND guest flow (consistent with start)
    const session = readSessionFromRequest(request);
    if (session && !['student'].includes(session.role)) {
      throw createHttpError(403, 'لا يمكن للمدرس أو المسؤول تسليم اختبار كطالب.');
    }
    const payload = await submitStudentExam(request.params.examId, request.body, request);
    logAudit('Student', 'Exam Submitted', { requestId: request.requestId, examId: request.params.examId, authenticated: Boolean(session) });
    sendJson(response, 201, payload);
  } catch (err) { next(err); }
});

app.get('/api/student/dashboard', async (request, response, next) => {
  try {
    const session = requireStudent(request);
    const [userSnapshot, historySnapshot] = await Promise.all([
      database.ref(firebasePath('users', session.uid)).get(),
      database.ref(firebasePath('studentHistory', session.uid)).get()
    ]);

    const userData = userSnapshot.val() || {};
    if (!userSnapshot.exists() || userData.role !== 'student') {
      throw createHttpError(404, 'حساب الطالب غير موجود.');
    }
    if (userData.isActive === false) {
      throw createHttpError(403, 'هذا الحساب موقوف حالياً. يرجى مراجعة الإدارة.');
    }

    const history = historySnapshot.exists()
      ? Object.values(historySnapshot.val() || {})
        .filter((item) => item && typeof item === 'object')
        .sort((a, b) => Number(b.at || b.submittedAt || 0) - Number(a.at || a.submittedAt || 0))
      : [];

    sendJson(response, 200, {
      profile: {
        name: userData.name || session.name,
        username: userData.username,
        role: userData.role,
        createdAt: userData.createdAt
      },
      history
    });
  } catch (err) { next(err); }
});

app.get('/api/student/exams/:examId/receipt/:submissionId', async (request, response, next) => {
  try {
    const receiptToken = typeof request.query.token === 'string' ? request.query.token : '';
    const payload = await readStudentReceipt(request.params.examId, request.params.submissionId, receiptToken);
    sendJson(response, 200, payload);
  } catch (err) { next(err); }
});

app.post('/api/student/results/lookup', parseJsonBody, async (request, response, next) => {
  try {
    const payload = await lookupPublishedStudentResult(request.body);
    sendJson(response, 200, payload);
  } catch (err) { next(err); }
});

// ============================================================
// 404 FALLBACK & ERROR HANDLER
// ============================================================

app.use((request, response) => {
  sendText(response, 404, 'الصفحة المطلوبة غير موجودة.');
});

// Express 4-argument error handler
app.use((error, request, response, next) => { // eslint-disable-line no-unused-vars
  const status = error.status || 500;
  const message = status >= 500 ? 'حدث خطأ داخلي في الخادم.' : error.message;

  const errorMeta = {
    requestId: request.requestId,
    method: request.method,
    pathname: request.path,
    ip: getClientIp(request),
    status
  };

  if (status >= 500) {
    logError('HTTP', 'Server Error', errorMeta, error);
  } else if (status === 401 || status === 403 || status === 429) {
    logSecurity('HTTP', 'Security Exception', { ...errorMeta, message });
  } else {
    logWarn('HTTP', 'Client Error', { ...errorMeta, message });
  }

  const extraHeaders = error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {};
  sendJson(response, status, { error: message }, extraHeaders);
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Firebase Realtime Database root: ${FIREBASE_ROOT}`);
  console.log(`Configured admin accounts: ${ADMIN_ACCOUNTS.length}`);
});
