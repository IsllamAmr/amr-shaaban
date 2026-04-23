// ============================================================
// js/api.js — Server communication & session management
// Depends on: app-state.js, utils.js
// ============================================================

function buildApiUrl(url) {
  if (/^https?:\/\//i.test(String(url || ""))) return String(url);
  return API_BASE_URL ? `${API_BASE_URL}${url}` : String(url || "");
}

function getApiRequestCredentials(url) {
  const targetUrl = new URL(buildApiUrl(url), window.location.origin);
  return targetUrl.origin === window.location.origin ? "same-origin" : "include";
}

async function requestServerJson(url, options = {}) {
  const headers = { ...(options.headers || {}) };

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

let isUserAuthenticated = false;
let currentUser = null;
let currentRole = null;

async function syncSession(options = {}) {
  const { silent = false } = options;

  try {
    const session = await requestServerJson("/api/auth/session", { method: "GET" });

    if (!session.authenticated) {
      isUserAuthenticated = false;
      currentUser = null;
      currentRole = null;
      isAdminAuthenticated = false; // Legacy support
      adminUid = null;
      if (typeof updateAdminLoginView === 'function') updateAdminLoginView();
      return session;
    }

    isUserAuthenticated = true;
    currentUser = session;
    currentRole = session.role;
    
    // Legacy support for dashboard logic
    isAdminAuthenticated = ['super_admin', 'teacher'].includes(session.role);
    adminUid = session.uid;
    
    if (typeof updateAdminLoginView === 'function') updateAdminLoginView();
    return session;
  } catch (error) {
    isUserAuthenticated = false;
    currentUser = null;
    currentRole = null;
    isAdminAuthenticated = false;
    adminUid = null;
    if (typeof updateAdminLoginView === 'function') updateAdminLoginView();

    if (silent) return { authenticated: false };
    throw error;
  }
}

// Backward compatibility shim
async function syncAdminSession(options = {}) {
  return syncSession(options);
}

async function ensureRoleAccess(role) {
  if (!isUserAuthenticated || (role && currentRole !== role)) {
    throw new Error("يجب تسجيل الدخول للوصول.");
  }
}

async function ensureAdminAccess() {
  await ensureRoleAccess('teacher');
}

async function refreshAdminMode() {
  await syncSession({ silent: true });
}

// --- File upload / delete ---
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

  if (!normalized?.temporary || !normalized.storagePath) return;

  await requestServerJson("/api/admin/uploads", {
    method: "DELETE",
    body: JSON.stringify({ storagePath: normalized.storagePath })
  });
}
