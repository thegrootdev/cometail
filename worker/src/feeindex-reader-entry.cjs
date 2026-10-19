// The Fee Index reader thread's entry, plain CommonJS: a worker thread starts it whether or not it inherited the
// parent's TypeScript loader (the service runs under tsx, the tests under ts-node).
if (!require.extensions[".ts"]) require("tsx/cjs");
require("./feeindex-reader-thread.ts");
