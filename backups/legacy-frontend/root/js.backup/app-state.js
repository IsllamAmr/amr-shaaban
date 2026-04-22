// ============================================================
// js/app-state.js — Global constants & mutable state
// Loaded FIRST. All other modules depend on these variables.
// ============================================================

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

// --- Mutable global state ---
let adminUid = null;
let isAdminAuthenticated = false;
let exams = [];
let currentExam = null;
let currentAttemptId = "";
let currentAttemptToken = "";
let currentAttemptRemainingSeconds = 0;
let currentStudent = "";
let currentStudentGroup = "";
let currentSubmissionReceipt = null;
let currentPublishedResult = null;
let linkedExam = null;
let studentEntryStep = 1;
let isLinkedExamLoading = false;
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
