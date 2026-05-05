const $ = (id) => document.getElementById(id);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const WORKSPACE_MARKER = "rapid-vimnote.workspace.v2";
const WALLPAPERS = ["walnut", "moss", "wine", "blue"];

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
  topicLinkButton: $("topicLinkButton"),
  modeSwitchButton: $("modeSwitchButton"),
  wallpaperButton: $("wallpaperButton"),
  shareButton: $("shareButton"),
  shareView: $("shareView"),
  shareMeta: $("shareMeta"),
  shareText: $("shareText"),
  normalDesktop: $("normalDesktop"),
  desktopCanvas: $("desktopCanvas"),
  desktopWindow: $("desktopWindow"),
  desktopWindowTitle: $("desktopWindowTitle"),
  desktopEditor: $("desktopEditor"),
  desktopShareButton: $("desktopShareButton"),
  desktopCloseButton: $("desktopCloseButton"),
  nerdShell: $("nerdShell"),
  terminalOutput: $("terminalOutput"),
  terminalActions: $("terminalActions"),
  terminalForm: $("terminalForm"),
  terminalPrompt: $("terminalPrompt"),
  terminalInput: $("terminalInput"),
  contextMenu: $("contextMenu")
};

const state = {
  vimMode: "locked",
  uiMode: localStorage.getItem("rapid-vimnote:ui-mode") || "normal",
  session: null,
  topic: "",
  topicId: "",
  key: null,
  revision: 0,
  dirty: false,
  saveTimer: null,
  workspace: null,
  currentFile: "note.txt",
  desktopSelectedFile: "",
  contextTargetFile: "",
  contextPoint: { x: 28, y: 28 },
  touchTimer: 0,
  touchedFile: "",
  touchMoved: false,
  suppressNextDesktopClick: false,
  editorOpen: false,
  yank: ""
};

init();

async function init() {
  wireEvents();
  updateNetwork();
  renderTopics();
  registerServiceWorker();

  if (!ensureSecureCrypto()) {
    return;
  }

  if (location.pathname.startsWith("/s/")) {
    await openShare();
    return;
  }

  const shortShareToken = shortTokenFromPath();
  if (shortShareToken && await openShare({ token: shortShareToken, silentNotFound: true })) {
    return;
  }

  const lastTopic = topicFromPath() || localStorage.getItem("rapid-vimnote:last-topic") || "";
  els.topicInput.value = lastTopic;
  els.pinInput.focus();
  setVimMode("locked");
  applyUiMode("normal");
}

function wireEvents() {
  window.addEventListener("online", updateNetwork);
  window.addEventListener("offline", updateNetwork);
  window.addEventListener("resize", renderResponsiveLabels);
  window.addEventListener("click", (event) => {
    if (!event.target.closest(".context-menu")) hideContextMenu();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideContextMenu();
  });

  els.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ensureSecureCrypto()) {
      return;
    }

    const pin = els.pinInput.value.trim();
    const topic = normalizeTopic(els.topicInput.value);
    if (!pin || !topic) {
      flash("pin y cuaderno son requeridos");
      return;
    }
    await unlockTopic(pin, topic);
  });

  els.modeSwitchButton.addEventListener("click", async () => {
    if (!state.key) return;
    await saveLocalNow();
    switchUiMode(state.uiMode === "nerd" ? "normal" : "nerd");
  });

  els.topicLinkButton.addEventListener("click", async () => {
    if (!state.topic) return;
    await copyShortTopicLink();
  });

  els.wallpaperButton.addEventListener("click", () => {
    cycleWallpaper();
  });

  els.shareButton.addEventListener("click", async () => {
    if (!state.key) {
      flash("abre un cuaderno primero");
      return;
    }
    await saveLocalNow();
    await createPublicShare("5m", state.currentFile);
  });

  els.editor.addEventListener("input", () => {
    commitVimEditor();
    markDirty("editando en vim");
  });
  els.editor.addEventListener("keydown", handleEditorKeydown);
  els.commandInput.addEventListener("keydown", handleCommandKeydown);

  els.terminalForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const raw = els.terminalInput.value;
    els.terminalInput.value = "";
    await runTerminalCommand(raw);
  });

  els.terminalActions.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-command]");
    if (!button) return;
    await runTerminalQuickCommand(button.dataset.command);
  });

  els.desktopCanvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const fileEl = event.target.closest("[data-file]");
    state.contextTargetFile = fileEl ? fileEl.dataset.file : "";
    state.contextPoint = desktopPointFromEvent(event);
    showContextMenu(event.clientX, event.clientY, Boolean(fileEl));
  });

  els.desktopCanvas.addEventListener("click", (event) => {
    if (state.suppressNextDesktopClick) {
      event.preventDefault();
      state.suppressNextDesktopClick = false;
      return;
    }

    const fileEl = event.target.closest("[data-file]");
    if (!fileEl) {
      state.desktopSelectedFile = "";
      renderDesktop();
      return;
    }
    openDesktopFile(fileEl.dataset.file);
  });

  els.desktopCanvas.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    if (!touch) return;
    const fileEl = event.target.closest("[data-file]");
    state.touchedFile = fileEl ? fileEl.dataset.file : "";
    state.touchMoved = false;
    state.contextTargetFile = state.touchedFile;
    state.contextPoint = desktopPointFromTouch(touch);
    clearTimeout(state.touchTimer);
    state.touchTimer = setTimeout(() => {
      state.suppressNextDesktopClick = true;
      if (navigator.vibrate) navigator.vibrate(18);
      showContextMenu(touch.clientX, touch.clientY, Boolean(state.contextTargetFile));
    }, 520);
  }, { passive: true });

  els.desktopCanvas.addEventListener("touchend", () => {
    clearTimeout(state.touchTimer);
    if (state.touchedFile && !state.touchMoved && !state.suppressNextDesktopClick) {
      openDesktopFile(state.touchedFile, false);
      state.suppressNextDesktopClick = true;
      setTimeout(() => {
        state.suppressNextDesktopClick = false;
      }, 700);
    } else if (state.suppressNextDesktopClick) {
      setTimeout(() => {
        state.suppressNextDesktopClick = false;
      }, 700);
    }
    state.touchedFile = "";
  });

  els.desktopCanvas.addEventListener("touchmove", () => {
    state.touchMoved = true;
    clearTimeout(state.touchTimer);
  }, { passive: true });

  els.contextMenu.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    await runContextAction(button.dataset.action);
  });

  els.desktopEditor.addEventListener("input", () => {
    commitDesktopEditor();
    markDirty("editando archivo");
  });

  els.desktopCloseButton.addEventListener("click", async () => {
    commitDesktopEditor();
    await saveLocalNow();
    els.desktopWindow.hidden = true;
  });

  els.desktopShareButton.addEventListener("click", async () => {
    const ttl = prompt("Tiempo para compartir: 30s, 5m, 15m, 1h", "5m") || "5m";
    await saveLocalNow();
    await createPublicShare(ttl, state.currentFile);
  });

  els.topicList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-topic]");
    if (!button) return;
    await saveLocalNow();
    els.topicInput.value = button.dataset.topic;
    lock();
  });

  window.addEventListener("beforeunload", () => {
    if (state.dirty) saveLocalNow();
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
  state.workspace = createWorkspace();
  state.currentFile = "note.txt";
  state.desktopSelectedFile = "";
  state.editorOpen = false;

  localStorage.setItem("rapid-vimnote:last-topic", topic);
  setShortTopicPath(topic);
  els.topicLabel.textContent = topic;
  els.boot.hidden = true;
  els.shareView.hidden = true;
  els.topicLinkButton.hidden = false;
  els.modeSwitchButton.hidden = false;
  els.wallpaperButton.hidden = false;
  els.shareButton.hidden = false;

  const local = await loadLocal(topic);
  if (local) {
    const payload = await decryptText(state.key, local.iv, local.bodyCipher);
    applyWorkspace(parseWorkspace(payload));
    state.revision = local.revision || 0;
    state.dirty = Boolean(local.dirty);
    renderStatus(local.dirty ? "local pendiente de sync" : "cuaderno local cargado");
  } else {
    applyWorkspace(createWorkspace());
    renderStatus("cuaderno nuevo");
  }

  await syncFromRemote();
  await saveTopicMeta(topic);
  renderTopics();
  switchUiMode(state.uiMode);
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
      const payload = await decryptText(state.key, remote.iv, remote.bodyCipher);
      applyWorkspace(parseWorkspace(payload));
      state.revision = remote.revision;
      state.dirty = false;
      await saveEncryptedLocal(serializeWorkspace(), false);
      renderStatus("sync remoto recibido");
      return;
    }

    if (state.dirty) await syncToRemote(false);
  } catch {
    renderStatus("sin red usable, seguimos local");
  }
}

async function syncToRemote(force) {
  if (!state.topicId || !navigator.onLine) {
    renderStatus("guardado local, sync luego");
    return;
  }

  const payload = serializeWorkspace();
  const encrypted = await encryptText(state.key, payload);

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
      const serverPayload = await decryptText(state.key, conflict.server.iv, conflict.server.bodyCipher);
      const serverWorkspace = parseWorkspace(serverPayload);
      state.workspace = mergeWorkspaces(state.workspace, serverWorkspace);
      state.revision = conflict.server.revision;
      state.dirty = true;
      renderWorkspaceViews();
      await saveEncryptedLocal(serializeWorkspace(), true);
      renderStatus("conflicto mezclado, usa :w! para forzar");
      return;
    }

    const saved = await response.json();
    state.revision = saved.revision;
    state.dirty = false;
    await saveEncryptedLocal(payload, false);
    renderStatus("sync ok");
  } catch {
    await saveEncryptedLocal(payload, true);
    renderStatus("red fallo, quedo local");
  }
}

function createWorkspace(content = "") {
  const now = Date.now();
  const existingCount = Object.keys(state.workspace?.files || {}).length;
  return {
    marker: WORKSPACE_MARKER,
    version: 2,
    wallpaper: "walnut",
    currentFile: "note.txt",
    files: {
      "note.txt": {
        type: "text",
        content,
        createdAt: now,
        updatedAt: now,
        ...nextFilePosition(existingCount)
      }
    }
  };
}

function parseWorkspace(payload) {
  try {
    const parsed = JSON.parse(payload);
    if (parsed && parsed.marker === WORKSPACE_MARKER && parsed.files && typeof parsed.files === "object") {
      return normalizeWorkspace(parsed);
    }
  } catch {
    return createWorkspace(payload || "");
  }
  return createWorkspace(payload || "");
}

function normalizeWorkspace(workspace) {
  const now = Date.now();
  const normalized = {
    marker: WORKSPACE_MARKER,
    version: 2,
    wallpaper: WALLPAPERS.includes(workspace.wallpaper) ? workspace.wallpaper : "walnut",
    currentFile: "",
    files: {}
  };

  for (const [name, file] of Object.entries(workspace.files || {})) {
    const source = file && typeof file === "object" ? file : {};
    const safeName = normalizeFileName(name, "note.txt");
    normalized.files[safeName] = {
      type: "text",
      content: typeof source.content === "string" ? source.content : "",
      createdAt: Number.isFinite(source.createdAt) ? source.createdAt : now,
      updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : now,
      x: Number.isFinite(source.x) ? source.x : 28 + Object.keys(normalized.files).length * 92,
      y: Number.isFinite(source.y) ? source.y : 28
    };
  }

  if (!Object.keys(normalized.files).length) {
    return createWorkspace();
  }

  normalized.currentFile = normalized.files[workspace.currentFile] ? workspace.currentFile : Object.keys(normalized.files)[0];
  return normalized;
}

function applyWorkspace(workspace) {
  state.workspace = normalizeWorkspace(workspace);
  state.currentFile = state.workspace.currentFile;
  state.desktopSelectedFile = state.currentFile;
  renderWorkspaceViews();
}

function serializeWorkspace() {
  commitActiveEditors();
  if (!state.workspace) state.workspace = createWorkspace();
  state.workspace.currentFile = state.currentFile || firstFileName();
  return JSON.stringify(state.workspace);
}

function mergeWorkspaces(localWorkspace, serverWorkspace) {
  const merged = normalizeWorkspace(serverWorkspace);
  const local = normalizeWorkspace(localWorkspace);
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 12);

  for (const [name, file] of Object.entries(local.files)) {
    if (!merged.files[name]) {
      merged.files[name] = file;
      continue;
    }

    if (merged.files[name].content !== file.content) {
      const copyName = uniqueFileName(`${withoutExtension(name)}.local-${stamp}.txt`);
      merged.files[copyName] = { ...file, x: file.x + 30, y: file.y + 30 };
    }
  }

  merged.currentFile = local.currentFile || merged.currentFile;
  return merged;
}

function renderWorkspaceViews() {
  renderDesktop();
  renderTerminalPrompt();
  if (state.editorOpen) openVim(state.currentFile, false);
  if (!els.desktopWindow.hidden) openDesktopFile(state.currentFile, false);
}

async function saveLocalNow() {
  if (!state.key || !state.topic) return;
  await saveEncryptedLocal(serializeWorkspace(), state.dirty);
}

async function saveEncryptedLocal(payload, dirty) {
  const encrypted = await encryptText(state.key, payload);
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
    empty.textContent = "sin cuadernos";
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

function switchUiMode(mode) {
  state.uiMode = mode === "nerd" ? "nerd" : "normal";
  localStorage.setItem("rapid-vimnote:ui-mode", state.uiMode);
  applyUiMode(state.uiMode);
}

function applyUiMode(mode) {
  hideContextMenu();
  closeCommand();
  renderResponsiveLabels();
  els.wallpaperButton.hidden = !state.key || mode === "nerd";

  if (!state.key) {
    els.normalDesktop.hidden = true;
    els.nerdShell.hidden = true;
    els.editor.hidden = true;
    return;
  }

  if (mode === "nerd") {
    state.editorOpen = false;
    els.normalDesktop.hidden = true;
    els.nerdShell.hidden = false;
    els.editor.hidden = true;
    setVimMode("shell");
    renderTerminalPrompt();
    if (!els.terminalOutput.dataset.booted) {
      writeTerminal("Rapid Vimnote shell. Usa ls, cat, echo, touch, vim, share, sync, help.");
      els.terminalOutput.dataset.booted = "1";
    }
    els.terminalInput.focus();
    return;
  }

  state.editorOpen = false;
  els.nerdShell.hidden = true;
  els.normalDesktop.hidden = false;
  els.editor.hidden = true;
  setVimMode("desktop");
  renderDesktop();
}

function renderModeButton() {
  const isCompact = window.matchMedia("(max-width: 760px)").matches;
  if (state.uiMode === "nerd") {
    els.modeSwitchButton.textContent = isCompact ? "Normal" : "Modo normal";
  } else {
    els.modeSwitchButton.textContent = isCompact ? "Nerd" : "Modo nerd";
  }
}

function renderResponsiveLabels() {
  renderModeButton();
  const isCompact = window.matchMedia("(max-width: 760px)").matches;
  els.topicLinkButton.textContent = isCompact ? "Cuaderno" : "Link cuaderno";
  els.shareButton.textContent = isCompact ? "Archivo" : "Share archivo 5m";
}

function renderDesktop() {
  if (!state.workspace) return;
  els.normalDesktop.dataset.wallpaper = state.workspace.wallpaper || "walnut";
  els.desktopCanvas.innerHTML = "";

  for (const [name, file] of Object.entries(state.workspace.files)) {
    const icon = document.createElement("button");
    icon.type = "button";
    icon.className = "file-icon";
    if (name === state.desktopSelectedFile) icon.classList.add("selected");
    icon.dataset.file = name;
    const position = clampFilePosition(file.x || 28, file.y || 28);
    file.x = position.x;
    file.y = position.y;
    icon.style.left = `${position.x}px`;
    icon.style.top = `${position.y}px`;
    icon.innerHTML = `<span class="file-paper">txt</span><span>${escapeHtml(name)}</span>`;
    els.desktopCanvas.append(icon);
  }
}

function openDesktopFile(fileName, focus = true) {
  const file = getFile(fileName);
  if (!file) return;
  state.currentFile = fileName;
  state.workspace.currentFile = fileName;
  state.desktopSelectedFile = fileName;
  els.desktopWindow.hidden = false;
  els.desktopWindowTitle.textContent = fileName;
  if (els.desktopEditor.value !== file.content) els.desktopEditor.value = file.content;
  renderDesktop();
  renderStatus(`abierto ${fileName}`);
  if (focus) els.desktopEditor.focus();
}

function commitDesktopEditor() {
  if (els.desktopWindow.hidden || !state.currentFile) return;
  const file = getFile(state.currentFile);
  if (!file) return;
  if (file.content !== els.desktopEditor.value) {
    file.content = els.desktopEditor.value;
    file.updatedAt = Date.now();
  }
}

function showContextMenu(clientX, clientY, hasFile) {
  const actions = els.contextMenu.querySelectorAll("[data-action]");
  actions.forEach((button) => {
    const fileOnly = ["open-file", "share-file", "rename-file", "delete-file"].includes(button.dataset.action);
    button.hidden = fileOnly && !hasFile;
  });

  els.contextMenu.hidden = false;
  const rect = els.contextMenu.getBoundingClientRect();
  const x = Math.min(clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(clientY, window.innerHeight - rect.height - 8);
  els.contextMenu.style.left = `${Math.max(8, x)}px`;
  els.contextMenu.style.top = `${Math.max(8, y)}px`;
}

function hideContextMenu() {
  els.contextMenu.hidden = true;
}

async function runContextAction(action) {
  const target = state.contextTargetFile;
  hideContextMenu();

  if (action === "new-file") {
    const name = uniqueFileName("nuevo.txt");
    createFile(name, "", state.contextPoint.x, state.contextPoint.y);
    openDesktopFile(name);
    markDirty(`creado ${name}`);
    return;
  }

  if (action === "wallpaper") {
    cycleWallpaper();
    return;
  }

  if (!target) return;

  if (action === "open-file") {
    openDesktopFile(target);
    return;
  }

  if (action === "share-file") {
    const ttl = prompt("Tiempo para compartir: 30s, 5m, 15m, 1h", "5m") || "5m";
    await saveLocalNow();
    await createPublicShare(ttl, target);
    return;
  }

  if (action === "rename-file") {
    const next = normalizeFileName(prompt("Nuevo nombre", target) || "", target);
    if (next && next !== target) renameFile(target, next);
    return;
  }

  if (action === "delete-file") {
    if (Object.keys(state.workspace.files).length <= 1) {
      renderStatus("deja al menos un archivo");
      return;
    }
    if (confirm(`Borrar ${target}?`)) deleteFile(target);
  }
}

function desktopPointFromEvent(event) {
  const rect = els.desktopCanvas.getBoundingClientRect();
  return {
    x: Math.round(event.clientX - rect.left),
    y: Math.round(event.clientY - rect.top)
  };
}

function desktopPointFromTouch(touch) {
  const rect = els.desktopCanvas.getBoundingClientRect();
  return {
    x: Math.round(touch.clientX - rect.left),
    y: Math.round(touch.clientY - rect.top)
  };
}

async function runTerminalQuickCommand(command) {
  const current = state.currentFile || firstFileName();

  if (command === "ls" || command === "sync") {
    await runTerminalCommand(command);
    return;
  }

  if (command === "cat") {
    els.terminalInput.value = `cat ${current}`;
    els.terminalInput.focus();
    return;
  }

  if (command === "vim") {
    els.terminalInput.value = `vim ${current}`;
    els.terminalInput.focus();
    return;
  }

  if (command === "share") {
    els.terminalInput.value = `share 5m ${current}`;
    els.terminalInput.focus();
    return;
  }

  if (command === "touch") {
    const name = prompt("Nombre del archivo", nextUntitledFileName()) || "";
    if (!name.trim()) return;
    await runTerminalCommand(`touch ${name}`);
    renderStatus(`creado ${state.currentFile}`);
  }
}

function cycleWallpaper() {
  if (!state.workspace) return;
  const current = WALLPAPERS.indexOf(state.workspace.wallpaper);
  state.workspace.wallpaper = WALLPAPERS[(current + 1) % WALLPAPERS.length];
  renderDesktop();
  markDirty(`fondo ${state.workspace.wallpaper}`);
}

async function runTerminalCommand(raw) {
  const input = raw.trim();
  if (!input) return;
  writeTerminal(`$ ${input}`);

  const redirect = input.match(/^echo\s+(.+?)\s*(>>|>)\s+(.+)$/);
  if (redirect) {
    const text = unquote(redirect[1]);
    const op = redirect[2];
    const fileName = normalizeFileName(redirect[3], "note.txt");
    const file = ensureFile(fileName);
    file.content = op === ">>" ? `${file.content}${file.content ? "\n" : ""}${text}` : text;
    file.updatedAt = Date.now();
    state.currentFile = fileName;
    markDirty(`${op} ${fileName}`);
    writeTerminal(fileName);
    return;
  }

  const args = parseArgs(input);
  const cmd = (args[0] || "").toLowerCase();

  switch (cmd) {
    case "help":
      writeTerminal("ls | cat file.txt | touch file.txt | echo \"texto\" >> file.txt | vim file.txt | share 5m [file] | rm file.txt | mv a b | sync | clear | desktop | lock");
      break;
    case "clear":
      els.terminalOutput.innerHTML = "";
      break;
    case "pwd":
      writeTerminal(`/home/rapid/${state.topic}`);
      break;
    case "ls":
      writeTerminal(Object.keys(state.workspace.files).join("  ") || "(vacio)");
      break;
    case "cat":
      writeTerminal(readFileForTerminal(args[1] || state.currentFile));
      break;
    case "touch":
      if (!args[1]) return writeTerminal("touch: falta archivo");
      ensureFile(args[1]);
      state.currentFile = normalizeFileName(args[1], "nuevo.txt");
      state.workspace.currentFile = state.currentFile;
      state.desktopSelectedFile = state.currentFile;
      state.workspace.files[state.currentFile].updatedAt = Date.now();
      renderWorkspaceViews();
      markDirty(`touch ${state.currentFile}`);
      writeTerminal(state.currentFile);
      break;
    case "vim":
    case "vi":
      openVim(normalizeFileName(args[1] || state.currentFile, "note.txt"));
      break;
    case "share":
      await saveLocalNow();
      await createPublicShare(args[1] || "5m", args[2] || state.currentFile);
      break;
    case "sync":
      await saveLocalNow();
      await syncFromRemote();
      await syncToRemote(false);
      break;
    case "rm":
      if (!args[1]) return writeTerminal("rm: falta archivo");
      deleteFile(args[1], false);
      break;
    case "mv":
      if (!args[1] || !args[2]) return writeTerminal("mv: usa mv origen destino");
      renameFile(args[1], args[2]);
      break;
    case "desktop":
    case "normal":
      switchUiMode("normal");
      break;
    case "lock":
    case "exit":
      await saveLocalNow();
      lock();
      break;
    case "w":
    case "write":
      await commandWrite(false);
      break;
    default:
      writeTerminal(`${cmd}: comando no encontrado`);
  }
}

function writeTerminal(text) {
  const block = document.createElement("div");
  block.textContent = text;
  els.terminalOutput.append(block);
  els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
}

function renderTerminalPrompt() {
  els.terminalPrompt.textContent = `~/` + (state.topic || "locked") + " $";
}

function readFileForTerminal(fileName) {
  const file = getFile(fileName);
  if (!file) return `cat: ${fileName}: no existe`;
  return file.content || "";
}

function parseArgs(input) {
  const args = [];
  input.replace(/"([^"]*)"|'([^']*)'|(\S+)/g, (_, doubleQuoted, singleQuoted, bare) => {
    args.push(doubleQuoted ?? singleQuoted ?? bare);
    return "";
  });
  return args;
}

function unquote(value) {
  const trimmed = String(value).trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function openVim(fileName, focus = true) {
  const safeName = normalizeFileName(fileName, "note.txt");
  const file = ensureFile(safeName);
  state.currentFile = safeName;
  state.workspace.currentFile = safeName;
  state.editorOpen = true;
  els.editor.hidden = false;
  els.editor.value = file.content;
  setVimMode("normal");
  renderStatus(`vim ${safeName}`);
  if (focus) els.editor.focus();
}

function closeVim() {
  commitVimEditor();
  state.editorOpen = false;
  els.editor.hidden = true;
  closeCommand();
  setVimMode(state.uiMode === "nerd" ? "shell" : "desktop");
  if (state.uiMode === "nerd") els.terminalInput.focus();
}

function commitVimEditor() {
  if (!state.editorOpen || !state.currentFile) return;
  const file = getFile(state.currentFile);
  if (!file) return;
  if (file.content !== els.editor.value) {
    file.content = els.editor.value;
    file.updatedAt = Date.now();
  }
}

function commitActiveEditors() {
  commitVimEditor();
  commitDesktopEditor();
}

function handleEditorKeydown(event) {
  if (!state.editorOpen) return;

  if (event.key === "Escape") {
    event.preventDefault();
    closeCommand();
    setVimMode("normal");
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    commandWrite(false);
    return;
  }

  if (state.vimMode === "insert") return;

  if (state.vimMode === "normal") {
    if (event.key.length === 1 || ["Backspace", "Enter", "Tab"].includes(event.key)) {
      event.preventDefault();
    }

    if (event.key === "i") return setVimMode("insert");
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
    setVimMode("normal");
    els.editor.focus();
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    const value = els.commandInput.value.trim();
    closeCommand();
    runVimCommand(value);
  }
}

function openCommand(prefix) {
  state.vimMode = "command";
  els.commandBar.hidden = false;
  els.commandInput.value = prefix;
  els.commandInput.focus();
  renderStatus("comando");
}

function closeCommand() {
  els.commandBar.hidden = true;
}

async function runVimCommand(raw) {
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
    case "wq":
      await commandWrite(false);
      closeVim();
      break;
    case "q":
      await saveLocalNow();
      closeVim();
      break;
    case "lock":
      await saveLocalNow();
      lock();
      break;
    case "e":
    case "edit":
      openVim(arg || state.currentFile);
      break;
    case "sync":
      await syncFromRemote();
      await syncToRemote(false);
      break;
    case "topic":
      await saveLocalNow();
      els.topicInput.value = normalizeTopic(arg);
      lock();
      break;
    case "ls":
      renderStatus(Object.keys(state.workspace.files).join(" ") || "sin archivos");
      break;
    case "share":
      await createPublicShareFromText(arg || "5m", state.currentFile);
      break;
    case "find":
      findText(arg);
      break;
    case "clear":
      els.editor.value = "";
      commitVimEditor();
      markDirty("buffer limpio");
      break;
    case "help":
      renderStatus(":w | :q | :e file.txt | :share 5m | :ls | :sync | :lock");
      break;
    default:
      renderStatus(cmd ? `comando no existe: ${cmd}` : "sin comando");
  }

  if (state.editorOpen) {
    setVimMode("normal");
    els.editor.focus();
  }
}

async function commandWrite(force) {
  commitActiveEditors();
  await saveLocalNow();
  await syncToRemote(force);
}

async function createPublicShare(ttlText, fileName = state.currentFile) {
  if (!state.key) return;

  const safeName = normalizeFileName(fileName, state.currentFile);
  const file = getFile(safeName);
  if (!file) {
    renderStatus(`no existe ${safeName}`);
    if (state.uiMode === "nerd") writeTerminal(`share: ${safeName}: no existe`);
    return;
  }

  const ttlSeconds = parseTtl(ttlText);
  const shareKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const encrypted = await encryptText(shareKey, file.content);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", shareKey));
  const shareKeyText = base64url(raw);

  let data;
  try {
    const response = await api("/api/share", {
      method: "POST",
      body: {
        topicId: state.topicId,
        bodyCipher: encrypted.bodyCipher,
        iv: encrypted.iv,
        shareKey: shareKeyText,
        ttlSeconds
      }
    });

    data = await response.json();
    if (!response.ok || !data.token) {
      throw new Error(data.error || "share_failed");
    }
  } catch {
    renderStatus("no pude crear share, red no disponible");
    if (state.uiMode === "nerd") writeTerminal("share: red no disponible");
    return;
  }

  const link = `${location.origin}/${data.token}`;
  await publishCreatedShareLink(link, safeName, data.expiresAt);
}

async function publishCreatedShareLink(link, fileName, expiresAt) {
  const expires = new Date(expiresAt).toLocaleTimeString();
  const message = `archivo ${fileName} compartido, expira ${expires}`;

  if (state.uiMode === "nerd") writeTerminal(link);

  try {
    if (navigator.share) {
      await navigator.share({
        title: "Rapid Vimnote",
        text: `Archivo compartido: ${fileName}`,
        url: link
      });
      renderStatus(`${message}. link enviado`);
      return;
    }
  } catch {
    // Continue to clipboard/manual fallback.
  }

  try {
    await copyText(link);
    renderStatus(`${message}. link copiado`);
    return;
  } catch {
    renderStatus(`${message}. copia manual: ${link}`);
    prompt("Copia este link", link);
  }
}

async function createPublicShareFromText(input, fallbackFile) {
  const args = parseArgs(`share ${input}`);
  await createPublicShare(args[1] || "5m", args[2] || fallbackFile);
}

function parseTtl(text) {
  const match = String(text).trim().match(/^(\d+)\s*([smh]?)$/i);
  if (!match) return 300;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const seconds = unit === "h" ? value * 3600 : unit === "s" ? value : value * 60;
  return Math.min(3600, Math.max(30, seconds));
}

async function openShare(options = {}) {
  els.boot.hidden = true;
  els.editor.hidden = true;
  els.modeSwitchButton.hidden = true;
  els.topicLinkButton.hidden = true;
  els.wallpaperButton.hidden = true;
  els.shareButton.hidden = true;
  els.normalDesktop.hidden = true;
  els.nerdShell.hidden = true;
  els.shareView.hidden = false;
  setVimMode("share");

  const token = options.token || location.pathname.split("/").filter(Boolean).pop();
  let keyText = location.hash.slice(1);

  if (!token) {
    els.shareText.textContent = "link incompleto";
    return true;
  }

  try {
    const response = await fetch(`/api/share/${token}`, { headers: { accept: "application/json" } });
    const data = await response.json();

    if (!response.ok) {
      if (options.silentNotFound && response.status === 404) {
        resetShareShellForLogin();
        return false;
      }
      els.shareText.textContent = data.error === "expired" ? "share expirado" : "share no encontrado";
      return true;
    }

    keyText = keyText || data.shareKey || "";
    if (!keyText) {
      els.shareText.textContent = "este share no tiene llave temporal. Vuelve a compartir el archivo para generar un link corto nuevo.";
      return true;
    }

    const keyBytes = fromBase64url(keyText);
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const text = await decryptText(key, data.iv, data.bodyCipher);
    els.shareText.textContent = text || "(vacio)";
    els.shareMeta.textContent = `archivo compartido | expira ${new Date(data.expiresAt).toLocaleString()}`;
    return true;
  } catch {
    if (options.silentNotFound) {
      resetShareShellForLogin();
      return false;
    }
    els.shareText.textContent = "no pude abrir este share";
    return true;
  }
}

function markDirty(message) {
  state.dirty = true;
  renderStatus(message);
  scheduleLocalSave();
}

function scheduleLocalSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    await saveLocalNow();
    syncToRemote(false);
  }, 900);
}

function setVimMode(mode) {
  state.vimMode = String(mode).toLowerCase();
  els.editor.readOnly = state.vimMode !== "insert";
  els.mode.textContent = String(mode).toUpperCase();
  renderStatus();
}

function lock() {
  state.vimMode = "locked";
  state.session = null;
  state.key = null;
  state.topicId = "";
  state.revision = 0;
  state.dirty = false;
  state.workspace = null;
  state.currentFile = "note.txt";
  state.editorOpen = false;
  els.editor.value = "";
  els.editor.hidden = true;
  els.desktopWindow.hidden = true;
  els.boot.hidden = false;
  els.modeSwitchButton.hidden = true;
  els.topicLinkButton.hidden = true;
  els.wallpaperButton.hidden = true;
  els.shareButton.hidden = true;
  els.normalDesktop.hidden = true;
  els.nerdShell.hidden = true;
  els.pinInput.value = "";
  els.pinInput.focus();
  els.topicLabel.textContent = "locked";
  setVimMode("locked");
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

function resetShareShellForLogin() {
  els.shareView.hidden = true;
  els.boot.hidden = false;
  els.editor.hidden = true;
  els.modeSwitchButton.hidden = true;
  els.topicLinkButton.hidden = true;
  els.wallpaperButton.hidden = true;
  els.shareButton.hidden = true;
  els.normalDesktop.hidden = true;
  els.nerdShell.hidden = true;
  setVimMode("locked");
}

function ensureSecureCrypto() {
  if (globalThis.crypto && globalThis.crypto.subtle) {
    return true;
  }

  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  if (location.protocol === "http:" && !isLocalhost) {
    location.replace(`https://${location.host}${location.pathname}${location.search}${location.hash}`);
    return false;
  }

  flash("WebCrypto no esta disponible. Abre la app con HTTPS o localhost.");
  const submit = els.loginForm.querySelector("button[type='submit']");
  if (submit) submit.disabled = true;
  return false;
}

function topicFromPath() {
  const parts = location.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (!parts.length) return "";

  if (parts[0] === "t" && parts[1]) {
    return normalizeTopic(parts[1]);
  }

  const reserved = new Set([
    "api",
    "s",
    "app.js",
    "styles.css",
    "sw.js",
    "manifest.webmanifest",
    "favicon.ico"
  ]);

  if (reserved.has(parts[0])) return "";
  return normalizeTopic(parts[0]);
}

function shortTokenFromPath() {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts.length !== 1) return "";
  const segment = decodeURIComponent(parts[0]);
  if (/^[a-z2-9]{5}$/.test(segment)) return segment;
  return "";
}

function shortTopicLink(topic = state.topic) {
  return `${location.origin}/${encodeURIComponent(topic)}`;
}

function setShortTopicPath(topic) {
  if (!topic || location.pathname.startsWith("/s/")) return;
  const nextPath = `/${encodeURIComponent(topic)}`;
  if (location.pathname !== nextPath) {
    history.replaceState(null, "", nextPath);
  }
}

async function copyShortTopicLink() {
  const link = shortTopicLink();
  await copyText(link);
  renderStatus(`link de cuaderno copiado: ${link}`);
}

function createFile(name, content = "", x = 28, y = 28) {
  if (!state.workspace) state.workspace = createWorkspace();
  const fileName = uniqueFileName(normalizeFileName(name, "nuevo.txt"));
  const now = Date.now();
  const position = clampFilePosition(x, y);
  state.workspace.files[fileName] = {
    type: "text",
    content,
    createdAt: now,
    updatedAt: now,
    x: position.x,
    y: position.y
  };
  state.currentFile = fileName;
  state.workspace.currentFile = fileName;
  state.desktopSelectedFile = fileName;
  renderWorkspaceViews();
  return fileName;
}

function ensureFile(name) {
  const fileName = normalizeFileName(name, "note.txt");
  if (!state.workspace.files[fileName]) {
    const position = nextFilePosition(Object.keys(state.workspace.files).length);
    createFile(fileName, "", position.x, position.y);
  }
  return state.workspace.files[fileName];
}

function getFile(name) {
  if (!state.workspace || !name) return null;
  return state.workspace.files[name] || null;
}

function firstFileName() {
  return Object.keys(state.workspace?.files || {})[0] || "note.txt";
}

function renameFile(from, to) {
  const source = normalizeFileName(from, "");
  const target = normalizeFileName(to, "");
  if (!source || !target || !state.workspace.files[source]) return;
  if (state.workspace.files[target]) {
    renderStatus(`${target} ya existe`);
    return;
  }
  state.workspace.files[target] = state.workspace.files[source];
  delete state.workspace.files[source];
  if (state.currentFile === source) state.currentFile = target;
  if (state.workspace.currentFile === source) state.workspace.currentFile = target;
  state.desktopSelectedFile = target;
  renderWorkspaceViews();
  markDirty(`renombrado ${target}`);
}

function deleteFile(name, ask = true) {
  const fileName = normalizeFileName(name, "");
  if (!fileName || !state.workspace.files[fileName]) return;
  if (Object.keys(state.workspace.files).length <= 1) {
    renderStatus("deja al menos un archivo");
    return;
  }
  if (ask && !confirm(`Borrar ${fileName}?`)) return;
  delete state.workspace.files[fileName];
  state.currentFile = firstFileName();
  state.workspace.currentFile = state.currentFile;
  state.desktopSelectedFile = state.currentFile;
  if (!els.desktopWindow.hidden) openDesktopFile(state.currentFile, false);
  renderWorkspaceViews();
  markDirty(`borrado ${fileName}`);
}

function uniqueFileName(baseName) {
  const safeBase = normalizeFileName(baseName, "nuevo.txt");
  if (!state.workspace || !state.workspace.files[safeBase]) return safeBase;

  const base = withoutExtension(safeBase);
  let index = 2;
  let next = `${base}-${index}.txt`;
  while (state.workspace.files[next]) {
    index += 1;
    next = `${base}-${index}.txt`;
  }
  return next;
}

function normalizeFileName(value, fallback) {
  const raw = String(value || "").trim().replace(/^\.\/+/, "");
  const cleaned = raw
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  if (!cleaned) return fallback;
  return /\.[A-Za-z0-9]{1,8}$/.test(cleaned) ? cleaned : `${cleaned}.txt`;
}

function withoutExtension(name) {
  return String(name).replace(/\.[^.]+$/, "");
}

function nextUntitledFileName() {
  let index = Object.keys(state.workspace?.files || {}).length + 1;
  let name = `file-${index}.txt`;
  while (state.workspace?.files[name]) {
    index += 1;
    name = `file-${index}.txt`;
  }
  return name;
}

function nextFilePosition(index) {
  const rect = els.desktopCanvas?.getBoundingClientRect();
  const width = rect?.width || window.innerWidth;
  const columns = Math.max(1, Math.floor((width - 20) / 92));
  return clampFilePosition(18 + (index % columns) * 88, 22 + Math.floor(index / columns) * 96);
}

function clampFilePosition(x, y) {
  const rect = els.desktopCanvas?.getBoundingClientRect();
  const width = Math.max(120, rect?.width || window.innerWidth);
  const height = Math.max(160, rect?.height || window.innerHeight);
  return {
    x: Math.max(8, Math.min(Math.round(x), width - 86)),
    y: Math.max(8, Math.min(Math.round(y), height - 98))
  };
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
  setVimMode("insert");
}

function openLineBelow() {
  const bounds = lineBounds();
  const pos = bounds.end;
  els.editor.value = `${els.editor.value.slice(0, pos)}\n${els.editor.value.slice(pos)}`;
  setCaret(pos + 1);
  commitVimEditor();
  markDirty("linea nueva");
  setVimMode("insert");
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
  commitVimEditor();
  markDirty("char borrado");
}

function deleteLine() {
  const bounds = lineBounds();
  const text = els.editor.value;
  let end = bounds.end;
  if (text[end] === "\n") end += 1;
  state.yank = text.slice(bounds.start, end);
  els.editor.value = text.slice(0, bounds.start) + text.slice(end);
  setCaret(Math.min(bounds.start, els.editor.value.length));
  commitVimEditor();
  markDirty("linea borrada");
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
  commitVimEditor();
  markDirty("pegado");
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
  const wasHidden = els.editor.hidden;
  els.editor.hidden = false;
  els.editor.value = text;
  els.editor.select();
  document.execCommand("copy");
  els.editor.value = previous;
  els.editor.hidden = wasHidden;
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
