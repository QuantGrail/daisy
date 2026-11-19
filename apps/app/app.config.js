// The web page only (a phone opens Daisy in its browser). DAISY_BASE_PATH=/daisy
// builds it for a sub-path (assets under /daisy/_expo/…); App.tsx then talks
// to origin + /daisy/api. The variable's old name, HARBOR_BASE_PATH, is still
// read when DAISY_BASE_PATH is not set, with the one-time warning every
// renamed variable gives (legacyEnvWarning in packages/contracts/src/env.ts;
// this file is CommonJS and cannot import it). A build-time console line:
// English only, like log lines (ADR-159 §11.7).
function basePath(env = process.env) {
  let value = env.DAISY_BASE_PATH;
  if (value === undefined && env.HARBOR_BASE_PATH !== undefined) {
    console.warn(
      "HARBOR_BASE_PATH is deprecated, use DAISY_BASE_PATH",
    );
    value = env.HARBOR_BASE_PATH;
  }
  const raw = (value || "").trim();
  if (!raw || raw === "/") return "";
  if (!/^\/?[A-Za-z0-9._~\-/]+$/.test(raw))
    throw new Error(`DAISY_BASE_PATH must be a URL path, got ${raw}`);
  return "/" + raw.replace(/^\/+|\/+$/g, "");
}
module.exports = ({ config }) => {
  const base = basePath();
  return {
    ...config,
    experiments: {
      ...config.experiments,
      ...(base ? { baseUrl: base } : {}),
    },
  };
};
module.exports.basePath = basePath;
