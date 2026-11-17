// Loads .env before anything else reads process.env (Node 20.12+).
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {}
