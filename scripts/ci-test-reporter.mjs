// Test reporter for scripts/ci-test.mjs (P0-01).
// Emits one JSON line per top-level test result: { status, file, name } and, for a
// failure, `error`: the first 600 characters of its message (P5-05: a paid Windows run
// must say why, not only what — never secrets: tests print none, S-1).
// Top level only: a failing subtest also fails its parent, and the parent is
// what tests/platform-pending.json marks.
export default async function* ciReporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const data = event.data;
    if (data.nesting !== 0 || !data.file) continue;
    // A file-level failure (e.g. the file did not load) has the file path as its name.
    const status =
      event.type === "test:fail"
        ? "fail"
        : data.skip !== undefined && data.skip !== false
          ? "skip"
          : "pass";
    const err = data.details?.error;
    const error =
      status === "fail" && err
        ? String(err.cause?.message ?? err.cause ?? err.message ?? err)
            .replace(/\s+/g, " ")
            .slice(0, 600)
        : undefined;
    yield JSON.stringify({ status, file: data.file, name: data.name, ...(error ? { error } : {}) }) + "\n";
  }
}
