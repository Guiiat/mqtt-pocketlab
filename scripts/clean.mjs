import { rm } from "node:fs/promises";

// Keep build cleanup narrowly scoped to this package's generated dist directory.
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
