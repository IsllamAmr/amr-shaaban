// ============================================================
// js/admin.js — All admin logic: auth, dashboard, exams, banks, results
// Depends on: app-state.js, utils.js, api.js, ui-helpers.js
// ============================================================

// ============ Admin Auth ============

function updateAdminLoginView() {
  const title = document.getElementById("al-title");
  const helper = document.getElementById("al-helper");
  const button = document.getElementById("al-action-btn");
  const tag = document.getElementById("al-mode-tag");
  const username = document.getElementById("al-user");
  const password = document.getElementById("al-pass");
  if (!title || !helper || !button || !tag || !username || !password) return;
  tag.textContent = isAdminAuthenticated ? "جلسة أدمن نشطة" : "دخول الأدمن";
  title.textContent = "دخول المدرس";
  helper.textContent = isAdminAuthenticated
    ? "تم التحقق من جلسة الأدمن عبر السيرفر. يمكنك فتح لوحة التحكم بأمان."
    : "أدخل اسم المستخدم وكلمة المرور ليتم التحقق منهما عبر السيرفر ثم فتح لوحة التحكم.";
  button.textContent = isAdminAuthenticated ? "تجديد الدخول" : "دخول";
  username.placeholder = "مثال: admin";
  password.placeholder = "أدخل كلمة المرور";
}

async function ensureAdminAccess() {
  if (isAdminAuthenticated && adminUid) return;
  const session = await syncAdminSession();
  if (!session.authenticated) throw new Error("سجّل دخول المدرس أولًا.");
}

async function adminLogin() {
  const usernameInput = document.getElementById("al-user").value;
  const passwordInput = document.getElementById("al-pass").value;
  const errorEl = document.getElementById("al-err");
  const actionButton = document.getElementById("al-action-btn");
  hideErr("al-err");
  hideNotice();
  const username = String(usernameInput || "").trim();
  const password = String(passwordInput || "").trim();
  if (!username) { showErr(errorEl, "أدخل اسم المستخدم."); return; }
  if (!password) { showErr(errorEl, "أدخل كلمة المرور."); return; }
  setButtonLoading(actionButton, true, "جارٍ التحقق...");
  try {
    const payload = await requestServerJson("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    isAdminAuthenticated = true;
    adminUid = payload.adminUid;
    document.getElementById("al-pass").value = "";
    updateAdminLoginView();
    showNotice(`✅ تم تسجيل دخول ${payload.adminName || "الأدمن"} عبر السيرفر بنجاح`);
    await goPage("pg-admindash");
  } catch (error) {
    showErr(errorEl, `❌ ${mapFirebaseError(error, "تعذر تسجيل الدخول عبر السيرفر.")}`);
  } finally {
    setButtonLoading(actionButton, false);
  }
}

async function adminLogout() {
  try {
    await requestServerJson("/api/admin/logout", { method: "POST", body: JSON.stringify({}) });
  } catch (error) {
    console.warn("تعذر إنهاء جلسة السيرفر:", error);
  }
  isAdminAuthenticated = false;
  adminUid = null;
  document.getElementById("al-pass").value = "";
  updateAdminLoginView();
  showNotice("✅ تم تسجيل خروج الأدمن");
  await goPage("pg-adminlogin");
}

// ============ Dashboard ============

function buildSubmissionList(submissionMap, correctAnswers, total) {
  return Object.entries(submissionMap || {}).map(([id, item]) => {
    const answers = normalizeAnswers(item.answers, total);
    const score = calculateScore(correctAnswers, answers);
    const answeredCount = toNumericValue(item.answeredCount, answers.filter((a) => a >= 0).length);
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
  }).sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
}

async function loadAdminDashboard() {
  try {
    await ensureAdminAccess();
    const data = await requestServerJson("/api/admin/dashboard", { method: "GET" });
    exams = (data.exams || []).map((exam) => ({ ...exam, questions: normalizeQuestions(exam.questions) }));
    renderDash({
      summary: data.summary || { examCount: exams.length, studentCount: 0, averageScore: 0 },
      exams,
      chartsHtml: buildDashboardCharts(exams, data.allResults || [])
    });
    return true;
  } catch (error) {
    const message = mapFirebaseError(error, "تعذر تحميل لوحة التحكم.");
    if (message.includes("سجّل دخول")) { showErr(document.getElementById("al-err"), message); showPage("pg-adminlogin"); return false; }
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
    container.innerHTML = `<div class="empty-state">لا توجد امتحانات بعد<br><span>ابدأ بإنشاء أول امتحان الآن.</span></div>`;
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
        <span class="badge ${exam.active ? "badge-green" : "badge-red"}" style="white-space:nowrap">${exam.active ? "✅ متاح" : "⛔ مغلق"}</span>
      </div>
      <div class="divider"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm ${exam.active ? "btn-red" : "btn-green"}" onclick="toggleExam('${exam.id}')">${exam.active ? "⛔ إغلاق" : "✅ فتح"}</button>
        <button class="btn btn-sm btn-outline" onclick="copyExamLink('${exam.id}')">🔗 نسخ الرابط</button>
        <button class="btn btn-sm btn-gold" onclick="viewResults('${exam.id}')">📊 النتائج (${exam.resultCount})</button>
        <button class="btn btn-sm btn-outline" onclick="deleteExam('${exam.id}')">🗑 حذف الامتحان</button>
      </div>
    </div>
  `).join("");
}

// ============ Navigation ============

async function goPage(id) {
  if (id === "pg-adminlogin") {
    try { await refreshAdminMode(); } catch (error) { showErr(document.getElementById("al-err"), mapFirebaseError(error, "تعذر قراءة حالة حساب المدرس.")); }
  }
  if (ADMIN_PAGES.has(id)) {
    try {
      if (id === "pg-admindash" || id === "pg-createexam") {
        const loaded = await loadAdminDashboard();
        if (!loaded) return;
      } else {
        await ensureAdminAccess();
      }
      if (id === "pg-createexam") await initCreateExam();
      if (id === "pg-banks") await loadQuestionBanksPage();
    } catch (error) {
      const message = mapFirebaseError(error, "تعذر فتح الصفحة المطلوبة.");
      if (message.includes("سجّل دخول")) { showErr(document.getElementById("al-err"), message); showPage("pg-adminlogin"); return; }
      alert(message);
      return;
    }
  }
  showPage(id);
}

// ============ Exam Management ============

function mapQuestionBankList(bankMap) {
  const entries = Array.isArray(bankMap) ? bankMap.map((bank) => [bank.id, bank]) : Object.entries(bankMap || {});
  return entries.map(([id, bank]) => ({
    id,
    title: sanitizePlainText(bank.title, "بنك بدون اسم"),
    description: sanitizePlainText(bank.description, ""),
    createdAt: bank.createdAt || 0,
    updatedAt: bank.updatedAt || 0,
    questions: normalizeQuestions(bank.questions),
    questionCount: Array.isArray(bank.questions) ? bank.questions.length : Object.keys(bank.questions || {}).length
  })).sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
}

async function loadQuestionBanks() {
  await ensureAdminAccess();
  const payload = await requestServerJson("/api/admin/question-banks", { method: "GET" });
  questionBanks = mapQuestionBankList(payload.banks || []);
  return questionBanks;
}

function getBankById(bankId) { return questionBanks.find((bank) => bank.id === bankId) || null; }

function buildDifficultyOptions(selectedValue) {
  return DIFFICULTY_LEVELS.map((item) => `<option value="${item.value}" ${item.value === normalizeDifficulty(selectedValue) ? "selected" : ""}>${item.label}</option>`).join("");
}

function buildDifficultySummary(questionList) {
  if (!questionList.length) return "لا توجد أسئلة بعد.";
  const counts = DIFFICULTY_LEVELS.map((level) => ({ label: level.label, count: questionList.filter((q) => normalizeDifficulty(q.difficulty) === level.value).length })).filter((item) => item.count > 0);
  return counts.map((item) => `${item.label}: ${item.count}`).join(" • ");
}

function showBankNote(message) {
  const note = document.getElementById("qb-note");
  if (!note) return;
  note.style.display = "block";
  note.textContent = message;
}

function hideBankNote() {
  const note = document.getElementById("qb-note");
  if (!note) return;
  note.style.display = "none";
  note.textContent = "";
}

async function copyExamLink(examId) {
  const exam = exams.find((item) => item.id === examId);
  if (!exam) { alert("تعذر العثور على الامتحان المطلوب."); return; }
  const examLink = buildExamShareLink(examId);
  try { await navigator.clipboard.writeText(examLink); alert(`تم نسخ رابط الامتحان:\n${examLink}`); }
  catch (error) { window.prompt("انسخ رابط الامتحان من هنا:", examLink); }
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
  setTimeout(() => { const field = document.getElementById(`qt-${question.id}`); if (field) field.focus(); }, 100);
}

function removeQuestion(id) { questions = questions.filter((q) => q.id !== id); renderQuestions(); }

function renderQuestions() {
  const container = document.getElementById("ce-questions");
  if (!questions.length) {
    container.innerHTML = `<div class="card" style="margin-bottom:22px;text-align:center"><div style="font-size:42px;margin-bottom:10px">🧩</div><div style="font-size:18px;font-weight:800;color:var(--gd);margin-bottom:8px">لم تضف أسئلة للامتحان بعد</div><div style="color:var(--tm);font-size:14px;line-height:1.9">يمكنك استيراد أي سؤال من أحد البنوك، أو إضافة سؤال جديد من عندك بالكامل.</div></div>`;
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
      <div class="source-note" style="margin-bottom:12px">${question.sourceBankTitle ? `📚 مستورد من بنك: <strong>${escapeHtml(question.sourceBankTitle)}</strong>، ويمكنك تعديله بحرية قبل الحفظ.` : "✍️ سؤال مضاف يدويًا من المدرس."}</div>
      <div class="difficulty-row">
        <div style="color:var(--tm);font-size:13px;line-height:1.8">غيّر الصعوبة أو عدّل نص السؤال واختياراته كما تريد.</div>
        <div class="inp-wrap difficulty-select" style="margin-bottom:0">
          <label class="label">درجة الصعوبة</label>
          <select class="inp" onchange="qSetDifficulty('${question.id}', this.value)">${buildDifficultyOptions(question.difficulty)}</select>
        </div>
      </div>
      <div class="inp-wrap"><label class="label">نص السؤال</label><textarea class="inp" id="qt-${question.id}" rows="2" placeholder="اكتب السؤال هنا..." oninput="qSetText('${question.id}', this.value)">${escapeHtml(question.text)}</textarea></div>
      <div class="attachment-editor">
        <div class="attachment-editor-head"><span class="label" style="margin-bottom:0">إرفاق صورة أو ملف اختياري</span><span class="attachment-hint">الحد الأقصى ${humanFileSize(QUESTION_ATTACHMENT_MAX_SIZE)}</span></div>
        <div class="attachment-actions">
          <label class="btn btn-outline btn-sm file-picker-btn">رفع مرفق<input type="file" accept="${QUESTION_ATTACHMENT_ACCEPT}" onchange="qUploadAttachment('${question.id}', this)"></label>
          ${question.attachment ? `<button class="btn btn-sm btn-red" onclick="qRemoveAttachment('${question.id}')">حذف المرفق</button>` : ""}
        </div>
        ${question.attachment ? renderQuestionAttachment(question.attachment, { compact: true }) : '<div class="attachment-placeholder">لا يوجد مرفق لهذا السؤال.</div>'}
      </div>
      <div style="font-weight:700;color:var(--gm);font-size:13px;margin-bottom:10px">اختر الإجابة الصحيحة من الزر الجانبي.</div>
      ${question.type === "mcq" ? question.options.map((option, optionIndex) => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <button onclick="qSetCorrect('${question.id}', ${optionIndex})" title="حدد كإجابة صحيحة" style="min-width:36px;height:36px;border-radius:50%;border:2px solid ${question.correct === optionIndex ? "var(--gm)" : "var(--cd)"};background:${question.correct === optionIndex ? "var(--gm)" : "#fff"};color:${question.correct === optionIndex ? "#fff" : "var(--tm)"};font-weight:800;font-size:14px;cursor:pointer;transition:all .2s;flex-shrink:0">${MCQ_LABELS[optionIndex]}</button>
          <input class="inp" style="flex:1" placeholder="اكتب الاختيار ${MCQ_LABELS[optionIndex]}" value="${escapeHtml(option)}" oninput="qSetOption('${question.id}', ${optionIndex}, this.value)" />
        </div>
      `).join("") : `<div style="display:flex;gap:14px">${TF_LABELS.map((option, optionIndex) => `<button onclick="qSetCorrect('${question.id}', ${optionIndex})" style="flex:1;padding:12px;border-radius:10px;border:2px solid ${question.correct === optionIndex ? "var(--gm)" : "var(--cd)"};background:${question.correct === optionIndex ? "var(--gm)" : "#fff"};color:${question.correct === optionIndex ? "#fff" : "var(--td)"};font-size:17px;font-weight:800;cursor:pointer;transition:all .2s">${question.correct === optionIndex ? "✓ " : ""}${option}</button>`).join("")}</div>`}
    </div>
  `).join("");
}

function qSetText(id, value) { const q = questions.find((item) => item.id === id); if (q) q.text = value; }
function qSetOption(id, optionIndex, value) { const q = questions.find((item) => item.id === id); if (q) q.options[optionIndex] = value; }
function qSetCorrect(id, optionIndex) { const q = questions.find((item) => item.id === id); if (q) { q.correct = optionIndex; renderQuestions(); } }
function qSetDifficulty(id, value) { const q = questions.find((item) => item.id === id); if (q) { q.difficulty = normalizeDifficulty(value); renderQuestions(); } }

async function qUploadAttachment(id, input) {
  const file = input.files?.[0];
  if (!file) return;
  if (!isSupportedAttachmentFile(file)) { alert("الملف غير مدعوم."); input.value = ""; return; }
  if (file.size > QUESTION_ATTACHMENT_MAX_SIZE) { alert(`حجم الملف أكبر من المسموح. الحد الأقصى هو ${humanFileSize(QUESTION_ATTACHMENT_MAX_SIZE)}.`); input.value = ""; return; }
  try { const q = questions.find((item) => item.id === id); if (!q) return; await deleteTemporaryAttachment(q.attachment); q.attachment = await uploadAttachmentToServer(file); renderQuestions(); }
  catch (error) { alert(error.message || "تعذر رفع الملف."); }
  finally { input.value = ""; }
}

async function qRemoveAttachment(id) {
  const q = questions.find((item) => item.id === id);
  if (!q) return;
  await deleteTemporaryAttachment(q.attachment);
  q.attachment = null;
  renderQuestions();
}

function renderBankImportSection() {
  const panel = document.getElementById("ce-bank-panel");
  if (!panel) return;
  if (!questionBanks.length) { panel.innerHTML = `<div class="muted-note">لا توجد بنوك أسئلة بعد. أنشئ أول بنك الآن، ثم ارجع هنا لاستيراد ما تريد منه.</div>`; return; }
  const selectedBank = getBankById(selectedImportBankId) || questionBanks[0];
  selectedImportBankId = selectedBank.id;
  panel.innerHTML = `
    <div class="grid2" style="margin-bottom:16px">
      <div class="inp-wrap"><label class="label">اختر البنك المرجعي</label>
        <select class="inp" onchange="selectImportBank(this.value)">${questionBanks.map((bank) => `<option value="${bank.id}" ${bank.id === selectedBank.id ? "selected" : ""}>${escapeHtml(bank.title)} (${bank.questionCount})</option>`).join("")}</select>
      </div>
      <div class="muted-note">${escapeHtml(selectedBank.description || "هذا البنك جاهز لتكوين الامتحانات الجديدة.")}<br><strong>التوزيع:</strong> ${escapeHtml(buildDifficultySummary(selectedBank.questions))}</div>
    </div>
    <div class="question-actions" style="margin-bottom:14px"><button class="btn btn-gold btn-sm" onclick="addAllQuestionsFromBank('${selectedBank.id}')">إضافة كل أسئلة البنك</button></div>
    <div class="bank-import-list">${selectedBank.questions.length ? selectedBank.questions.map((question, index) => `
      <div class="bank-import-item">
        <div class="flex-between" style="margin-bottom:10px">
          <div style="font-weight:800;color:var(--gd);font-size:15px">سؤال ${index + 1}<span class="badge badge-gold" style="margin-right:8px">${question.type === "mcq" ? "اختياري" : "صح / خطأ"}</span><span class="badge ${getDifficultyBadgeClass(question.difficulty)}">${getDifficultyLabel(question.difficulty)}</span></div>
          <button class="btn btn-sm btn-green" onclick="addQuestionFromBank('${selectedBank.id}', '${escapeAttribute(question.id)}')">+ إضافة</button>
        </div>
        <div style="font-size:15px;font-weight:700;color:var(--td);line-height:1.9;margin-bottom:8px">${escapeHtml(question.text)}</div>
        <div class="source-note">${question.attachment ? "📎 يحتوي على مرفق" : "بدون مرفقات"} • ${question.type === "mcq" ? "4 اختيارات" : "صح / خطأ"}</div>
      </div>
    `).join("") : `<div class="muted-note">هذا البنك ما زال فارغًا. أضف إليه أسئلة من صفحة البنوك أولًا.</div>`}</div>
  `;
}

function selectImportBank(bankId) { selectedImportBankId = bankId; renderBankImportSection(); }

async function addQuestionFromBank(bankId, questionId) {
  try {
    await ensureAdminAccess();
    const payload = await requestServerJson(`/api/admin/question-banks/${encodeURIComponent(bankId)}/import`, { method: "POST", body: JSON.stringify({ questionIds: [questionId] }) });
    const imported = normalizeQuestions(payload.questions);
    if (!imported.length) return;
    questions.push(...imported);
    renderQuestions();
  } catch (error) { alert(mapFirebaseError(error, "تعذر استيراد السؤال من بنك الأسئلة.")); }
}

async function addAllQuestionsFromBank(bankId) {
  try {
    await ensureAdminAccess();
    const payload = await requestServerJson(`/api/admin/question-banks/${encodeURIComponent(bankId)}/import`, { method: "POST", body: JSON.stringify({}) });
    const imported = normalizeQuestions(payload.questions);
    if (!imported.length) return;
    questions.push(...imported);
    renderQuestions();
  } catch (error) { alert(mapFirebaseError(error, "تعذر استيراد أسئلة البنك.")); }
}

async function saveExam() {
  const title = document.getElementById("ce-title").value.trim();
  const code = sanitizeCode(document.getElementById("ce-code").value);
  const duration = Number.parseInt(document.getElementById("ce-dur").value, 10) || 30;
  const err = document.getElementById("ce-err");
  hideErr("ce-err");
  if (!title) { showErr(err, "أدخل عنوان الامتحان."); return; }
  if (!/^[A-Z0-9_-]{2,20}$/.test(code)) { showErr(err, "كود الامتحان يجب أن يكون من حرفين إلى 20 حرفًا أو رقمًا بدون مسافات."); return; }
  if (!questions.length) { showErr(err, "أضف سؤالًا واحدًا على الأقل، سواء من البنك أو من عندك."); return; }
  for (let index = 0; index < questions.length; index++) {
    const q = questions[index];
    if (!q.text.trim()) { showErr(err, `أدخل نص السؤال ${index + 1}.`); return; }
    if (q.correct < 0) { showErr(err, `حدد الإجابة الصحيحة للسؤال ${index + 1}.`); return; }
    if (q.type === "mcq" && q.options.some((o) => !o.trim())) { showErr(err, `أدخل جميع اختيارات السؤال ${index + 1}.`); return; }
  }
  try {
    await ensureAdminAccess();
    await requestServerJson("/api/admin/exams", { method: "POST", body: JSON.stringify({ title, code, duration, questions: sanitizeQuestionList(questions) }) });
    await loadAdminDashboard();
    showPage("pg-admindash");
  } catch (error) { showErr(err, mapFirebaseError(error, "تعذر حفظ الامتحان.")); }
}

async function toggleExam(id) {
  try {
    await ensureAdminAccess();
    const exam = exams.find((item) => item.id === id);
    if (!exam) throw new Error("الامتحان غير موجود.");
    await requestServerJson(`/api/admin/exams/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ active: !exam.active }) });
    await loadAdminDashboard();
  } catch (error) { alert(mapFirebaseError(error, "تعذر تحديث حالة الامتحان.")); }
}

async function deleteExam(id) {
  if (!confirm("هل أنت متأكد من حذف هذا الامتحان نهائيًا؟ سيتم حذف جميع تسليماته أيضًا.")) return;
  try {
    await ensureAdminAccess();
    await requestServerJson(`/api/admin/exams/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadAdminDashboard();
  } catch (error) { alert(mapFirebaseError(error, "تعذر حذف الامتحان.")); }
}

// ============ Question Banks ============

function resetBankEditor(createStarterQuestion = true) {
  activeBankId = null; activeBankUpdatedAt = 0; bankQuestions = []; bankQuestionCounter = 0;
  document.getElementById("qb-name").value = "";
  document.getElementById("qb-description").value = "";
  document.getElementById("qb-editor-title").textContent = "بنك جديد";
  document.getElementById("qb-editor-subtitle").textContent = "اكتب اسم البنك ثم أضف إليه الأسئلة التي تريد الرجوع إليها لاحقًا.";
  document.getElementById("qb-delete-btn").style.display = "none";
  hideErr("qb-err"); hideBankNote();
  if (createStarterQuestion) bankQuestions.push(createEmptyQuestion("mcq", createBankQuestionId));
  renderBankList(); renderBankQuestions();
}

function openBankEditor(bankId) {
  const bank = getBankById(bankId);
  if (!bank) return;
  activeBankId = bank.id; activeBankUpdatedAt = Number(bank.updatedAt || bank.createdAt || 0); bankQuestionCounter = 0;
  bankQuestions = bank.questions.map((q) => ({ ...createEmptyQuestion(q.type, createBankQuestionId), text: q.text, options: [...q.options], correct: q.correct, attachment: normalizeAttachment(q.attachment), difficulty: normalizeDifficulty(q.difficulty) }));
  document.getElementById("qb-name").value = bank.title;
  document.getElementById("qb-description").value = bank.description || "";
  document.getElementById("qb-editor-title").textContent = bank.title;
  document.getElementById("qb-editor-subtitle").textContent = `${bank.questionCount} سؤال • ${buildDifficultySummary(bank.questions)}`;
  document.getElementById("qb-delete-btn").style.display = "inline-flex";
  hideErr("qb-err"); hideBankNote();
  renderBankList(); renderBankQuestions();
}

function renderBankList() {
  const container = document.getElementById("qb-list");
  if (!container) return;
  if (!questionBanks.length) { container.innerHTML = `<div class="muted-note">لم يتم إنشاء أي بنك بعد. ابدأ ببنك النصوص أو بنك النحو ثم أضف أسئلتك إليه.</div>`; return; }
  container.innerHTML = questionBanks.map((bank) => `
    <div class="bank-item ${bank.id === activeBankId ? "active" : ""}" onclick="openBankEditor('${bank.id}')">
      <div class="bank-item-title">${escapeHtml(bank.title)}</div>
      <div class="bank-item-meta">${escapeHtml(bank.description || "بدون وصف")}<br>${bank.questionCount} سؤال • ${escapeHtml(buildDifficultySummary(bank.questions))}</div>
    </div>
  `).join("");
}

function addBankQuestion(type) {
  const question = createEmptyQuestion(type, createBankQuestionId);
  bankQuestions.push(question);
  renderBankQuestions();
  setTimeout(() => { const field = document.getElementById(`bqt-${question.id}`); if (field) field.focus(); }, 100);
}

function removeBankQuestion(id) { bankQuestions = bankQuestions.filter((q) => q.id !== id); renderBankQuestions(); }

function renderBankQuestions() {
  const container = document.getElementById("qb-questions");
  if (!container) return;
  if (!bankQuestions.length) { container.innerHTML = `<div class="muted-note" style="margin-top:14px">هذا البنك لا يحتوي أسئلة بعد. أضف سؤالًا واحدًا على الأقل حتى يظهر هنا.</div>`; return; }
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
        <div style="color:var(--tm);font-size:13px;line-height:1.8">هذا السؤال سيكون مرجعًا متاحًا عند إنشاء الامتحانات الجديدة.</div>
        <div class="inp-wrap difficulty-select" style="margin-bottom:0"><label class="label">درجة الصعوبة</label><select class="inp" onchange="bankQSetDifficulty('${question.id}', this.value)">${buildDifficultyOptions(question.difficulty)}</select></div>
      </div>
      <div class="inp-wrap"><label class="label">نص السؤال</label><textarea class="inp" id="bqt-${question.id}" rows="2" placeholder="اكتب السؤال هنا..." oninput="bankQSetText('${question.id}', this.value)">${escapeHtml(question.text)}</textarea></div>
      <div class="attachment-editor">
        <div class="attachment-editor-head"><span class="label" style="margin-bottom:0">إرفاق صورة أو ملف اختياري</span><span class="attachment-hint">الحد الأقصى ${humanFileSize(QUESTION_ATTACHMENT_MAX_SIZE)}</span></div>
        <div class="attachment-actions">
          <label class="btn btn-outline btn-sm file-picker-btn">رفع مرفق<input type="file" accept="${QUESTION_ATTACHMENT_ACCEPT}" onchange="bankQUploadAttachment('${question.id}', this)"></label>
          ${question.attachment ? `<button class="btn btn-sm btn-red" onclick="bankQRemoveAttachment('${question.id}')">حذف المرفق</button>` : ""}
        </div>
        ${question.attachment ? renderQuestionAttachment(question.attachment, { compact: true }) : '<div class="attachment-placeholder">لا يوجد مرفق لهذا السؤال.</div>'}
      </div>
      <div style="font-weight:700;color:var(--gm);font-size:13px;margin-bottom:10px">اختر الإجابة الصحيحة من الزر الجانبي.</div>
      ${question.type === "mcq" ? question.options.map((option, optionIndex) => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><button onclick="bankQSetCorrect('${question.id}', ${optionIndex})" style="min-width:36px;height:36px;border-radius:50%;border:2px solid ${question.correct === optionIndex ? "var(--gm)" : "var(--cd)"};background:${question.correct === optionIndex ? "var(--gm)" : "#fff"};color:${question.correct === optionIndex ? "#fff" : "var(--tm)"};font-weight:800;font-size:14px;cursor:pointer;transition:all .2s;flex-shrink:0">${MCQ_LABELS[optionIndex]}</button><input class="inp" style="flex:1" placeholder="اكتب الاختيار ${MCQ_LABELS[optionIndex]}" value="${escapeHtml(option)}" oninput="bankQSetOption('${question.id}', ${optionIndex}, this.value)" /></div>`).join("") : `<div style="display:flex;gap:14px">${TF_LABELS.map((option, optionIndex) => `<button onclick="bankQSetCorrect('${question.id}', ${optionIndex})" style="flex:1;padding:12px;border-radius:10px;border:2px solid ${question.correct === optionIndex ? "var(--gm)" : "var(--cd)"};background:${question.correct === optionIndex ? "var(--gm)" : "#fff"};color:${question.correct === optionIndex ? "#fff" : "var(--td)"};font-size:17px;font-weight:800;cursor:pointer;transition:all .2s">${question.correct === optionIndex ? "✓ " : ""}${option}</button>`).join("")}</div>`}
    </div>
  `).join("");
}

function bankQSetText(id, v) { const q = bankQuestions.find((i) => i.id === id); if (q) q.text = v; }
function bankQSetOption(id, idx, v) { const q = bankQuestions.find((i) => i.id === id); if (q) q.options[idx] = v; }
function bankQSetCorrect(id, idx) { const q = bankQuestions.find((i) => i.id === id); if (q) { q.correct = idx; renderBankQuestions(); } }
function bankQSetDifficulty(id, v) { const q = bankQuestions.find((i) => i.id === id); if (q) { q.difficulty = normalizeDifficulty(v); renderBankQuestions(); } }

async function bankQUploadAttachment(id, input) {
  const file = input.files?.[0];
  if (!file) return;
  if (!isSupportedAttachmentFile(file)) { alert("الملف غير مدعوم."); input.value = ""; return; }
  if (file.size > QUESTION_ATTACHMENT_MAX_SIZE) { alert(`حجم الملف أكبر من المسموح. الحد الأقصى هو ${humanFileSize(QUESTION_ATTACHMENT_MAX_SIZE)}.`); input.value = ""; return; }
  try { const q = bankQuestions.find((i) => i.id === id); if (!q) return; await deleteTemporaryAttachment(q.attachment); q.attachment = await uploadAttachmentToServer(file); renderBankQuestions(); }
  catch (error) { alert(error.message || "تعذر رفع الملف."); }
  finally { input.value = ""; }
}

async function bankQRemoveAttachment(id) {
  const q = bankQuestions.find((i) => i.id === id);
  if (!q) return;
  await deleteTemporaryAttachment(q.attachment);
  q.attachment = null;
  renderBankQuestions();
}

async function loadQuestionBanksPage() {
  await loadQuestionBanks();
  if (activeBankId && getBankById(activeBankId)) { openBankEditor(activeBankId); return; }
  if (questionBanks.length) { openBankEditor(questionBanks[0].id); return; }
  resetBankEditor(true);
}

async function saveQuestionBank() {
  const name = document.getElementById("qb-name").value.trim();
  const description = document.getElementById("qb-description").value.trim();
  const err = document.getElementById("qb-err");
  const saveButton = document.getElementById("qb-save-btn");
  hideErr("qb-err"); hideBankNote();
  if (isQuestionBankSaving) return;
  if (!name) { showErr(err, "اكتب اسم البنك أولًا."); return; }
  if (!bankQuestions.length) { showErr(err, "أضف سؤالًا واحدًا على الأقل داخل البنك."); return; }
  for (let i = 0; i < bankQuestions.length; i++) {
    const q = bankQuestions[i];
    if (!q.text.trim()) { showErr(err, `أدخل نص سؤال البنك ${i + 1}.`); return; }
    if (q.correct < 0) { showErr(err, `حدد الإجابة الصحيحة لسؤال البنك ${i + 1}.`); return; }
    if (q.type === "mcq" && q.options.some((o) => !o.trim())) { showErr(err, `أدخل جميع اختيارات سؤال البنك ${i + 1}.`); return; }
  }
  try {
    isQuestionBankSaving = true;
    setButtonLoading(saveButton, true, "جارٍ حفظ البنك...");
    await ensureAdminAccess();
    const sanitizedQuestions = sanitizeQuestionList(bankQuestions).map((q) => ({ id: q.id, type: q.type, text: q.text, options: q.options, correct: q.correct, attachment: q.attachment || null, difficulty: q.difficulty }));
    const debugRequestId = createClientDebugId(activeBankId ? "qb-update" : "qb-create");
    const method = activeBankId ? "PATCH" : "POST";
    const endpoint = activeBankId ? `/api/admin/question-banks/${encodeURIComponent(activeBankId)}` : "/api/admin/question-banks";
    const payload = await requestServerJson(endpoint, { method, body: JSON.stringify({ debugRequestId, expectedUpdatedAt: activeBankUpdatedAt, title: name, description, questions: sanitizedQuestions }) });
    const savedBankId = payload.bank?.id || activeBankId;
    await loadQuestionBanks();
    activeBankId = savedBankId;
    openBankEditor(savedBankId);
    renderBankImportSection();
    showBankNote("تم حفظ البنك بنجاح.");
  } catch (error) { showErr(err, mapFirebaseError(error, "تعذر حفظ بنك الأسئلة.")); }
  finally { isQuestionBankSaving = false; setButtonLoading(saveButton, false); }
}

async function deleteQuestionBank() {
  if (!activeBankId || isQuestionBankDeleting) return;
  if (!confirm("هل أنت متأكد من حذف هذا البنك؟ سيتم حذف كل أسئلته من المرجع.")) return;
  try {
    isQuestionBankDeleting = true;
    setButtonLoading("qb-delete-btn", true, "جارٍ حذف البنك...");
    await ensureAdminAccess();
    const deletedId = activeBankId;
    const debugRequestId = createClientDebugId("qb-delete");
    await requestServerJson(`/api/admin/question-banks/${encodeURIComponent(deletedId)}`, { method: "DELETE", body: JSON.stringify({ debugRequestId }) });
    if (selectedImportBankId === deletedId) selectedImportBankId = "";
    await loadQuestionBanks();
    renderBankImportSection();
    if (questionBanks.length) openBankEditor(questionBanks[0].id); else resetBankEditor(true);
    showBankNote("تم حذف البنك بنجاح.");
  } catch (error) { showErr(document.getElementById("qb-err"), mapFirebaseError(error, "تعذر حذف بنك الأسئلة.")); }
  finally { isQuestionBankDeleting = false; setButtonLoading("qb-delete-btn", false); }
}

// ============ Results ============

async function viewResults(id) {
  try {
    await ensureAdminAccess();
    const data = await requestServerJson(`/api/admin/exams/${encodeURIComponent(id)}/results`, { method: "GET" });
    renderAdminResults({ ...data.exam, id, questions: normalizeQuestions(data.exam?.questions) }, data.results || [], data.correctAnswers || []);
    showPage("pg-adminresults");
  } catch (error) { alert(mapFirebaseError(error, "تعذر تحميل النتائج.")); }
}

async function publishExamResults() {
  const exam = adminResultsState.exam;
  const results = adminResultsState.results || [];
  if (!exam) { alert("افتح نتائج الامتحان أولًا ثم انشرها للطلاب."); return; }
  if (!results.length) { alert("لا توجد نتائج منشورة لهذا الامتحان بعد."); return; }
  try {
    await ensureAdminAccess();
    await requestServerJson(`/api/admin/exams/${encodeURIComponent(exam.id)}/publish-results`, { method: "POST", body: JSON.stringify({}) });
    alert("تم نشر النتائج بنجاح. يمكن للطلاب الآن مراجعة نتائجهم باستخدام كود الامتحان ورقم المتابعة.");
  } catch (error) { alert(mapFirebaseError(error, "تعذر نشر النتائج للطلاب.")); }
}

function buildAdminReviewMarkup(exam, result, options = {}) {
  const { printable = false } = options;
  const metaColor = printable ? "#666" : "var(--tm)";
  const textColor = printable ? "#1a1a1a" : "var(--td)";
  const wrongColor = printable ? "#c0392b" : "var(--red)";
  return exam.questions.map((question, index) => {
    const studentAnswer = result.answers[index];
    const correctAnswer = exam.correctAnswers[index];
    const isCorrect = studentAnswer === correctAnswer;
    const attachmentHtml = question.attachment ? renderQuestionAttachment(question.attachment, { allowDownload: !printable, compact: printable }) : "";
    return `
      <div class="${printable ? "print-card print-question" : "card"}" style="${printable ? "" : `margin-bottom:14px;border-right:5px solid ${isCorrect ? "#2e7d32" : "var(--red)"}`}">
        <div style="font-weight:700;font-size:12px;color:${metaColor};margin-bottom:8px">السؤال ${index + 1} — ${isCorrect ? '<span style="color:#2e7d32">✅ إجابة صحيحة</span>' : `<span style="color:${wrongColor}">❌ إجابة خاطئة</span>`}</div>
        <div style="font-size:16px;font-weight:700;color:${textColor};margin-bottom:14px;font-family:'Amiri',serif;line-height:1.8">${escapeHtml(question.text)}</div>
        ${attachmentHtml}
        ${question.options.map((option, optionIndex) => `
          <div class="${printable ? "print-option" : ""} ${optionIndex === correctAnswer ? "correct" : optionIndex === studentAnswer && studentAnswer !== correctAnswer ? "wrong" : ""}" style="${printable ? "" : `display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;margin-bottom:6px;background:${optionIndex === correctAnswer ? "#e8f5e9" : optionIndex === studentAnswer && studentAnswer !== correctAnswer ? "#fde8e8" : "transparent"};border:1.5px solid ${optionIndex === correctAnswer ? "#2e7d32" : optionIndex === studentAnswer && studentAnswer !== correctAnswer ? "var(--red)" : "var(--cd)"};font-weight:${optionIndex === correctAnswer || optionIndex === studentAnswer ? "700" : "400"}`}">
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
  const average = results.length ? Math.round(results.reduce((s, i) => s + i.pct, 0) / results.length) : 0;
  const passed = results.filter((i) => i.pct >= 50).length;
  document.getElementById("ar-stats").innerHTML = `<div class="stat-card"><div class="stat-num">${results.length}</div><div class="stat-lbl">عدد الطلاب</div></div><div class="stat-card"><div class="stat-num">${average}%</div><div class="stat-lbl">متوسط الدرجات</div></div><div class="stat-card"><div class="stat-num">${passed}</div><div class="stat-lbl">ناجح (50%+)</div></div>`;
  document.getElementById("ar-charts").innerHTML = buildExamResultsCharts(results);
  adminResultsState = { exam: { ...exam, correctAnswers }, byId: Object.fromEntries(results.map((item) => [item.id, item])), results };
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
  if (!result || !exam) return;
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

function printAdminReview() {
  const result = adminResultsState.byId[currentAdminReviewId];
  const exam = adminResultsState.exam;
  if (!result || !exam) return;
  openPrintWindow(`نتيجة ${result.studentName}`, `
    <div class="print-card">
      <div style="font-size:20px;font-weight:800;margin-bottom:8px">${escapeHtml(result.studentName)}</div>
      <div style="color:#555;line-height:1.9">الامتحان: ${escapeHtml(exam.title)}<br>الفصل / المجموعة: ${escapeHtml(result.studentGroup)}<br>وقت التسليم: ${formatDate(result.at)}</div>
      <div class="print-grid"><div class="print-stat"><strong>${result.score}</strong><span>صحيح</span></div><div class="print-stat"><strong>${result.total - result.score}</strong><span>خطأ</span></div><div class="print-stat"><strong>${result.pct}%</strong><span>النسبة</span></div></div>
    </div>
    ${buildAdminReviewMarkup(exam, result, { printable: true })}
  `);
}

function printExcellenceCertificate(resultId = currentAdminReviewId) {
  const result = adminResultsState.byId[resultId];
  const exam = adminResultsState.exam;
  if (!result || !exam) return;
  if (result.pct < 80) { alert("تظهر الشهادة فقط للطلاب الحاصلين على 80% فأكثر."); return; }
  openPrintWindow(`شهادة تفوق - ${result.studentName}`, `
    <div class="print-card" style="border:8px double #c9973a;padding:34px;text-align:center;background:linear-gradient(180deg,#fffdf8 0%,#f7f0de 100%)">
      <div style="font-size:14px;letter-spacing:2px;color:#7a5200;font-weight:700;margin-bottom:12px">شهادة تقدير وتميّز</div>
      <div style="font-size:34px;font-weight:900;color:#0b2e1a;margin-bottom:12px;font-family:'Amiri',serif">شهادة تفوق</div>
      <div style="font-size:16px;color:#555;line-height:1.9;margin-bottom:18px">تُمنح هذه الشهادة إلى الطالب/الطالبة</div>
      <div style="font-size:30px;font-weight:900;color:#1a5235;margin-bottom:16px;font-family:'Amiri',serif">${escapeHtml(result.studentName)}</div>
      <div style="font-size:16px;color:#444;line-height:2;margin-bottom:20px">تقديرًا لتفوقه في <strong>${escapeHtml(exam.title)}</strong><br>بعد تحقيق نسبة <strong>${result.pct}%</strong> بدرجة <strong>${result.score}</strong> من <strong>${result.total}</strong></div>
      <div class="print-grid" style="margin-bottom:22px"><div class="print-stat"><strong>${result.pct}%</strong><span>نسبة الإنجاز</span></div><div class="print-stat"><strong>${escapeHtml(result.studentGroup)}</strong><span>الفصل / المجموعة</span></div><div class="print-stat"><strong>${formatDate(result.at)}</strong><span>تاريخ التسليم</span></div></div>
    </div>
  `);
}
