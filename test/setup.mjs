// test/setup.mjs
// Loaded via --import before each test file. Registers the @/ alias resolver so
// route handlers (which import from "@/lib/...") work in the plain Node.js test runner.
import { register } from 'node:module';
register('./alias-loader.mjs', import.meta.url);
