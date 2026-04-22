// ============================================================
// js/admin.js — All admin logic: auth, dashboard, exams, banks, results
// Depends on: app-state.js, utils.js, api.js, ui-helpers.js
// ============================================================

// ============ Admin Auth ============

function updateAdminLoginView() {
  const sidebar = document.getElementById("admin-sidebar");
  const teacherLink = document.getElementById("nav-teachers");
  if (!isUserAuthenticated) {
    if (sidebar) sidebar.style.display = "none";
    return;
  }
  
  if (teacherLink) {
    teacherLink.style.display = currentRole === 'super_admin' ? 'block' : 'none';
  }
}

async function ensureAdminAccess() {
  if (isUserAuthenticated && (currentRole === 'admin' || currentRole === 'super_admin' || currentRole === 'teacher')) return;
  const session = await syncSession();
  if (session.authenticated && ['admin', 'super_admin', 'teacher'].includes(session.role)) return;
  if (session.authenticated) throw new Error("Access denied.");
  if (!session.authenticated) throw new Error("يجب تسجيل الدخول أولاً.");
}

async function refreshAdminMode() {
  await syncSession({ silent: true });
}

async function adminLogin() {
  await performRoleLogin('al');
}

async function performRoleLogin(prefix) {
  const usernameInput = document.getElementById(`${prefix}-user`).value;
  const passwordInput = document.getElementById(`${prefix}-pass`).value;
  const errorEl = document.getElementById(`${prefix}-err`);
  const actionButton = document.getElementById(`${prefix}-action-btn`);

  hideErr(`${prefix}-err`);
  const username = String(usernameInput || "").trim();
  const password = String(passwordInput || "").trim();

  if (!username) { showErr(errorEl, "أدخل اسم المستخدم."); return; }
  if (!password) { showErr(errorEl, "أدخل كلمة المرور."); return; }

  setButtonLoading(actionButton, true, "جارٍ التحقق...");
  try {
    await requestServerJson("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    // Sync shared session state
    await syncSession();

    document.getElementById(`${prefix}-pass`).value = "";
    updateAdminLoginView();
    await goPage("pg-admindash");
  } catch (error) {
    showErr(errorEl, `❌ ${mapFirebaseError(error, "بيانات الدخول غير صحيحة.")}`);
  } finally {
    setButtonLoading(actionButton, false);
  }
}
async function adminLogout() {
  try {
    await requestServerJson("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
  } catch (error) {
    console.warn("تعذر إنهاء جلسة السيرفر:", error);
  }
  isAdminAuthenticated = false;
  adminUid = null;
  isUserAuthenticated = false;
  currentUser = null;
  currentRole = null;
  
  if (document.getElementById("al-pass")) document.getElementById("al-pass").value = "";
  if (typeof updateAdminLoginView === 'function') updateAdminLoginView();
  
  goHome();
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

window.loadAdminDashboard = loadAdminDashboard;

let teachersState = [];
let currentEditingTeacherId = null;

async function loadAdminTeachers() {
  try {
    const session = await syncSession();
    if (session.role !== 'super_admin') {
      alert("هذه الصفحة متاحة للمسؤول العام فقط.");
      goPage("pg-admindash");
      return;
    }
    const data = await requestServerJson("/api/admin/teachers", { method: "GET" });
    teachersState = data.teachers || [];
    renderTeacherList(teachersState);
  } catch (error) {
    alert(mapFirebaseError(error, "تعذر تحميل قائمة المدرسين."));
  }
}

function renderTeacherList(teachers) {
  const container = document.getElementById("teacher-list-container");
  if (!container) return;
  
  if (!teachers.length) {
    container.innerHTML = `
      <div class="empty-state" style="text-align:center; padding:100px 20px; color:var(--tm); background:rgba(26,40,30,0.02); border-radius:32px; border:2px dashed var(--cd)">
        <div style="font-size:80px; margin-bottom:24px">🧑‍🏫</div>
        <h3 style="font-weight:900; color:var(--gd); font-size:24px">لا يوجد مدرسون حالياً</h3>
        <p style="font-size:16px; margin-top:8px">ابدأ بإضافة أول مدرس للمنصة لتنظيم العملية التعليمية.</p>
        <button class="btn btn-green" style="margin-top:32px" onclick="openAddTeacherModal()">+ إضافة مدرس جديد</button>
      </div>`;
    return;
  }

  container.innerHTML = `
    <div class="saas-table-container">
      <table class="saas-table">
        <thead>
          <tr>
            <th>المدرس</th>
            <th>اسم المستخدم</th>
            <th>المادة</th>
            <th>الحالة</th>
            <th style="text-align:center">إجراءات</th>
          </tr>
        </thead>
        <tbody>
          ${teachers.map((t) => {
            const perms = t.permissions || {};
            const permCount = Object.values(perms).filter(v => v === true).length;
            return `
              <tr>
                <td>
                  <div style="font-weight:900; color:var(--gd); font-size:17px">${escapeHtml(t.name)}</div>
                  <div style="font-size:12px; color:var(--tm); margin-top:4px">صلاحيات نشطة: ${permCount} من 10</div>
                </td>
                <td><span style="font-family:monospace; font-weight:700; color:var(--gl)">${escapeHtml(t.username)}</span></td>
                <td><span style="font-weight:800; color:var(--tm)">${escapeHtml(t.subject || "غير محدد")}</span></td>
                <td>
                  <span class="badge ${t.isActive !== false ? "badge-green" : "badge-red"}">
                    <span style="width:8px; height:8px; border-radius:50%; background:currentColor"></span>
                    ${t.isActive !== false ? "نشط" : "موقف"}
                  </span>
                </td>
                <td>
                  <div style="display:flex; gap:8px; justify-content:center">
                    <button class="btn btn-sm btn-outline" onclick="openEditTeacherModal('${t.uid}')">تعديل و صلاحيات</button>
                    <button class="btn btn-sm btn-outline" style="color:var(--gm)" onclick="openResetTeacherPasswordModal('${t.uid}', '${escapeAttribute(t.name)}')">كلمة المرور</button>
                    <button class="btn btn-sm ${t.isActive !== false ? "btn-outline" : "btn-green"}" style="${t.isActive !== false ? "color:var(--red); border-color:rgba(153,27,27,0.2)" : ""}" onclick="toggleTeacherStatus('${t.uid}', ${t.isActive !== false})">
                      ${t.isActive !== false ? "إيقاف" : "تنشيط"}
                    </button>
                    <button class="btn btn-sm btn-outline" style="color:var(--red); opacity:0.6" onclick="deleteTeacher('${t.uid}')">حذف</button>
                  </div>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function filterTeacherList(query) {
  const normalized = String(query || "").toLowerCase().trim();
  if (!normalized) { renderTeacherList(teachersState); return; }
  const filtered = teachersState.filter(t => 
    escapeHtml(t.name).toLowerCase().includes(normalized) || 
    escapeHtml(t.username).toLowerCase().includes(normalized) ||
    escapeHtml(t.subject || "").toLowerCase().includes(normalized)
  );
  renderTeacherList(filtered);
}

function openAddTeacherModal() {
  currentEditingTeacherId = null;
  document.getElementById("teacher-modal-title").textContent = "إضافة مدرس جديد";
  document.getElementById("mt-pass-wrap").style.display = "block";
  document.getElementById("mt-name").value = "";
  document.getElementById("mt-user").value = "";
  document.getElementById("mt-pass").value = "";
  document.getElementById("mt-subject").value = "";
  
  // Reset permissions to default (all true)
  document.querySelectorAll(".mt-perm").forEach(cb => cb.checked = true);
  
  hideErr("mt-err");
  document.getElementById("teacher-modal").style.display = "flex";
}

function openEditTeacherModal(teacherId) {
  const t = teachersState.find(item => item.uid === teacherId);
  if (!t) return;
  currentEditingTeacherId = teacherId;
  document.getElementById("teacher-modal-title").textContent = "تعديل بيانات المدرس و الصلاحيات";
  document.getElementById("mt-pass-wrap").style.display = "none";
  document.getElementById("mt-name").value = t.name;
  document.getElementById("mt-user").value = t.username;
  document.getElementById("mt-subject").value = t.subject || "";
  
  // Load permissions
  const perms = t.permissions || {};
  document.querySelectorAll(".mt-perm").forEach(cb => {
    cb.checked = perms[cb.value] !== false;
  });
  
  hideErr("mt-err");
  document.getElementById("teacher-modal").style.display = "flex";
}

function closeTeacherModal() {
  document.getElementById("teacher-modal").style.display = "none";
}

async function saveTeacher() {
  const name = document.getElementById("mt-name").value.trim();
  const username = document.getElementById("mt-user").value.trim();
  const password = document.getElementById("mt-pass").value.trim();
  const subject = document.getElementById("mt-subject").value.trim();
  const err = document.getElementById("mt-err");
  const actionButton = document.getElementById("mt-action-btn");

  if (!name || !username) { showErr(err, "يرجى ملء جميع الحقول المطلوبة."); return; }
  if (!currentEditingTeacherId && password.length < 8) { showErr(err, "كلمة المرور يجب أن تكون 8 أحرف على الأقل."); return; }

  // Build permissions object
  const permissions = {};
  document.querySelectorAll(".mt-perm").forEach(cb => {
    permissions[cb.value] = cb.checked;
  });

  setButtonLoading(actionButton, true, "جارٍ الحفظ...");
  try {
    const isEdit = !!currentEditingTeacherId;
    const method = isEdit ? "PATCH" : "POST";
    const url = isEdit ? `/api/admin/teachers/${currentEditingTeacherId}` : "/api/admin/teachers";
    const body = { name, username, subject, permissions };
    if (!isEdit) body.password = password;

    await requestServerJson(url, { method, body: JSON.stringify(body) });
    await loadAdminTeachers();
    closeTeacherModal();
  } catch (error) {
    showErr(err, mapFirebaseError(error, "تعذر حفظ بيانات المدرس."));
  } finally {
    setButtonLoading(actionButton, false);
  }
}

async function toggleTeacherStatus(teacherId, currentActive) {
  try {
    await requestServerJson(`/api/admin/teachers/${teacherId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: !currentActive })
    });
    await loadAdminTeachers();
  } catch (error) {
    alert(mapFirebaseError(error, "تعذر تحديث حالة المدرس."));
  }
}

let resetTeacherPassId = null;
function openResetTeacherPasswordModal(teacherId, name) {
  resetTeacherPassId = teacherId;
  document.getElementById("rtp-teacher-name").textContent = name;
  document.getElementById("rtp-new-pass").value = "";
  hideErr("rtp-err");
  document.getElementById("reset-teacher-pass-modal").style.display = "flex";
}

async function confirmResetTeacherPassword() {
  const password = document.getElementById("rtp-new-pass").value.trim();
  const err = document.getElementById("rtp-err");
  if (password.length < 8) { showErr(err, "كلمة المرور يجب أن تكون 8 أحرف على الأقل."); return; }

  try {
    await requestServerJson(`/api/admin/teachers/${resetTeacherPassId}/reset-password`, {
      method: "PATCH",
      body: JSON.stringify({ password })
    });
    document.getElementById("reset-teacher-pass-modal").style.display = "none";
    alert("تم تغيير كلمة المرور بنجاح.");
  } catch (error) {
    showErr(err, mapFirebaseError(error, "تعذر إعادة تعيين كلمة المرور."));
  }
}

async function deleteTeacher(teacherId) {
  if (!confirm("هل أنت متأكد من حذف هذا المدرس نهائياً؟ لا يمكن التراجع عن هذه العملية.")) return;
  try {
    await requestServerJson(`/api/admin/teachers/${teacherId}`, { method: "DELETE" });
    await loadAdminTeachers();
  } catch (error) {
    alert(mapFirebaseError(error, "تعذر حذف المدرس."));
  }
}

async function goPage(id) {
  if (id === "pg-adminlogin") {
    try { await refreshAdminMode(); } catch (error) { showErr(document.getElementById("al-err"), mapFirebaseError(error, "تعذر قراءة حالة حساب المدرس.")); }
  }
  if (ADMIN_PAGES.has(id)) {
    try {
      if (id === "pg-admindash" || id === "pg-createexam") {
        const loaded = await loadAdminDashboard();
        if (!loaded) return;
      } else if (id === "pg-teacher-students") {
        await loadTeacherStudents();
      } else if (id === "pg-admin-teachers") {
        await loadAdminTeachers();
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
    container.innerHTML = `
      <div class="empty-state" style="text-align:center; padding:60px 20px; color:var(--tm); border:2px dashed var(--cd); border-radius:24px; margin-bottom:32px">
        <div style="font-size:48px; margin-bottom:16px">🧩</div>
        <h3 style="font-weight:900; color:var(--gd)">لم تضف أسئلة للامتحان بعد</h3>
        <p>يمكنك استيراد أسئلة من بنوك الأسئلة أو إضافة سؤال جديد يدوياً.</p>
      </div>`;
    return;
  }
  container.innerHTML = questions.map((question, index) => `
    <div class="card" style="margin-bottom:24px; border:1px solid ${question.correct >= 0 ? "var(--gl)" : "var(--cd)"}; position:relative">
      <div class="flex-between" style="margin-bottom:16px">
        <div style="display:flex; align-items:center; gap:12px">
          <span style="background:var(--gd); color:var(--wh); width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:12px">${index + 1}</span>
          <span class="badge badge-gold" style="font-size:11px">${question.type === "mcq" ? "اختياري" : "صح / خطأ"}</span>
          <span class="badge ${getDifficultyBadgeClass(question.difficulty)}" style="font-size:11px">${getDifficultyLabel(question.difficulty)}</span>
          ${question.correct >= 0 ? '<span class="badge badge-green" style="font-size:10px">✓ مكتمل</span>' : '<span class="badge badge-red" style="font-size:10px">! ناقص</span>'}
        </div>
        <button class="btn btn-sm btn-outline" style="color:var(--red); border-color:rgba(239,68,68,0.1)" onclick="removeQuestion('${question.id}')">حذف</button>
      </div>
      
      ${question.sourceBankTitle ? `<div style="font-size:12px; color:var(--tm); background:#f8fafc; padding:8px 16px; border-radius:8px; margin-bottom:16px">📚 مستورد من: <strong>${escapeHtml(question.sourceBankTitle)}</strong></div>` : ""}

      <div class="inp-wrap">
        <label class="label">نص السؤال</label>
        <textarea class="inp" id="qt-${question.id}" rows="3" style="font-family:'Amiri', serif; font-size:18px; font-weight:700" placeholder="اكتب السؤال هنا..." oninput="qSetText('${question.id}', this.value)">${escapeHtml(question.text)}</textarea>
      </div>

      <div class="grid2" style="margin-bottom:20px">
        <div class="inp-wrap" style="margin-bottom:0">
          <label class="label">درجة الصعوبة</label>
          <select class="inp" onchange="qSetDifficulty('${question.id}', this.value)">${buildDifficultyOptions(question.difficulty)}</select>
        </div>
        <div class="attachment-editor">
           <label class="label">المرفقات</label>
           <div style="display:flex; gap:8px">
             <label class="btn btn-sm btn-outline file-picker-btn">📁 رفع ملف<input type="file" style="display:none" accept="${QUESTION_ATTACHMENT_ACCEPT}" onchange="qUploadAttachment('${question.id}', this)"></label>
             ${question.attachment ? `<button class="btn btn-sm btn-red" onclick="qRemoveAttachment('${question.id}')">🗑 حذف</button>` : ""}
           </div>
        </div>
      </div>

      ${question.attachment ? `<div style="margin-bottom:20px">${renderQuestionAttachment(question.attachment, { compact: true })}</div>` : ""}

      <div style="font-weight:900; color:var(--tm); font-size:13px; margin-bottom:16px; border-top:1px solid #f1f5f9; padding-top:16px">الإجابة الصحيحة:</div>
      
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px">
        ${question.type === "mcq" ? question.options.map((option, optionIndex) => `
          <div style="display:flex; align-items:center; gap:12px; background:#f8fafc; padding:12px; border-radius:12px; border:1.5px solid ${question.correct === optionIndex ? "var(--gl)" : "transparent"}">
            <button onclick="qSetCorrect('${question.id}', ${optionIndex})" style="min-width:32px; height:32px; border-radius:50%; border:2px solid ${question.correct === optionIndex ? "var(--gl)" : "var(--cd)"}; background:${question.correct === optionIndex ? "var(--gl)" : "var(--wh)"}; color:${question.correct === optionIndex ? "var(--wh)" : "var(--tl)"}; font-weight:900; font-size:13px; cursor:pointer">${MCQ_LABELS[optionIndex]}</button>
            <input class="inp" style="background:transparent; border:none; padding:0; box-shadow:none" placeholder="خيار ${MCQ_LABELS[optionIndex]}" value="${escapeHtml(option)}" oninput="qSetOption('${question.id}', ${optionIndex}, this.value)" />
          </div>
        `).join("") : TF_LABELS.map((option, optionIndex) => `
          <button onclick="qSetCorrect('${question.id}', ${optionIndex})" style="flex:1; padding:16px; border-radius:12px; border:2px solid ${question.correct === optionIndex ? "var(--gl)" : "var(--cd)"}; background:${question.correct === optionIndex ? "var(--gl)" : "var(--wh)"}; color:${question.correct === optionIndex ? "var(--wh)" : "var(--td)"}; font-size:16px; font-weight:900; transition:all 0.2s">${question.correct === optionIndex ? "✓ " : ""}${option}</button>
        `).join("")}
      </div>
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
  if (!questionBanks.length) { panel.innerHTML = `<div class="empty-state" style="padding:40px; font-size:14px; color:var(--tm)">لا توجد مخازن أسئلة متاحة حالياً. أنشئ أول مخزن لك لتتمكن من الاستيراد منه.</div>`; return; }
  const selectedBank = getBankById(selectedImportBankId) || questionBanks[0];
  selectedImportBankId = selectedBank.id;
  panel.innerHTML = `
    <div class="grid2" style="margin-bottom:24px">
      <div class="inp-wrap" style="margin-bottom:0"><label class="label">اختر المخزن المرجعي</label>
        <select class="inp" onchange="selectImportBank(this.value)">${questionBanks.map((bank) => `<option value="${bank.id}" ${bank.id === selectedBank.id ? "selected" : ""}>${escapeHtml(bank.title)} (${bank.questionCount})</option>`).join("")}</select>
      </div>
      <div style="background:rgba(0,0,0,0.02); padding:16px 20px; border-radius:14px; font-size:14px; color:var(--tm); line-height:1.6">
        ${escapeHtml(selectedBank.description || "هذا المخزن متاح لاستيراد الأسئلة وتكوين الاختبارات الجديدة.")}<br>
        <strong style="color:var(--gd)">توزيع الصعوبة:</strong> ${escapeHtml(buildDifficultySummary(selectedBank.questions))}
      </div>
    </div>
    <div style="margin-bottom:20px"><button class="btn btn-green btn-sm" onclick="addAllQuestionsFromBank('${selectedBank.id}')">إضافة جميع أسئلة المخزن</button></div>
    <div class="bank-import-list">${selectedBank.questions.length ? selectedBank.questions.map((question, index) => `
      <div class="bank-import-item" style="padding:20px; border-bottom:1px solid var(--cd); last-child:border-none">
        <div class="flex-between" style="margin-bottom:12px">
          <div style="display:flex; align-items:center; gap:10px">
            <span style="font-weight:900; color:var(--gd); font-size:15px">سؤال ${index + 1}</span>
            <span class="badge badge-gold" style="font-size:10px">${question.type === "mcq" ? "متعدد" : "صح/خطأ"}</span>
            <span class="badge ${getDifficultyBadgeClass(question.difficulty)}" style="font-size:10px">${getDifficultyLabel(question.difficulty)}</span>
          </div>
          <button class="btn btn-sm btn-green" onclick="addQuestionFromBank('${selectedBank.id}', '${escapeAttribute(question.id)}')">+ استيراد</button>
        </div>
        <div style="font-size:16px; font-weight:800; color:var(--td); line-height:1.7">${escapeHtml(question.text)}</div>
        <div style="font-size:12px; color:var(--tl); margin-top:8px; font-weight:700">${question.attachment ? "📎 يتضمن مرفقاً" : "بدون مرفقات"} • ${question.type === "mcq" ? "٤ خيارات" : "نظام صح/خطأ"}</div>
      </div>
    `).join("") : `<div class="empty-state">هذا المخزن لا يحتوي على أسئلة بعد.</div>`}</div>
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
  if (!questionBanks.length) {
    container.innerHTML = `<div class="empty-state" style="padding:40px 20px; font-size:13px">لم يتم إنشاء بنوك أسئلة بعد.</div>`;
    return;
  }
  container.innerHTML = questionBanks.map((bank) => `
    <div class="bank-item ${bank.id === activeBankId ? "active" : ""}" onclick="openBankEditor('${bank.id}')" style="cursor:pointer; padding:16px; border-radius:12px; margin-bottom:8px; border:1.5px solid ${bank.id === activeBankId ? "var(--gl)" : "transparent"}; background:${bank.id === activeBankId ? "var(--wh)" : "transparent"}; transition:all 0.2s">
      <div style="font-weight:900; color:${bank.id === activeBankId ? "var(--gl)" : "var(--gd)"}; font-size:15px">${escapeHtml(bank.title)}</div>
      <div style="font-size:12px; color:var(--tm); margin-top:4px">${bank.questionCount} سؤال • ${escapeHtml(buildDifficultySummary(bank.questions))}</div>
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
  if (!bankQuestions.length) {
    container.innerHTML = `<div class="empty-state" style="margin-top:20px; border:2px dashed var(--cd); border-radius:16px">هذا البنك لا يحتوي أسئلة بعد.</div>`;
    return;
  }
  container.innerHTML = bankQuestions.map((question, index) => `
    <div class="card" style="margin-bottom:24px; border:1px solid ${question.correct >= 0 ? "var(--gl)" : "var(--cd)"}; position:relative">
      <div class="flex-between" style="margin-bottom:20px">
        <div style="display:flex; align-items:center; gap:12px">
          <span style="background:var(--gd); color:var(--wh); width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:12px">${index + 1}</span>
          <span class="badge badge-gold" style="font-size:11px">${question.type === "mcq" ? "اختياري" : "صح / خطأ"}</span>
          <span class="badge ${getDifficultyBadgeClass(question.difficulty)}" style="font-size:11px">${getDifficultyLabel(question.difficulty)}</span>
          ${question.correct >= 0 ? '<span class="badge badge-green" style="font-size:10px">✓ جاهز</span>' : '<span class="badge badge-red" style="font-size:10px">! ينقصه إجابة</span>'}
        </div>
        <button class="btn btn-sm btn-outline" style="color:var(--red); border-color:rgba(239,68,68,0.1)" onclick="removeBankQuestion('${question.id}')">حذف</button>
      </div>
      
      <div class="inp-wrap">
        <label class="label">نص السؤال</label>
        <textarea class="inp" id="bqt-${question.id}" rows="3" style="font-family:'Amiri', serif; font-size:18px; font-weight:700" placeholder="اكتب السؤال هنا..." oninput="bankQSetText('${question.id}', this.value)">${escapeHtml(question.text)}</textarea>
      </div>

      <div class="grid2" style="margin-bottom:20px">
        <div class="inp-wrap" style="margin-bottom:0">
          <label class="label">درجة الصعوبة</label>
          <select class="inp" onchange="bankQSetDifficulty('${question.id}', this.value)">${buildDifficultyOptions(question.difficulty)}</select>
        </div>
        <div class="attachment-editor">
           <label class="label">المرفقات</label>
           <div style="display:flex; gap:8px">
             <label class="btn btn-sm btn-outline file-picker-btn">📁 رفع ملف<input type="file" style="display:none" accept="${QUESTION_ATTACHMENT_ACCEPT}" onchange="bankQUploadAttachment('${question.id}', this)"></label>
             ${question.attachment ? `<button class="btn btn-sm btn-red" onclick="bankQRemoveAttachment('${question.id}')">🗑 حذف</button>` : ""}
           </div>
        </div>
      </div>

      ${question.attachment ? `<div style="margin-bottom:20px">${renderQuestionAttachment(question.attachment, { compact: true })}</div>` : ""}

      <div style="font-weight:900; color:var(--tm); font-size:13px; margin-bottom:16px; border-top:1px solid #f1f5f9; padding-top:16px">الإجابات المتاحة (اختر الإجابة الصحيحة):</div>
      
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px">
        ${question.type === "mcq" ? question.options.map((option, optionIndex) => `
          <div style="display:flex; align-items:center; gap:12px; background:#f8fafc; padding:12px; border-radius:12px; border:1.5px solid ${question.correct === optionIndex ? "var(--gl)" : "transparent"}">
            <button onclick="bankQSetCorrect('${question.id}', ${optionIndex})" style="min-width:32px; height:32px; border-radius:50%; border:2px solid ${question.correct === optionIndex ? "var(--gl)" : "var(--cd)"}; background:${question.correct === optionIndex ? "var(--gl)" : "var(--wh)"}; color:${question.correct === optionIndex ? "var(--wh)" : "var(--tl)"}; font-weight:900; font-size:13px; cursor:pointer">${MCQ_LABELS[optionIndex]}</button>
            <input class="inp" style="background:transparent; border:none; padding:0; box-shadow:none" placeholder="خيار ${MCQ_LABELS[optionIndex]}" value="${escapeHtml(option)}" oninput="bankQSetOption('${question.id}', ${optionIndex}, this.value)" />
          </div>
        `).join("") : TF_LABELS.map((option, optionIndex) => `
          <button onclick="bankQSetCorrect('${question.id}', ${optionIndex})" style="flex:1; padding:16px; border-radius:12px; border:2px solid ${question.correct === optionIndex ? "var(--gl)" : "var(--cd)"}; background:${question.correct === optionIndex ? "var(--gl)" : "var(--wh)"}; color:${question.correct === optionIndex ? "var(--wh)" : "var(--td)"}; font-size:16px; font-weight:900; transition:all 0.2s">${question.correct === optionIndex ? "✓ " : ""}${option}</button>
        `).join("")}
      </div>
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
  document.getElementById("ar-title").textContent = exam.title;
  document.getElementById("ar-subtitle").textContent = `تحليل نتائج ${results.length} طالباً في بيئة ركائز`;
  
  const average = results.length ? Math.round(results.reduce((s, i) => s + i.pct, 0) / results.length) : 0;
  const passed = results.filter((i) => i.pct >= 50).length;

  document.getElementById("ar-stats").innerHTML = `
    <div class="stat-item"><div class="icon">👥</div><span class="num">${results.length}</span><span class="lbl">إجمالي الطلاب</span></div>
    <div class="stat-item"><div class="icon">🎯</div><span class="num">${average}%</span><span class="lbl">متوسط الأداء</span></div>
    <div class="stat-item"><div class="icon">🏆</div><span class="num">${passed}</span><span class="lbl">تجاوزوا الاختبار</span></div>
  `;
  
  document.getElementById("ar-charts").innerHTML = buildExamResultsCharts(results);
  adminResultsState = { exam: { ...exam, correctAnswers }, byId: Object.fromEntries(results.map((item) => [item.id, item])), results };
  
  const container = document.getElementById("ar-list");
  if (!results.length) {
    container.innerHTML = `<div class="empty-state" style="padding:100px; text-align:center; border:2px dashed var(--cd); border-radius:32px">لا توجد نتائج مسجلة لهذا الاختبار حتى الآن.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="saas-table-container">
      <table class="saas-table">
        <thead>
          <tr>
            <th style="width:60px">#</th>
            <th>اسم الطالب بالكامل</th>
            <th>المجموعة / الفصل</th>
            <th style="text-align:center">الدرجة</th>
            <th style="text-align:center">النسبة المئوية</th>
            <th>تاريخ التسليم</th>
            <th style="text-align:center">إجراءات</th>
          </tr>
        </thead>
        <tbody>
          ${results.map((item, index) => `
            <tr>
              <td style="color:var(--tl); font-weight:800; padding-right:32px">${index + 1}</td>
              <td>
                <div style="font-weight:900; color:var(--gd); font-size:17px">${escapeHtml(item.studentName)}</div>
                ${item.pct >= 85 ? '<span class="badge badge-green" style="font-size:11px; padding:3px 10px; margin-top:6px; border-radius:6px">أداء متميز</span>' : ""}
              </td>
              <td><span style="font-weight:800; color:var(--tm)">${escapeHtml(item.studentGroup)}</span></td>
              <td style="text-align:center; font-family:monospace; font-weight:900; font-size:18px">${item.score} / ${item.total}</td>
              <td style="text-align:center">
                <div style="font-weight:900; font-size:18px; color:${getScoreColor(item.pct)}">${item.pct}%</div>
              </td>
              <td style="font-size:14px; color:var(--tm); font-weight:700">${formatDate(item.at)}</td>
              <td style="text-align:center">
                <div style="display:flex; gap:10px; justify-content:center">
                  <button class="btn btn-sm btn-outline" style="padding:6px 14px" onclick="openAdminReview('${item.id}')">📖 مراجعة</button>
                  ${item.pct >= 80 ? `<button class="btn btn-sm btn-outline" style="color:var(--gm); border-color:rgba(46,74,54,0.2); padding:6px 14px" onclick="printExcellenceCertificate('${item.id}')">🏆 شهادة</button>` : ""}
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
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
