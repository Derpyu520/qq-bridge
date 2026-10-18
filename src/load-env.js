import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../.env', import.meta.url));
if (fs.existsSync(file)) process.loadEnvFile(file);
