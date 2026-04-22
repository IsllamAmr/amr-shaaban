// ============================================================
// js/ui-helpers.js — DOM utilities, charts, print, anti-cheat
// Depends on: app-state.js, utils.js, api.js
// ============================================================

// ============ Backup & Recovery ============

function createBackup() {
  try {
    const backup = { timestamp: new Date().toISOString(), exams, questionBanks, version: "1.0" };
    setStoredJson("app_backup", backup);
    return backup;
  } catch (error) {
    console.error("خطأ في إنشاء النسخة الاحتياطية:", error);
    return null;
  }
}

function exportDataAsJson() {
  try {
    const exportData = { exams, banks: questionBanks, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
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
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = (e) => {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const backupData = JSON.parse(event.target.result);
        if (confirm("هل تريد استيراد البيانات من الملف؟ سيتم استبدال البيانات الحالية.")) {
          exams = backupData.exams || [];
          questionBanks = backupData.banks || [];
          createBackup();
          showNotice("✅ تم استيراد النسخة الاحتياطية بنجاح");
          location.reload();
        }
      } catch (error) {
        showErr(document.getElementById("al-err"), "❌ ملف غير صحيح أو تالف");
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ============ Anti-Cheat / Security ============

function addSecurityWatermark() {
  const watermark = document.createElement("div");
  watermark.innerHTML = "🔐 منصة امتحانات آمنة";
  watermark.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:42px;color:rgba(0,0,0,0.02);pointer-events:none;z-index:-1;font-weight:bold;font-family:Cairo;`;
  document.body.appendChild(watermark);
}

function monitorExamSecurity() {
  if (!currentExam) return;
  setInterval(() => {
    if (studentAnswers && questions) {
      if (studentAnswers.length > questions.length) {
        console.warn("⚠️ تم اكتشاف محاولة غش: إجابات إضافية");
        registerCheatWarning("⚠️ تم اكتشاف نشاط غير مسموح.");
      }
    }
  }, 3000);
}

function blockRightClick(event) { event.preventDefault(); }

function blockKeys(event) {
  if (event.ctrlKey && ["c", "v", "u", "s", "p", "a", "i"].includes(event.key.toLowerCase())) event.preventDefault();
  if (["F12", "F11", "F10"].includes(event.key)) event.preventDefault();
}

function detectMouseOut(event) {
  if (!document.getElementById("pg-exam").classList.contains("active")) return;
  const rect = document.getElementById("pg-exam").getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
    if (!mouseOutWarningShown) {
      mouseOutWarningShown = true;
      registerCheatWarning("⚠️ تم رصد محاولة مغادرة منطقة الامتحان.");
      setTimeout(() => { mouseOutWarningShown = false; }, 5000);
    }
  }
}

function blockCopy(event) { event.preventDefault(); }

function handleBeforeUnload(event) {
  if (!document.getElementById("pg-exam").classList.contains("active")) return undefined;
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
  if (!document.getElementById("pg-exam").classList.contains("active")) return;
  if (document.hidden) registerCheatWarning("تم رصد مغادرة نافذة الامتحان.");
}

function handleExamBackNavigation(event) {
  if (!document.getElementById("pg-exam").classList.contains("active") || !examBackGuardActive) return;
  history.pushState({ examGuard: Date.now() }, "", window.location.href);
  registerCheatWarning("محاولة الرجوع للخلف غير مسموحة أثناء الامتحان.");
}

function setupHistoryBackGuard() {
  if (examBackGuardActive) return;
  history.pushState({ examGuard: Date.now() }, "", window.location.href);
  window.addEventListener("popstate", handleExamBackNavigation);
  examBackGuardActive = true;
}

function teardownHistoryBackGuard() {
  if (!examBackGuardActive) return;
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

function closeWarnModal() { document.getElementById("warn-modal").style.display = "none"; }

// ============ UI Helpers ============

function showPage(id) {
  document.querySelectorAll(".page").forEach((page) => page.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  window.scrollTo(0, 0);
}

function showErr(el, msg) {
  if (!el) return;
  el.style.display = "block";
  el.textContent = msg;
}

function hideErr(id) {
  const el = document.getElementById(id);
  if (el) { el.style.display = "none"; el.textContent = ""; }
}

function showNotice(msg) {
  const note = document.getElementById("al-note");
  if (!note) return;
  note.style.display = "block";
  note.textContent = msg;
}

function hideNotice() {
  const note = document.getElementById("al-note");
  if (!note) return;
  note.style.display = "none";
  note.textContent = "";
}

function setButtonLoading(buttonId, isLoading, loadingText = "جارٍ التنفيذ...") {
  const button = typeof buttonId === "string" ? document.getElementById(buttonId) : buttonId;
  if (!button) return;
  if (isLoading) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.classList.add("is-loading");
    button.innerHTML = `<span class="btn-content"><span class="btn-spinner"></span><span>${loadingText}</span></span>`;
    return;
  }
  button.disabled = false;
  button.classList.remove("is-loading");
  if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
}

function renderQuestionAttachment(attachment, options = {}) {
  const normalized = normalizeAttachment(attachment);
  if (!normalized) return "";
  const { allowDownload = true, compact = false } = options;
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
      <div class="question-attachment-body">${preview}</div>
    </div>
  `;
}

// ============ Charts ============

function buildBarChartCard(title, items, options = {}) {
  const { emptyText = "لا توجد بيانات كافية بعد.", formatter = (value) => String(value), color = "var(--gold)" } = options;
  if (!items.length) return `<div class="chart-card"><div class="chart-title">${title}</div><div class="chart-empty">${emptyText}</div></div>`;
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
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(result);
  });
  return grouped;
}

function buildDashboardCharts(examEntries, allResults) {
  const bySubmissions = [...examEntries].sort((a, b) => b.resultCount - a.resultCount).slice(0, 5).map((exam) => ({ label: exam.title, value: exam.resultCount, meta: `${exam.questionCount} سؤال`, color: "var(--gold)" }));
  const byAverageScore = examEntries.filter((exam) => exam.resultCount > 0).sort((a, b) => b.averageScore - a.averageScore).slice(0, 5).map((exam) => ({ label: exam.title, value: exam.averageScore, meta: `${exam.resultCount} تسليم`, color: "#2d8a57" }));
  const groups = Object.entries(groupResultsByField(allResults, (r) => r.studentGroup)).map(([label, items]) => ({ label, value: items.length, meta: `متوسط ${Math.round(items.reduce((s, i) => s + i.pct, 0) / items.length)}%`, color: "#5d9cec" })).sort((a, b) => b.value - a.value).slice(0, 5);
  return [
    buildBarChartCard("أكثر الامتحانات تسليمًا", bySubmissions, { emptyText: "لم تصل أي تسليمات بعد.", formatter: (v) => `${v} تسليم` }),
    buildBarChartCard("أفضل متوسطات الدرجات", byAverageScore, { emptyText: "سيظهر هذا الرسم بعد أول تصحيح.", formatter: (v) => `${v}%`, color: "#2d8a57" }),
    buildBarChartCard("المجموعات الأكثر نشاطًا", groups, { emptyText: "أضف اسم الفصل/المجموعة لتظهر الإحصائية هنا.", formatter: (v) => `${v} طالب`, color: "#5d9cec" })
  ].join("");
}

function buildExamResultsCharts(results) {
  const scoreBands = [
    { label: "0% - 49%", value: results.filter((i) => i.pct < 50).length, color: "var(--red)" },
    { label: "50% - 69%", value: results.filter((i) => i.pct >= 50 && i.pct < 70).length, color: "#e67e22" },
    { label: "70% - 84%", value: results.filter((i) => i.pct >= 70 && i.pct < 85).length, color: "#4caf50" },
    { label: "85% - 100%", value: results.filter((i) => i.pct >= 85).length, color: "#2d8a57" }
  ];
  const topGroups = Object.entries(groupResultsByField(results, (r) => r.studentGroup)).map(([label, items]) => ({ label, value: items.length, meta: `متوسط ${Math.round(items.reduce((s, i) => s + i.pct, 0) / items.length)}%`, color: "#5d9cec" })).sort((a, b) => b.value - a.value).slice(0, 5);
  const topScores = [...results].sort((a, b) => b.pct - a.pct).slice(0, 5).map((item) => ({ label: item.studentName, value: item.pct, meta: sanitizePlainText(item.studentGroup, "بدون مجموعة"), color: getScoreColor(item.pct) }));
  return [
    buildBarChartCard("توزيع الدرجات", scoreBands, { emptyText: "لا توجد نتائج بعد.", formatter: (v) => `${v} طالب` }),
    buildBarChartCard("المجموعات المشاركة", topGroups, { emptyText: "لا توجد بيانات مجموعات بعد.", formatter: (v) => `${v} طالب`, color: "#5d9cec" }),
    buildBarChartCard("أعلى الدرجات", topScores, { emptyText: "سيظهر ترتيب الطلاب بعد أول تسليم.", formatter: (v) => `${v}%` })
  ].join("");
}

// ============ Print ============

function buildPrintableLayout(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title><meta name="color-scheme" content="light"><style>*{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{font-family:Tahoma,Arial,sans-serif;margin:0;padding:32px;background:#f7f5ef;color:#1a1a1a;direction:rtl}.print-shell{max-width:900px;margin:0 auto;background:#fff;border:1px solid #e5dcc8;border-radius:20px;overflow:hidden}.print-header{background:linear-gradient(135deg,#0b2e1a 0%,#1a5235 100%);color:#fff;padding:24px 28px}.print-header h1{margin:0 0 8px;font-size:28px}.print-body{padding:24px 28px}.print-card{border:1px solid #eadfc8;border-radius:16px;padding:18px;margin-bottom:16px}.print-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.print-stat{background:#f8f1df;border-radius:12px;padding:14px;text-align:center}.print-stat strong{display:block;font-size:28px;color:#0b2e1a}.print-question{border-right:4px solid #c9973a}.print-option{border:1px solid #ddd3be;border-radius:10px;padding:10px 12px;margin-bottom:8px}.print-option.correct{border-color:#2e7d32;background:#edf7ee}.print-option.wrong{border-color:#c0392b;background:#fdeeee}.question-attachment-image{max-width:100%;border-radius:12px;border:1px solid #eadfc8;margin-top:12px}@media print{body{padding:10px;background:#fff}.print-shell{border:0;border-radius:0}}</style></head><body><div class="print-shell"><div class="print-header"><h1>${escapeHtml(title)}</h1><p>منصة أ/ عمرو شعبان التعليمية</p></div><div class="print-body">${bodyHtml}</div></div></body></html>`;
}

function openPrintWindow(title, bodyHtml) {
  const markup = buildPrintableLayout(title, bodyHtml);
  const printWindow = window.open("", "_blank", "width=900,height=1200");
  if (printWindow && !printWindow.closed) {
    try {
      printWindow.document.open();
      printWindow.document.write(markup);
      printWindow.document.close();
      setTimeout(() => { try { printWindow.focus(); printWindow.print(); } catch (e) {} }, 500);
      return;
    } catch (error) {}
  }
  // Fallback: iframe
  try {
    const printFrame = document.createElement("iframe");
    printFrame.style.cssText = "display:none;position:absolute;width:0;height:0;border:0";
    document.body.appendChild(printFrame);
    setTimeout(() => {
      try {
        const frameDoc = printFrame.contentDocument || printFrame.contentWindow.document;
        frameDoc.open(); frameDoc.write(markup); frameDoc.close();
        setTimeout(() => {
          printFrame.contentWindow.focus(); printFrame.contentWindow.print();
          setTimeout(() => document.body.removeChild(printFrame), 1000);
        }, 500);
      } catch (error) {
        alert("❌ تعذر فتح نافذة الطباعة. تأكد من السماح بالنوافذ المنبثقة.");
        document.body.removeChild(printFrame);
      }
    }, 100);
  } catch (error) {
    alert("❌ تعذر فتح نافذة الطباعة. جرب متصفحاً آخر.");
  }
}
