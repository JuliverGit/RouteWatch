// Creates an account. Usage:  npm run seed-user -- <username> <admin|dispatcher|conductor|passenger>
// The password is typed at a hidden prompt, so it is never in the code or in shell history.
// (For automated tests only, NEW_USER_PASSWORD can supply it instead.)
import "./env.js";
import readline from "node:readline";
import { createUser, ROLES } from "./users.js";
import { close } from "./db.js";

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    let muted = false;
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => (muted && hidden ? (s.includes("\n") || s.includes("\r") ? write("\n") : undefined) : write(s));
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
    muted = true;
  });
}

const [username, role] = process.argv.slice(2);
if (!username || !ROLES.includes(role)) {
  console.error(`Usage: npm run seed-user -- <username> <${ROLES.join("|")}>`);
  process.exit(1);
}
try {
  let password = process.env.NEW_USER_PASSWORD;
  if (!password) {
    password = await ask("Password: ", true);
    if (password !== (await ask("Confirm password: ", true))) throw new Error("Passwords do not match");
  }
  const user = await createUser(username, password, role);
  console.log(`Created ${user.role} account "${user.username}".`);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
} finally { await close(); }
