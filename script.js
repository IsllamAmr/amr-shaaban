const ADMIN_PAGES = new Set(["pg-admindash", "pg-createexam", "pg-adminresults", "pg-banks"]);
const MCQ_LABELS = ["أ", "ب", "ج", "د"];
const TF_LABELS = ["صح", "خطأ"];
const TF_SYMBOLS = ["✓", "✗"];
const DIFFICULTY_LEVELS = [
  { value: "easy", label: "سهل" },
  { value: "medium", label: "متوسط" },
  { value: "hard", label: "صعب" },
  { value: "impossible", label: "مستحيل" }
];
const QUESTION_ATTACHMENT_MAX_SIZE = 2 * 1024 * 1024;
const QUESTION_ATTACHMENT_ACCEPT = "image/*,.pdf,.txt,.doc,.docx,.ppt,.pptx,.xls,.xlsx";
const APP_CONFIG = window.APP_CONFIG || {};
const API_BASE_URL = String(APP_CONFIG.API_BASE_URL || "").trim().replace(/\/+$/, "");

if (!API_BASE_URL && /(?:web\.app|firebaseapp\.com)$/i.test(window.location.hostname)) {
  console.warn("APP_CONFIG.API_BASE_URL is empty. Set it to your Render backend URL before using the hosted site.");
}

let adminUid = null;
let isAdminAuthenticated = false;
let exams = [];
let currentExam = null;
let currentAttemptToken = "";
let currentStudent = "";
let currentStudentGroup = "";
let currentSubmissionReceipt = null;
let currentPublishedResult = null;
let linkedExam = null;
let studentAnswers = [];
let examTimerInterval = null;
let examAutoSaveInterval = null;
let examTimeLeft = 0;
let examTotalTime = 0;
let cheatWarnings = 0;
let mouseOutWarningShown = false;
let questions = [];
let qCounter = 0;
let questionBanks = [];
let activeBankId = null;
let activeBankUpdatedAt = 0;
let bankQuestions = [];
let bankQuestionCounter = 0;
let selectedImportBankId = "";
let isQuestionBankSaving = false;
let isQuestionBankDeleting = false;
let adminResultsState = { exam: null, byId: {} };
let currentAdminReviewId = null;
let examBackGuardActive = false;

// ============ أدوات التخزين المحلي البسيطة ============
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

// ============ مصادقة المدرس عبر السيرفر ============
function buildApiUrl(url) {
  if (/^https?:\/\//i.test(String(url || ""))) {
    return String(url);
  }

  return API_BASE_URL ? `${API_BASE_URL}${url}` : String(url || "");
}

function getApiRequestCredentials(url) {
  const targetUrl = new URL(buildApiUrl(url), window.location.origin);
  return targetUrl.origin === window.location.origin ? "same-origin" : "include";
}

async function requestServerJson(url, options = {}) {
  const headers = {
    ...(options.headers || {})
  };

  if (options.body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(buildApiUrl(url), {
    credentials: getApiRequestCredentials(url),
    headers,
    ...options
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    if (payload?.error) {
      const serverError = new Error(payload.error);
      serverError.status = response.status;
      throw serverError;
    }
    const error = new Error(payload?.message || "تعذر إتمام الطلب على السيرفر.");
    error.status = response.status;
    throw error;
  }

  return payload || {};
}

async function syncAdminSession(options = {}) {
  const { silent = false } = options;

  try {
    const session = await requestServerJson("/api/admin/session", {
      method: "GET"
    });

    if (!session.authenticated) {
      isAdminAuthenticated = false;
      adminUid = null;
      updateAdminLoginView();
      return session;
    }

    isAdminAuthenticated = true;
    adminUid = session.adminUid;
    updateAdminLoginView();
    return session;
  } catch (error) {
    isAdminAuthenticated = false;
    adminUid = null;
    updateAdminLoginView();

    if (silent) {
      return { authenticated: false };
    }

    throw error;
  }
}

// ============ نهاية مصادقة المدرس ============

// ============ نظام النسخ الاحتياطي (Backup/Recovery) ============

function createBackup() {
  try {
    const backup = {
      timestamp: new Date().toISOString(),
      exams: exams,
      questionBanks: questionBanks,
      version: "1.0"
    };
    
    setStoredJson("app_backup", backup);
    
    return backup;
  } catch (error) {
    console.error("خطأ في إنشاء النسخة الاحتياطية:", error);
    return null;
  }
}

function restoreBackup(backupData) {
  try {
    if (!backupData || !backupData.exams || !backupData.questionBanks) {
      throw new Error("بيانات النسخة الاحتياطية غير صحيحة");
    }
    
    exams = backupData.exams;
    questionBanks = backupData.questionBanks;
    logQuestionBankDebug("restore-backup-local-state", {
      bankCount: Array.isArray(questionBanks) ? questionBanks.length : Object.keys(questionBanks || {}).length
    });
    
    console.log("%c✅ تم استرجاع البيانات من النسخة الاحتياطية", "color:green;font-weight:bold");
    return true;
  } catch (error) {
    console.error("خطأ في استرجاع النسخة الاحتياطية:", error);
    return false;
  }
}

function exportDataAsJson() {
  try {
    const exportData = {
      exams: exams,
      banks: questionBanks,
      exportedAt: new Date().toISOString()
    };
    
    const dataStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement("a");
    a.href = url;
    a.download = `exam_backup_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showNotice("✅ تم تحميل النسخة الاحتياطية");
  } catch (error) {
    console.error("خطأ في التصدير:", error);
  }
}

function importDataFromJson() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  
  input.onchange = (e) => {
    const file = e.target.files[0];
    const reader = new FileReader();
    
    reader.onload = (event) => {
      try {
        const backupData = JSON.parse(event.target.result);
        
        if (confirm("هل تريد استيراد البيانات من الملف؟ سيتم استبدال البيانات الحالية.")) {
          exams = backupData.exams || [];
          questionBanks = backupData.banks || [];
          logQuestionBankDebug("import-backup-local-state", {
            importedBankCount: Array.isArray(questionBanks) ? questionBanks.length : Object.keys(questionBanks || {}).length
          });
          
          // حفظ النسخة الاحتياطية الجديدة
          createBackup();
          
          showNotice("✅ تم استيراد النسخة الاحتياطية بنجاح");
          location.reload(); // إعادة تحميل الصفحة
        }
      } catch (error) {
        showErr(document.getElementById("al-err"), "❌ ملف غير صحيح أو تالف");
        console.error("خطأ في الاستيراد:", error);
      }
    };
    
    reader.readAsText(file);
  };
  
  input.click();
}

// ============ نهاية نظام النسخ الاحتياطية ============

// ============ تحسين حماية الغش ============

function addSecurityWatermark() {
  const watermark = document.createElement('div');
  watermark.innerHTML = '🔐 منصة امتحانات آمنة';
  watermark.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) rotate(-45deg);
    font-size: 42px;
    color: rgba(0, 0, 0, 0.02);
    pointer-events: none;
    z-index: -1;
    font-weight: bold;
    font-family: Cairo;
  `;
  document.body.appendChild(watermark);
}

function monitorExamSecurity() {
  if (!currentExam) return;
  
  // مراقبة الأمان كل 3 ثواني
  setInterval(() => {
    // 1. التحقق من عدم تعديل متغيرات الامتحان
    if (studentAnswers && questions) {
      if (studentAnswers.length > questions.length) {
        console.warn("⚠️ تم اكتشاف محاولة غش: إجابات إضافية");
        registerCheatWarning();
      }
    }
    
    // 2. منع محاولات الوصول للـ console
    if (typeof window.console !== 'object') {
      console.warn("⚠️ محاولة تعطيل console");
    }
  }, 3000);
}

function protectExamData() {
  // منع وصول الطالب لبيانات الامتحان في memory
  if (currentExam) {
    Object.defineProperty(window, 'currentExam', {
      configurable: false,
      writable: false,
      value: currentExam
    });
  }
}

// ============ نهاية تحسين الحماية ============
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

function normalizeDifficulty(value) {
  const allowed = new Set(DIFFICULTY_LEVELS.map((item) => item.value));
  return allowed.has(value) ? value : "medium";
}

function getDifficultyLabel(value) {
  return DIFFICULTY_LEVELS.find((item) => item.value === value)?.label || "متوسط";
}

function getDifficultyBadgeClass(value) {
  switch (value) {
    case "easy":
      return "badge-green";
    case "medium":
      return "badge-gold";
    case "hard":
      return "badge-red";
    case "impossible":
      return "badge-dark";
    default:
      return "badge-gold";
  }
}

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
  if (bytes < 1024) {
    return `${bytes} بايت`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} ك.ب`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} م.ب`;
}

function getQuestionOptionMarker(questionType, optionIndex) {
  return questionType === "mcq" ? MCQ_LABELS[optionIndex] : TF_SYMBOLS[optionIndex];
}

function getScoreColor(score) {
  if (score >= 70) {
    return "#2e7d32";
  }

  if (score >= 50) {
    return "#e67e22";
  }

  return "var(--red)";
}

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }

  const fileName = String(attachment.fileName || attachment.name || "").trim();
  const contentType = String(attachment.contentType || attachment.type || "").trim();
  const downloadUrl = String(attachment.downloadUrl || "").trim();
  const dataUrl = String(attachment.dataUrl || "").trim();
  const storagePath = String(attachment.storagePath || "").trim();

  if (!fileName || (!downloadUrl && !dataUrl && !storagePath)) {
    return null;
  }

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
  if (!attachment) {
    return "";
  }

  return attachment.kind === "image" ? "صورة مرفقة" : "ملف مرفق";
}

function isSupportedAttachmentFile(file) {
  if (!file) {
    return false;
  }

  const allowedExtensions = [
    ".pdf",
    ".txt",
    ".doc",
    ".docx",
    ".ppt",
    ".pptx",
    ".xls",
    ".xlsx",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp"
  ];
  const lowerName = file.name.toLowerCase();

  return file.type.startsWith("image/")
    || file.type === "application/pdf"
    || allowedExtensions.some((extension) => lowerName.endsWith(extension));
}

async function uploadAttachmentToServer(file) {
  const uploadUrl = "/api/admin/uploads";
  const response = await fetch(buildApiUrl(uploadUrl), {
    method: "POST",
    credentials: getApiRequestCredentials(uploadUrl),
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Upload-Filename": encodeURIComponent(file.name),
      "X-Upload-Content-Type": file.type || "application/octet-stream"
    },
    body: file
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(payload?.error || "Upload failed.");
    error.status = response.status;
    throw error;
  }

  return normalizeAttachment(payload?.attachment);
}

async function deleteTemporaryAttachment(attachment) {
  const normalized = normalizeAttachment(attachment);

  if (!normalized?.temporary || !normalized.storagePath) {
    return;
  }

  await requestServerJson("/api/admin/uploads", {
    method: "DELETE",
    body: JSON.stringify({
      storagePath: normalized.storagePath
    })
  });
}

function renderQuestionAttachment(attachment, options = {}) {
  const normalized = normalizeAttachment(attachment);

  if (!normalized) {
    return "";
  }

  const {
    allowDownload = true,
    compact = false
  } = options;
  const attachmentUrl = normalized.downloadUrl || normalized.dataUrl || "";
  const preview = normalized.kind === "image"
    ? `<img class="question-attachment-image${compact ? " compact" : ""}" src="${attachmentUrl}" alt="${escapeHtml(normalized.name)}">`
    : `<div class="attachment-icon">FILE</div>`;

  return `
    <div class="question-attachment${compact ? " compact" : ""}">
      <div class="question-attachment-header">
        <div>
          <div class="question-attachment-title">${getAttachmentTypeLabel(normalized)}</div>
          <div class="question-attachment-meta">${escapeHtml(normalized.name)}${normalized.size ? ` - ${humanFileSize(normalized.size)}` : ""}</div>
        </div>
        ${allowDownload && attachmentUrl ? `<a class="attachment-download" href="${attachmentUrl}" download="${escapeHtml(normalized.name)}" target="_blank" rel="noopener">Download</a>` : ""}
      </div>
      <div class="question-attachment-body">
        ${preview}
      </div>
    </div>
  `;
}
function buildBarChartCard(title, items, options = {}) {
  const {
    emptyText = "لا توجد بيانات كافية بعد.",
    formatter = (value) => String(value),
    color = "var(--gold)"
  } = options;

  if (!items.length) {
    return `
      <div class="chart-card">
        <div class="chart-title">${title}</div>
        <div class="chart-empty">${emptyText}</div>
      </div>
    `;
  }

  const maxValue = Math.max(...items.map((item) => Number(item.value || 0)), 1);

  return `
    <div class="chart-card">
      <div class="chart-title">${title}</div>
      <div class="chart-list">
        ${items.map((item) => `
          <div class="chart-row">
            <div class="chart-row-top">
              <span class="chart-label">${escapeHtml(item.label)}</span>
              <span class="chart-value">${formatter(item.value)}</span>
            </div>
            <div class="chart-track">
              <div class="chart-fill" style="width:${Number(item.value || 0) > 0 ? Math.max(8, Math.round((Number(item.value || 0) / maxValue) * 100)) : 0}%;background:${item.color || color}"></div>
            </div>
            ${item.meta ? `<div class="chart-meta">${escapeHtml(item.meta)}</div>` : ""}
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function groupResultsByField(results, selector) {
  const grouped = {};

  results.forEach((result) => {
    const key = sanitizePlainText(selector(result), "غير محدد");
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(result);
  });

  return grouped;
}

function buildDashboardCharts(examEntries, allResults) {
  const bySubmissions = [...examEntries]
    .sort((first, second) => second.resultCount - first.resultCount)
    .slice(0, 5)
    .map((exam) => ({
      label: exam.title,
      value: exam.resultCount,
      meta: `${exam.questionCount} سؤال`,
      color: "var(--gold)"
    }));

  const byAverageScore = examEntries
    .filter((exam) => exam.resultCount > 0)
    .sort((first, second) => second.averageScore - first.averageScore)
    .slice(0, 5)
    .map((exam) => ({
      label: exam.title,
      value: exam.averageScore,
      meta: `${exam.resultCount} تسليم`,
      color: "#2d8a57"
    }));

  const groups = Object.entries(groupResultsByField(allResults, (result) => result.studentGroup))
    .map(([label, groupItems]) => ({
      label,
      value: groupItems.length,
      meta: `متوسط ${Math.round(groupItems.reduce((sum, item) => sum + item.pct, 0) / groupItems.length)}%`,
      color: "#5d9cec"
    }))
    .sort((first, second) => second.value - first.value)
    .slice(0, 5);

  return [
    buildBarChartCard("أكثر الامتحانات تسليمًا", bySubmissions, {
      emptyText: "لم تصل أي تسليمات بعد.",
      formatter: (value) => `${value} تسليم`
    }),
    buildBarChartCard("أفضل متوسطات الدرجات", byAverageScore, {
      emptyText: "سيظهر هذا الرسم بعد أول تصحيح.",
      formatter: (value) => `${value}%`,
      color: "#2d8a57"
    }),
    buildBarChartCard("المجموعات الأكثر نشاطًا", groups, {
      emptyText: "أضف اسم الفصل/المجموعة لتظهر الإحصائية هنا.",
      formatter: (value) => `${value} طالب`,
      color: "#5d9cec"
    })
  ].join("");
}

function buildExamResultsCharts(results) {
  const scoreBands = [
    { label: "0% - 49%", value: results.filter((item) => item.pct < 50).length, color: "var(--red)" },
    { label: "50% - 69%", value: results.filter((item) => item.pct >= 50 && item.pct < 70).length, color: "#e67e22" },
    { label: "70% - 84%", value: results.filter((item) => item.pct >= 70 && item.pct < 85).length, color: "#4caf50" },
    { label: "85% - 100%", value: results.filter((item) => item.pct >= 85).length, color: "#2d8a57" }
  ];

  const topGroups = Object.entries(groupResultsByField(results, (result) => result.studentGroup))
    .map(([label, groupItems]) => ({
      label,
      value: groupItems.length,
      meta: `متوسط ${Math.round(groupItems.reduce((sum, item) => sum + item.pct, 0) / groupItems.length)}%`,
      color: "#5d9cec"
    }))
    .sort((first, second) => second.value - first.value)
    .slice(0, 5);

  const topScores = [...results]
    .sort((first, second) => second.pct - first.pct)
    .slice(0, 5)
    .map((item) => ({
      label: item.studentName,
      value: item.pct,
      meta: sanitizePlainText(item.studentGroup, "بدون مجموعة"),
      color: getScoreColor(item.pct)
    }));

  return [
    buildBarChartCard("توزيع الدرجات", scoreBands, {
      emptyText: "لا توجد نتائج بعد.",
      formatter: (value) => `${value} طالب`
    }),
    buildBarChartCard("المجموعات المشاركة", topGroups, {
      emptyText: "لا توجد بيانات مجموعات بعد.",
      formatter: (value) => `${value} طالب`,
      color: "#5d9cec"
    }),
    buildBarChartCard("أعلى الدرجات", topScores, {
      emptyText: "سيظهر ترتيب الطلاب بعد أول تسليم.",
      formatter: (value) => `${value}%`
    })
  ].join("");
}

function buildPrintableLayout(title, bodyHtml) {
  return `
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <title>${escapeHtml(title)}</title>
      <meta name="color-scheme" content="light">
      <style>
        * {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
          -webkit-filter: none;
          filter: none;
        }

        body {
          font-family: Tahoma, Arial, sans-serif;
          margin: 0;
          padding: 32px;
          background: #f7f5ef;
          color: #1a1a1a;
          direction: rtl;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }

        .print-shell {
          max-width: 900px;
          margin: 0 auto;
          background: #fff;
          border: 1px solid #e5dcc8;
          border-radius: 20px;
          overflow: hidden;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }

        .print-header {
          background: linear-gradient(135deg, #0b2e1a 0%, #1a5235 100%);
          color: #fff;
          padding: 24px 28px;
        }

        .print-header h1 {
          margin: 0 0 8px;
          font-size: 28px;
        }

        .print-header p {
          margin: 0;
          opacity: 0.9;
          font-size: 14px;
        }

        .print-body {
          padding: 24px 28px;
        }

        .print-card {
          border: 1px solid #eadfc8;
          border-radius: 16px;
          padding: 18px;
          margin-bottom: 16px;
        }

        .print-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          margin: 18px 0;
        }

        .print-stat {
          background: #f8f1df;
          border-radius: 12px;
          padding: 14px;
          text-align: center;
        }

        .print-stat strong {
          display: block;
          font-size: 28px;
          color: #0b2e1a;
        }

        .print-question {
          border-right: 4px solid #c9973a;
        }

        .print-option {
          border: 1px solid #ddd3be;
          border-radius: 10px;
          padding: 10px 12px;
          margin-bottom: 8px;
        }

        .print-option.correct {
          border-color: #2e7d32;
          background: #edf7ee;
        }

        .print-option.wrong {
          border-color: #c0392b;
          background: #fdeeee;
        }

        .question-attachment-image {
          max-width: 100%;
          border-radius: 12px;
          border: 1px solid #eadfc8;
          margin-top: 12px;
        }

        .question-attachment {
          border: 1px solid #eadfc8;
          border-radius: 14px;
          padding: 14px;
          margin-bottom: 14px;
          background: #faf7ef;
        }

        .question-attachment-header {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 10px;
        }

        .question-attachment-title {
          font-weight: 800;
        }

        .question-attachment-meta {
          color: #666;
          font-size: 12px;
          margin-top: 4px;
        }

        .attachment-icon {
          width: 60px;
          height: 60px;
          border-radius: 50%;
          background: #f8f1df;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 26px;
        }

        @media print {
          * {
            margin: 0;
            padding: 0;
          }

          body {
            padding: 10px;
            background: #fff;
            margin: 0;
          }

          .print-shell {
            border: 0;
            border-radius: 0;
            box-shadow: none;
            page-break-after: avoid;
          }

          .print-header {
            page-break-after: avoid;
          }

          .print-body {
            page-break-inside: avoid;
          }

          .print-card {
            page-break-inside: avoid;
          }

          h1, h2, h3, h4, h5, h6 {
            page-break-after: avoid;
          }

          table, pre {
            page-break-inside: avoid;
          }
        }
      </style>
    </head>
    <body>
      <div class="print-shell">
        <div class="print-header">
          <h1>${escapeHtml(title)}</h1>
          <p>منصة أ/ عمرو شعبان التعليمية</p>
        </div>
        <div class="print-body">
          ${bodyHtml}
        </div>
      </div>
    </body>
    </html>
  `;
}

function openPrintWindow(title, bodyHtml) {
  const printableMarkup = buildPrintableLayout(title, bodyHtml);
  
  // الطريقة الأولى: نافذة جديدة
  const printWindow = window.open("", "_blank", "width=900,height=1200");

  if (printWindow && !printWindow.closed) {
    try {
      printWindow.document.open();
      printWindow.document.write(printableMarkup);
      printWindow.document.close();

      // انتظر تحميل الصفحة ثم اطبع
      setTimeout(() => {
        try {
          printWindow.focus();
          printWindow.print();
        } catch (error) {
          console.error("خطأ في الطباعة:", error);
        }
      }, 500);

      return;
    } catch (error) {
      console.error("خطأ في النافذة المنبثقة:", error);
    }
  }

  // الطريقة البديلة: استخدام iframe مع طريقة أفضل
  console.warn("تم حظر النافذة المنبثقة، استخدام طريقة بديلة...");
  
  try {
    const printFrame = document.createElement("iframe");
    printFrame.style.display = "none";
    printFrame.style.position = "absolute";
    printFrame.style.width = "0";
    printFrame.style.height = "0";
    printFrame.style.border = "0";
    document.body.appendChild(printFrame);

    // انتظر قليلاً حتى يكون الـ iframe جاهزاً
    setTimeout(() => {
      try {
        const frameDoc = printFrame.contentDocument || printFrame.contentWindow.document;
        frameDoc.open();
        frameDoc.write(printableMarkup);
        frameDoc.close();

        // انتظر ثم اطبع
        setTimeout(() => {
          printFrame.contentWindow.focus();
          printFrame.contentWindow.print();
          
          // أزل الـ iframe بعد الطباعة
          setTimeout(() => {
            document.body.removeChild(printFrame);
          }, 1000);
        }, 500);
      } catch (error) {
        console.error("خطأ في كتابة iframe:", error);
        alert("❌ تعذر فتح نافذة الطباعة. تأكد من السماح بالنوافذ المنبثقة.");
        document.body.removeChild(printFrame);
      }
    }, 100);
  } catch (error) {
    console.error("خطأ عام في الطباعة:", error);
    alert("❌ تعذر فتح نافذة الطباعة. جرب متصفحاً آخر أو تحقق من إعدادات الحجب.");
  }
}

function showPage(id) {
  document.querySelectorAll(".page").forEach((page) => page.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  window.scrollTo(0, 0);
}

function showErr(el, msg) {
  if (!el) {
    return;
  }

  el.style.display = "block";
  el.textContent = msg;
}

function hideErr(id) {
  const el = document.getElementById(id);

  if (el) {
    el.style.display = "none";
    el.textContent = "";
  }
}

function showNotice(msg) {
  const note = document.getElementById("al-note");
  if (!note) {
    return;
  }

  note.style.display = "block";
  note.textContent = msg;
}

function hideNotice() {
  const note = document.getElementById("al-note");
  if (!note) {
    return;
  }

  note.style.display = "none";
  note.textContent = "";
}

function setButtonLoading(buttonId, isLoading, loadingText = "جارٍ التنفيذ...") {
  const button = typeof buttonId === "string" ? document.getElementById(buttonId) : buttonId;

  if (!button) {
    return;
  }

  if (isLoading) {
    if (!button.dataset.originalHtml) {
      button.dataset.originalHtml = button.innerHTML;
    }

    button.disabled = true;
    button.classList.add("is-loading");
    button.innerHTML = `<span class="btn-content"><span class="btn-spinner"></span><span>${loadingText}</span></span>`;
    return;
  }

  button.disabled = false;
  button.classList.remove("is-loading");

  if (button.dataset.originalHtml) {
    button.innerHTML = button.dataset.originalHtml;
  }
}

function formatDate(value) {
  if (!value) {
    return "غير محدد";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "غير محدد" : date.toLocaleString("ar-EG");
}

function mapFirebaseError(error, fallback = "حدث خطأ غير متوقع.") {
  const code = String(error?.code || "").toLowerCase();

  switch (code) {
    case "auth/invalid-email":
      return "البريد الإلكتروني غير صالح.";
    case "auth/missing-password":
      return "أدخل كلمة المرور.";
    case "auth/weak-password":
      return "كلمة المرور ضعيفة. استخدم 6 أحرف على الأقل.";
    case "auth/email-already-in-use":
      return "هذا البريد مستخدم بالفعل. جرّب تسجيل الدخول بدل إنشاء الحساب.";
    case "auth/invalid-login-credentials":
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "بيانات الدخول غير صحيحة.";
    case "auth/too-many-requests":
      return "تمت محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.";
    case "auth/network-request-failed":
      return "تعذر الاتصال بالإنترنت أو Firebase.";
    case "auth/operation-not-allowed":
      return "فعّل Email/Password من Firebase Authentication ثم أعد المحاولة.";
    case "permission_denied":
    case "database/permission-denied":
      return "لا توجد صلاحية كافية لتنفيذ هذه العملية. تأكد من نشر قواعد قاعدة البيانات.";
    default:
      return error?.message || fallback;
  }
}

function normalizeQuestions(rawQuestions) {
  if (!rawQuestions) {
    return [];
  }

  const list = Array.isArray(rawQuestions) ? rawQuestions : Object.values(rawQuestions);

  return list
    .filter(Boolean)
    .map((question, index) => ({
      id: question.id || `q${index + 1}`,
      type: question.type === "tf" ? "tf" : "mcq",
      text: String(question.text || ""),
      options: Array.isArray(question.options) ? question.options.map((option) => String(option || "")) : [],
      correct: Number.isInteger(question.correct) ? question.correct : Number.parseInt(question.correct, 10),
      attachment: normalizeAttachment(question.attachment),
      difficulty: normalizeDifficulty(question.difficulty),
      sourceBankId: question.sourceBankId || "",
      sourceBankTitle: question.sourceBankTitle || ""
    }));
}

function normalizeAnswers(rawAnswers, total) {
  const length = Number.isInteger(total) && total > 0 ? total : 0;

  if (Array.isArray(rawAnswers)) {
    return Array.from({ length: Math.max(length, rawAnswers.length) }, (_, index) => {
      const parsed = Number.parseInt(rawAnswers[index], 10);
      return Number.isFinite(parsed) ? parsed : -1;
    });
  }

  if (rawAnswers && typeof rawAnswers === "object") {
    const objectKeys = Object.keys(rawAnswers);
    const size = Math.max(length, objectKeys.length);
    return Array.from({ length: size }, (_, index) => {
      const parsed = Number.parseInt(rawAnswers[index], 10);
      return Number.isFinite(parsed) ? parsed : -1;
    });
  }

  return Array.from({ length }, () => -1);
}

function calculateScore(correctAnswers, answers) {
  return correctAnswers.reduce((score, correctAnswer, index) => (
    answers[index] === correctAnswer ? score + 1 : score
  ), 0);
}

function sanitizeQuestionList(rawQuestions) {
  return rawQuestions.map((question) => ({
    id: question.id,
    type: question.type,
    text: question.text.trim(),
    options: question.options.map((option) => option.trim()),
    correct: Number.parseInt(question.correct, 10),
    attachment: normalizeAttachment(question.attachment),
    difficulty: normalizeDifficulty(question.difficulty),
    sourceBankId: question.sourceBankId || "",
    sourceBankTitle: question.sourceBankTitle || ""
  }));
}

function createEmptyQuestion(type = "mcq", idFactory = createQuestionId) {
  return {
    id: idFactory(),
    type,
    text: "",
    options: type === "mcq" ? ["", "", "", ""] : [...TF_LABELS],
    correct: -1,
    attachment: null,
    difficulty: "medium",
    sourceBankId: "",
    sourceBankTitle: ""
  };
}

function cloneQuestionForExam(question) {
  return {
    ...createEmptyQuestion(question.type, createQuestionId),
    text: question.text,
    options: [...question.options],
    correct: question.correct,
    attachment: normalizeAttachment(question.attachment),
    difficulty: normalizeDifficulty(question.difficulty),
    sourceBankId: question.sourceBankId || question.bankId || "",
    sourceBankTitle: question.sourceBankTitle || question.bankTitle || ""
  };
}

function buildExamShareLink(examId) {
  const url = new URL(window.location.href);
  url.searchParams.set("exam", examId);
  return url.toString();
}

function updateHomeEntryMode() {
  const linkedCard = document.getElementById("h-linked-card");
  const codeWrap = document.getElementById("h-code-wrap");
  const linkedTitle = document.getElementById("h-linked-title");
  const linkedMeta = document.getElementById("h-linked-meta");
  const linkedLink = document.getElementById("h-linked-link");
  const subtitle = document.getElementById("h-subtitle");

  if (!linkedCard || !codeWrap || !linkedTitle || !linkedMeta || !linkedLink || !subtitle) {
    return;
  }

  if (linkedExam) {
    linkedCard.style.display = "block";
    linkedTitle.textContent = linkedExam.title;
    const linkedQuestionCount = Number(linkedExam.questionCount || linkedExam.questions?.length || 0);
    linkedMeta.textContent = `⏱ ${linkedExam.duration} دقيقة • ❓ ${linkedExam.questions.length} سؤال`;
    linkedLink.textContent = buildExamShareLink(linkedExam.id);
    codeWrap.style.display = "none";
    subtitle.textContent = "اكتب بياناتك ثم ابدأ الامتحان مباشرة من الرابط الذي أرسله المدرس.";
  } else {
    linkedCard.style.display = "none";
    codeWrap.style.display = "block";
    subtitle.textContent = "أدخل بياناتك وكود الامتحان ثم ابدأ مباشرة.";
  }
}

async function loadLinkedExamFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const linkedExamId = params.get("exam");

  linkedExam = null;
  updateHomeEntryMode();

  if (!linkedExamId) {
    return;
  }

  try {
    const payload = await requestServerJson("/api/student/exam-access", {
      method: "POST",
      body: JSON.stringify({ examId: linkedExamId })
    });

    if (!payload?.exam) {
      throw new Error("هذا الرابط غير صالح أو الامتحان مغلق الآن.");
    }

    linkedExam = {
      ...payload.exam,
      questions: new Array(Number(payload.exam?.questionCount || 0))
    };
    hideErr("h-err");
  } catch (error) {
    linkedExam = null;
    showErr(document.getElementById("h-err"), mapFirebaseError(error, "تعذر فتح رابط الامتحان المباشر."));
  } finally {
    updateHomeEntryMode();
  }
}

function mapQuestionBankList(bankMap) {
  const entries = Array.isArray(bankMap)
    ? bankMap.map((bank) => [bank.id, bank])
    : Object.entries(bankMap || {});

  return entries
    .map(([id, bank]) => ({
      id,
      title: sanitizePlainText(bank.title, "بنك بدون اسم"),
      description: sanitizePlainText(bank.description, ""),
      createdAt: bank.createdAt || 0,
      updatedAt: bank.updatedAt || 0,
      questions: normalizeQuestions(bank.questions),
      questionCount: Array.isArray(bank.questions) ? bank.questions.length : Object.keys(bank.questions || {}).length
    }))
    .sort((first, second) => Number(second.updatedAt || second.createdAt || 0) - Number(first.updatedAt || first.createdAt || 0));
}

async function loadQuestionBanks() {
  await ensureAdminAccess();
  const payload = await requestServerJson("/api/admin/question-banks", {
    method: "GET"
  });
  questionBanks = mapQuestionBankList(payload.banks || []);
  logQuestionBankDebug("load-question-banks", {
    bankCount: questionBanks.length,
    bankIds: questionBanks.map((bank) => bank.id),
    activeBankId,
    selectedImportBankId
  });
  return questionBanks;
}

function getBankById(bankId) {
  return questionBanks.find((bank) => bank.id === bankId) || null;
}

function buildDifficultyOptions(selectedValue) {
  return DIFFICULTY_LEVELS.map((item) => (
    `<option value="${item.value}" ${item.value === normalizeDifficulty(selectedValue) ? "selected" : ""}>${item.label}</option>`
  )).join("");
}

function buildDifficultySummary(questionList) {
  if (!questionList.length) {
    return "لا توجد أسئلة بعد.";
  }

  const counts = DIFFICULTY_LEVELS
    .map((level) => ({
      label: level.label,
      count: questionList.filter((question) => normalizeDifficulty(question.difficulty) === level.value).length
    }))
    .filter((item) => item.count > 0);

  return counts.map((item) => `${item.label}: ${item.count}`).join(" • ");
}

function showBankNote(message) {
  const note = document.getElementById("qb-note");

  if (!note) {
    return;
  }

  note.style.display = "block";
  note.textContent = message;
}

function hideBankNote() {
  const note = document.getElementById("qb-note");

  if (!note) {
    return;
  }

  note.style.display = "none";
  note.textContent = "";
}

async function copyExamLink(examId) {
  const exam = exams.find((item) => item.id === examId);

  if (!exam) {
    alert("تعذر العثور على الامتحان المطلوب.");
    return;
  }

  const examLink = buildExamShareLink(examId);

  try {
    await navigator.clipboard.writeText(examLink);
    alert(`تم نسخ رابط الامتحان:\n${examLink}`);
  } catch (error) {
    window.prompt("انسخ رابط الامتحان من هنا:", examLink);
  }
}

async function refreshAdminMode() {
  const session = await syncAdminSession({ silent: true });
  return session.authenticated ? session.adminUid : null;
}

function updateAdminLoginView() {
  const title = document.getElementById("al-title");
  const helper = document.getElementById("al-helper");
  const button = document.getElementById("al-action-btn");
  const tag = document.getElementById("al-mode-tag");
  const password = document.getElementById("al-pass");

  if (!title || !helper || !button || !tag || !password) {
    return;
  }

  tag.textContent = isAdminAuthenticated ? "جلسة خادم نشطة" : "دخول كلمة المرور";
  title.textContent = "دخول المدرس";
  helper.textContent = isAdminAuthenticated
    ? "تم التحقق من جلسة المدرس عبر السيرفر. يمكنك فتح لوحة التحكم بأمان."
    : "أدخل كلمة المرور الخاصة بك ليتم التحقق منها عبر السيرفر ثم فتح لوحة التحكم.";
  button.textContent = isAdminAuthenticated ? "تجديد الدخول" : "دخول";
  password.placeholder = "أدخل كلمة المرور";
}

async function ensureAdminAccess() {
  if (isAdminAuthenticated && adminUid) {
    return;
  }

  const session = await syncAdminSession();

  if (!session.authenticated) {
    throw new Error("سجّل دخول المدرس أولًا.");
  }
}

function buildSubmissionList(submissionMap, correctAnswers, total) {
  return Object.entries(submissionMap || {})
    .map(([id, item]) => {
      const answers = normalizeAnswers(item.answers, total);
      const score = calculateScore(correctAnswers, answers);
      const answeredCount = toNumericValue(item.answeredCount, answers.filter((answer) => answer >= 0).length);

      return {
        id,
        studentName: sanitizePlainText(item.studentName, "طالب"),
        studentGroup: sanitizePlainText(item.studentGroup || item.className || item.groupName, "غير محدد"),
        answers,
        at: item.submittedAt || item.at || Date.now(),
        answeredCount,
        score,
        total,
        pct: total ? Math.round((score / total) * 100) : 0
      };
    })
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
}

async function loadAdminDashboard() {
  try {
    await ensureAdminAccess();

    const data = await requestServerJson("/api/admin/dashboard", {
      method: "GET"
    });

    exams = (data.exams || []).map((exam) => ({
      ...exam,
      questions: normalizeQuestions(exam.questions)
    }));

    renderDash({
      summary: data.summary || {
        examCount: exams.length,
        studentCount: 0,
        averageScore: 0
      },
      exams,
      chartsHtml: buildDashboardCharts(exams, data.allResults || [])
    });

    return true;
  } catch (error) {
    const message = mapFirebaseError(error, "تعذر تحميل لوحة التحكم.");

    if (message.includes("سجّل دخول")) {
      showErr(document.getElementById("al-err"), message);
      showPage("pg-adminlogin");
      return false;
    }

    alert(message);
    return false;
  }
}

function renderDash(data) {
  document.getElementById("ad-stats").innerHTML = `
    <div class="stat-card"><div class="stat-num">${data.summary.examCount}</div><div class="stat-lbl">الامتحانات</div></div>
    <div class="stat-card"><div class="stat-num">${data.summary.studentCount}</div><div class="stat-lbl">التسليمات</div></div>
    <div class="stat-card"><div class="stat-num">${data.summary.averageScore}%</div><div class="stat-lbl">متوسط الدرجات</div></div>
  `;
  document.getElementById("ad-charts").innerHTML = data.chartsHtml;

  const container = document.getElementById("ad-exams");

  if (!data.exams.length) {
    container.innerHTML = `
      <div class="empty-state">
        لا توجد امتحانات بعد
        <br>
        <span>ابدأ بإنشاء أول امتحان الآن.</span>
      </div>
    `;
    return;
  }

  container.innerHTML = data.exams.map((exam) => `
    <div class="exam-card">
      <div class="flex-between" style="margin-bottom:14px">
        <div>
          <div style="font-size:17px;font-weight:800;color:var(--td);margin-bottom:6px">${escapeHtml(exam.title)}</div>
          <div style="font-size:13px;color:var(--tm);display:flex;gap:12px;flex-wrap:wrap">
            <span class="badge badge-gold">${escapeHtml(exam.code)}</span>
            <span>⏱ ${exam.duration} دقيقة</span>
            <span>❓ ${exam.questionCount} سؤال</span>
            <span>📨 ${exam.resultCount} تسليم</span>
            ${exam.resultCount ? `<span>📊 متوسط ${exam.averageScore}%</span>` : ""}
          </div>
        </div>
        <span class="badge ${exam.active ? "badge-green" : "badge-red"}" style="white-space:nowrap">
          ${exam.active ? "✅ متاح" : "⛔ مغلق"}
        </span>
      </div>
      <div class="divider"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm ${exam.active ? "btn-red" : "btn-green"}" onclick="toggleExam('${exam.id}')">
          ${exam.active ? "⛔ إغلاق" : "✅ فتح"}
        </button>
        <button class="btn btn-sm btn-outline" onclick="copyExamLink('${exam.id}')">🔗 نسخ الرابط</button>
        <button class="btn btn-sm btn-gold" onclick="viewResults('${exam.id}')">📊 النتائج (${exam.resultCount})</button>
        <button class="btn btn-sm btn-outline" onclick="deleteExam('${exam.id}')">🗑 حذف الامتحان</button>
      </div>
    </div>
  `).join("");
}

async function goPage(id) {
  if (id === "pg-adminlogin") {
    try {
      await refreshAdminMode();
    } catch (error) {
      showErr(document.getElementById("al-err"), mapFirebaseError(error, "تعذر قراءة حالة حساب المدرس."));
    }
  }

  if (ADMIN_PAGES.has(id)) {
    try {
      if (id === "pg-admindash" || id === "pg-createexam") {
        const loaded = await loadAdminDashboard();

        if (!loaded) {
          return;
        }
      } else {
        await ensureAdminAccess();
      }

      if (id === "pg-createexam") {
        await initCreateExam();
      }

      if (id === "pg-banks") {
        await loadQuestionBanksPage();
      }
    } catch (error) {
      const message = mapFirebaseError(error, "تعذر فتح الصفحة المطلوبة.");

      if (message.includes("سجّل دخول")) {
        showErr(document.getElementById("al-err"), message);
        showPage("pg-adminlogin");
        return;
      }

      alert(message);
      return;
    }
  }

  showPage(id);
}

async function adminLogin() {
  const passwordInput = document.getElementById("al-pass").value;
  const errorEl = document.getElementById("al-err");
  const actionButton = document.getElementById("al-action-btn");

  hideErr("al-err");
  hideNotice();

  const password = String(passwordInput || "").trim();

  if (!password) {
    showErr(errorEl, "أدخل كلمة المرور.");
    return;
  }

  setButtonLoading(actionButton, true, "جارٍ التحقق...");

  try {
    const payload = await requestServerJson("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password })
    });

    isAdminAuthenticated = true;
    adminUid = payload.adminUid;

    document.getElementById("al-pass").value = "";
    updateAdminLoginView();
    showNotice("✅ تم تسجيل دخول المدرس عبر السيرفر بنجاح");
    await goPage("pg-admindash");
  } catch (error) {
    console.error("خطأ في الدخول:", error);
    showErr(errorEl, `❌ ${mapFirebaseError(error, "تعذر تسجيل الدخول عبر السيرفر.")}`);
  } finally {
    setButtonLoading(actionButton, false);
  }
}

async function adminLogout() {
  try {
    await requestServerJson("/api/admin/logout", {
      method: "POST",
      body: JSON.stringify({})
    });
  } catch (error) {
    console.warn("تعذر إنهاء جلسة السيرفر:", error);
  }

  isAdminAuthenticated = false;
  adminUid = null;
  document.getElementById("al-pass").value = "";
  updateAdminLoginView();

  showNotice("✅ تم تسجيل خروج المدرس");
  await goPage("pg-adminlogin");
}

async function initCreateExam() {
  questions = [];
  qCounter = 0;
  document.getElementById("ce-title").value = "";
  document.getElementById("ce-code").value = `AR${101 + exams.length}`;
  document.getElementById("ce-dur").value = "30";
  hideErr("ce-err");

  await loadQuestionBanks();
  selectedImportBankId = questionBanks[0]?.id || "";
  renderBankImportSection();
  renderQuestions();
}

function addQuestion(type) {
  const question = createEmptyQuestion(type, createQuestionId);
  questions.push(question);
  renderQuestions();

  setTimeout(() => {
    const field = document.getElementById(`qt-${question.id}`);
    if (field) {
      field.focus();
    }
  }, 100);
}

function removeQuestion(id) {
  questions = questions.filter((question) => question.id !== id);
  renderQuestions();
}

function renderQuestions() {
  const container = document.getElementById("ce-questions");

  if (!questions.length) {
    container.innerHTML = `
      <div class="card" style="margin-bottom:22px;text-align:center">
        <div style="font-size:42px;margin-bottom:10px">🧩</div>
        <div style="font-size:18px;font-weight:800;color:var(--gd);margin-bottom:8px">لم تضف أسئلة للامتحان بعد</div>
        <div style="color:var(--tm);font-size:14px;line-height:1.9">
          يمكنك استيراد أي سؤال من أحد البنوك، أو إضافة سؤال جديد من عندك بالكامل.
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = questions.map((question, index) => `
    <div class="card" style="margin-bottom:18px;border:2px solid ${question.correct >= 0 ? "var(--gold)" : "var(--cd)"}">
      <div class="flex-between" style="margin-bottom:16px">
        <div style="font-weight:800;color:var(--gd);font-size:15px">
          سؤال ${index + 1}
          <span class="badge badge-gold" style="margin-right:8px">${question.type === "mcq" ? "اختياري" : "صح / خطأ"}</span>
          <span class="badge ${getDifficultyBadgeClass(question.difficulty)}">${getDifficultyLabel(question.difficulty)}</span>
          ${question.correct >= 0 ? '<span class="badge badge-green">✓ مكتمل</span>' : '<span class="badge badge-red">! ناقص</span>'}
        </div>
        <button class="btn btn-sm btn-red" onclick="removeQuestion('${question.id}')">حذف</button>
      </div>

      <div class="source-note" style="margin-bottom:12px">
        ${question.sourceBankTitle ? `📚 مستورد من بنك: <strong>${escapeHtml(question.sourceBankTitle)}</strong>، ويمكنك تعديله بحرية قبل الحفظ.` : "✍️ سؤال مضاف يدويًا من المدرس."}
      </div>

      <div class="difficulty-row">
        <div style="color:var(--tm);font-size:13px;line-height:1.8">
          غيّر الصعوبة أو عدّل نص السؤال واختياراته كما تريد.
        </div>
        <div class="inp-wrap difficulty-select" style="margin-bottom:0">
          <label class="label">درجة الصعوبة</label>
          <select class="inp" onchange="qSetDifficulty('${question.id}', this.value)">
            ${buildDifficultyOptions(question.difficulty)}
          </select>
        </div>
      </div>

      <div class="inp-wrap">
        <label class="label">نص السؤال</label>
        <textarea class="inp" id="qt-${question.id}" rows="2" placeholder="اكتب السؤال هنا..." oninput="qSetText('${question.id}', this.value)">${escapeHtml(question.text)}</textarea>
      </div>

      <div class="attachment-editor">
        <div class="attachment-editor-head">
          <span class="label" style="margin-bottom:0">إرفاق صورة أو ملف اختياري</span>
          <span class="attachment-hint">الحد الأقصى ${humanFileSize(QUESTION_ATTACHMENT_MAX_SIZE)}</span>
        </div>
        <div class="attachment-actions">
          <label class="btn btn-outline btn-sm file-picker-btn">
            رفع مرفق
            <input type="file" accept="${QUESTION_ATTACHMENT_ACCEPT}" onchange="qUploadAttachment('${question.id}', this)">
          </label>
          ${question.attachment ? `<button class="btn btn-sm btn-red" onclick="qRemoveAttachment('${question.id}')">حذف المرفق</button>` : ""}
        </div>
        ${question.attachment ? renderQuestionAttachment(question.attachment, { compact: true }) : '<div class="attachment-placeholder">لا يوجد مرفق لهذا السؤال.</div>'}
      </div>

      <div style="font-weight:700;color:var(--gm);font-size:13px;margin-bottom:10px">اختر الإجابة الصحيحة من الزر الجانبي.</div>
      ${question.type === "mcq" ? question.options.map((option, optionIndex) => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <button
            onclick="qSetCorrect('${question.id}', ${optionIndex})"
            title="حدد كإجابة صحيحة"
            style="min-width:36px;height:36px;border-radius:50%;border:2px solid ${question.correct === optionIndex ? "var(--gm)" : "var(--cd)"};
            background:${question.correct === optionIndex ? "var(--gm)" : "#fff"};color:${question.correct === optionIndex ? "#fff" : "var(--tm)"};
            font-weight:800;font-size:14px;cursor:pointer;transition:all .2s;flex-shrink:0"
          >
            ${MCQ_LABELS[optionIndex]}
          </button>
          <input
            class="inp"
            style="flex:1"
            placeholder="اكتب الاختيار ${MCQ_LABELS[optionIndex]}"
            value="${escapeHtml(option)}"
            oninput="qSetOption('${question.id}', ${optionIndex}, this.value)"
          />
        </div>
      `).join("") : `
        <div style="display:flex;gap:14px">
          ${TF_LABELS.map((option, optionIndex) => `
            <button
              onclick="qSetCorrect('${question.id}', ${optionIndex})"
              style="flex:1;padding:12px;border-radius:10px;border:2px solid ${question.correct === optionIndex ? "var(--gm)" : "var(--cd)"};
              background:${question.correct === optionIndex ? "var(--gm)" : "#fff"};color:${question.correct === optionIndex ? "#fff" : "var(--td)"};
              font-size:17px;font-weight:800;cursor:pointer;transition:all .2s"
            >
              ${question.correct === optionIndex ? "✓ " : ""}${option}
            </button>
          `).join("")}
        </div>
      `}
    </div>
  `).join("");
}

function qSetText(id, value) {
  const question = questions.find((item) => item.id === id);
  if (question) {
    question.text = value;
  }
}

function qSetOption(id, optionIndex, value) {
  const question = questions.find((item) => item.id === id);
  if (question) {
    question.options[optionIndex] = value;
  }
}

function qSetCorrect(id, optionIndex) {
  const question = questions.find((item) => item.id === id);
  if (question) {
    question.correct = optionIndex;
    renderQuestions();
  }
}

function qSetDifficulty(id, value) {
  const question = questions.find((item) => item.id === id);
  if (question) {
    question.difficulty = normalizeDifficulty(value);
    renderQuestions();
  }
}

async function qUploadAttachment(id, input) {
  const file = input.files?.[0];

  if (!file) {
    return;
  }

  if (!isSupportedAttachmentFile(file)) {
    alert("الملف غير مدعوم. استخدم صورة أو PDF أو ملفًا مكتبيًا صغير الحجم.");
    input.value = "";
    return;
  }

  if (file.size > QUESTION_ATTACHMENT_MAX_SIZE) {
    alert(`حجم الملف أكبر من المسموح. الحد الأقصى هو ${humanFileSize(QUESTION_ATTACHMENT_MAX_SIZE)}.`);
    input.value = "";
    return;
  }

  try {
    const question = questions.find((item) => item.id === id);

    if (!question) {
      return;
    }

    await deleteTemporaryAttachment(question.attachment);
    question.attachment = await uploadAttachmentToServer(file);
    renderQuestions();
  } catch (error) {
    alert(error.message || "تعذر رفع الملف.");
  } finally {
    input.value = "";
  }
}

async function qRemoveAttachment(id) {
  const question = questions.find((item) => item.id === id);

  if (!question) {
    return;
  }

  await deleteTemporaryAttachment(question.attachment);
  question.attachment = null;
  renderQuestions();
}

function renderBankImportSection() {
  const panel = document.getElementById("ce-bank-panel");

  if (!panel) {
    return;
  }

  if (!questionBanks.length) {
    panel.innerHTML = `
      <div class="muted-note">
        لا توجد بنوك أسئلة بعد. أنشئ أول بنك الآن، ثم ارجع هنا لاستيراد ما تريد منه.
      </div>
    `;
    return;
  }

  const selectedBank = getBankById(selectedImportBankId) || questionBanks[0];
  selectedImportBankId = selectedBank.id;

  panel.innerHTML = `
    <div class="grid2" style="margin-bottom:16px">
      <div class="inp-wrap">
        <label class="label">اختر البنك المرجعي</label>
        <select class="inp" onchange="selectImportBank(this.value)">
          ${questionBanks.map((bank) => `<option value="${bank.id}" ${bank.id === selectedBank.id ? "selected" : ""}>${escapeHtml(bank.title)} (${bank.questionCount})</option>`).join("")}
        </select>
      </div>
      <div class="muted-note">
        ${escapeHtml(selectedBank.description || "هذا البنك جاهز لتكوين الامتحانات الجديدة.")}
        <br>
        <strong>التوزيع:</strong> ${escapeHtml(buildDifficultySummary(selectedBank.questions))}
      </div>
    </div>
    <div class="question-actions" style="margin-bottom:14px">
      <button class="btn btn-gold btn-sm" onclick="addAllQuestionsFromBank('${selectedBank.id}')">إضافة كل أسئلة البنك</button>
    </div>
    <div class="bank-import-list">
      ${selectedBank.questions.length ? selectedBank.questions.map((question, index) => `
        <div class="bank-import-item">
          <div class="flex-between" style="margin-bottom:10px">
            <div style="font-weight:800;color:var(--gd);font-size:15px">
              سؤال ${index + 1}
              <span class="badge badge-gold" style="margin-right:8px">${question.type === "mcq" ? "اختياري" : "صح / خطأ"}</span>
              <span class="badge ${getDifficultyBadgeClass(question.difficulty)}">${getDifficultyLabel(question.difficulty)}</span>
            </div>
            <button class="btn btn-sm btn-green" onclick="addQuestionFromBank('${selectedBank.id}', '${escapeAttribute(question.id)}')">+ إضافة</button>
          </div>
          <div style="font-size:15px;font-weight:700;color:var(--td);line-height:1.9;margin-bottom:8px">${escapeHtml(question.text)}</div>
          <div class="source-note">
            ${question.attachment ? "📎 يحتوي على مرفق" : "بدون مرفقات"} • ${question.type === "mcq" ? "4 اختيارات" : "صح / خطأ"}
          </div>
        </div>
      `).join("") : `
        <div class="muted-note">هذا البنك ما زال فارغًا. أضف إليه أسئلة من صفحة البنوك أولًا.</div>
      `}
    </div>
  `;
}

function selectImportBank(bankId) {
  selectedImportBankId = bankId;
  renderBankImportSection();
}

async function addQuestionFromBank(bankId, questionId) {
  try {
    await ensureAdminAccess();

    const payload = await requestServerJson(`/api/admin/question-banks/${encodeURIComponent(bankId)}/import`, {
      method: "POST",
      body: JSON.stringify({
        questionIds: [questionId]
      })
    });

    const importedQuestions = normalizeQuestions(payload.questions);

    if (!importedQuestions.length) {
      return;
    }

    questions.push(...importedQuestions);
    renderQuestions();
  } catch (error) {
    alert(mapFirebaseError(error, "تعذر استيراد السؤال من بنك الأسئلة."));
  }
}

async function addAllQuestionsFromBank(bankId) {
  try {
    await ensureAdminAccess();

    const payload = await requestServerJson(`/api/admin/question-banks/${encodeURIComponent(bankId)}/import`, {
      method: "POST",
      body: JSON.stringify({})
    });

    const importedQuestions = normalizeQuestions(payload.questions);

    if (!importedQuestions.length) {
      return;
    }

    questions.push(...importedQuestions);
    renderQuestions();
  } catch (error) {
    alert(mapFirebaseError(error, "تعذر استيراد أسئلة البنك."));
  }
}

function resetBankEditor(createStarterQuestion = true) {
  activeBankId = null;
  activeBankUpdatedAt = 0;
  bankQuestions = [];
  bankQuestionCounter = 0;

  document.getElementById("qb-name").value = "";
  document.getElementById("qb-description").value = "";
  document.getElementById("qb-editor-title").textContent = "بنك جديد";
  document.getElementById("qb-editor-subtitle").textContent = "اكتب اسم البنك ثم أضف إليه الأسئلة التي تريد الرجوع إليها لاحقًا.";
  document.getElementById("qb-delete-btn").style.display = "none";
  hideErr("qb-err");
  hideBankNote();

  if (createStarterQuestion) {
    bankQuestions.push(createEmptyQuestion("mcq", createBankQuestionId));
  }

  renderBankList();
  renderBankQuestions();
  logQuestionBankDebug("reset-bank-editor", {
    createStarterQuestion,
    activeBankId,
    bankQuestionCount: bankQuestions.length
  });
}

function openBankEditor(bankId) {
  const bank = getBankById(bankId);

  if (!bank) {
    logQuestionBankDebug("open-bank-editor-missing-bank", {
      bankId,
      knownBankIds: questionBanks.map((item) => item.id),
      activeBankId
    });
    return;
  }

  activeBankId = bank.id;
  activeBankUpdatedAt = Number(bank.updatedAt || bank.createdAt || 0);
  bankQuestionCounter = 0;
  bankQuestions = bank.questions.map((question) => ({
    ...createEmptyQuestion(question.type, createBankQuestionId),
    text: question.text,
    options: [...question.options],
    correct: question.correct,
    attachment: normalizeAttachment(question.attachment),
    difficulty: normalizeDifficulty(question.difficulty)
  }));

  document.getElementById("qb-name").value = bank.title;
  document.getElementById("qb-description").value = bank.description || "";
  document.getElementById("qb-editor-title").textContent = bank.title;
  document.getElementById("qb-editor-subtitle").textContent = `${bank.questionCount} سؤال • ${buildDifficultySummary(bank.questions)}`;
  document.getElementById("qb-delete-btn").style.display = "inline-flex";
  hideErr("qb-err");
  hideBankNote();

  renderBankList();
  renderBankQuestions();
  logQuestionBankDebug("open-bank-editor", {
    bankId: bank.id,
    title: bank.title,
    bankQuestionCount: bank.questions.length,
    activeBankUpdatedAt
  });
}

function renderBankList() {
  const container = document.getElementById("qb-list");

  if (!container) {
    return;
  }

  if (!questionBanks.length) {
    container.innerHTML = `
      <div class="muted-note">
        لم يتم إنشاء أي بنك بعد. ابدأ ببنك النصوص أو بنك النحو ثم أضف أسئلتك إليه.
      </div>
    `;
    return;
  }

  container.innerHTML = questionBanks.map((bank) => `
    <div class="bank-item ${bank.id === activeBankId ? "active" : ""}" onclick="openBankEditor('${bank.id}')">
      <div class="bank-item-title">${escapeHtml(bank.title)}</div>
      <div class="bank-item-meta">
        ${escapeHtml(bank.description || "بدون وصف")}
        <br>
        ${bank.questionCount} سؤال • ${escapeHtml(buildDifficultySummary(bank.questions))}
      </div>
    </div>
  `).join("");
}

function addBankQuestion(type) {
  const question = createEmptyQuestion(type, createBankQuestionId);
  bankQuestions.push(question);
  renderBankQuestions();

  setTimeout(() => {
    const field = document.getElementById(`bqt-${question.id}`);
    if (field) {
      field.focus();
    }
  }, 100);
}

function removeBankQuestion(id) {
  bankQuestions = bankQuestions.filter((question) => question.id !== id);
  renderBankQuestions();
}

function renderBankQuestions() {
  const container = document.getElementById("qb-questions");

  if (!container) {
    return;
  }

  if (!bankQuestions.length) {
    container.innerHTML = `
      <div class="muted-note" style="margin-top:14px">
        هذا البنك لا يحتوي أسئلة بعد. أضف سؤالًا واحدًا على الأقل حتى يظهر هنا.
      </div>
    `;
    return;
  }

  container.innerHTML = bankQuestions.map((question, index) => `
    <div class="card" style="margin-bottom:18px;border:2px solid ${question.correct >= 0 ? "var(--gold)" : "var(--cd)"}">
      <div class="flex-between" style="margin-bottom:16px">
        <div style="font-weight:800;color:var(--gd);font-size:15px">
          سؤال البنك ${index + 1}
          <span class="badge badge-gold" style="margin-right:8px">${question.type === "mcq" ? "اختياري" : "صح / خطأ"}</span>
          <span class="badge ${getDifficultyBadgeClass(question.difficulty)}">${getDifficultyLabel(question.difficulty)}</span>
          ${question.correct >= 0 ? '<span class="badge badge-green">✓ مكتمل</span>' : '<span class="badge badge-red">! ناقص</span>'}
        </div>
        <button class="btn btn-sm btn-red" onclick="removeBankQuestion('${question.id}')">حذف</button>
      </div>

      <div class="difficulty-row">
        <div style="color:var(--tm);font-size:13px;line-height:1.8">
          هذا السؤال سيكون مرجعًا متاحًا عند إنشاء الامتحانات الجديدة.
        </div>
        <div class="inp-wrap difficulty-select" style="margin-bottom:0">
          <label class="label">درجة الصعوبة</label>
          <select class="inp" onchange="bankQSetDifficulty('${question.id}', this.value)">
            ${buildDifficultyOptions(question.difficulty)}
          </select>
        </div>
      </div>

      <div class="inp-wrap">
        <label class="label">نص السؤال</label>
        <textarea class="inp" id="bqt-${question.id}" rows="2" placeholder="اكتب السؤال هنا..." oninput="bankQSetText('${question.id}', this.value)">${escapeHtml(question.text)}</textarea>
      </div>

      <div class="attachment-editor">
        <div class="attachment-editor-head">
          <span class="label" style="margin-bottom:0">إرفاق صورة أو ملف اختياري</span>
          <span class="attachment-hint">الحد الأقصى ${humanFileSize(QUESTION_ATTACHMENT_MAX_SIZE)}</span>
        </div>
        <div class="attachment-actions">
          <label class="btn btn-outline btn-sm file-picker-btn">
            رفع مرفق
            <input type="file" accept="${QUESTION_ATTACHMENT_ACCEPT}" onchange="bankQUploadAttachment('${question.id}', this)">
          </label>
          ${question.attachment ? `<button class="btn btn-sm btn-red" onclick="bankQRemoveAttachment('${question.id}')">حذف المرفق</button>` : ""}
        </div>
        ${question.attachment ? renderQuestionAttachment(question.attachment, { compact: true }) : '<div class="attachment-placeholder">لا يوجد مرفق لهذا السؤال.</div>'}
      </div>

      <div style="font-weight:700;color:var(--gm);font-size:13px;margin-bottom:10px">اختر الإجابة الصحيحة من الزر الجانبي.</div>
      ${question.type === "mcq" ? question.options.map((option, optionIndex) => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <button
            onclick="bankQSetCorrect('${question.id}', ${optionIndex})"
            title="حدد كإجابة صحيحة"
            style="min-width:36px;height:36px;border-radius:50%;border:2px solid ${question.correct === optionIndex ? "var(--gm)" : "var(--cd)"};
            background:${question.correct === optionIndex ? "var(--gm)" : "#fff"};color:${question.correct === optionIndex ? "#fff" : "var(--tm)"};
            font-weight:800;font-size:14px;cursor:pointer;transition:all .2s;flex-shrink:0"
          >
            ${MCQ_LABELS[optionIndex]}
          </button>
          <input
            class="inp"
            style="flex:1"
            placeholder="اكتب الاختيار ${MCQ_LABELS[optionIndex]}"
            value="${escapeHtml(option)}"
            oninput="bankQSetOption('${question.id}', ${optionIndex}, this.value)"
          />
        </div>
      `).join("") : `
        <div style="display:flex;gap:14px">
          ${TF_LABELS.map((option, optionIndex) => `
            <button
              onclick="bankQSetCorrect('${question.id}', ${optionIndex})"
              style="flex:1;padding:12px;border-radius:10px;border:2px solid ${question.correct === optionIndex ? "var(--gm)" : "var(--cd)"};
              background:${question.correct === optionIndex ? "var(--gm)" : "#fff"};color:${question.correct === optionIndex ? "#fff" : "var(--td)"};
              font-size:17px;font-weight:800;cursor:pointer;transition:all .2s"
            >
              ${question.correct === optionIndex ? "✓ " : ""}${option}
            </button>
          `).join("")}
        </div>
      `}
    </div>
  `).join("");
}

function bankQSetText(id, value) {
  const question = bankQuestions.find((item) => item.id === id);
  if (question) {
    question.text = value;
  }
}

function bankQSetOption(id, optionIndex, value) {
  const question = bankQuestions.find((item) => item.id === id);
  if (question) {
    question.options[optionIndex] = value;
  }
}

function bankQSetCorrect(id, optionIndex) {
  const question = bankQuestions.find((item) => item.id === id);
  if (question) {
    question.correct = optionIndex;
    renderBankQuestions();
  }
}

function bankQSetDifficulty(id, value) {
  const question = bankQuestions.find((item) => item.id === id);
  if (question) {
    question.difficulty = normalizeDifficulty(value);
    renderBankQuestions();
  }
}

async function bankQUploadAttachment(id, input) {
  const file = input.files?.[0];

  if (!file) {
    return;
  }

  if (!isSupportedAttachmentFile(file)) {
    alert("الملف غير مدعوم. استخدم صورة أو PDF أو ملفًا مكتبيًا صغير الحجم.");
    input.value = "";
    return;
  }

  if (file.size > QUESTION_ATTACHMENT_MAX_SIZE) {
    alert(`حجم الملف أكبر من المسموح. الحد الأقصى هو ${humanFileSize(QUESTION_ATTACHMENT_MAX_SIZE)}.`);
    input.value = "";
    return;
  }

  try {
    const question = bankQuestions.find((item) => item.id === id);

    if (!question) {
      return;
    }

    await deleteTemporaryAttachment(question.attachment);
    question.attachment = await uploadAttachmentToServer(file);
    renderBankQuestions();
  } catch (error) {
    alert(error.message || "تعذر رفع الملف.");
  } finally {
    input.value = "";
  }
}

async function bankQRemoveAttachment(id) {
  const question = bankQuestions.find((item) => item.id === id);

  if (!question) {
    return;
  }

  await deleteTemporaryAttachment(question.attachment);
  question.attachment = null;
  renderBankQuestions();
}

async function loadQuestionBanksPage() {
  await loadQuestionBanks();

  if (activeBankId && getBankById(activeBankId)) {
    logQuestionBankDebug("load-bank-page-reopen-active", {
      activeBankId
    });
    openBankEditor(activeBankId);
    return;
  }

  if (questionBanks.length) {
    logQuestionBankDebug("load-bank-page-fallback-first", {
      previousActiveBankId: activeBankId,
      fallbackBankId: questionBanks[0].id
    });
    openBankEditor(questionBanks[0].id);
    return;
  }

  resetBankEditor(true);
}

async function saveQuestionBank() {
  const name = document.getElementById("qb-name").value.trim();
  const description = document.getElementById("qb-description").value.trim();
  const err = document.getElementById("qb-err");
  const saveButton = document.getElementById("qb-save-btn");

  hideErr("qb-err");
  hideBankNote();

  if (isQuestionBankSaving) {
    logQuestionBankDebug("save-question-bank-skipped-duplicate", {
      activeBankId,
      bankQuestionCount: bankQuestions.length
    });
    return;
  }

  if (!name) {
    showErr(err, "اكتب اسم البنك أولًا.");
    return;
  }

  if (!bankQuestions.length) {
    showErr(err, "أضف سؤالًا واحدًا على الأقل داخل البنك.");
    return;
  }

  for (let index = 0; index < bankQuestions.length; index += 1) {
    const question = bankQuestions[index];

    if (!question.text.trim()) {
      showErr(err, `أدخل نص سؤال البنك ${index + 1}.`);
      return;
    }

    if (question.correct < 0) {
      showErr(err, `حدد الإجابة الصحيحة لسؤال البنك ${index + 1}.`);
      return;
    }

    if (question.type === "mcq" && question.options.some((option) => !option.trim())) {
      showErr(err, `أدخل جميع اختيارات سؤال البنك ${index + 1}.`);
      return;
    }
  }

  try {
    isQuestionBankSaving = true;
    setButtonLoading(saveButton, true, "جارٍ حفظ البنك...");
    await ensureAdminAccess();
    const sanitizedQuestions = sanitizeQuestionList(bankQuestions).map((question) => ({
      id: question.id,
      type: question.type,
      text: question.text,
      options: question.options,
      correct: question.correct,
      attachment: question.attachment || null,
      difficulty: question.difficulty
    }));
    const debugRequestId = createClientDebugId(activeBankId ? "qb-update" : "qb-create");
    const editorBank = activeBankId ? getBankById(activeBankId) : null;
    const method = activeBankId ? "PATCH" : "POST";
    const endpoint = activeBankId
      ? `/api/admin/question-banks/${encodeURIComponent(activeBankId)}`
      : "/api/admin/question-banks";
    logQuestionBankDebug("save-question-bank-request", {
      debugRequestId,
      method,
      endpoint,
      activeBankId,
      activeBankUpdatedAt,
      editorBankQuestionCount: editorBank?.questionCount ?? null,
      payloadQuestionCount: sanitizedQuestions.length,
      payloadQuestionIds: sanitizedQuestions.map((question) => question.id),
      payloadQuestions: summarizeBankQuestions(sanitizedQuestions)
    });
    const payload = await requestServerJson(endpoint, {
      method,
      body: JSON.stringify({
        debugRequestId,
        expectedUpdatedAt: activeBankUpdatedAt,
        title: name,
        description,
        questions: sanitizedQuestions
      })
    });
    const savedBankId = payload.bank?.id || activeBankId;

    await loadQuestionBanks();
    activeBankId = savedBankId;
    openBankEditor(savedBankId);
    renderBankImportSection();
    logQuestionBankDebug("save-question-bank-success", {
      debugRequestId,
      savedBankId,
      returnedQuestionCount: payload.bank?.questionCount ?? null,
      activeBankUpdatedAt
    });
    showBankNote("تم حفظ البنك بنجاح.");
  } catch (error) {
    logQuestionBankDebug("save-question-bank-error", {
      activeBankId,
      activeBankUpdatedAt,
      bankQuestionCount: bankQuestions.length,
      message: error?.message || String(error)
    });
    showErr(err, mapFirebaseError(error, "تعذر حفظ بنك الأسئلة."));
  } finally {
    isQuestionBankSaving = false;
    setButtonLoading(saveButton, false);
  }
}

async function deleteQuestionBank() {
  if (!activeBankId) {
    return;
  }

  if (isQuestionBankDeleting) {
    logQuestionBankDebug("delete-question-bank-skipped-duplicate", {
      activeBankId
    });
    return;
  }

  const confirmed = confirm("هل أنت متأكد من حذف هذا البنك؟ سيتم حذف كل أسئلته من المرجع.");

  if (!confirmed) {
    return;
  }

  try {
    isQuestionBankDeleting = true;
    setButtonLoading("qb-delete-btn", true, "جارٍ حذف البنك...");
    await ensureAdminAccess();
    const deletedId = activeBankId;
    const debugRequestId = createClientDebugId("qb-delete");
    const deletingBank = getBankById(deletedId);
    logQuestionBankDebug("delete-question-bank-request", {
      debugRequestId,
      deletedId,
      title: deletingBank?.title || "",
      questionCount: deletingBank?.questionCount ?? null
    });
    await requestServerJson(`/api/admin/question-banks/${encodeURIComponent(deletedId)}`, {
      method: "DELETE",
      body: JSON.stringify({
        debugRequestId
      })
    });

    if (selectedImportBankId === deletedId) {
      selectedImportBankId = "";
    }

    await loadQuestionBanks();
    renderBankImportSection();

    if (questionBanks.length) {
      openBankEditor(questionBanks[0].id);
    } else {
      resetBankEditor(true);
    }

    showBankNote("تم حذف البنك بنجاح.");
    logQuestionBankDebug("delete-question-bank-success", {
      debugRequestId,
      deletedId,
      remainingBankIds: questionBanks.map((bank) => bank.id)
    });
  } catch (error) {
    logQuestionBankDebug("delete-question-bank-error", {
      activeBankId,
      message: error?.message || String(error)
    });
    showErr(document.getElementById("qb-err"), mapFirebaseError(error, "تعذر حذف بنك الأسئلة."));
  } finally {
    isQuestionBankDeleting = false;
    setButtonLoading("qb-delete-btn", false);
  }
}

async function saveExam() {
  const title = document.getElementById("ce-title").value.trim();
  const code = sanitizeCode(document.getElementById("ce-code").value);
  const duration = Number.parseInt(document.getElementById("ce-dur").value, 10) || 30;
  const err = document.getElementById("ce-err");

  hideErr("ce-err");

  if (!title) {
    showErr(err, "أدخل عنوان الامتحان.");
    return;
  }

  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) {
    showErr(err, "كود الامتحان يجب أن يكون من حرفين إلى 20 حرفًا أو رقمًا بدون مسافات.");
    return;
  }

  if (!questions.length) {
    showErr(err, "أضف سؤالًا واحدًا على الأقل، سواء من البنك أو من عندك.");
    return;
  }

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];

    if (!question.text.trim()) {
      showErr(err, `أدخل نص السؤال ${index + 1}.`);
      return;
    }

    if (question.correct < 0) {
      showErr(err, `حدد الإجابة الصحيحة للسؤال ${index + 1}.`);
      return;
    }

    if (question.type === "mcq" && question.options.some((option) => !option.trim())) {
      showErr(err, `أدخل جميع اختيارات السؤال ${index + 1}.`);
      return;
    }
  }

  try {
    await ensureAdminAccess();

    const payloadQuestions = sanitizeQuestionList(questions);
    await requestServerJson("/api/admin/exams", {
      method: "POST",
      body: JSON.stringify({
        title,
        code,
        duration,
        questions: payloadQuestions
      })
    });

    await loadAdminDashboard();
    showPage("pg-admindash");
  } catch (error) {
    showErr(err, mapFirebaseError(error, "تعذر حفظ الامتحان."));
  }
}

async function toggleExam(id) {
  try {
    await ensureAdminAccess();

    const selectedExam = exams.find((item) => item.id === id);

    if (!selectedExam) {
      throw new Error("الامتحان غير موجود.");
    }

    await requestServerJson(`/api/admin/exams/${encodeURIComponent(id)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ active: !selectedExam.active })
    });

    await loadAdminDashboard();
    return;
  } catch (error) {
    alert(mapFirebaseError(error, "تعذر تحديث حالة الامتحان."));
  }
}

async function deleteExam(id) {
  const confirmed = confirm("هل أنت متأكد من حذف هذا الامتحان نهائيًا؟ سيتم حذف جميع تسليماته أيضًا.");

  if (!confirmed) {
    return;
  }

  try {
    await ensureAdminAccess();

    await requestServerJson(`/api/admin/exams/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });

    await loadAdminDashboard();
    return;
  } catch (error) {
    alert(mapFirebaseError(error, "تعذر حذف الامتحان."));
  }
}

async function viewResults(id) {
  try {
    await ensureAdminAccess();

    const data = await requestServerJson(`/api/admin/exams/${encodeURIComponent(id)}/results`, {
      method: "GET"
    });

    renderAdminResults(
      {
        ...data.exam,
        id,
        questions: normalizeQuestions(data.exam?.questions)
      },
      data.results || [],
      data.correctAnswers || []
    );
    showPage("pg-adminresults");
    return;
  } catch (error) {
    alert(mapFirebaseError(error, "تعذر تحميل النتائج."));
  }
}

async function publishExamResults() {
  const exam = adminResultsState.exam;
  const results = adminResultsState.results || [];

  if (!exam) {
    alert("افتح نتائج الامتحان أولًا ثم انشرها للطلاب.");
    return;
  }

  if (!results.length) {
    alert("لا توجد نتائج منشورة لهذا الامتحان بعد.");
    return;
  }

  try {
    await ensureAdminAccess();

    await requestServerJson(`/api/admin/exams/${encodeURIComponent(exam.id)}/publish-results`, {
      method: "POST",
      body: JSON.stringify({})
    });

    alert("Results were published successfully. Students can now check their result using the exam code and tracking token.");
    return;
  } catch (error) {
    alert(mapFirebaseError(error, "تعذر نشر النتائج للطلاب."));
  }
}

function buildAdminReviewMarkup(exam, result, options = {}) {
  const {
    printable = false
  } = options;
  const metaColor = printable ? "#666" : "var(--tm)";
  const textColor = printable ? "#1a1a1a" : "var(--td)";
  const wrongColor = printable ? "#c0392b" : "var(--red)";

  return exam.questions.map((question, index) => {
    const studentAnswer = result.answers[index];
    const correctAnswer = exam.correctAnswers[index];
    const isCorrect = studentAnswer === correctAnswer;
    const attachmentHtml = question.attachment
      ? renderQuestionAttachment(question.attachment, { allowDownload: !printable, compact: printable })
      : "";

    return `
      <div class="${printable ? "print-card print-question" : "card"}" style="${printable ? "" : `margin-bottom:14px;border-right:5px solid ${isCorrect ? "#2e7d32" : "var(--red)"}`};">
        <div style="font-weight:700;font-size:12px;color:${metaColor};margin-bottom:8px">
          السؤال ${index + 1} —
          ${isCorrect ? '<span style="color:#2e7d32">✅ إجابة صحيحة</span>' : `<span style="color:${wrongColor}">❌ إجابة خاطئة</span>`}
        </div>
        <div style="font-size:16px;font-weight:700;color:${textColor};margin-bottom:14px;font-family:'Amiri',serif;line-height:1.8">${escapeHtml(question.text)}</div>
        ${attachmentHtml}
        ${question.options.map((option, optionIndex) => `
          <div class="${printable ? "print-option" : ""} ${optionIndex === correctAnswer ? "correct" : optionIndex === studentAnswer && studentAnswer !== correctAnswer ? "wrong" : ""}" style="${printable ? "" : `
            display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;margin-bottom:6px;
            background:${optionIndex === correctAnswer ? "#e8f5e9" : optionIndex === studentAnswer && studentAnswer !== correctAnswer ? "#fde8e8" : "transparent"};
            border:1.5px solid ${optionIndex === correctAnswer ? "#2e7d32" : optionIndex === studentAnswer && studentAnswer !== correctAnswer ? "var(--red)" : "var(--cd)"};
            font-weight:${optionIndex === correctAnswer || optionIndex === studentAnswer ? "700" : "400"}`
          }">
            <span style="font-size:13px">${getQuestionOptionMarker(question.type, optionIndex)}</span>
            <span style="flex:1;font-size:14px;color:${optionIndex === correctAnswer ? "#1b5e20" : optionIndex === studentAnswer && studentAnswer !== correctAnswer ? wrongColor : textColor}">${escapeHtml(option)}</span>
            ${optionIndex === correctAnswer ? '<span style="font-size:11px;color:#2e7d32;font-weight:800">← الصحيحة</span>' : ""}
            ${optionIndex === studentAnswer && studentAnswer !== correctAnswer ? `<span style="font-size:11px;color:${wrongColor};font-weight:800">← إجابة الطالب</span>` : ""}
          </div>
        `).join("")}
      </div>
    `;
  }).join("");
}

function renderAdminResults(exam, results, correctAnswers) {
  document.getElementById("ar-title").textContent = `📊 ${exam.title}`;
  document.getElementById("ar-subtitle").textContent = `${results.length} طالب متقدم`;

  const average = results.length
    ? Math.round(results.reduce((sum, item) => sum + item.pct, 0) / results.length)
    : 0;
  const passed = results.filter((item) => item.pct >= 50).length;

  document.getElementById("ar-stats").innerHTML = `
    <div class="stat-card"><div class="stat-num">${results.length}</div><div class="stat-lbl">عدد الطلاب</div></div>
    <div class="stat-card"><div class="stat-num">${average}%</div><div class="stat-lbl">متوسط الدرجات</div></div>
    <div class="stat-card"><div class="stat-num">${passed}</div><div class="stat-lbl">ناجح (50%+)</div></div>
  `;
  document.getElementById("ar-charts").innerHTML = buildExamResultsCharts(results);

  adminResultsState = {
    exam: {
      ...exam,
      correctAnswers
    },
    byId: Object.fromEntries(results.map((item) => [item.id, item])),
    results
  };

  document.getElementById("ar-list").innerHTML = results.length ? results.map((item, index) => `
    <div class="exam-card">
      <div class="flex-between" style="margin-bottom:12px">
        <div>
          <div style="font-weight:800;color:var(--td);font-size:16px">${index + 1}. ${escapeHtml(item.studentName)} ${item.pct >= 80 ? '<span class="badge badge-green" style="margin-right:8px">متفوق</span>' : ""}</div>
          <div style="font-size:12px;color:var(--tm);margin-top:4px">🏫 ${escapeHtml(item.studentGroup)}</div>
          <div style="font-size:12px;color:var(--tm);margin-top:4px">📅 ${formatDate(item.at)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:28px;font-weight:900;color:${getScoreColor(item.pct)}">${item.pct}%</div>
          <div style="font-size:13px;color:var(--tm)">${item.score} من ${item.total}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm btn-gold" onclick="openAdminReview('${item.id}')">📖 مراجعة الإجابات</button>
        ${item.pct >= 80 ? `<button class="btn btn-sm btn-outline" onclick="printExcellenceCertificate('${item.id}')">🏆 طباعة شهادة</button>` : ""}
      </div>
    </div>
  `).join("") : '<div class="empty-state">لا توجد نتائج بعد.</div>';
}

function openAdminReview(resultId) {
  const result = adminResultsState.byId[resultId];
  const exam = adminResultsState.exam;

  if (!result || !exam) {
    return;
  }

  currentAdminReviewId = resultId;
  document.getElementById("admin-review-title").textContent = result.studentName;
  document.getElementById("admin-review-subtitle").textContent = `${result.studentGroup} — ${result.score} من ${result.total} — ${result.pct}%`;
  document.getElementById("admin-review-content").innerHTML = buildAdminReviewMarkup(exam, result);
  document.getElementById("admin-certificate-btn").style.display = result.pct >= 80 ? "inline-flex" : "none";

  document.getElementById("admin-review-modal").style.display = "flex";
}

function closeAdminReview() {
  currentAdminReviewId = null;
  document.getElementById("admin-certificate-btn").style.display = "none";
  document.getElementById("admin-review-modal").style.display = "none";
}

async function homeEnter() {
  const name = document.getElementById("h-name").value.trim();
  const group = document.getElementById("h-group").value.trim();
  const rawCode = document.getElementById("h-code").value;
  const code = rawCode.trim() ? sanitizeCode(rawCode) : "";
  const err = document.getElementById("h-err");
  const actionButton = document.getElementById("h-enter-btn");

  if (!name) {
    showErr(err, "من فضلك أدخل اسم الطالب كاملًا.");
    return;
  }

  if (!group) {
    showErr(err, "من فضلك أدخل الفصل أو المجموعة.");
    return;
  }

  if (!linkedExam && !code) {
    showErr(err, "من فضلك أدخل كود الامتحان.");
    return;
  }

  hideErr("h-err");
  setButtonLoading(actionButton, true, "جارٍ تجهيز الامتحان...");

  try {
    let resolvedExamId = linkedExam?.id || "";

    if (!resolvedExamId) {
      const accessPayload = await requestServerJson("/api/student/exam-access", {
        method: "POST",
        body: JSON.stringify({ code })
      });

      if (!accessPayload?.exam?.id) {
        throw new Error("كود الامتحان غير صحيح أو الامتحان مغلق الآن.");
      }

      linkedExam = {
        ...accessPayload.exam,
        questions: new Array(Number(accessPayload.exam.questionCount || 0))
      };
      resolvedExamId = accessPayload.exam.id;
    }

    const startPayload = await requestServerJson(`/api/student/exams/${encodeURIComponent(resolvedExamId)}/start`, {
      method: "POST",
      body: JSON.stringify({
        studentName: name,
        studentGroup: group
      })
    });

    hideErr("h-err");
    currentAttemptToken = startPayload.attemptToken || "";
    currentExam = {
      ...startPayload.exam,
      questions: normalizeQuestions(startPayload.exam?.questions)
    };
    currentStudent = startPayload.studentName || name;
    currentStudentGroup = startPayload.studentGroup || group;
    startExam();
    return;
  } catch (error) {
    showErr(err, mapFirebaseError(error, "تعذر فتح الامتحان."));
  } finally {
    setButtonLoading(actionButton, false);
  }
}

function startExam() {
  // استعادة الإجابات المحفوظة محلياً إن وجدت
  loadAutoSavedAnswers();
  
  // إذا لم توجد إجابات محفوظة، ابدأ بأسئلة جديدة
  if (studentAnswers.length === 0) {
    studentAnswers = new Array(currentExam.questions.length).fill(-1);
  }
  
  currentSubmissionReceipt = null;
  cheatWarnings = 0;
  mouseOutWarningShown = false;
  examTotalTime = currentExam.duration * 60;
  examTimeLeft = examTotalTime;

  document.getElementById("ex-title").textContent = currentExam.title;
  document.getElementById("ex-student").textContent = `👤 ${currentStudent} • ${currentStudentGroup}`;

  closeWarnModal();
  document.getElementById("submit-modal").style.display = "none";

  renderExamQuestions();
  updateExamProgress();
  updateTimerDisplay();

  clearInterval(examTimerInterval);
  examTimerInterval = setInterval(tickTimer, 1000);

  // بدء الحفظ التلقائي كل 30 ثانية
  clearInterval(examAutoSaveInterval);
  examAutoSaveInterval = setInterval(autoSaveAnswers, 30000);

  setupAntiCheat();
  setupHistoryBackGuard();
  showPage("pg-exam");
}

function renderExamQuestions() {
  document.getElementById("ex-questions").innerHTML = currentExam.questions.map((question, questionIndex) => `
    <div class="q-card" id="qc-${questionIndex}">
      <div style="font-weight:700;color:var(--tl);font-size:13px;margin-bottom:8px">السؤال ${questionIndex + 1} من ${currentExam.questions.length}</div>
      <div style="font-size:17px;font-weight:700;color:var(--td);margin-bottom:18px;font-family:'Amiri',serif;line-height:1.8">${escapeHtml(question.text)}</div>
      ${question.attachment ? renderQuestionAttachment(question.attachment) : ""}
      <div id="opts-${questionIndex}">
        ${question.options.map((option, optionIndex) => `
          <button class="option-btn" id="opt-${questionIndex}-${optionIndex}" onclick="selectAnswer(${questionIndex}, ${optionIndex})">
            <span style="background:var(--cd);border-radius:50%;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0">
              ${getQuestionOptionMarker(question.type, optionIndex)}
            </span>
            <span>${escapeHtml(option)}</span>
          </button>
        `).join("")}
      </div>
    </div>
  `).join("");
}

function selectAnswer(questionIndex, optionIndex) {
  studentAnswers[questionIndex] = optionIndex;
  document
    .querySelectorAll(`#opts-${questionIndex} .option-btn`)
    .forEach((button, index) => button.classList.toggle("selected", index === optionIndex));
  document.getElementById(`qc-${questionIndex}`).classList.add("answered");
  updateExamProgress();
  // حفظ فوري عند تحديد الإجابة
  autoSaveAnswers();
}

function autoSaveAnswers() {
  if (!currentExam || !Array.isArray(studentAnswers)) {
    return;
  }

  try {
    const saveData = {
      examId: currentExam.id,
      studentName: currentStudent,
      studentGroup: currentStudentGroup,
      answers: studentAnswers,
      savedAt: Date.now(),
      timeLeft: examTimeLeft
    };
    localStorage.setItem("exam_autosave", JSON.stringify(saveData));
    
    // عرض مؤشر حفظ سريع
    const saveIndicator = document.getElementById("ex-save-indicator");
    if (saveIndicator) {
      saveIndicator.style.opacity = "1";
      setTimeout(() => {
        saveIndicator.style.opacity = "0";
      }, 2000);
    }
  } catch (error) {
    console.warn("فشل الحفظ التلقائي:", error);
  }
}

function loadAutoSavedAnswers() {
  try {
    const saved = localStorage.getItem("exam_autosave");
    if (!saved) {
      return;
    }

    const saveData = JSON.parse(saved);
    
    // التحقق من أن الحفظ للامتحان الحالي
    if (saveData.examId === currentExam.id && 
        saveData.studentName === currentStudent &&
        Array.isArray(saveData.answers) &&
        saveData.answers.length === currentExam.questions.length) {
      studentAnswers = [...saveData.answers];
      console.log("✅ تم استعادة الإجابات المحفوظة");
    } else {
      localStorage.removeItem("exam_autosave");
    }
  } catch (error) {
    console.warn("فشل استعادة الحفظ التلقائي:", error);
    localStorage.removeItem("exam_autosave");
  }
}

function clearAutoSavedAnswers() {
  try {
    localStorage.removeItem("exam_autosave");
  } catch (error) {
    console.warn("فشل حذف الحفظ التلقائي:", error);
  }
}

function updateExamProgress() {
  const answered = studentAnswers.filter((answer) => answer >= 0).length;
  const total = currentExam.questions.length;

  document.getElementById("ex-progress-txt").textContent = `📝 ${total} سؤال`;
  document.getElementById("ex-answered-txt").textContent = `✅ ${answered} مجاب من ${total}`;
  document.getElementById("ex-progressbar").style.width = `${(answered / total) * 100}%`;
}

function updateTimerDisplay() {
  const minutes = Math.floor(Math.max(0, examTimeLeft) / 60);
  const seconds = Math.max(0, examTimeLeft) % 60;
  const percent = examTotalTime ? examTimeLeft / examTotalTime : 0;
  const timerBar = document.getElementById("ex-timerbar");

  document.getElementById("ex-timer").textContent = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  timerBar.style.width = `${Math.max(0, percent * 100)}%`;
  timerBar.className = `timer-fill${percent < 0.25 ? " danger" : percent < 0.5 ? " warn" : ""}`;
}

function tickTimer() {
  examTimeLeft -= 1;
  updateTimerDisplay();

  if (examTimeLeft <= 0) {
    clearInterval(examTimerInterval);
    submitExam();
  }
}

function blockRightClick(event) {
  event.preventDefault();
}

function blockKeys(event) {
  if (event.ctrlKey && ["c", "v", "u", "s", "p", "a", "i"].includes(event.key.toLowerCase())) {
    event.preventDefault();
  }

  if (["F12", "F11", "F10"].includes(event.key)) {
    event.preventDefault();
  }
}

function detectMouseOut(event) {
  if (!document.getElementById("pg-exam").classList.contains("active")) {
    return;
  }

  const examContainer = document.getElementById("pg-exam");
  const rect = examContainer.getBoundingClientRect();
  
  // التحقق من أن الفأرة خارج منطقة الامتحان
  if (event.clientX < rect.left || 
      event.clientX > rect.right || 
      event.clientY < rect.top || 
      event.clientY > rect.bottom) {
    if (!mouseOutWarningShown) {
      mouseOutWarningShown = true;
      registerCheatWarning("⚠️ تم رصد محاولة مغادرة منطقة الامتحان.");
      setTimeout(() => {
        mouseOutWarningShown = false;
      }, 5000);
    }
  }
}

function blockCopy(event) {
  event.preventDefault();
}

function handleBeforeUnload(event) {
  if (!document.getElementById("pg-exam").classList.contains("active")) {
    return undefined;
  }

  event.preventDefault();
  event.returnValue = "";
  return "";
}

function registerCheatWarning(message) {
  cheatWarnings += 1;

  if (cheatWarnings >= 3) {
    clearInterval(examTimerInterval);
    teardownAntiCheat();
    submitExam();
    return;
  }

  document.getElementById("warn-msg").textContent = message;
  document.getElementById("warn-count-txt").textContent = `تحذير ${cheatWarnings} من 3 — تبقى ${3 - cheatWarnings} تحذير`;
  document.getElementById("warn-modal").style.display = "flex";
}

function detectTabSwitch() {
  if (!document.getElementById("pg-exam").classList.contains("active")) {
    return;
  }

  if (document.hidden) {
    registerCheatWarning("تم رصد مغادرة نافذة الامتحان.");
  }
}

function handleExamBackNavigation(event) {
  if (!document.getElementById("pg-exam").classList.contains("active")) {
    return;
  }

  if (!examBackGuardActive) {
    return;
  }

  history.pushState({ examGuard: Date.now() }, "", window.location.href);
  registerCheatWarning("محاولة الرجوع للخلف غير مسموحة أثناء الامتحان.");
}

function setupHistoryBackGuard() {
  if (examBackGuardActive) {
    return;
  }

  history.pushState({ examGuard: Date.now() }, "", window.location.href);
  window.addEventListener("popstate", handleExamBackNavigation);
  examBackGuardActive = true;
}

function teardownHistoryBackGuard() {
  if (!examBackGuardActive) {
    return;
  }

  window.removeEventListener("popstate", handleExamBackNavigation);
  examBackGuardActive = false;
}

function setupAntiCheat() {
  document.addEventListener("contextmenu", blockRightClick);
  document.addEventListener("keydown", blockKeys);
  document.addEventListener("copy", blockCopy);
  document.addEventListener("visibilitychange", detectTabSwitch);
  document.addEventListener("mousemove", detectMouseOut);
  window.addEventListener("beforeunload", handleBeforeUnload);
}

function teardownAntiCheat() {
  document.removeEventListener("contextmenu", blockRightClick);
  document.removeEventListener("keydown", blockKeys);
  document.removeEventListener("copy", blockCopy);
  document.removeEventListener("visibilitychange", detectTabSwitch);
  document.removeEventListener("mousemove", detectMouseOut);
  window.removeEventListener("beforeunload", handleBeforeUnload);
  teardownHistoryBackGuard();
}

function closeWarnModal() {
  document.getElementById("warn-modal").style.display = "none";
}

function confirmSubmit() {
  const answered = studentAnswers.filter((answer) => answer >= 0).length;
  const total = currentExam.questions.length;
  const unanswered = total - answered;

  document.getElementById("sub-msg").textContent = unanswered > 0
    ? `تنبيه: يوجد ${unanswered} سؤالًا لم تُجب عنه. هل تريد التسليم؟`
    : "أجبت على جميع الأسئلة. هل تريد التسليم الآن؟";
  document.getElementById("submit-modal").style.display = "flex";
}

async function submitExam() {
  document.getElementById("submit-modal").style.display = "none";
  clearInterval(examTimerInterval);
  clearInterval(examAutoSaveInterval);
  teardownAntiCheat();

  const answeredCount = studentAnswers.filter((answer) => answer >= 0).length;
  const receiptAt = Date.now();

  try {
    const payload = await requestServerJson(`/api/student/exams/${encodeURIComponent(currentExam.id)}/submit`, {
      method: "POST",
      body: JSON.stringify({
        studentName: currentStudent,
        studentGroup: currentStudentGroup,
        answers: studentAnswers,
        attemptToken: currentAttemptToken
      })
    });

    currentSubmissionReceipt = {
      ...(payload.receipt || {}),
      submittedAt: payload.receipt?.submittedAt || receiptAt,
      answeredCount: payload.receipt?.answeredCount ?? answeredCount,
      totalQuestions: payload.receipt?.totalQuestions ?? currentExam.questions.length,
      studentName: payload.receipt?.studentName || currentStudent,
      studentGroup: payload.receipt?.studentGroup || currentStudentGroup,
      examTitle: payload.receipt?.examTitle || currentExam.title
    };
    currentAttemptToken = "";

    clearAutoSavedAnswers();
    showSubmissionReceipt();
    return;
  } catch (error) {
    alert(mapFirebaseError(error, "تعذر تسليم الامتحان."));

    if (currentExam && document.getElementById("pg-exam").classList.contains("active")) {
      setupAntiCheat();

      if (examTimeLeft > 0) {
        clearInterval(examTimerInterval);
        examTimerInterval = setInterval(tickTimer, 1000);
        clearInterval(examAutoSaveInterval);
        examAutoSaveInterval = setInterval(autoSaveAnswers, 30000);
      }
    }
  }
}

function showSubmissionReceipt() {
  const receiptTotal = Number(currentSubmissionReceipt.totalQuestions || 0);
  const receiptScore = Number(currentSubmissionReceipt.score || 0);
  const receiptPct = Number(currentSubmissionReceipt.pct || 0);
  const receiptWrong = Math.max(0, receiptTotal - receiptScore);
  const receiptAnswered = Number(currentSubmissionReceipt.answeredCount || 0);
  const receiptPassed = receiptPct >= 50;
  const receiptStatus = currentSubmissionReceipt.status || (receiptPassed ? "????" : "?? ????");
  const receiptTrackingToken = currentSubmissionReceipt.trackingToken || currentSubmissionReceipt.submissionId || "??? ????";

  document.getElementById("res-heading").textContent = "?? ????? ????????";
  document.getElementById("res-circle").className = `score-circle ${receiptPassed ? "score-good" : "score-fail"}`;
  document.getElementById("res-pct").textContent = `${receiptPct}%`;
  document.getElementById("res-circle-subtitle").textContent = receiptStatus;
  document.getElementById("res-emoji").textContent = receiptPassed ? "??" : "??";
  document.getElementById("res-name").textContent = currentSubmissionReceipt.studentName || currentStudent;
  document.getElementById("res-exam-title").textContent = `${currentSubmissionReceipt.examTitle || currentExam.title} ? ${currentSubmissionReceipt.studentGroup || currentStudentGroup}`;
  document.getElementById("res-score").textContent = receiptScore;
  document.getElementById("res-wrong").textContent = receiptWrong;
  document.getElementById("res-total").textContent = receiptTotal;
  document.getElementById("res-score-label").textContent = "?????";
  document.getElementById("res-wrong-label").textContent = "?????";
  document.getElementById("res-total-label").textContent = "?????? ???????";
  document.getElementById("res-msg").textContent = `?? ??????? ??? ??????? ?????. ${receiptStatus} ? ??? ????????: ${receiptTrackingToken}`;
  document.getElementById("res-msg").style.overflowWrap = "anywhere";
  document.getElementById("res-review-title").textContent = "?????? ???????";
  document.getElementById("res-review").innerHTML = `
    <div class="card" style="margin-bottom:14px;border-right:5px solid var(--gold)">
      <div style="font-weight:800;color:var(--gd);margin-bottom:8px">? ?? ??????? ???????? ?????</div>
      <div style="color:var(--tm);font-size:14px;line-height:1.9">
        ????? / ????????: ${escapeHtml(currentSubmissionReceipt.studentGroup || currentStudentGroup)}
        <br>
        ??? ??????? ??????? ????: ${receiptAnswered} ?? ${receiptTotal}
        <br>
        ??? ???????: ${formatDate(currentSubmissionReceipt.submittedAt)}
        <br>
        ??? ????????:
        <span style="overflow-wrap:anywhere;word-break:break-word">${escapeHtml(receiptTrackingToken)}</span>
      </div>
    </div>
    <div class="card" style="margin-bottom:14px;border-right:5px solid var(--gm)">
      <div style="font-weight:800;color:var(--gd);margin-bottom:8px">?? ?????</div>
      <div style="color:var(--tm);font-size:14px;line-height:1.9">
        ?? ???? ??????? ??? ???????? ??? ??? ??? ???????? ?? ?????? ???? ??????.
      </div>
    </div>
  `;

  showPage("pg-results");
}

function printStudentReceipt() {
  if (!currentSubmissionReceipt) {
    return;
  }

  const receiptTotal = Number(currentSubmissionReceipt.totalQuestions || 0);
  const receiptScore = Number(currentSubmissionReceipt.score || 0);
  const receiptWrong = Math.max(0, receiptTotal - receiptScore);
  const receiptPct = Number(currentSubmissionReceipt.pct || 0);
  const receiptStatus = currentSubmissionReceipt.status || (receiptPct >= 50 ? "????" : "?? ????");
  const receiptTrackingToken = currentSubmissionReceipt.trackingToken || currentSubmissionReceipt.submissionId || "??? ????";

  openPrintWindow("????? ????? ????????", `
    <div class="print-card">
      <div style="font-size:20px;font-weight:800;margin-bottom:8px">${escapeHtml(currentSubmissionReceipt.studentName)}</div>
      <div style="color:#555;line-height:1.9">
        ????????: ${escapeHtml(currentSubmissionReceipt.examTitle)}
        <br>
        ????? / ????????: ${escapeHtml(currentSubmissionReceipt.studentGroup)}
        <br>
        ??? ???????: ${formatDate(currentSubmissionReceipt.submittedAt)}
        <br>
        ??? ????????: <span style="overflow-wrap:anywhere;word-break:break-word">${escapeHtml(receiptTrackingToken)}</span>
      </div>
      <div class="print-grid">
        <div class="print-stat"><strong>${receiptScore}</strong><span>??????</span></div>
        <div class="print-stat"><strong>${receiptWrong}</strong><span>?????</span></div>
        <div class="print-stat"><strong>${receiptPct}%</strong><span>${escapeHtml(receiptStatus)}</span></div>
      </div>
      <div style="color:#666;line-height:1.9">
        ?? ??????? ??? ???????? ??? ??? ??? ???????? ?? ?????? ???? ?? ??? ???????.
      </div>
    </div>
  `);
}

function renderPublishedResult(result) {
  const pct = Number(result?.pct || 0);
  const total = Number(result?.total || 0);
  const score = Number(result?.score || 0);
  const statusView = getPassStatus(pct);
  const statusLabel = sanitizePlainText(result?.status, statusView.label);

  currentPublishedResult = {
    examCode: String(result?.examCode || ""),
    examTitle: String(result?.examTitle || ""),
    studentName: String(result?.studentName || ""),
    studentGroup: String(result?.studentGroup || ""),
    score,
    total,
    pct,
    status: statusLabel,
    submittedAt: result?.submittedAt || null,
    publishedAt: result?.publishedAt || null,
    trackingToken: String(result?.trackingToken || "")
  };

  document.getElementById("sr-emoji").textContent = statusView.emoji;
  document.getElementById("sr-heading").textContent = "????? ??????";
  document.getElementById("sr-circle").className = `score-circle ${pct >= 50 ? "score-good" : "score-fail"}`;
  document.getElementById("sr-pct").textContent = `${pct}%`;
  document.getElementById("sr-circle-subtitle").textContent = statusLabel;
  document.getElementById("sr-name").textContent = currentPublishedResult.studentName;
  document.getElementById("sr-exam-title").textContent = `${currentPublishedResult.examTitle} ? ${currentPublishedResult.studentGroup}`;
  document.getElementById("sr-score").textContent = score;
  document.getElementById("sr-total").textContent = total;
  document.getElementById("sr-status").textContent = statusLabel;

  const publishedLabel = currentPublishedResult.publishedAt
    ? `?? ??? ??? ??????? ?? ${formatDate(currentPublishedResult.publishedAt)}.`
    : "?? ?????? ??? ??????? ?????? ??????.";
  const submittedLabel = currentPublishedResult.submittedAt
    ? `??? ???????: ${formatDate(currentPublishedResult.submittedAt)}.`
    : "";

  document.getElementById("sr-msg").textContent = `${publishedLabel} ${submittedLabel}`.trim();
  hideErr("rl-err");
  showPage("pg-studentresult");
}

async function lookupPublishedResult() {
  const codeInput = document.getElementById("rl-code");
  const tokenInput = document.getElementById("rl-token");
  const errorEl = document.getElementById("rl-err");
  const code = sanitizeCode(codeInput.value);
  const trackingToken = String(tokenInput.value || "").trim();

  hideErr("rl-err");

  if (!code) {
    showErr(errorEl, "أدخل كود الامتحان أولًا.");
    return;
  }

  if (!trackingToken) {
    showErr(errorEl, "أدخل رقم متابعة النتيجة.");
    return;
  }

  try {
    const payload = await requestServerJson("/api/student/results/lookup", {
      method: "POST",
      body: JSON.stringify({
        code,
        trackingToken
      })
    });

    codeInput.value = code;
    tokenInput.value = trackingToken;
    renderPublishedResult(payload.result || {});
  } catch (error) {
    currentPublishedResult = null;
    showErr(errorEl, mapFirebaseError(error, "تعذر عرض النتيجة الآن."));
  }
}

function printPublishedResult() {
  if (!currentPublishedResult) {
    alert("???? ??????? ????? ?? ??????.");
    return;
  }

  openPrintWindow(`????? ${currentPublishedResult.studentName}`, `
    <div class="print-card">
      <div style="font-size:20px;font-weight:800;margin-bottom:8px">${escapeHtml(currentPublishedResult.studentName)}</div>
      <div style="color:#555;line-height:1.9">
        ????????: ${escapeHtml(currentPublishedResult.examTitle)}
        <br>
        ????? / ????????: ${escapeHtml(currentPublishedResult.studentGroup)}
        <br>
        ??? ????????: ${escapeHtml(currentPublishedResult.examCode)}
        <br>
        ${currentPublishedResult.submittedAt ? `??? ???????: ${formatDate(currentPublishedResult.submittedAt)}` : ""}
        ${currentPublishedResult.publishedAt ? `<br>??? ?????: ${formatDate(currentPublishedResult.publishedAt)}` : ""}
      </div>
      <div class="print-grid">
        <div class="print-stat"><strong>${currentPublishedResult.score}</strong><span>??????</span></div>
        <div class="print-stat"><strong>${currentPublishedResult.total}</strong><span>?????? ???????</span></div>
        <div class="print-stat"><strong>${currentPublishedResult.pct}%</strong><span>${escapeHtml(currentPublishedResult.status)}</span></div>
      </div>
      <div style="color:#666;line-height:1.9">
        ??? ???? ????? ???? ??????? ???? ??? ????? ?? ?????? ?? ?????? ?????.
      </div>
    </div>
  `);
}

function printAdminReview() {
  const result = adminResultsState.byId[currentAdminReviewId];
  const exam = adminResultsState.exam;

  if (!result || !exam) {
    return;
  }

  openPrintWindow(`نتيجة ${result.studentName}`, `
    <div class="print-card">
      <div style="font-size:20px;font-weight:800;margin-bottom:8px">${escapeHtml(result.studentName)}</div>
      <div style="color:#555;line-height:1.9">
        الامتحان: ${escapeHtml(exam.title)}
        <br>
        الفصل / المجموعة: ${escapeHtml(result.studentGroup)}
        <br>
        وقت التسليم: ${formatDate(result.at)}
      </div>
      <div class="print-grid">
        <div class="print-stat"><strong>${result.score}</strong><span>صحيح</span></div>
        <div class="print-stat"><strong>${result.total - result.score}</strong><span>خطأ</span></div>
        <div class="print-stat"><strong>${result.pct}%</strong><span>النسبة</span></div>
      </div>
    </div>
    ${buildAdminReviewMarkup(exam, result, { printable: true })}
  `);
}

function printExcellenceCertificate(resultId = currentAdminReviewId) {
  const result = adminResultsState.byId[resultId];
  const exam = adminResultsState.exam;

  if (!result || !exam) {
    return;
  }

  if (result.pct < 80) {
    alert("تظهر الشهادة فقط للطلاب الحاصلين على 80% فأكثر.");
    return;
  }

  openPrintWindow(`شهادة تفوق - ${result.studentName}`, `
    <div class="print-card" style="border:8px double #c9973a;padding:34px;text-align:center;background:linear-gradient(180deg,#fffdf8 0%,#f7f0de 100%)">
      <div style="font-size:14px;letter-spacing:2px;color:#7a5200;font-weight:700;margin-bottom:12px">شهادة تقدير وتميّز</div>
      <div style="font-size:34px;font-weight:900;color:#0b2e1a;margin-bottom:12px;font-family:'Amiri',serif">شهادة تفوق</div>
      <div style="font-size:16px;color:#555;line-height:1.9;margin-bottom:18px">
        تُمنح هذه الشهادة إلى الطالب/الطالبة
      </div>
      <div style="font-size:30px;font-weight:900;color:#1a5235;margin-bottom:16px;font-family:'Amiri',serif">${escapeHtml(result.studentName)}</div>
      <div style="font-size:16px;color:#444;line-height:2;margin-bottom:20px">
        تقديرًا لتفوقه في <strong>${escapeHtml(exam.title)}</strong>
        <br>
        بعد تحقيق نسبة <strong>${result.pct}%</strong> بدرجة <strong>${result.score}</strong> من <strong>${result.total}</strong>
      </div>
      <div class="print-grid" style="margin-bottom:22px">
        <div class="print-stat"><strong>${result.pct}%</strong><span>نسبة الإنجاز</span></div>
        <div class="print-stat"><strong>${escapeHtml(result.studentGroup)}</strong><span>الفصل / المجموعة</span></div>
        <div class="print-stat"><strong>${formatDate(result.at)}</strong><span>تاريخ التسليم</span></div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:18px;align-items:flex-end;margin-top:26px;text-align:right">
        <div style="flex:1">
          <div style="font-size:13px;color:#7a5200;margin-bottom:8px">المعلم</div>
          <div style="font-size:24px;font-weight:800;color:#0b2e1a;font-family:'Amiri',serif">أ/ عمرو شعبان</div>
          <div style="font-size:14px;color:#555">مدرس اللغة العربية</div>
        </div>
        <div style="width:120px;height:120px;border-radius:50%;border:2px solid rgba(201,151,58,0.4);display:flex;align-items:center;justify-content:center;background:rgba(201,151,58,0.08);font-size:44px">🏆</div>
      </div>
    </div>
  `);
}

function goHome() {
  clearInterval(examTimerInterval);
  teardownAntiCheat();
  closeWarnModal();
  closeAdminReview();

  currentExam = null;
  currentAttemptToken = "";
  currentStudent = "";
  currentStudentGroup = "";
  currentSubmissionReceipt = null;
  currentPublishedResult = null;
  studentAnswers = [];
  examTimeLeft = 0;
  examTotalTime = 0;
  cheatWarnings = 0;

  document.getElementById("h-name").value = "";
  document.getElementById("h-group").value = "";
  document.getElementById("h-code").value = "";
  hideErr("h-err");
  hideErr("rl-err");

  showPage("pg-home");
}

function registerDomEvents() {
  document.getElementById("h-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      homeEnter();
    }
  });

  document.getElementById("h-group").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      homeEnter();
    }
  });

  document.getElementById("h-code").addEventListener("input", function handleCodeInput() {
    this.value = sanitizeCode(this.value);
  });

  document.getElementById("h-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      homeEnter();
    }
  });

  document.getElementById("rl-code").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      lookupPublishedResult();
    }
  });

  document.getElementById("rl-token").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      lookupPublishedResult();
    }
  });

  document.getElementById("al-pass").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      adminLogin();
    }
  });
}

async function bootstrap() {
  registerDomEvents();
  updateAdminLoginView();
  addSecurityWatermark();
  monitorExamSecurity();
  await Promise.all([refreshAdminMode(), loadLinkedExamFromUrl()]);
  showPage("pg-home");
}

document.addEventListener("DOMContentLoaded", () => {
  bootstrap().catch((error) => {
    console.error("خطأ في التهيئة:", error);
    showErr(document.getElementById("h-err"), "تعذر تهيئة التطبيق. تأكد من الاتصال بالإنترنت.");
  });
});
