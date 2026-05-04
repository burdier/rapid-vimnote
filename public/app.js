const $ = (id) => document.getElementById(id);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const els = {
  boot: $("boot"),
  loginForm: $("loginForm"),
  pinInput: $("pinInput"),
  topicInput: $("topicInput"),
  topicLabel: $("topicLabel"),
  topicList: $("topicList"),
  editor: $("editor"),
  commandBar: $("commandBar"),
  commandInput: $("commandInput"),
  mode: $("mode"),
  revision: $("revision"),
  dirty: $("dirty"),
  message: $("message"),
  netState: $("netState"),
  shareView: $("shareView"),
  shareMeta: $("shareMeta"),
  shareText: $("shareText")
};

const state = {
  mode: "locked",
  session: null,
  topic: "",
  topicId: "",
  key: null,
  revision: 0,
  dirty: false,
  saveTimer: null,
  lastText: "",
  yank: ""
};

init();

async function init() {
  wireEvents();
  updateNetwork();
  renderTopics();
  registerServiceWorker();

  if (location.pathname.startsWith("/s/")) {
    await openShare();
    return;
  }

  const lastTopic = localStorage.getItem("rapid-vimnote:last-topic") || "";
  els.topicInput.value = lastTopic;
  els.pinInput.focus();
  setMode("locked");
}

function wireEvents() {
  window.addEventListener("online", updateNetwork);
  window.addEventListener("offline", updateNetwork);

  els.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pin = els.pinInput.value.trim();
    const topic = normalizeTopic(els.topicInput.value);
    if (!pin || !topic) {
      flash("pin y topic son requeridos");
      return;
    }
    await unlockTopic(pin, topic);
  });

  els.editor.addEventListener("input", () => {
    state.dirty = true;
    state.lastText = els.editor.value;
    renderStatus("editando local");
    scheduleLocalSave();
  });

  els.editor.addEventListener("keydown", handleEditorKeydown);
  els.commandInput.addEventListener("keydown", handleCommandKeydown);

  els.topicList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-topic]");
    if (!button) return;
    await saveLocalNow();
    els.topicInput.value = button.dataset.topic;
    lock();
  });

  window.addEventListener("beforeunload", () => {
    if (state.dirty) {
      saveLocalNow();
    }
  });
}

async function unlockTopic(pin, topic) {
  flash("derivando llaves...");
  const session = await deriveSession(pin, topic);
  state.session = session;
  state.topic = topic;
  state.topicId = session.topicId;
  state.key = session.key;
  state.revision = 0;
  state.dirty = false;
  state.lastText = "";

  localStorage.setItem("rapid-vimnote:last-topic", topic);
  els.topicLabel.textContent = topic;
  els.boot.hidden = true;
  els.shareView.hidden = true;
  setMode("normal");

  const local = await loadLocal(topic);
  if (local) {
    const text = await decryptText(state.key, local.iv, local.bodyCipher);
    els.editor.value = text;
    state.lastText = text;
    state.revision = local.revision || 0;
    state.dirty = Boolean(local.dirty);
    renderStatus(local.dirty ? "local pendiente de sync" : "nota local cargada");
  } else {
    els.editor.value = "";
    renderStatus("nota nueva");
  }

  await syncFromRemote();
  await saveTopicMeta(topic);
  renderTopics();
  els.editor.focus();
}

async function syncFromRemote() {
  if (!navigator.onLine || !state.topicId) return;

  try {
    const response = await api("/api/notes/get", {
      method: "POST",
      body: { topicId: state.topicId }
    });

    if (response.status === 404) {
      if (state.dirty) await syncToRemote(false);
      return;
    }

    const remote = await response.json();
    if (!remote.found) return;

    if (remote.revision > state.revision && !state.dirty) {
      const text = await decryptText(state.key, remote.iv, remote.bodyCipher);
      els.editor.value = text;
      state.lastText = text;
      state.revision = remote.revision;
      state.dirty = false;
      await saveEncryptedLocal(text, false);
      renderStatus("sync remoto recibido");
      return;
    }

    if (state.dirty) {
      await syncToRemote(false);
    }
  } catch {
    renderStatus("sin red usable, seguimos local");
  }
}

async function syncToRemote(force) {
  if (!state.topicId || !navigator.onLine) {
    renderStatus("guardado local, sync luego");
    return;
  }

  const text = els.editor.value;
  const encrypted = await encryptText(state.key, text);

  try {
    const response = await api("/api/notes/put", {
      method: "PUT",
      body: {
        topicId: state.topicId,
        bodyCipher: encrypted.bodyCipher,
        iv: encrypted.iv,
        knownRevision: state.revision,
        force
      }
    });

    if (response.status === 409) {
      const conflict = await response.json();
      const serverText = await decryptText(state.key, conflict.server.iv, conflict.server.bodyCipher);
      const merged = mergeConflict(text, serverText);
      els.editor.value = merged;
      state.lastText = merged;
      state.revision = conflict.server.revision;
      state.dirty = true;
      await saveEncryptedLocal(merged, true);
      renderStatus("conflicto mezclado, usa :w! para forzar");
      return;
    }

    const saved = await response.json();
    state.revision = saved.revision;
    state.dirty = false;
    await saveEncryptedLocal(text, false);
    renderStatus("sync ok");
  } catch {
    await saveEncryptedLocal(text, true);
    renderStatus("red fallo, quedo local");
  }
}

function mergeConflict(localText, serverText) {
  if (localText === serverText) return localText;
  return [
    serverText,
    "",
    "# --- local pendiente ---",
    localText
  ].join("\n");
}

function scheduleLocalSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    await saveLocalNow();
    syncToRemote(false);
  }, 900);
}

async function saveLocalNow() {
  if (!state.key || !state.topic) return;
  await saveEncryptedLocal(els.editor.value, state.dirty);
}

async function saveEncryptedLocal(text, dirty) {
  const encrypted = await encryptText(state.key, text);
  const db = await openDb();
  const record = {
    topic: state.topic,
    topicId: state.topicId,
    bodyCipher: encrypted.bodyCipher,
    iv: encrypted.iv,
    revision: state.revision,
    dirty,
    updatedAt: Date.now()
  };
  await txPut(db, "notes", record);
  await saveTopicMeta(state.topic);
}

async function saveTopicMeta(topic) {
  const db = await openDb();
  await txPut(db, "topics", { topic, updatedAt: Date.now() });
}

async function loadLocal(topic) {
  const db = await openDb();
  return txGet(db, "notes", topic);
}

async function listTopics() {
  const db = await openDb();
  return txAll(db, "topics");
}

async function renderTopics() {
  const topics = await listTopics();
  topics.sort((a, b) => b.updatedAt - a.updatedAt);
  els.topicList.innerHTML = "";

  if (!topics.length) {
    const empty = document.createElement("div");
    empty.className = "topic-item";
    empty.textContent = "sin topics";
    els.topicList.append(empty);
    return;
  }

  for (const item of topics) {
    const button = document.createElement("button");
    button.className = "topic-item";
    if (item.topic === state.topic) button.classList.add("active");
    button.type = "button";
    button.dataset.topic = item.topic;
    button.innerHTML = `<strong>${escapeHtml(item.topic)}</strong><small>${new Date(item.updatedAt).toLocaleString()}</small>`;
    els.topicList.append(button);
  }
}

function handleEditorKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeCommand();
    setMode("normal");
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    commandWrite(false);
    return;
  }

  if (state.mode === "insert") return;

  if (state.mode === "normal") {
    if (event.key.length === 1 || ["Backspace", "Enter", "Tab"].includes(event.key)) {
      event.preventDefault();
    }

    if (event.key === "i") return setMode("insert");
    if (event.key === "a") return moveAndInsert(1);
    if (event.key === "o") return openLineBelow();
    if (event.key === ":") return openCommand("");
    if (event.key === "/") return openCommand("/");
    if (event.key === "h") return moveCaret(-1);
    if (event.key === "l") return moveCaret(1);
    if (event.key === "j") return moveLine(1);
    if (event.key === "k") return moveLine(-1);
    if (event.key === "0") return setCaret(lineBounds().start);
    if (event.key === "$") return setCaret(lineBounds().end);
    if (event.key === "x") return deleteChar();
    if (event.key === "p") return pasteYank();
    if (event.key === "y") return twoKey("y", yankLine);
    if (event.key === "d") return twoKey("d", deleteLine);
  }
}

function handleCommandKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeCommand();
    setMode("normal");
    els.editor.focus();
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    const value = els.commandInput.value.trim();
    closeCommand();
    runCommand(value);
  }
}

function openCommand(prefix) {
  state.mode = "command";
  els.commandBar.hidden = false;
  els.commandInput.value = prefix;
  els.commandInput.focus();
  renderStatus("comando");
}

function closeCommand() {
  els.commandBar.hidden = true;
}

async function runCommand(raw) {
  const input = raw.startsWith("/") ? `find ${raw.slice(1)}` : raw;
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(" ");

  switch (cmd) {
    case "w":
    case "write":
      await commandWrite(false);
      break;
    case "w!":
      await commandWrite(true);
      break;
    case "q":
    case "lock":
      await saveLocalNow();
      lock();
      break;
    case "sync":
      await syncFromRemote();
      break;
    case "topic":
      await saveLocalNow();
      els.topicInput.value = normalizeTopic(arg);
      lock();
      break;
    case "ls":
      await showTopicsMessage();
      break;
    case "share":
      await createPublicShare(arg || "5m");
      break;
    case "find":
      findText(arg);
      break;
    case "clear":
      els.editor.value = "";
      state.dirty = true;
      await saveLocalNow();
      renderStatus("buffer limpio");
      break;
    case "help":
      showHelp();
      break;
    default:
      renderStatus(cmd ? `comando no existe: ${cmd}` : "sin comando");
  }

  setMode("normal");
  els.editor.focus();
}

async function commandWrite(force) {
  await saveLocalNow();
  await syncToRemote(force);
}

async function showTopicsMessage() {
  const topics = await listTopics();
  renderStatus(topics.map((item) => item.topic).join(" ") || "sin topics locales");
}

function showHelp() {
  renderStatus(":w save | :w! force | :share 5m | :topic x | :ls | :sync | :q");
}

async function createPublicShare(ttlText) {
  if (!state.key) return;

  const ttlSeconds = parseTtl(ttlText);
  const shareKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const encrypted = await encryptText(shareKey, els.editor.value);

  try {
    const response = await api("/api/share", {
      method: "POST",
      body: {
        topicId: state.topicId,
        bodyCipher: encrypted.bodyCipher,
        iv: encrypted.iv,
        ttlSeconds
      }
    });

    const data = await response.json();
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", shareKey));
    const link = `${location.origin}/s/${data.token}#${base64url(raw)}`;
    await copyText(link);
    renderStatus(`share copiado, expira ${new Date(data.expiresAt).toLocaleTimeString()}`);
  } catch {
    renderStatus("no pude crear share, red no disponible");
  }
}

function parseTtl(text) {
  const match = String(text).trim().match(/^(\d+)\s*([smh]?)$/i);
  if (!match) return 300;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const seconds = unit === "h" ? value * 3600 : unit === "s" ? value : value * 60;
  return Math.min(3600, Math.max(30, seconds));
}

async function openShare() {
  els.boot.hidden = true;
  els.editor.hidden = true;
  els.shareView.hidden = false;
  setMode("SHARE");

  const token = location.pathname.split("/").filter(Boolean).pop();
  const keyText = location.hash.slice(1);

  if (!token || !keyText) {
    els.shareText.textContent = "link incompleto";
    return;
  }

  try {
    const keyBytes = fromBase64url(keyText);
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const response = await fetch(`/api/share/${token}`, { headers: { accept: "application/json" } });
    const data = await response.json();

    if (!response.ok) {
      els.shareText.textContent = data.error === "expired" ? "share expirado" : "share no encontrado";
      return;
    }

    const text = await decryptText(key, data.iv, data.bodyCipher);
    els.shareText.textContent = text || "(vacio)";
    els.shareMeta.textContent = `public share | expira ${new Date(data.expiresAt).toLocaleString()}`;
  } catch {
    els.shareText.textContent = "no pude abrir este share";
  }
}

function setMode(mode) {
  state.mode = String(mode).toLowerCase();
  els.editor.readOnly = state.mode !== "insert";
  els.mode.textContent = String(mode).toUpperCase();
  renderStatus();
}

function lock() {
  state.mode = "locked";
  state.session = null;
  state.key = null;
  state.topicId = "";
  state.revision = 0;
  state.dirty = false;
  els.editor.value = "";
  els.boot.hidden = false;
  els.pinInput.value = "";
  els.pinInput.focus();
  els.topicLabel.textContent = "locked";
  setMode("locked");
}

function updateNetwork() {
  els.netState.textContent = navigator.onLine ? "online" : "offline";
}

function renderStatus(message) {
  els.revision.textContent = `rev ${state.revision || 0}`;
  els.dirty.textContent = state.dirty ? "dirty" : "clean";
  if (message) els.message.textContent = message;
}

function flash(message) {
  els.message.textContent = message;
}

async function deriveSession(pin, topic) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: encoder.encode(`rapid-vimnote:v1:${topic}`),
    iterations: 70000,
    hash: "SHA-256"
  }, material, 512);

  const bytes = new Uint8Array(bits);
  const encBytes = bytes.slice(0, 32);
  const authBytes = bytes.slice(32);
  const key = await crypto.subtle.importKey("raw", encBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const topicId = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", authBytes)));
  return { key, topicId };
}

async function encryptText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(text));
  return {
    iv: base64url(iv),
    bodyCipher: base64url(new Uint8Array(cipher))
  };
}

async function decryptText(key, ivText, cipherText) {
  const iv = fromBase64url(ivText);
  const cipher = fromBase64url(cipherText);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return decoder.decode(plain);
}

function normalizeTopic(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function api(path, options) {
  return fetch(path, {
    method: options.method,
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(options.body)
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("rapid-vimnote", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("notes")) {
        db.createObjectStore("notes", { keyPath: "topic" });
      }
      if (!db.objectStoreNames.contains("topics")) {
        db.createObjectStore("topics", { keyPath: "topic" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function txGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function txAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function lineBounds() {
  const text = els.editor.value;
  const pos = els.editor.selectionStart;
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  const next = text.indexOf("\n", pos);
  const end = next === -1 ? text.length : next;
  return { start, end };
}

function setCaret(pos) {
  els.editor.setSelectionRange(pos, pos);
}

function moveCaret(delta) {
  const pos = Math.max(0, Math.min(els.editor.value.length, els.editor.selectionStart + delta));
  setCaret(pos);
}

function moveAndInsert(delta) {
  moveCaret(delta);
  setMode("insert");
}

function openLineBelow() {
  const bounds = lineBounds();
  const pos = bounds.end;
  els.editor.value = `${els.editor.value.slice(0, pos)}\n${els.editor.value.slice(pos)}`;
  setCaret(pos + 1);
  state.dirty = true;
  setMode("insert");
  scheduleLocalSave();
}

function moveLine(delta) {
  const text = els.editor.value;
  const pos = els.editor.selectionStart;
  const before = text.slice(0, pos);
  const column = before.length - before.lastIndexOf("\n") - 1;
  const lines = text.split("\n");
  let index = before.split("\n").length - 1;
  index = Math.max(0, Math.min(lines.length - 1, index + delta));
  const prefix = lines.slice(0, index).join("\n");
  const base = prefix ? prefix.length + 1 : 0;
  setCaret(base + Math.min(column, lines[index].length));
}

function deleteChar() {
  const pos = els.editor.selectionStart;
  const text = els.editor.value;
  if (pos >= text.length) return;
  els.editor.value = text.slice(0, pos) + text.slice(pos + 1);
  setCaret(pos);
  state.dirty = true;
  scheduleLocalSave();
}

function deleteLine() {
  const bounds = lineBounds();
  const text = els.editor.value;
  let end = bounds.end;
  if (text[end] === "\n") end += 1;
  state.yank = text.slice(bounds.start, end);
  els.editor.value = text.slice(0, bounds.start) + text.slice(end);
  setCaret(Math.min(bounds.start, els.editor.value.length));
  state.dirty = true;
  scheduleLocalSave();
}

function yankLine() {
  const bounds = lineBounds();
  state.yank = els.editor.value.slice(bounds.start, bounds.end) + "\n";
  renderStatus("linea copiada");
}

function pasteYank() {
  if (!state.yank) return;
  const pos = els.editor.selectionStart;
  els.editor.value = els.editor.value.slice(0, pos) + state.yank + els.editor.value.slice(pos);
  setCaret(pos + state.yank.length);
  state.dirty = true;
  scheduleLocalSave();
}

function twoKey(expected, action) {
  const handler = (event) => {
    els.editor.removeEventListener("keydown", handler, true);
    if (event.key === expected) {
      event.preventDefault();
      event.stopImmediatePropagation();
      action();
    }
  };
  els.editor.addEventListener("keydown", handler, true);
  renderStatus(`${expected}${expected}`);
}

function findText(query) {
  if (!query) return;
  const text = els.editor.value.toLowerCase();
  const start = Math.max(0, els.editor.selectionEnd);
  const index = text.indexOf(query.toLowerCase(), start);
  if (index === -1) {
    renderStatus(`no encontrado: ${query}`);
    return;
  }
  els.editor.setSelectionRange(index, index + query.length);
  renderStatus(`find: ${query}`);
}

async function copyText(text) {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const previous = els.editor.value;
  els.editor.value = text;
  els.editor.select();
  document.execCommand("copy");
  els.editor.value = previous;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}
