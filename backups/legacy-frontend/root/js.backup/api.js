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

async function syncAdminSession(options = {}) {
  const { silent = false } = options;

  try {
    const session = await requestServerJson("/api/admin/session", { method: "GET" });

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

    if (silent) return { authenticated: false };
    throw error;
  }
}

async function ensureAdminAccess() {
  if (!isAdminAuthenticated) {
    throw new Error("دخول المدرس مطلوب.");
  }
}

async function refreshAdminMode() {
  await syncAdminSession({ silent: true });
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
