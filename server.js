const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const ROOT_DIR = __dirname;
const HTML_FILE = 'index.html';
const STYLE_FILE = 'style.css';
const SCRIPT_FILE = 'script.js';
const APP_CONFIG_FILE = 'app-config.js';
const SESSION_COOKIE = '__session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const ATTEMPT_TOKEN_TTL_MS = 1000 * 60 * 60 * 8;
const RESULT_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 180;
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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Amr@2024';
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
const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update(`${ADMIN_PASSWORD}|${FIREBASE_DATABASE_URL || 'local'}`).digest('hex');

let database;
let storageBucket;

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
  console.log(`[question-bank] ${new Date().toISOString()} ${event} ${JSON.stringify(payload)}`);
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

function createSignedSessionCookieValue() {
  const payload = Buffer.from(JSON.stringify({
    role: 'admin',
    exp: Date.now() + SESSION_TTL_MS
  })).toString('base64url');
  const signature = createSessionSignature(payload);
  return `${payload}.${signature}`;
}

function readAdminSessionFromRequest(request) {
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

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));

    if (parsed.role !== 'admin' || typeof parsed.exp !== 'number' || parsed.exp <= Date.now()) {
      return null;
    }

    return parsed;
  } catch (error) {
    return null;
  }
}

function requireAdmin(request) {
  const adminSession = readAdminSessionFromRequest(request);

  if (!adminSession) {
    throw createHttpError(401, 'دخول المدرس مطلوب.');
  }

  return adminSession;
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

function passwordMatches(input, expected) {
  const inputBuffer = Buffer.from(String(input || ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected), 'utf8');

  if (inputBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(inputBuffer, expectedBuffer);
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
      allResults.push({
        ...result,
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

function normalizeStudentIdentityPart(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildStudentKey(studentName, studentGroup) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeStudentIdentityPart(studentName)}|${normalizeStudentIdentityPart(studentGroup)}`)
    .digest('hex');
}

function sanitizeStudentIdentity(body = {}) {
  const studentName = sanitizeText(body.studentName ?? body.name, 'اسم الطالب', 120);
  const studentGroup = sanitizeText(body.studentGroup ?? body.group, 'الفصل / المجموعة', 120);

  return {
    studentName,
    studentGroup,
    studentKey: buildStudentKey(studentName, studentGroup)
  };
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

  if (signature !== expectedSignature) {
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

function createStudentAttemptToken(examId, studentKey) {
  return createSignedStudentToken({
    type: 'student_attempt',
    examId,
    studentKey,
    iat: Date.now(),
    exp: Date.now() + ATTEMPT_TOKEN_TTL_MS
  });
}

function createStudentReceiptToken(examId, submissionId, studentKey) {
  return createSignedStudentToken({
    type: 'student_receipt',
    examId,
    submissionId,
    studentKey,
    exp: Date.now() + ATTEMPT_TOKEN_TTL_MS
  });
}

function createStudentResultToken(examId, submissionId, studentKey) {
  return createSignedStudentToken({
    type: 'student_result',
    examId,
    submissionId,
    studentKey,
    exp: Date.now() + RESULT_TOKEN_TTL_MS
  });
}

function requireValidStudentAttemptToken(token, examId, studentKey) {
  const payload = readSignedStudentToken(token);

  if (!payload || payload.type !== 'student_attempt' || payload.examId !== examId || payload.studentKey !== studentKey) {
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

  if (!payload || payload.type !== 'student_result' || !payload.examId || !payload.submissionId || !payload.studentKey) {
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

async function readExistingSubmissionByStudentKey(examId, studentKey) {
  const submissionsSnapshot = await database.ref(firebasePath('submissions', examId)).get();

  if (!submissionsSnapshot.exists()) {
    return null;
  }

  const submissions = submissionsSnapshot.val();

  for (const [submissionId, submission] of Object.entries(submissions)) {
    if (submission && submission.studentKey === studentKey) {
      return {
        id: submissionId,
        ...submission
      };
    }
  }

  return null;
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

async function startStudentExam(examId, body = {}) {
  const exam = await getActiveExamById(examId);
  const identity = sanitizeStudentIdentity(body);
  const existingSubmission = await readExistingSubmissionByStudentKey(exam.id, identity.studentKey);

  if (existingSubmission) {
    throw createHttpError(409, 'تم تسليم هذا الامتحان بالفعل بنفس الاسم والمجموعة.');
  }

  return {
    studentName: identity.studentName,
    studentGroup: identity.studentGroup,
    exam: sanitizeCurrentExamForStudent(exam.id, exam),
    attemptToken: createStudentAttemptToken(exam.id, identity.studentKey)
  };
}

async function submitStudentExam(examId, body = {}) {
  const exam = await getActiveExamById(examId);
  const identity = sanitizeStudentIdentity(body);
  requireValidStudentAttemptToken(body.attemptToken, exam.id, identity.studentKey);

  const existingSubmission = await readExistingSubmissionByStudentKey(exam.id, identity.studentKey);

  if (existingSubmission) {
    throw createHttpError(409, 'تم تسليم هذا الامتحان مسبقًا ولا يمكن إرسال محاولة جديدة.');
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
  const submissionRef = database.ref(firebasePath('submissions', exam.id)).push();
  const submittedAt = Date.now();
  const submissionPayload = {
    id: submissionRef.key,
    examId: exam.id,
    examCode: String(exam.code || ''),
    studentName: identity.studentName,
    studentGroup: identity.studentGroup,
    studentKey: identity.studentKey,
    answers,
    answeredCount,
    totalQuestions: questions.length,
    score,
    pct,
    status: getPassStatus(pct),
    submittedAt
  };

  await submissionRef.set(submissionPayload);
  const resultToken = createStudentResultToken(exam.id, submissionRef.key, identity.studentKey);

  return {
    receipt: {
      ...buildStudentReceipt(exam, submissionPayload, { trackingToken: resultToken }),
      receiptToken: createStudentReceiptToken(exam.id, submissionRef.key, identity.studentKey),
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

  if (submission.studentKey !== tokenPayload.studentKey) {
    throw createHttpError(403, 'هذا الإيصال لا يخص نفس محاولة الطالب.');
  }

  return {
    receipt: {
      ...buildStudentReceipt(exam, submission, {
        trackingToken: createStudentResultToken(examId, submissionId, tokenPayload.studentKey)
      }),
      receiptToken,
      resultToken: createStudentResultToken(examId, submissionId, tokenPayload.studentKey)
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

  if (!submission || submission.studentKey !== tokenPayload.studentKey) {
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

async function serveStaticFile(response, filePath, contentType) {
  try {
    const content = await fs.promises.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(content);
  } catch (error) {
    sendText(response, 404, 'الملف غير موجود.');
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    const corsApplied = applyCorsHeaders(request, response);

    if (request.method === 'OPTIONS') {
      if (request.headers.origin && !corsApplied) {
        sendJson(response, 403, { error: 'This origin is not allowed.' });
        return;
      }

      response.writeHead(204);
      response.end();
      return;
    }

    if (pathname.startsWith('/api/') && request.headers.origin && !corsApplied) {
      sendJson(response, 403, { error: 'This origin is not allowed.' });
      return;
    }

    if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === `/${HTML_FILE}`)) {
      await serveStaticFile(response, path.join(ROOT_DIR, HTML_FILE), 'text/html; charset=utf-8');
      return;
    }

    if (request.method === 'GET' && pathname === `/${STYLE_FILE}`) {
      await serveStaticFile(response, path.join(ROOT_DIR, STYLE_FILE), 'text/css; charset=utf-8');
      return;
    }

    if (request.method === 'GET' && pathname === `/${SCRIPT_FILE}`) {
      await serveStaticFile(response, path.join(ROOT_DIR, SCRIPT_FILE), 'application/javascript; charset=utf-8');
      return;
    }

    if (request.method === 'GET' && pathname === `/${APP_CONFIG_FILE}`) {
      await serveStaticFile(response, path.join(ROOT_DIR, APP_CONFIG_FILE), 'application/javascript; charset=utf-8');
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admin/uploads') {
      requireAdmin(request);
      const fileName = decodeUploadHeader(String(request.headers['x-upload-filename'] || ''));
      const contentType = String(request.headers['x-upload-content-type'] || request.headers['content-type'] || 'application/octet-stream')
        .split(';')[0]
        .trim()
        .toLowerCase();

      if (!fileName) {
        throw createHttpError(400, 'اسم الملف المرفوع مطلوب.');
      }

      const buffer = await readBinaryBody(request, MAX_ATTACHMENT_SIZE);
      const attachment = await uploadTemporaryAttachment({
        fileName,
        contentType,
        size: buffer.length,
        buffer
      });
      sendJson(response, 201, { attachment });
      return;
    }

    if (request.method === 'DELETE' && pathname === '/api/admin/uploads') {
      requireAdmin(request);
      const body = await readJsonBody(request);
      const storagePath = typeof body.storagePath === 'string' ? body.storagePath.trim() : '';

      if (!isTemporaryAttachmentPath(storagePath)) {
        throw createHttpError(400, 'لا يمكن حذف هذا المرفق من الواجهة مباشرة.');
      }

      await deleteStorageFile(storagePath);
      sendJson(response, 200, { success: true });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/session') {
      const adminSession = readAdminSessionFromRequest(request);

      if (!adminSession) {
        sendJson(response, 200, { authenticated: false });
        return;
      }

      sendJson(response, 200, {
        authenticated: true,
        adminUid: 'admin'
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admin/login') {
      const body = await readJsonBody(request);
      if (!passwordMatches(body.password, ADMIN_PASSWORD)) {
        throw createHttpError(401, 'كلمة مرور المدرس غير صحيحة.');
      }

      sendJson(
        response,
        200,
        {
          success: true,
          adminUid: 'admin'
        },
        { 'Set-Cookie': createSessionCookie(request, createSignedSessionCookieValue()) }
      );
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admin/logout') {
      sendJson(
        response,
        200,
        { success: true },
        { 'Set-Cookie': clearSessionCookie(request) }
      );
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/dashboard') {
      requireAdmin(request);
      const { examsMap, keysMap, submissionsMap } = await readAdminCollections();
      sendJson(response, 200, buildAdminDashboardPayload(examsMap, keysMap, submissionsMap));
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admin/exams') {
      requireAdmin(request);
      const body = await readJsonBody(request);

      const createdExam = await createAdminExam(body);
      sendJson(response, 201, { exam: createdExam });
      return;
    }

    const statusMatch = pathname.match(/^\/api\/admin\/exams\/([^/]+)\/status$/);

    if (request.method === 'PATCH' && statusMatch) {
      requireAdmin(request);
      const examId = statusMatch[1];
      const body = await readJsonBody(request);
      const active = await setAdminExamStatus(examId, body.active);
      sendJson(response, 200, { success: true, active });
      return;
    }

    const resultsMatch = pathname.match(/^\/api\/admin\/exams\/([^/]+)\/results$/);

    if (request.method === 'GET' && resultsMatch) {
      requireAdmin(request);
      const examId = resultsMatch[1];
      const adminExamBundle = await readAdminExamBundle(examId);
      sendJson(
        response,
        200,
        buildAdminExamResultsPayload(
          examId,
          adminExamBundle.exam,
          adminExamBundle.keyData,
          adminExamBundle.submissions
        )
      );
      return;
    }

    const publishResultsMatch = pathname.match(/^\/api\/admin\/exams\/([^/]+)\/publish-results$/);

    if (request.method === 'POST' && publishResultsMatch) {
      requireAdmin(request);
      const examId = publishResultsMatch[1];
      const result = await publishAdminExamResults(examId);
      sendJson(response, 200, { success: true, ...result });
      return;
    }

    const deleteMatch = pathname.match(/^\/api\/admin\/exams\/([^/]+)$/);

    if (request.method === 'DELETE' && deleteMatch) {
      requireAdmin(request);
      const examId = deleteMatch[1];
      await deleteAdminExam(examId);
      sendJson(response, 200, { success: true });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/question-banks') {
      requireAdmin(request);
      const requestId = createDebugRequestId('qb-list');
      const banks = await listQuestionBanks({ requestId });
      sendJson(response, 200, { banks });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admin/question-banks') {
      requireAdmin(request);
      const body = await readJsonBody(request);
      const requestId = typeof body?.debugRequestId === 'string' && body.debugRequestId.trim()
        ? body.debugRequestId.trim()
        : createDebugRequestId('qb-create');
      logQuestionBankOp('route:create', {
        requestId,
        payload: summarizeQuestionBankPayload(body)
      });
      const bank = await createQuestionBank(body, { requestId });
      sendJson(response, 201, { bank });
      return;
    }

    const bankQuestionsItemMatch = pathname.match(/^\/api\/admin\/question-banks\/([^/]+)\/questions\/([^/]+)$/);

    if (request.method === 'PATCH' && bankQuestionsItemMatch) {
      requireAdmin(request);
      const bankId = bankQuestionsItemMatch[1];
      const questionId = bankQuestionsItemMatch[2];
      const body = await readJsonBody(request);
      const payload = await updateBankQuestion(bankId, questionId, body);
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === 'DELETE' && bankQuestionsItemMatch) {
      requireAdmin(request);
      const bankId = bankQuestionsItemMatch[1];
      const questionId = bankQuestionsItemMatch[2];
      const payload = await deleteBankQuestion(bankId, questionId);
      sendJson(response, 200, payload);
      return;
    }

    const bankQuestionsMatch = pathname.match(/^\/api\/admin\/question-banks\/([^/]+)\/questions$/);

    if (request.method === 'GET' && bankQuestionsMatch) {
      requireAdmin(request);
      const bankId = bankQuestionsMatch[1];
      const bank = await getQuestionBankRecord(bankId);
      sendJson(response, 200, {
        bank: {
          id: bank.id,
          title: bank.title,
          description: bank.description,
          createdAt: bank.createdAt,
          updatedAt: bank.updatedAt,
          questionCount: bank.questionCount
        },
        questions: bank.questions
      });
      return;
    }

    if (request.method === 'POST' && bankQuestionsMatch) {
      requireAdmin(request);
      const bankId = bankQuestionsMatch[1];
      const body = await readJsonBody(request);
      const payload = await addQuestionToBank(bankId, body);
      sendJson(response, 201, payload);
      return;
    }

    const bankImportMatch = pathname.match(/^\/api\/admin\/question-banks\/([^/]+)\/import$/);

    if (request.method === 'POST' && bankImportMatch) {
      requireAdmin(request);
      const bankId = bankImportMatch[1];
      const body = await readJsonBody(request);
      const requestId = typeof body?.debugRequestId === 'string' && body.debugRequestId.trim()
        ? body.debugRequestId.trim()
        : createDebugRequestId('qb-import');
      logQuestionBankOp('route:import', {
        requestId,
        bankId,
        requestedQuestionIds: Array.isArray(body?.questionIds) ? body.questionIds : []
      });
      const payload = await importQuestionBankQuestions(bankId, body, { requestId });
      sendJson(response, 200, payload);
      return;
    }

    const bankItemMatch = pathname.match(/^\/api\/admin\/question-banks\/([^/]+)$/);

    if (request.method === 'GET' && bankItemMatch) {
      requireAdmin(request);
      const bank = await getQuestionBankRecord(bankItemMatch[1]);
      sendJson(response, 200, { bank });
      return;
    }

    if (request.method === 'PATCH' && bankItemMatch) {
      requireAdmin(request);
      const body = await readJsonBody(request);
      const requestId = typeof body?.debugRequestId === 'string' && body.debugRequestId.trim()
        ? body.debugRequestId.trim()
        : createDebugRequestId('qb-update');
      logQuestionBankOp('route:update', {
        requestId,
        bankId: bankItemMatch[1],
        expectedUpdatedAt: Number(body?.expectedUpdatedAt || 0),
        payload: summarizeQuestionBankPayload(body)
      });
      const bank = await updateQuestionBank(bankItemMatch[1], body, { requestId });
      sendJson(response, 200, { bank });
      return;
    }

    if (request.method === 'DELETE' && bankItemMatch) {
      requireAdmin(request);
      const body = await readJsonBody(request);
      const requestId = typeof body?.debugRequestId === 'string' && body.debugRequestId.trim()
        ? body.debugRequestId.trim()
        : createDebugRequestId('qb-delete');
      logQuestionBankOp('route:delete', {
        requestId,
        bankId: bankItemMatch[1]
      });
      await deleteQuestionBankRecord(bankItemMatch[1], { requestId });
      sendJson(response, 200, { success: true });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/student/exam-access') {
      const body = await readJsonBody(request);
      const exam = await resolveExamAccess(body);
      sendJson(response, 200, { exam: sanitizeExamPreview(exam.id, exam) });
      return;
    }

    const studentStartMatch = pathname.match(/^\/api\/student\/exams\/([^/]+)\/start$/);

    if (request.method === 'POST' && studentStartMatch) {
      const examId = studentStartMatch[1];
      const body = await readJsonBody(request);
      const payload = await startStudentExam(examId, body);
      sendJson(response, 200, payload);
      return;
    }

    const studentSubmitMatch = pathname.match(/^\/api\/student\/exams\/([^/]+)\/submit$/);

    if (request.method === 'POST' && studentSubmitMatch) {
      const examId = studentSubmitMatch[1];
      const body = await readJsonBody(request);
      const payload = await submitStudentExam(examId, body);
      sendJson(response, 201, payload);
      return;
    }

    const studentReceiptMatch = pathname.match(/^\/api\/student\/exams\/([^/]+)\/receipt\/([^/]+)$/);

    if (request.method === 'GET' && studentReceiptMatch) {
      const examId = studentReceiptMatch[1];
      const submissionId = studentReceiptMatch[2];
      const receiptToken = typeof url.searchParams.get('token') === 'string'
        ? url.searchParams.get('token')
        : '';
      const payload = await readStudentReceipt(examId, submissionId, receiptToken);
      sendJson(response, 200, payload);
      return;
    }

    if (request.method === 'POST' && pathname === '/api/student/results/lookup') {
      const body = await readJsonBody(request);
      const payload = await lookupPublishedStudentResult(body);
      sendJson(response, 200, payload);
      return;
    }

    sendText(response, 404, 'الصفحة المطلوبة غير موجودة.');
  } catch (error) {
    const status = error.status || 500;
    const message = status >= 500 ? 'حدث خطأ داخلي في الخادم.' : error.message;
    sendJson(response, status, { error: message });
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response);
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Firebase Realtime Database root: ${FIREBASE_ROOT}`);

  if (!process.env.ADMIN_PASSWORD) {
    console.log('Tip: set ADMIN_PASSWORD in a .env file to override the default server-side password.');
  }
});
