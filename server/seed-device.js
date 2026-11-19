// Registers a tracking device. Usage:
//   npm run seed-simulator                                         demo: 2 simulated devices (tokens saved for the simulator)
//   npm run seed-device -- <deviceId> <busId> "<Bus name>" <simulation|gps>
// The device token is printed ONCE and only its hash is stored. Running this again for the same
// device id replaces its token (use this to rotate a leaked or lost token).
import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { saveDevice, SIM_TOKENS_FILE as TOKENS_FILE } from "./devices.js";
import { ensureBus } from "./buses.js";
import { close } from "./db.js";

try {
  const args = process.argv.slice(2);
  if (args[0] === "--simulator") {
    const demo = [
      { deviceId: "sim-01", busId: "RW-01", busName: "Modern Bus 01", start: "villanueva" },
      { deviceId: "sim-02", busId: "RW-02", busName: "Modern Bus 02", start: "cdo" },
    ];
    // A device may only report for a REGISTERED bus, so make sure the bus records exist (existing ones are left untouched).
    for (const d of demo) await ensureBus({ busId: d.busId, name: d.busName });
    const out = [];
    for (const d of demo) out.push({ deviceId: d.deviceId, start: d.start, token: await saveDevice({ ...d, source: "simulation" }) });
    fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(out, null, 2), { mode: 0o600 });
    console.log(`Registered ${out.length} SIMULATED devices. Their tokens were saved for the simulator in ${path.relative(process.cwd(), TOKENS_FILE)} (keep it private; it is git-ignored).`);
  } else {
    const [deviceId, busId, busName, source] = args;
    if (!deviceId || !busId || !busName || !source) throw new Error('Usage: npm run seed-device -- <deviceId> <busId> "<Bus name>" <simulation|gps>');
    await ensureBus({ busId, name: busName });
    const token = await saveDevice({ deviceId, busId, source });
    console.log(`Registered device "${deviceId}" for bus ${busId} (${source}).\nToken (shown only once, copy it now):\n${token}`);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
} finally { await close(); }
