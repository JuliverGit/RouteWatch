import { io } from "socket.io-client";

// ONE Socket.IO connection for the whole page, shared by every screen that needs live data. Each screen calls joinSocket(), adds
// its handlers with .on() and releases them with .disconnect() (which removes only ITS handlers). The real connection closes when the
// last screen leaves. The server reads the session cookie when a connection is made, so when the signed-in user changes
// (sign-in, sign-out) the connection is made again to carry the new identity.
// Nothing connects when this module is imported: the connection is made by the first joinSocket().
let sharedSocket = null, sharedUsers = 0, sharedIdentity = null, sharedCloseTimer = null;
export function joinSocket() {
  clearTimeout(sharedCloseTimer);
  if (!sharedSocket) sharedSocket = io();
  else if (!sharedSocket.active) sharedSocket.connect(); // the server ended it (sign-out): connect again with the cookie the browser holds now
  const s = sharedSocket, mine = [];
  let left = false;
  sharedUsers++;
  return {
    on(event, fn) { mine.push([event, fn]); s.on(event, fn); if (event === "connect" && s.connected) fn(); return this; },
    disconnect() {
      if (left) return;
      left = true;
      for (const [event, fn] of mine) s.off(event, fn);
      // Close after a short pause, so moving from one screen to another reuses the same connection.
      if (--sharedUsers === 0) sharedCloseTimer = setTimeout(() => { if (sharedUsers === 0) { s.disconnect(); if (sharedSocket === s) sharedSocket = null; } }, 1500);
    },
  };
}
export function setSocketIdentity(name) {
  if (sharedIdentity === name) return;
  const first = sharedIdentity === null;
  sharedIdentity = name;
  if (!first && sharedSocket) { sharedSocket.disconnect(); sharedSocket.connect(); }
}
/** Connects again if the server ended the connection while a screen still uses it. Nothing happens otherwise. */
export function reconnectIfDropped() {
  if (sharedSocket && !sharedSocket.active && sharedUsers > 0) sharedSocket.connect();
}
