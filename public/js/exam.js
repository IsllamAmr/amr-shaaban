// ============================================================
// js/exam.js — Student exam flow: entry, timer, submit, results
// Depends on: app-state.js, utils.js, api.js, ui-helpers.js, admin.js
// ============================================================

// ============ Student Entry ============

function renderStudentEntryStepper() {
  // Safely handle optional stepper element
  document.querySelectorAll("#h-stepper .student-step-indicator").forEach((indicator) => {
    const step = Number(indicator.dataset.step || 0);
    indicator.classList.toggle("is-active", step === studentEntryStep);
    indicator.classList.toggle("is-complete", step < studentEntryStep);
  });
}

function togglePasswordVisibility(id) {
  const inp = document.getElementById(id);
  if (!inp) return;
  inp.type = inp.type === "password" ? "text" : "password";
}

async function loadStudentDashboard() {
  try {
    const data = await requestServerJson("/api/student/dashboard", { method: "GET" });
    // Guard against missing profile fields
    const profile = data.profile || {};
    currentStudent = profile.name || currentUser?.name || currentStudent || "";
    currentStudentGroup = profile.group || currentStudentGroup || "";

    // Update Profile UI
    const headerNameEl = document.getElementById("sd-header-name");
    const profNameEl = document.getElementById("sd-prof-name");
    const profUserEl = document.getElementById("sd-prof-user");
    const profDateEl = document.getElementById("sd-prof-date");
    if (headerNameEl) headerNameEl.textContent = profile.name || "";
    if (profNameEl) profNameEl.textContent = profile.name || "";
    if (profUserEl) profUserEl.textContent = profile.username || "";
    if (profDateEl) profDateEl.textContent = formatDate(profile.createdAt);

    // Update Stats
    const history = Array.isArray(data.history)
      ? data.history.filter((item) => item && typeof item === "object")
      : Object.values(data.history || {}).filter((item) => item && typeof item === "object");
    const takenEl = document.getElementById("sd-stat-taken");
    const avgEl = document.getElementById("sd-stat-avg");
    const rankEl = document.getElementById("sd-stat-rank");
    if (takenEl) takenEl.textContent = history.length;

    const avgPct = history.length 
      ? Math.round(history.reduce((sum, item) => sum + (item.pct || 0), 0) / history.length) 
      : 0;
    if (avgEl) avgEl.textContent = `${avgPct}%`;

    let level = "\u0645\u0628\u062a\u062f\u0626"; // مبتدئ
    if (avgPct >= 90) level = "\u0639\u0628\u0642\u0631\u064a \uD83D\uDC8E"; // عبقري
    else if (avgPct >= 75) level = "\u0645\u062a\u0645\u064a\u0632 \uD83C\uDF1F"; // متميز
    else if (avgPct >= 50) level = "\u0645\u062c\u062a\u0647\u062f \u2705"; // مجتهد
    if (rankEl) rankEl.textContent = level;

    // Render History
    const container = document.getElementById("sd-history-container");
    if (container) {
      if (!history.length) {
        container.innerHTML = `
          <div class="empty-state card" style="text-align:center; padding:60px 20px; color:var(--tm)">
            <div style="font-size:48px; margin-bottom:16px">📝</div>
            <p>ليس لديك أي اختبارات سابقة حتى الآن.</p>
          </div>`;
      } else {
        container.innerHTML = history.map(item => {
          const pct = Number(item.pct || 0);
          const score = Number(item.score || 0);
          const total = Number(item.total || 0);
          return `
          <div class="card" style="margin-bottom:16px; padding:20px; display:flex; justify-content:space-between; align-items:center">
            <div>
              <div style="font-weight:900; font-size:18px; color:var(--gd); margin-bottom:4px">${escapeHtml(item.examTitle || "")}</div>
              <div style="font-size:13px; color:var(--tm)">كود: <span style="font-family:monospace">${escapeHtml(item.examCode || "")}</span> • ${formatDate(item.at)}</div>
            </div>
            <div style="text-align:left">
              <div style="font-size:24px; font-weight:900; color:${getScoreColor(pct)}">${score}/${total}</div>
              <div style="font-size:12px; opacity:0.7; font-weight:800">${pct}%</div>
            </div>
          </div>
        `;
        }).join("");
      }
    }

    showPage("pg-student-dash");
  } catch (error) {
    alert(mapFirebaseError(error, "تعذر تحميل لوحة التحكم الخاصة بك."));
  }
}

function getScoreColor(pct) {
  if (pct >= 85) return "#059669"; // Green
  if (pct >= 50) return "#d97706"; // Gold
  return "#dc2626"; // Red
}

function openStudentCodeModal() {
  const codeInput = document.getElementById("sd-code-input");
  const modal = document.getElementById("student-code-modal");
  if (!codeInput || !modal) {
    goPage("pg-home");
    goStudentEntryStep(2);
    document.getElementById("h-code")?.focus();
    return;
  }
  codeInput.value = "";
  hideErr("sd-code-err");
  modal.style.display = "flex";
}

async function studentEnterExamFromDash() {
  const codeInput = document.getElementById("sd-code-input");
  const code = codeInput.value.trim().toUpperCase();
  const errorEl = document.getElementById("sd-code-err");
  const actionButton = document.getElementById("sd-code-btn");

  if (!code) { showErr(errorEl, "يرجى إدخال كود الاختبار."); return; }

  setButtonLoading(actionButton, true, "جارٍ التحقق...");
  try {
    const data = await requestServerJson("/api/student/exam-access", {
      method: "POST",
      body: JSON.stringify({ code })
    });
    
    const resolvedExamId = data?.exam?.id;
    const studentName = currentStudent || currentUser?.name || document.getElementById("sd-prof-name")?.textContent?.trim() || "";
    const studentGroup = currentStudentGroup || "";

    if (!resolvedExamId) throw new Error("Invalid exam code.");
    if (!studentName) throw new Error("Student session is missing.");

    const startPayload = await requestServerJson(`/api/student/exams/${encodeURIComponent(resolvedExamId)}/start`, {
      method: "POST",
      body: JSON.stringify({ studentName, studentGroup })
    });

    currentAttemptToken = startPayload.attemptToken || "";
    currentExam = { ...startPayload.exam, questions: normalizeQuestions(startPayload.exam?.questions) };
    currentStudent = startPayload.studentName || studentName;
    currentStudentGroup = startPayload.studentGroup || studentGroup;
    document.getElementById("student-code-modal").style.display = "none";
    startExam();
  } catch (error) {
    showErr(errorEl, mapFirebaseError(error, "كود الاختبار غير صحيح."));
  } finally {
    setButtonLoading(actionButton, false);
  }
}

async function studentMockLogin() {
  const idInput = document.getElementById("h-student-id");
  const passInput = document.getElementById("h-student-pass");
  const errorEl = document.getElementById("h-err");
  const loginButton = document.getElementById("h-login-btn");

  hideErr("h-err");
  const username = idInput.value.trim();
  const password = passInput.value.trim();

  if (!username) { showErr(errorEl, "يرجى إدخال البريد الإلكتروني أو كود الطالب."); return; }
  if (!password) { showErr(errorEl, "يرجى إدخال كلمة المرور."); return; }

  setButtonLoading(loginButton, true, "جارٍ التحقق...");
  try {
    const res = await requestServerJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    if (res.role !== "student") {
      await requestServerJson("/api/auth/logout", { method: "POST" });
      throw new Error("هذه البوابة مخصصة للطلاب فقط.");
    }
    
    // Sync shared session state
    await syncSession();
    currentStudent = currentUser?.name || username;
    currentStudentGroup = "";
    
    // Navigate to student dashboard
    await loadStudentDashboard();
  } catch (error) {
    showErr(errorEl, `❌ ${mapFirebaseError(error, "بيانات الدخول غير صحيحة.")}`);
  } finally {
    setButtonLoading(loginButton, false);
  }
}

function goStudentEntryStep(step) {
  const nextStep = Number(step || 1);
  const stepOne = document.getElementById("h-step-1");
  const stepTwo = document.getElementById("h-step-2");
  if (!stepOne || !stepTwo) return;
  
  studentEntryStep = nextStep;
  const isStepOneActive = studentEntryStep === 1;
  
  stepOne.style.display = isStepOneActive ? "block" : "none";
  stepTwo.style.display = isStepOneActive ? "none" : "block";
  
  if (isStepOneActive) {
    document.getElementById("h-student-id")?.focus();
  } else {
    document.getElementById("h-code")?.focus();
  }
}

function renderLinkedExamPreview() {
  const elements = {
    linkedCard: document.getElementById("h-linked-card"),
    linkedTitle: document.getElementById("h-linked-title"),
    linkedMeta: document.getElementById("h-linked-meta"),
    linkedLink: document.getElementById("h-linked-link"),
    linkedQuestions: document.getElementById("h-linked-questions"),
    linkedDuration: document.getElementById("h-linked-duration"),
    linkedStatus: document.getElementById("h-linked-status"),
    linkedTeacher: document.getElementById("h-linked-teacher"),
    linkedLogo: document.getElementById("h-linked-logo"),
    selectedExamMini: document.getElementById("h-selected-exam-mini")
  };
  if (Object.values(elements).some((el) => !el)) return;
  if (!linkedExam) { elements.linkedCard.style.display = "none"; elements.selectedExamMini.innerHTML = ""; return; }
  const linkedQuestionCount = Number(linkedExam.questionCount || linkedExam.questions?.length || 0);
  const teacherName = getExamTeacherName(linkedExam);
  const isActive = linkedExam.active !== false;
  const safeExamCode = sanitizePlainText(linkedExam.code || "", "");
  const accessModeLabel = hasDirectExamLink()
    ? "تم تفعيل الاختبار عبر الرابط المباشر"
    : safeExamCode ? `كود الاختبار: ${safeExamCode}` : "تم التحقق من الاختبار بنجاح";
  elements.linkedCard.style.display = "block";
  elements.linkedTitle.textContent = linkedExam.title;
  elements.linkedMeta.textContent = "يرجى مراجعة تفاصيل الاختبار بدقة قبل البدء.";
  elements.linkedQuestions.textContent = `${linkedQuestionCount} سؤال`;
  elements.linkedDuration.textContent = `${Number(linkedExam.duration || 0)} دقيقة`;
  elements.linkedStatus.textContent = isActive ? "متاح الآن" : "مغلق حالياً";
  elements.linkedTeacher.textContent = teacherName;
  elements.linkedLogo.textContent = teacherName.replace(/^أ\/\s*/, "").trim().charAt(0) || "ع";
  elements.linkedLink.textContent = accessModeLabel;
  elements.selectedExamMini.innerHTML = `<span class="student-selected-exam-mini-label">الاختبار المحدد</span><strong>${escapeHtml(linkedExam.title)}</strong><span>${linkedQuestionCount} سؤال • ${Number(linkedExam.duration || 0)} دقيقة</span>`;
}

function updateStudentContinueButton() {
  const continueButton = document.getElementById("h-continue-btn");
  const changeExamButton = document.getElementById("h-change-exam-btn");
  if (!continueButton || !changeExamButton) return;
  if (linkedExam) continueButton.textContent = "متابعة ←";
  else if (hasDirectExamLink()) continueButton.textContent = isLinkedExamLoading ? "جارٍ التجهيز..." : "إعادة التحقق من الرابط ←";
  else continueButton.textContent = "التحقق من الاختبار ←";
  continueButton.disabled = Boolean(isLinkedExamLoading);
  changeExamButton.style.display = linkedExam && !hasDirectExamLink() ? "inline-flex" : "none";
}

function updateHomeEntryMode() {
  const codeWrap = document.getElementById("h-code-wrap");
  const linkedCard = document.getElementById("h-linked-card");
  if (!codeWrap || !linkedCard) return;
  
  if (linkedExam) {
    codeWrap.style.display = "none";
  } else if (hasDirectExamLink()) {
    codeWrap.style.display = "none";
    linkedCard.style.display = "none";
  } else {
    codeWrap.style.display = "block";
  }
  renderLinkedExamPreview();
  updateStudentContinueButton();
  renderStudentEntryStepper();
}

async function loadLinkedExamFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const linkedExamId = params.get("exam");
  linkedExam = null; isLinkedExamLoading = false; updateHomeEntryMode();
  if (!linkedExamId) return;
  isLinkedExamLoading = true; updateHomeEntryMode();
  try {
    const payload = await requestServerJson("/api/student/exam-access", { method: "POST", body: JSON.stringify({ examId: linkedExamId }) });
    if (!payload?.exam) throw new Error("هذا الرابط غير صالح أو الامتحان غير متاح الآن.");
    linkedExam = { ...payload.exam, questions: new Array(Number(payload.exam?.questionCount || 0)) };
    hideErr("h-err");
  } catch (error) {
    linkedExam = null;
    showErr(document.getElementById("h-err"), mapFirebaseError(error, "تعذر فتح رابط الامتحان المباشر."));
  } finally {
    isLinkedExamLoading = false; updateHomeEntryMode(); goStudentEntryStep(1);
    if (linkedExam) document.getElementById("h-continue-btn")?.focus();
  }
}

async function continueStudentEntry() {
  const rawCode = document.getElementById("h-code").value;
  const code = rawCode.trim() ? sanitizeCode(rawCode) : "";
  const err = document.getElementById("h-err");
  const continueButton = document.getElementById("h-continue-btn");
  const directExamId = new URLSearchParams(window.location.search).get("exam");
  hideErr("h-err");
  if (linkedExam) { goStudentEntryStep(2); return; }
  if (!code && !directExamId) { showErr(err, "أدخل كود الاختبار للمتابعة."); return; }
  isLinkedExamLoading = Boolean(directExamId);
  updateStudentContinueButton();
  setButtonLoading(continueButton, true, "جارٍ التحقق...");
  try {
    const accessPayload = await requestServerJson("/api/student/exam-access", { method: "POST", body: JSON.stringify(directExamId ? { examId: directExamId } : { code }) });
    if (!accessPayload?.exam?.id) throw new Error("كود الاختبار غير صحيح أو الاختبار غير متاح حالياً.");
    linkedExam = { ...accessPayload.exam, questions: new Array(Number(accessPayload.exam.questionCount || 0)) };
    if (!directExamId) document.getElementById("h-code").value = code;
    updateHomeEntryMode();
    document.getElementById("h-continue-btn")?.focus();
  } catch (error) {
    linkedExam = null; updateHomeEntryMode();
    showErr(err, mapFirebaseError(error, "تعذر التعرف على الاختبار المخصص."));
  } finally {
    isLinkedExamLoading = false; updateStudentContinueButton(); setButtonLoading(continueButton, false);
  }
}

function resetStudentExamSelection() {
  if (hasDirectExamLink()) return;
  linkedExam = null; isLinkedExamLoading = false;
  updateHomeEntryMode(); goStudentEntryStep(1);
  document.getElementById("h-code")?.focus();
}

async function homeEnter() {
  const name = currentStudent; // Use ID from login
  const group = ""; 
  const rawCode = document.getElementById("h-code").value;
  const code = rawCode.trim() ? sanitizeCode(rawCode) : "";
  const err = document.getElementById("h-err");
  const actionButton = document.getElementById("h-enter-btn");
  
  if (studentEntryStep !== 2) { await studentMockLogin(); return; }
  if (!name) { showErr(err, "خطأ في بيانات الجلسة. يرجى إعادة تسجيل الدخول."); goStudentEntryStep(1); return; }
  if (!linkedExam && !code) { showErr(err, "من فضلك أدخل كود الاختبار."); return; }
  
  hideErr("h-err");
  setButtonLoading(actionButton, true, "جارٍ تجهيز الاختبار...");
  try {
    let resolvedExamId = linkedExam?.id || "";
    if (!resolvedExamId) {
      const accessPayload = await requestServerJson("/api/student/exam-access", { method: "POST", body: JSON.stringify({ code }) });
      if (!accessPayload?.exam?.id) throw new Error("كود الاختبار غير صحيح أو الاختبار مغلق حالياً.");
      linkedExam = { ...accessPayload.exam, questions: new Array(Number(accessPayload.exam.questionCount || 0)) };
      resolvedExamId = accessPayload.exam.id;
    }
    const startPayload = await requestServerJson(`/api/student/exams/${encodeURIComponent(resolvedExamId)}/start`, { method: "POST", body: JSON.stringify({ studentName: name, studentGroup: group || "" }) });
    hideErr("h-err");
    currentAttemptToken = startPayload.attemptToken || "";
    currentExam = { ...startPayload.exam, questions: normalizeQuestions(startPayload.exam?.questions) };
    currentStudent = startPayload.studentName || name;
    currentStudentGroup = startPayload.studentGroup || group || "";
    startExam();
  } catch (error) {
    showErr(err, mapFirebaseError(error, "تعذر فتح الاختبار."));
  } finally {
    setButtonLoading(actionButton, false);
  }
}

// ============ Exam Engine ============

function startExam() {
  loadAutoSavedAnswers();
  if (studentAnswers.length === 0) studentAnswers = new Array(currentExam.questions.length).fill(-1);
  currentSubmissionReceipt = null;
  cheatWarnings = 0; mouseOutWarningShown = false;
  examTotalTime = currentExam.duration * 60;
  examTimeLeft = examTotalTime;
  document.getElementById("ex-title").textContent = currentExam.title;
  document.getElementById("ex-student").textContent = formatStudentHeaderLine(currentStudent, currentStudentGroup);
  closeWarnModal();
  document.getElementById("submit-modal").style.display = "none";
  renderExamQuestions();
  updateExamProgress();
  updateTimerDisplay();
  clearInterval(examTimerInterval);
  examTimerInterval = setInterval(tickTimer, 1000);
  clearInterval(examAutoSaveInterval);
  examAutoSaveInterval = setInterval(autoSaveAnswers, 30000);
  setupAntiCheat();
  setupHistoryBackGuard();
  showPage("pg-exam");
}

function renderExamQuestions() {
  document.getElementById("ex-questions").innerHTML = currentExam.questions.map((question, questionIndex) => `
    <div class="q-card card" id="qc-${questionIndex}" style="padding:48px; margin-bottom:32px; border-radius:32px">
      <div style="font-weight:900; color:var(--tm); font-size:14px; margin-bottom:16px; display:inline-flex; align-items:center; gap:8px; padding:6px 16px; background:rgba(26,40,30,0.03); border-radius:10px">
        <span style="width:8px; height:8px; border-radius:50%; background:var(--gm)"></span>
        السؤال ${questionIndex + 1} من إجمالي ${currentExam.questions.length}
      </div>
      <div style="font-size:22px; font-weight:900; color:var(--gd); margin-bottom:32px; font-family:'Amiri', serif; line-height:1.7">
        ${escapeHtml(question.text)}
      </div>
      ${question.attachment ? renderQuestionAttachment(question.attachment) : ""}
      <div id="opts-${questionIndex}" style="margin-top:24px; display:flex; flex-direction:column; gap:12px">
        ${question.options.map((option, optionIndex) => `
          <button class="option-btn" id="opt-${questionIndex}-${optionIndex}" onclick="selectAnswer(${questionIndex}, ${optionIndex})" style="width:100%; padding:18px 24px; border:1.5px solid var(--cd); border-radius:16px; background:var(--wh); text-align:right; font-size:17px; font-family:'Cairo', sans-serif; cursor:pointer; transition:all 0.2s ease; display:flex; align-items:center; gap:16px">
            <span style="background:var(--cream); border:1.5px solid var(--cd); border-radius:50%; width:36px; height:36px; display:inline-flex; align-items:center; justify-content:center; font-weight:900; font-size:14px; flex-shrink:0; color:var(--gm)">
              ${getQuestionOptionMarker(question.type, optionIndex)}
            </span>
            <span style="flex:1; font-weight:700; color:var(--td)">${escapeHtml(option)}</span>
          </button>
        `).join("")}
      </div>
    </div>
  `).join("");
}

function selectAnswer(questionIndex, optionIndex) {
  studentAnswers[questionIndex] = optionIndex;
  document.querySelectorAll(`#opts-${questionIndex} .option-btn`).forEach((button, index) => button.classList.toggle("selected", index === optionIndex));
  document.getElementById(`qc-${questionIndex}`).classList.add("answered");
  updateExamProgress();
  autoSaveAnswers();
}

function autoSaveAnswers() {
  if (!currentExam || !Array.isArray(studentAnswers)) return;
  try {
    localStorage.setItem("exam_autosave", JSON.stringify({ examId: currentExam.id, studentName: currentStudent, studentGroup: currentStudentGroup, answers: studentAnswers, savedAt: Date.now(), timeLeft: examTimeLeft }));
    const saveIndicator = document.getElementById("ex-save-indicator");
    if (saveIndicator) { saveIndicator.style.opacity = "1"; setTimeout(() => { saveIndicator.style.opacity = "0"; }, 2000); }
  } catch (error) { console.warn("فشل الحفظ التلقائي:", error); }
}

function loadAutoSavedAnswers() {
  try {
    const saved = localStorage.getItem("exam_autosave");
    if (!saved) return;
    const saveData = JSON.parse(saved);
    if (saveData.examId === currentExam.id && saveData.studentName === currentStudent && Array.isArray(saveData.answers) && saveData.answers.length === currentExam.questions.length) {
      studentAnswers = [...saveData.answers];
      console.log("✅ تم استعادة الإجابات المحفوظة");
    } else {
      localStorage.removeItem("exam_autosave");
    }
  } catch (error) { console.warn("فشل استعادة الحفظ التلقائي:", error); localStorage.removeItem("exam_autosave"); }
}

function clearAutoSavedAnswers() {
  try { localStorage.removeItem("exam_autosave"); }
  catch (error) { console.warn("فشل حذف الحفظ التلقائي:", error); }
}

function updateExamProgress() {
  const answered = studentAnswers.filter((a) => a >= 0).length;
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
  if (examTimeLeft <= 0) { clearInterval(examTimerInterval); submitExam(); }
}

function confirmSubmit() {
  const answered = studentAnswers.filter((a) => a >= 0).length;
  const total = currentExam.questions.length;
  const unanswered = total - answered;
  document.getElementById("sub-msg").textContent = unanswered > 0 ? `تنبيه: يوجد ${unanswered} سؤالًا لم تُجب عنه. هل تريد التسليم؟` : "أجبت على جميع الأسئلة. هل تريد التسليم الآن؟";
  document.getElementById("submit-modal").style.display = "flex";
}

async function submitExam() {
  document.getElementById("submit-modal").style.display = "none";
  clearInterval(examTimerInterval);
  clearInterval(examAutoSaveInterval);
  teardownAntiCheat();
  const answeredCount = studentAnswers.filter((a) => a >= 0).length;
  const receiptAt = Date.now();
  try {
    const payload = await requestServerJson(`/api/student/exams/${encodeURIComponent(currentExam.id)}/submit`, {
      method: "POST",
      body: JSON.stringify({ studentName: currentStudent, studentGroup: currentStudentGroup, answers: studentAnswers, attemptToken: currentAttemptToken })
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
  } catch (error) {
    const errorMessage = error?.message || "";
    const isTimeout = errorMessage.includes("انتهى وقت") || errorMessage.includes("تفتقر إلى وقت");
    alert(mapFirebaseError(error, "تعذر تسليم الامتحان."));
    if (isTimeout) { clearAutoSavedAnswers(); goHome(); return; }
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

// ============ Results ============

function showSubmissionReceipt() {
  const receiptTotal = Number(currentSubmissionReceipt.totalQuestions || 0);
  const receiptScore = Number(currentSubmissionReceipt.score || 0);
  const receiptPct = Number(currentSubmissionReceipt.pct || 0);
  const receiptWrong = Math.max(0, receiptTotal - receiptScore);
  const receiptAnswered = Number(currentSubmissionReceipt.answeredCount || 0);
  const receiptPassed = receiptPct >= 50;
  const receiptStatus = currentSubmissionReceipt.status || (receiptPassed ? "ناجح" : "لم يجتز");
  const receiptTrackingToken = currentSubmissionReceipt.trackingToken || currentSubmissionReceipt.submissionId || "غير متاح";
  document.getElementById("res-heading").textContent = "تم تسليم الاختبار بنجاح";
  document.getElementById("res-circle").className = `score-circle ${receiptPassed ? "score-good" : "score-fail"}`;
  document.getElementById("res-pct").textContent = `${receiptPct}%`;
  document.getElementById("res-circle-subtitle").textContent = receiptStatus;
  document.getElementById("res-emoji").textContent = receiptPassed ? "🎉" : "📘";
  document.getElementById("res-name").textContent = currentSubmissionReceipt.studentName || currentStudent;
  document.getElementById("res-exam-title").textContent = formatExamPreviewTitle(currentSubmissionReceipt.examTitle || currentExam.title, currentSubmissionReceipt.studentGroup || currentStudentGroup);
  document.getElementById("res-score").textContent = receiptScore;
  document.getElementById("res-wrong").textContent = receiptWrong;
  document.getElementById("res-total").textContent = receiptTotal;
  document.getElementById("res-score-label").textContent = "الدرجة المستحقة";
  document.getElementById("res-wrong-label").textContent = "الأخطاء المكتشفة";
  document.getElementById("res-total-label").textContent = "إجمالي الأسئلة";
  document.getElementById("res-msg").textContent = `تم رصد النتيجة بنجاح. الحالة الحالية: ${receiptStatus} - رقم المتابعة الخاص بك: ${receiptTrackingToken}`;
  document.getElementById("res-msg").style.overflowWrap = "anywhere";
  document.getElementById("res-review-title").textContent = "مراجعة عملية التسليم";
  document.getElementById("res-review").innerHTML = `
    <div class="card" style="margin-bottom:14px;border-right:5px solid var(--gd)">
      <div style="font-weight:900;color:var(--gd);margin-bottom:12px;font-size:17px">ملخص بيانات الطالب</div>
      <div style="color:var(--tm);font-size:15px;line-height:2;font-weight:700">
        ${buildOptionalGroupMarkup(currentSubmissionReceipt.studentGroup || currentStudentGroup)}
        ${hasStudentGroup(currentSubmissionReceipt.studentGroup || currentStudentGroup) ? "<br>" : ""}
        إجاباتك المرسلة: ${receiptAnswered} من ${receiptTotal}<br>
        تاريخ التسليم: ${formatDate(currentSubmissionReceipt.submittedAt)}<br>
        رقم المتابعة: <span style="color:var(--gd)">${escapeHtml(receiptTrackingToken)}</span>
      </div>
    </div>
    <div class="card" style="margin-bottom:14px;border-right:5px solid var(--gm)">
      <div style="font-weight:900;color:var(--gd);margin-bottom:12px;font-size:17px">ملاحظات هامة</div>
      <div style="color:var(--tm);font-size:15px;line-height:1.9;font-weight:700">هذه النسخة صادرة عن بيئة ركائز، وتعرض حالياً حالة التسليم والدرجة فقط لضمان عدالة التقييم.</div>
    </div>
  `;
  showPage("pg-results");
}

function printStudentReceipt() {
  if (!currentSubmissionReceipt) return;
  const receiptTotal = Number(currentSubmissionReceipt.totalQuestions || 0);
  const receiptScore = Number(currentSubmissionReceipt.score || 0);
  const receiptPct = Number(currentSubmissionReceipt.pct || 0);
  const receiptStatus = currentSubmissionReceipt.status || (receiptPct >= 50 ? "ناجح" : "لم يجتز");
  const receiptTrackingToken = currentSubmissionReceipt.trackingToken || currentSubmissionReceipt.submissionId || "غير متاح";
  openPrintWindow("إيصال تسليم الاختبار", `
    <div class="print-card">
      <div style="font-size:20px;font-weight:800;margin-bottom:8px">${escapeHtml(currentSubmissionReceipt.studentName)}</div>
      <div style="color:#555;line-height:1.9">الاختبار: ${escapeHtml(currentSubmissionReceipt.examTitle)}${hasStudentGroup(currentSubmissionReceipt.studentGroup) ? `<br>المجموعة: ${escapeHtml(currentSubmissionReceipt.studentGroup)}` : ""}<br>تاريخ التسليم: ${formatDate(currentSubmissionReceipt.submittedAt)}<br>رقم المتابعة: <span style="overflow-wrap:anywhere;word-break:break-word">${escapeHtml(receiptTrackingToken)}</span></div>
      <div class="print-grid"><div class="print-stat"><strong>${receiptScore}</strong><span>الدرجة</span></div><div class="print-stat"><strong>${Math.max(0, receiptTotal - receiptScore)}</strong><span>الأخطاء</span></div><div class="print-stat"><strong>${receiptPct}%</strong><span>${escapeHtml(receiptStatus)}</span></div></div>
      <div style="color:#666;line-height:1.9;margin-top:20px">هذه النسخة صادرة عن بيئة ركائز التعليمية، ولا تكشف الإجابات النموذجية.</div>

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
    examCode: String(result?.examCode || ""), examTitle: String(result?.examTitle || ""),
    studentName: String(result?.studentName || ""), studentGroup: String(result?.studentGroup || ""),
    score, total, pct, status: statusLabel,
    submittedAt: result?.submittedAt || null, publishedAt: result?.publishedAt || null,
    trackingToken: String(result?.trackingToken || "")
  };
  document.getElementById("sr-emoji").textContent = statusView.emoji;
  document.getElementById("sr-heading").textContent = "نتيجة الطالب";
  document.getElementById("sr-circle").className = `score-circle ${pct >= 50 ? "score-good" : "score-fail"}`;
  document.getElementById("sr-pct").textContent = `${pct}%`;
  document.getElementById("sr-circle-subtitle").textContent = statusLabel;
  document.getElementById("sr-name").textContent = currentPublishedResult.studentName;
  document.getElementById("sr-exam-title").textContent = formatExamPreviewTitle(currentPublishedResult.examTitle, currentPublishedResult.studentGroup);
  document.getElementById("sr-score").textContent = score;
  document.getElementById("sr-total").textContent = total;
  document.getElementById("sr-status").textContent = statusLabel;
  const publishedLabel = currentPublishedResult.publishedAt ? `تم نشر هذه النتيجة في ${formatDate(currentPublishedResult.publishedAt)}.` : "تم اعتماد هذه النتيجة بواسطة المدرس.";
  const submittedLabel = currentPublishedResult.submittedAt ? `وقت التسليم: ${formatDate(currentPublishedResult.submittedAt)}.` : "";
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
  if (!code) { showErr(errorEl, "أدخل كود الاختبار أولاً."); return; }
  if (!trackingToken) { showErr(errorEl, "أدخل رقم متابعة النتيجة."); return; }
  try {
    const payload = await requestServerJson("/api/student/results/lookup", { method: "POST", body: JSON.stringify({ code, trackingToken }) });
    codeInput.value = code; tokenInput.value = trackingToken;
    renderPublishedResult(payload.result || {});
  } catch (error) {
    currentPublishedResult = null;
    showErr(errorEl, mapFirebaseError(error, "تعذر عرض النتيجة حالياً."));
  }
}

function printPublishedResult() {
  if (!currentPublishedResult) { alert("يرجى فتح النتيجة أولاً لتتمكن من طباعتها."); return; }
  openPrintWindow(`نتيجة الاختبار - ${currentPublishedResult.studentName}`, `
    <div class="print-card">
      <div style="font-size:20px;font-weight:800;margin-bottom:8px">${escapeHtml(currentPublishedResult.studentName)}</div>
      <div style="color:#555;line-height:1.9">الاختبار: ${escapeHtml(currentPublishedResult.examTitle)}${hasStudentGroup(currentPublishedResult.studentGroup) ? `<br>المجموعة: ${escapeHtml(currentPublishedResult.studentGroup)}` : ""}<br>كود الاختبار: ${escapeHtml(currentPublishedResult.examCode)}${currentPublishedResult.submittedAt ? `<br>تاريخ التسليم: ${formatDate(currentPublishedResult.submittedAt)}` : ""}${currentPublishedResult.publishedAt ? `<br>تاريخ النشر: ${formatDate(currentPublishedResult.publishedAt)}` : ""}</div>
      <div class="print-grid"><div class="print-stat"><strong>${currentPublishedResult.score}</strong><span>الدرجة</span></div><div class="print-stat"><strong>${currentPublishedResult.total}</strong><span>إجمالي الأسئلة</span></div><div class="print-stat"><strong>${currentPublishedResult.pct}%</strong><span>${escapeHtml(currentPublishedResult.status)}</span></div></div>
      <div style="color:#666;line-height:1.9;margin-top:20px">هذه نسخة رسمية للنتائج عبر بيئة ركائز، ولا تتضمن مفاتيح التصحيح.</div>
    </div>
  `);
}

// ============ Navigation ============

async function goHome() {
  clearInterval(examTimerInterval);
  teardownAntiCheat();
  closeWarnModal();
  if (typeof closeAdminReview === "function") closeAdminReview();
  currentExam = null; currentAttemptToken = ""; 
  currentSubmissionReceipt = null; currentPublishedResult = null;
  studentAnswers = []; examTimeLeft = 0; examTotalTime = 0;
  cheatWarnings = 0; studentEntryStep = 1;
  if (!hasDirectExamLink()) linkedExam = null;
  
  const idInput = document.getElementById("h-student-id");
  const passInput = document.getElementById("h-student-pass");
  if (idInput) idInput.value = "";
  if (passInput) passInput.value = "";
  const codeInput = document.getElementById("h-code");
  if (codeInput) codeInput.value = "";
  
  hideErr("h-err"); hideErr("rl-err");

  // If student session is still active, go back to student dashboard
  if (isUserAuthenticated && currentRole === 'student' && currentStudent) {
    try {
      await loadStudentDashboard();
      return;
    } catch (_) { /* fall through to home page */ }
  }

  updateHomeEntryMode(); goStudentEntryStep(1);
  showPage("pg-home");
}

// ============ DOM Events & Bootstrap ============

function registerDomEvents() {
  document.getElementById("h-student-id")?.addEventListener("keydown", (event) => { if (event.key === "Enter") document.getElementById("h-student-pass")?.focus(); });
  document.getElementById("h-student-pass")?.addEventListener("keydown", (event) => { if (event.key === "Enter") studentMockLogin(); });
  document.getElementById("h-code")?.addEventListener("input", function () { this.value = sanitizeCode(this.value); });
  document.getElementById("h-code")?.addEventListener("keydown", (event) => { if (event.key === "Enter") homeEnter(); });
  document.getElementById("rl-code")?.addEventListener("keydown", (event) => { if (event.key === "Enter") lookupPublishedResult(); });
  document.getElementById("rl-token")?.addEventListener("keydown", (event) => { if (event.key === "Enter") lookupPublishedResult(); });
  document.getElementById("sd-code-input")?.addEventListener("keydown", (event) => { if (event.key === "Enter") studentEnterExamFromDash(); });
  document.getElementById("al-user")?.addEventListener("keydown", (event) => { if (event.key === "Enter") adminLogin(); });
  document.getElementById("al-pass")?.addEventListener("keydown", (event) => { if (event.key === "Enter") adminLogin(); });
}

async function bootstrap() {
  registerDomEvents();
  addSecurityWatermark();
  monitorExamSecurity();

  // Try to recover session
  try {
    const session = await syncSession({ silent: true });
    updateAdminLoginView();
    
    if (session.authenticated && session.role === 'student') {
      await loadStudentDashboard();
    } else {
      await loadLinkedExamFromUrl();
      showPage("pg-home");
    }
  } catch (error) {
    console.warn("تعذر استعادة الجلسة:", error);
    await loadLinkedExamFromUrl();
    showPage("pg-home");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bootstrap().catch((error) => {
    console.error("خطأ في التهيئة:", error);
    showErr(document.getElementById("h-err"), "تعذر تهيئة التطبيق. تأكد من الاتصال بالإنترنت.");
  });
});
