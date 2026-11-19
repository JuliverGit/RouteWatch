// Loads server/.env (if it exists) into process.env. Real environment variables always win over the file.
// Import this FIRST in every entry file, so the other modules see the settings when they start.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), ".env"), quiet: true });
