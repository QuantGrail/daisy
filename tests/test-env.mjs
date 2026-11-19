// P6-20 (ADR-159 §8): the tests' default language. Preloaded like
// no-network.mjs (scripts/ci-test.mjs puts it in NODE_OPTIONS, so every
// child process too; `npm test` imports it): unless the run sets
// DAISY_LANG itself, Daisy speaks Chinese in tests, so the existing
// assertions on Chinese text hold on any machine's locale while an area is
// converted. Tests of a converted area set the language they check
// (`--lang`, DAISY_LANG in the io's env, Accept-Language) — both languages.
if (!process.env.DAISY_LANG) process.env.DAISY_LANG = "zh-CN";
