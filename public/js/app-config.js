window.APP_CONFIG = Object.assign(
  {
    // Use relative path by default when served from Express backend
    // Or set to your Render URL if hosting frontend separately on Firebase (e.g. "https://amr-shaaban.onrender.com")
    API_BASE_URL: ["localhost", "127.0.0.1"].includes(window.location.hostname)
      ? ""
      : "https://amr-shaaban.onrender.com"
  },
  window.APP_CONFIG || {}
);
