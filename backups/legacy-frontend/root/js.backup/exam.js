// ============================================================
// js/exam.js — Student exam flow: entry, timer, submit, results
// Depends on: app-state.js, utils.js, api.js, ui-helpers.js, admin.js
// ============================================================

// ============ Student Entry ============

function renderStudentEntryStepper() {
  document.querySelectorAll("#h-stepper .student-step-indicator").forEach((indicator) => {
    const step = Number(indicator.dataset.step || 0);
    indicator.classList.toggle("is-active", step === studentEntryStep);
    indicator.classList.toggle("is-complete", step < studentEntryStep);
  });
}

function goStudentEntryStep(step) {
  const nextStep = Number(step || 1);
  const stepOne = document.getElementById("h-step-1");
  const stepTwo = document.getElementById("h-step-2");
  if (!stepOne || !stepTwo) return;
  if (nextStep === 2 && !linkedExam) return;
  studentEntryStep = nextStep === 2 ? 2 : 1;
  const isStepOneActive = studentEntryStep === 1;
  stepOne.hidden = !isStepOneActive;
  stepTwo.hidden = isStepOneActive;
  stepOne.classList.toggle("active", isStepOneActive);
  stepTwo.classList.toggle("active", !isStepOneActive);
  renderStudentEntryStepper();
  if (studentEntryStep === 2) document.getElementById("h-name")?.focus();
  else if (linkedExam) document.getElementById("h-continue-btn")?.focus();
  else document.getElementById("h-code")?.focus();
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
    ? "تم فتح الامتحان من الرابط المباشر"
    : safeExamCode ? `كود الامتحان: ${safeExamCode}` : "تم التحقق من الامتحان بنجاح";
  elements.linkedCard.style.display = "block";
  elements.linkedTitle.textContent = linkedExam.title;
  elements.linkedMeta.textContent = "راجع بيانات الامتحان جيدًا قبل إدخال اسمك والبدء.";
  elements.linkedQuestions.textContent = `${linkedQuestionCount} سؤال`;
  elements.linkedDuration.textContent = `${Number(linkedExam.duration || 0)} دقيقة`;
  elements.linkedStatus.textContent = isActive ? "متاح الآن" : "مغلق";
  elements.linkedTeacher.textContent = teacherName;
  elements.linkedLogo.textContent = teacherName.replace(/^أ\/\s*/, "").trim().charAt(0) || "ع";
  elements.linkedLink.textContent = accessModeLabel;
  elements.selectedExamMini.innerHTML = `<span class="student-selected-exam-mini-label">الامتحان المحدد</span><strong>${escapeHtml(linkedExam.title)}</strong><span>${linkedQuestionCount} سؤال • ${Number(linkedExam.duration || 0)} دقيقة</span>`;
}

function updateStudentContinueButton() {
  const continueButton = document.getElementById("h-continue-btn");
  const changeExamButton = document.getElementById("h-change-exam-btn");
  if (!continueButton || !changeExamButton) return;
  if (linkedExam) continueButton.textContent = "متابعة ←";
  else if (hasDirectExamLink()) continueButton.textContent = isLinkedExamLoading ? "جارٍ تجهيز الامتحان..." : "إعادة التحقق من الرابط ←";
  else continueButton.textContent = "التحقق من الامتحان ←";
  continueButton.disabled = Boolean(isLinkedExamLoading);
  changeExamButton.style.display = linkedExam && !hasDirectExamLink() ? "inline-flex" : "none";
}

function updateHomeEntryMode() {
  const codeWrap = document.getElementById("h-code-wrap");
  const subtitle = document.getElementById("h-subtitle");
  const stepOneText = document.getElementById("h-step-1-text");
  const linkedCard = document.getElementById("h-linked-card");
  if (!codeWrap || !subtitle || !stepOneText || !linkedCard) return;
  if (linkedExam) {
    codeWrap.style.display = "none";
    subtitle.textContent = hasDirectExamLink() ? "تم التعرّف على الامتحان من الرابط المباشر. راجع البطاقة ثم انتقل إلى كتابة اسمك للبدء." : "تم العثور على الامتحان بنجاح. راجع البطاقة ثم اضغط متابعة للانتقال إلى كتابة اسمك.";
    stepOneText.textContent = hasDirectExamLink() ? "هذه البطاقة تعرض لك بيانات الامتحان القادمة من الرابط المباشر قبل بدء الاختبار." : "بعد التحقق من الكود يمكنك مراجعة اسم الامتحان وعدد الأسئلة والوقت ثم الانتقال للخطوة التالية.";
  } else if (hasDirectExamLink()) {
    codeWrap.style.display = "none";
    linkedCard.style.display = "none";
    subtitle.textContent = isLinkedExamLoading ? "جارٍ تجهيز بيانات الامتحان من الرابط المباشر." : "تعذر جلب بيانات الامتحان من الرابط المباشر. حاول إعادة التحقق من الرابط.";
    stepOneText.textContent = isLinkedExamLoading ? "لن تحتاج إلى إدخال أي كود هنا. انتظر لحظة حتى تظهر بطاقة معاينة الامتحان." : "إذا كان الرابط صحيحًا فاضغط إعادة التحقق من الرابط، أو اطلب من المدرس إرسال رابط صالح.";
  } else {
    codeWrap.style.display = "block";
    subtitle.textContent = "ابدأ بإدخال كود الامتحان فقط. بعد التحقق من بياناته ستنتقل إلى خطوة كتابة الاسم.";
    stepOneText.textContent = "أدخل كود الامتحان أولًا لإظهار بطاقة المعاينة، ثم انتقل إلى كتابة اسمك قبل بدء الاختبار.";
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
  if (!code && !directExamId) { showErr(err, "أدخل كود الامتحان أولًا للمتابعة."); return; }
  isLinkedExamLoading = Boolean(directExamId);
  updateStudentContinueButton();
  setButtonLoading(continueButton, true, "جارٍ التحقق من الامتحان...");
  try {
    const accessPayload = await requestServerJson("/api/student/exam-access", { method: "POST", body: JSON.stringify(directExamId ? { examId: directExamId } : { code }) });
    if (!accessPayload?.exam?.id) throw new Error("كود الامتحان غير صحيح أو الامتحان غير متاح الآن.");
    linkedExam = { ...accessPayload.exam, questions: new Array(Number(accessPayload.exam.questionCount || 0)) };
    if (!directExamId) document.getElementById("h-code").value = code;
    updateHomeEntryMode();
    document.getElementById("h-continue-btn")?.focus();
  } catch (error) {
    linkedExam = null; updateHomeEntryMode();
    showErr(err, mapFirebaseError(error, "تعذر التعرّف على الامتحان."));
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
  const name = document.getElementById("h-name").value.trim();
  const group = document.getElementById("h-group").value.trim();
  const rawCode = document.getElementById("h-code").value;
  const code = rawCode.trim() ? sanitizeCode(rawCode) : "";
  const err = document.getElementById("h-err");
  const actionButton = document.getElementById("h-enter-btn");
  if (studentEntryStep !== 2) { await continueStudentEntry(); return; }
  if (!name) { showErr(err, "من فضلك أدخل اسم الطالب كاملًا."); return; }
  if (!linkedExam && !code) { showErr(err, "من فضلك أدخل كود الامتحان."); return; }
  hideErr("h-err");
  setButtonLoading(actionButton, true, "جارٍ تجهيز الامتحان...");
  try {
    let resolvedExamId = linkedExam?.id || "";
    if (!resolvedExamId) {
      const accessPayload = await requestServerJson("/api/student/exam-access", { method: "POST", body: JSON.stringify({ code }) });
      if (!accessPayload?.exam?.id) throw new Error("كود الامتحان غير صحيح أو الامتحان مغلق الآن.");
      linkedExam = { ...accessPayload.exam, questions: new Array(Number(accessPayload.exam.questionCount || 0)) };
      resolvedExamId = accessPayload.exam.id;
    }
    const startPayload = await requestServerJson(`/api/student/exams/${encodeURIComponent(resolvedExamId)}/start`, { method: "POST", body: JSON.stringify({ studentName: name, studentGroup: group || "" }) });
    hideErr("h-err");
    currentAttemptId = startPayload.attemptId || "";
    currentAttemptToken = startPayload.attemptToken || "";
    currentAttemptRemainingSeconds = Number(startPayload.remainingSeconds || 0);
    currentExam = { ...startPayload.exam, questions: normalizeQuestions(startPayload.exam?.questions) };
    currentStudent = startPayload.studentName || name;
    currentStudentGroup = startPayload.studentGroup || group || "";
    startExam();
  } catch (error) {
    showErr(err, mapFirebaseError(error, "تعذر فتح الامتحان."));
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
  examTimeLeft = currentAttemptRemainingSeconds > 0 ? Math.min(currentAttemptRemainingSeconds, examTotalTime) : examTotalTime;
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
    <div class="q-card ${studentAnswers[questionIndex] >= 0 ? "answered" : ""}" id="qc-${questionIndex}">
      <div style="font-weight:700;color:var(--tl);font-size:13px;margin-bottom:8px">السؤال ${questionIndex + 1} من ${currentExam.questions.length}</div>
      <div style="font-size:17px;font-weight:700;color:var(--td);margin-bottom:18px;font-family:'Amiri',serif;line-height:1.8">${escapeHtml(question.text)}</div>
      ${question.attachment ? renderQuestionAttachment(question.attachment) : ""}
      <div id="opts-${questionIndex}">
        ${question.options.map((option, optionIndex) => `
          <button class="option-btn ${studentAnswers[questionIndex] === optionIndex ? "selected" : ""}" id="opt-${questionIndex}-${optionIndex}" onclick="selectAnswer(${questionIndex}, ${optionIndex})">
            <span style="background:var(--cd);border-radius:50%;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0">${getQuestionOptionMarker(question.type, optionIndex)}</span>
            <span>${escapeHtml(option)}</span>
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
    localStorage.setItem(getExamAutosaveStorageKey(), JSON.stringify({ attemptId: currentAttemptId, examId: currentExam.id, studentName: currentStudent, studentGroup: currentStudentGroup, answers: studentAnswers, savedAt: Date.now(), timeLeft: examTimeLeft }));
    const saveIndicator = document.getElementById("ex-save-indicator");
    if (saveIndicator) { saveIndicator.style.opacity = "1"; setTimeout(() => { saveIndicator.style.opacity = "0"; }, 2000); }
  } catch (error) { console.warn("فشل الحفظ التلقائي:", error); }
}

function getExamAutosaveStorageKey() {
  return currentAttemptId ? `exam_autosave_${currentAttemptId}` : "exam_autosave";
}

function loadAutoSavedAnswers() {
  try {
    const primaryKey = getExamAutosaveStorageKey();
    const saved = localStorage.getItem(primaryKey) || localStorage.getItem("exam_autosave");
    if (!saved) return;
    const saveData = JSON.parse(saved);
    const matchesCurrentAttempt = saveData.attemptId
      ? saveData.attemptId === currentAttemptId
      : saveData.examId === currentExam.id && saveData.studentName === currentStudent;
    if (matchesCurrentAttempt && Array.isArray(saveData.answers) && saveData.answers.length === currentExam.questions.length) {
      studentAnswers = [...saveData.answers];
      if (!saveData.attemptId && currentAttemptId) {
        localStorage.setItem(primaryKey, JSON.stringify({ ...saveData, attemptId: currentAttemptId }));
      }
      localStorage.removeItem("exam_autosave");
      console.log("✅ تم استعادة الإجابات المحفوظة لنفس المحاولة");
    } else {
      localStorage.removeItem(primaryKey);
      localStorage.removeItem("exam_autosave");
    }
  } catch (error) {
    console.warn("فشل استعادة الحفظ التلقائي:", error);
    localStorage.removeItem(getExamAutosaveStorageKey());
    localStorage.removeItem("exam_autosave");
  }
}

function clearAutoSavedAnswers() {
  try {
    localStorage.removeItem(getExamAutosaveStorageKey());
    localStorage.removeItem("exam_autosave");
  }
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
    clearAutoSavedAnswers();
    currentAttemptId = "";
    currentAttemptToken = "";
    currentAttemptRemainingSeconds = 0;
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
  document.getElementById("res-heading").textContent = "تم تسليم الامتحان";
  document.getElementById("res-circle").className = `score-circle ${receiptPassed ? "score-good" : "score-fail"}`;
  document.getElementById("res-pct").textContent = `${receiptPct}%`;
  document.getElementById("res-circle-subtitle").textContent = receiptStatus;
  document.getElementById("res-emoji").textContent = receiptPassed ? "🎉" : "📘";
  document.getElementById("res-name").textContent = currentSubmissionReceipt.studentName || currentStudent;
  document.getElementById("res-exam-title").textContent = formatExamPreviewTitle(currentSubmissionReceipt.examTitle || currentExam.title, currentSubmissionReceipt.studentGroup || currentStudentGroup);
  document.getElementById("res-score").textContent = receiptScore;
  document.getElementById("res-wrong").textContent = receiptWrong;
  document.getElementById("res-total").textContent = receiptTotal;
  document.getElementById("res-score-label").textContent = "الدرجة";
  document.getElementById("res-wrong-label").textContent = "الأخطاء";
  document.getElementById("res-total-label").textContent = "إجمالي الأسئلة";
  document.getElementById("res-msg").textContent = `تم تسجيل نتيجة الطالب بنجاح. الحالة: ${receiptStatus} - رقم المتابعة: ${receiptTrackingToken}`;
  document.getElementById("res-msg").style.overflowWrap = "anywhere";
  document.getElementById("res-review-title").textContent = "تفاصيل التسليم";
  document.getElementById("res-review").innerHTML = `
    <div class="card" style="margin-bottom:14px;border-right:5px solid var(--gold)">
      <div style="font-weight:800;color:var(--gd);margin-bottom:8px">ملخص بيانات الطالب</div>
      <div style="color:var(--tm);font-size:14px;line-height:1.9">
        ${buildOptionalGroupMarkup(currentSubmissionReceipt.studentGroup || currentStudentGroup)}
        ${hasStudentGroup(currentSubmissionReceipt.studentGroup || currentStudentGroup) ? "<br>" : ""}
        عدد الإجابات المرسلة: ${receiptAnswered} من ${receiptTotal}<br>
        وقت التسليم: ${formatDate(currentSubmissionReceipt.submittedAt)}<br>
        رقم المتابعة: <span style="overflow-wrap:anywhere;word-break:break-word">${escapeHtml(receiptTrackingToken)}</span>
      </div>
    </div>
    <div class="card" style="margin-bottom:14px;border-right:5px solid var(--gm)">
      <div style="font-weight:800;color:var(--gd);margin-bottom:8px">مهم</div>
      <div style="color:var(--tm);font-size:14px;line-height:1.9">هذه النسخة تعرض نتيجة الطالب فقط، ولا تكشف الإجابات أو مفاتيح التصحيح.</div>
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
  openPrintWindow("إيصال تسليم الامتحان", `
    <div class="print-card">
      <div style="font-size:20px;font-weight:800;margin-bottom:8px">${escapeHtml(currentSubmissionReceipt.studentName)}</div>
      <div style="color:#555;line-height:1.9">الامتحان: ${escapeHtml(currentSubmissionReceipt.examTitle)}${hasStudentGroup(currentSubmissionReceipt.studentGroup) ? `<br>الفصل / المجموعة: ${escapeHtml(currentSubmissionReceipt.studentGroup)}` : ""}<br>وقت التسليم: ${formatDate(currentSubmissionReceipt.submittedAt)}<br>رقم المتابعة: <span style="overflow-wrap:anywhere;word-break:break-word">${escapeHtml(receiptTrackingToken)}</span></div>
      <div class="print-grid"><div class="print-stat"><strong>${receiptScore}</strong><span>الدرجة</span></div><div class="print-stat"><strong>${Math.max(0, receiptTotal - receiptScore)}</strong><span>الأخطاء</span></div><div class="print-stat"><strong>${receiptPct}%</strong><span>${escapeHtml(receiptStatus)}</span></div></div>
      <div style="color:#666;line-height:1.9">هذه النسخة تعرض نتيجة الطالب فقط، ولا تكشف الإجابات أو مفاتيح التصحيح.</div>
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
  if (!code) { showErr(errorEl, "أدخل كود الامتحان أولًا."); return; }
  if (!trackingToken) { showErr(errorEl, "أدخل رقم متابعة النتيجة."); return; }
  try {
    const payload = await requestServerJson("/api/student/results/lookup", { method: "POST", body: JSON.stringify({ code, trackingToken }) });
    codeInput.value = code; tokenInput.value = trackingToken;
    renderPublishedResult(payload.result || {});
  } catch (error) {
    currentPublishedResult = null;
    showErr(errorEl, mapFirebaseError(error, "تعذر عرض النتيجة الآن."));
  }
}

function printPublishedResult() {
  if (!currentPublishedResult) { alert("افتح النتيجة أولًا ثم اطبعها."); return; }
  openPrintWindow(`نتيجة ${currentPublishedResult.studentName}`, `
    <div class="print-card">
      <div style="font-size:20px;font-weight:800;margin-bottom:8px">${escapeHtml(currentPublishedResult.studentName)}</div>
      <div style="color:#555;line-height:1.9">الامتحان: ${escapeHtml(currentPublishedResult.examTitle)}${hasStudentGroup(currentPublishedResult.studentGroup) ? `<br>الفصل / المجموعة: ${escapeHtml(currentPublishedResult.studentGroup)}` : ""}<br>كود الامتحان: ${escapeHtml(currentPublishedResult.examCode)}${currentPublishedResult.submittedAt ? `<br>وقت التسليم: ${formatDate(currentPublishedResult.submittedAt)}` : ""}${currentPublishedResult.publishedAt ? `<br>وقت النشر: ${formatDate(currentPublishedResult.publishedAt)}` : ""}</div>
      <div class="print-grid"><div class="print-stat"><strong>${currentPublishedResult.score}</strong><span>الدرجة</span></div><div class="print-stat"><strong>${currentPublishedResult.total}</strong><span>إجمالي الأسئلة</span></div><div class="print-stat"><strong>${currentPublishedResult.pct}%</strong><span>${escapeHtml(currentPublishedResult.status)}</span></div></div>
      <div style="color:#666;line-height:1.9">هذه نسخة مخصصة لعرض النتيجة فقط، ولا تتضمن أي إجابات أو مفاتيح تصحيح.</div>
    </div>
  `);
}

// ============ Navigation ============

function goHome() {
  clearInterval(examTimerInterval);
  teardownAntiCheat();
  closeWarnModal();
  closeAdminReview();
  currentExam = null; currentAttemptToken = ""; currentStudent = ""; currentStudentGroup = "";
  currentSubmissionReceipt = null; currentPublishedResult = null;
  studentAnswers = []; examTimeLeft = 0; examTotalTime = 0;
  cheatWarnings = 0; studentEntryStep = 1;
  if (!hasDirectExamLink()) linkedExam = null;
  document.getElementById("h-name").value = "";
  document.getElementById("h-group").value = "";
  document.getElementById("h-code").value = "";
  hideErr("h-err"); hideErr("rl-err");
  updateHomeEntryMode(); goStudentEntryStep(1);
  showPage("pg-home");
}

// ============ DOM Events & Bootstrap ============

function registerDomEvents() {
  document.getElementById("h-name").addEventListener("keydown", (event) => { if (event.key === "Enter") homeEnter(); });
  document.getElementById("h-code").addEventListener("input", function () { this.value = sanitizeCode(this.value); });
  document.getElementById("h-code").addEventListener("keydown", (event) => { if (event.key === "Enter") continueStudentEntry(); });
  document.getElementById("rl-code").addEventListener("keydown", (event) => { if (event.key === "Enter") lookupPublishedResult(); });
  document.getElementById("rl-token").addEventListener("keydown", (event) => { if (event.key === "Enter") lookupPublishedResult(); });
  document.getElementById("al-user").addEventListener("keydown", (event) => { if (event.key === "Enter") adminLogin(); });
  document.getElementById("al-pass").addEventListener("keydown", (event) => { if (event.key === "Enter") adminLogin(); });
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
