// Preloaded (`node --import`) before the Daisy process loads anything: the
// one warning every start printed — Node's 「ExperimentalWarning: SQLite is
// an experimental feature」 for node:sqlite, which Daisy uses on purpose
// (ADR-108) — is dropped. Every other warning, ExperimentalWarning or not,
// is printed as before. Plain JavaScript: it runs before tsx is loaded,
// and before node:sqlite is (a builtin warns while the entry links).
const original = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const message = typeof warning === "string" ? warning : warning?.message;
  const type =
    typeof rest[0] === "string"
      ? rest[0]
      : (rest[0]?.type ?? (typeof warning === "object" ? warning?.name : undefined));
  if (
    type === "ExperimentalWarning" &&
    /^SQLite is an experimental feature/.test(String(message))
  )
    return;
  return original.call(process, warning, ...rest);
};
