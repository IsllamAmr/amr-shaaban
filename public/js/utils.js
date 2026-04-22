// --- Theme helpers ---
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
}

function toggleTheme() {
  const current = localStorage.getItem("theme") || "light";
  const target = current === "light" ? "dark" : "light";
  setTheme(target);
}

function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) setTheme(saved);
}

initTheme();

// ============================================================
// js/utils.js — Pure utility functions (no DOM, no API calls)
// Depends on: app-state.js (ADMIN_PAGES, MCQ_LABELS, etc.)
// ============================================================

// --- Storage helpers ---
function setStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error("تعذر حفظ البيانات محليًا:", error);
    return false;
  }
}

function getStoredJson(key) {
  try {
    const rawValue = localStorage.getItem(key);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch (error) {
    console.error("تعذر قراءة البيانات المحلية:", error);
    return null;
  }
}

// --- Debug helpers ---
function createClientDebugId(prefix = "qb") {
  if (window.crypto?.randomUUID) {
    return `${prefix}-${window.crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function summarizeBankQuestions(questionList = []) {
  return questionList.map((question, index) => ({
    id: question?.id || `q${index + 1}`,
    type: question?.type || "",
    correct: Number.parseInt(question?.correct, 10),
    difficulty: normalizeDifficulty(question?.difficulty),
    textLength: String(question?.text || "").trim().length,
    hasAttachment: Boolean(normalizeAttachment(question?.attachment))
  }));
}

function logQuestionBankDebug(event, payload = {}) {
  try {
    console.info(`[QB][${new Date().toISOString()}] ${event}`, payload);
  } catch (error) {
    console.info(`[QB][${new Date().toISOString()}] ${event}`);
  }
}

// --- String escaping & sanitization ---
function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeCode(value = "") {
  return String(value).toUpperCase().replace(/\s+/g, "").trim();
}

function generateId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createQuestionId() {
  qCounter += 1;
  return `q${qCounter}`;
}

function createBankQuestionId() {
  bankQuestionCounter += 1;
  return `bq${bankQuestionCounter}`;
}

// --- Difficulty helpers ---
function normalizeDifficulty(value) {
  const allowed = new Set(DIFFICULTY_LEVELS.map((item) => item.value));
  return allowed.has(value) ? value : "medium";
}

function getDifficultyLabel(value) {
  return DIFFICULTY_LEVELS.find((item) => item.value === value)?.label || "متوسط";
}

function getDifficultyBadgeClass(value) {
  switch (value) {
    case "easy": return "badge-green";
    case "medium": return "badge-gold";
    case "hard": return "badge-red";
    case "impossible": return "badge-dark";
    default: return "badge-gold";
  }
}

// --- Value helpers ---
function escapeAttribute(value = "") {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function sanitizePlainText(value = "", fallback = "غير محدد") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function getPassStatus(scorePercent) {
  return scorePercent >= 50
    ? { label: "ناجح", message: "أحسنت، لقد اجتزت الامتحان بنجاح.", className: "score-good", emoji: "🎉" }
    : { label: "لم يجتز", message: "يمكنك المراجعة والمحاولة بشكل أفضل في الامتحان القادم.", className: "score-fail", emoji: "📘" };
}

function toNumericValue(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function humanFileSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ك.ب`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} م.ب`;
}

function getQuestionOptionMarker(questionType, optionIndex) {
  return questionType === "mcq" ? MCQ_LABELS[optionIndex] : TF_SYMBOLS[optionIndex];
}

function getScoreColor(score) {
  if (score >= 70) return "#2e7d32";
  if (score >= 50) return "#e67e22";
  return "var(--red)";
}

// --- Attachment helpers ---
function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") return null;

  const fileName = String(attachment.fileName || attachment.name || "").trim();
  const contentType = String(attachment.contentType || attachment.type || "").trim();
  const downloadUrl = String(attachment.downloadUrl || "").trim();
  const dataUrl = String(attachment.dataUrl || "").trim();
  const storagePath = String(attachment.storagePath || "").trim();

  if (!fileName || (!downloadUrl && !dataUrl && !storagePath)) return null;

  const kind = attachment.kind === "image" || contentType.startsWith("image/") ? "image" : "file";

  return {
    id: String(attachment.id || ""),
    name: fileName,
    fileName,
    type: contentType,
    contentType,
    size: Number(attachment.size || 0),
    dataUrl,
    downloadUrl,
    storagePath,
    kind,
    uploadedAt: Number(attachment.uploadedAt || 0),
    temporary: Boolean(attachment.temporary)
  };
}

function getAttachmentTypeLabel(attachment) {
  if (!attachment) return "";
  return attachment.kind === "image" ? "صورة مرفقة" : "ملف مرفق";
}

function isSupportedAttachmentFile(file) {
  if (!file) return false;
  const allowedExtensions = [".pdf",".txt",".doc",".docx",".ppt",".pptx",".xls",".xlsx",".png",".jpg",".jpeg",".gif",".webp"];
  const lowerName = file.name.toLowerCase();
  return file.type.startsWith("image/") || file.type === "application/pdf"
    || allowedExtensions.some((extension) => lowerName.endsWith(extension));
}

// --- Date & error helpers ---
function formatDate(value) {
  if (!value) return "غير محدد";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "غير محدد" : date.toLocaleString("ar-EG");
}

function mapFirebaseError(error, fallback = "حدث خطأ غير متوقع.") {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  if (code.includes("network") || message.includes("network") || message.includes("fetch")) return "تعذر الاتصال بالخادم. تأكد من الاتصال بالإنترنت.";
  if (code.includes("permission") || message.includes("permission") || message.includes("unauthorized") || error?.status === 401 || error?.status === 403) return "ليس لديك صلاحية لهذه العملية.";
  if (code.includes("not-found") || message.includes("not found") || error?.status === 404) return fallback;
  if (error?.message) return error.message;
  return fallback;
}

// --- Question normalization ---
function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions.map((question, index) => ({
    id: String(question?.id || `q${index + 1}`),
    text: String(question?.text || ""),
    type: ["mcq", "tf"].includes(question?.type) ? question.type : "mcq",
    options: Array.isArray(question?.options) ? question.options.map(String) : ["", "", "", ""],
    correct: toNumericValue(question?.correct, 0),
    difficulty: normalizeDifficulty(question?.difficulty),
    attachment: normalizeAttachment(question?.attachment),
    sourceBankId: String(question?.sourceBankId || ""),
    sourceBankTitle: String(question?.sourceBankTitle || "")
  }));
}

function normalizeAnswers(rawAnswers, questionCount) {
  if (!Array.isArray(rawAnswers)) return new Array(questionCount).fill(-1);
  const answers = rawAnswers.map((answer) => {
    const n = Number.parseInt(answer, 10);
    return Number.isFinite(n) ? n : -1;
  });
  while (answers.length < questionCount) answers.push(-1);
  return answers.slice(0, questionCount);
}

function calculateScore(correctAnswers, studentAnswersList) {
  if (!Array.isArray(correctAnswers) || !Array.isArray(studentAnswersList)) return 0;
  return correctAnswers.reduce((score, correct, index) => {
    const studentAnswer = studentAnswersList[index];
    return typeof studentAnswer === "number" && studentAnswer >= 0 && studentAnswer === correct ? score + 1 : score;
  }, 0);
}

function sanitizeQuestionList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((question) => question && typeof question === "object" && String(question.text || "").trim());
}

// --- Exam helpers ---
function createEmptyQuestion() {
  return {
    id: createQuestionId(),
    text: "",
    type: "mcq",
    options: ["", "", "", ""],
    correct: 0,
    difficulty: "medium",
    attachment: null
  };
}

function cloneQuestionForExam(question, index) {
  return {
    id: String(question?.id || `q${index + 1}`),
    text: String(question?.text || ""),
    type: ["mcq", "tf"].includes(question?.type) ? question.type : "mcq",
    options: Array.isArray(question?.options) ? [...question.options] : ["", "", "", ""],
    attachment: normalizeAttachment(question?.attachment)
  };
}

// --- URL / share helpers ---
function buildExamShareLink(examId) {
  return `${window.location.origin}${window.location.pathname}?exam=${encodeURIComponent(examId)}`;
}

function hasDirectExamLink() {
  return Boolean(new URLSearchParams(window.location.search).get("exam"));
}

function hasStudentGroup(group) {
  return Boolean(String(group || "").trim());
}

function formatStudentHeaderLine(name, group) {
  const parts = [escapeHtml(name)];
  if (hasStudentGroup(group)) parts.push(`(${escapeHtml(group)})`);
  return parts.join(" ");
}

function formatExamPreviewTitle(examTitle, studentGroup) {
  if (!hasStudentGroup(studentGroup)) return escapeHtml(examTitle);
  return `${escapeHtml(examTitle)} — ${escapeHtml(studentGroup)}`;
}

function buildOptionalGroupMarkup(group) {
  if (!hasStudentGroup(group)) return "";
  return `الفصل / المجموعة: ${escapeHtml(group)}`;
}

function getExamTeacherName() {
  return APP_CONFIG?.teacherName || "أ/ عمرو شعبان";
}
