import { configDefaults, defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Written by drizzle-kit on every `generate`; reformatting them would only add noise.
    ignorePatterns: ["packages/db/migrations/**"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
  test: {
    // Fixture repos are test material for the agent, with their own (failing) tests.
    exclude: [...configDefaults.exclude, "fixtures/**"],
  },
});
