import { ADMIN, GROUPS, KNOCKOUT, MATCHES, SCORING, TEAMS } from "./data.js";
import { SQUADS } from "./squads.js";

const STORAGE_KEY = "prode-wc26-state-v1";
const app = document.querySelector("#app");

const emptyState = {
  currentUser: null,
  users: {
    [ADMIN.username]: { username: ADMIN.username, password: ADMIN.password, role: "admin", active: true, predictions: {}, awards: {}, savedAt: null }
  },
  realResults: {},
  appSettings: {
    viewPredictionsEnabled: false,
    predictionsLocked: false
  }
};

let state = structuredClone(emptyState);
let activeTab = "prode";
let viewedUsername = null;
let pendingFocus = null;
let storageMode = "local";
let supabase = null;
let currentProfile = null;
let syncTimer = null;
let rankingAwardsVisible = false;
const collapsedGroups = new Set();

const FEATURED_ASSETS = {
  stadium: {
    title: "New York New Jersey Stadium",
    subtitle: "Sede de la final",
    image: "https://commons.wikimedia.org/wiki/Special:FilePath/MetLife_Stadium_Exterior.jpg"
  }
};

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return structuredClone(emptyState);
  const parsed = JSON.parse(raw);
  return {
    ...structuredClone(emptyState),
    ...parsed,
    users: normalizeUsers({ ...emptyState.users, ...(parsed.users || {}) }),
    appSettings: { ...emptyState.appSettings, ...(parsed.appSettings || {}) }
  };
}

function normalizeUsers(users) {
  return Object.fromEntries(Object.entries(users).map(([username, user]) => [username, {
    ...user,
    active: user.active !== false
  }]));
}

function saveState() {
  if (storageMode === "supabase") {
    scheduleSupabaseSync();
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function initApp() {
  await initSupabase();
  if (storageMode === "supabase") {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user) {
      await loadSupabaseState(data.session.user);
    } else {
      state = structuredClone(emptyState);
      state.currentUser = null;
    }
  } else {
    state = loadState();
    const loadedExport = await loadLocalExportState();
    if (!loadedExport) seedLocalDemoUsers();
  }
  render();
}

async function loadLocalExportState() {
  if (!["localhost", "127.0.0.1"].includes(window.location.hostname)) return false;
  try {
    const response = await fetch("./src/local-export.json", { cache: "no-store" });
    if (!response.ok) return false;
    const data = await response.json();
    const importedState = stateFromSupabaseExport(data, state.currentUser);
    state = importedState;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    console.warn("No se pudo cargar el export local", error);
    return false;
  }
}

function stateFromSupabaseExport(data, preferredUser) {
  const users = { ...structuredClone(emptyState).users };
  const profiles = data.profiles || [];
  profiles.forEach(profile => {
    users[profile.username] = {
      id: profile.user_id,
      username: profile.username,
      password: "demo2026",
      role: profile.role,
      active: profile.active !== false,
      predictions: {},
      awards: {},
      savedAt: null
    };
  });

  (data.predictions || []).forEach(row => {
    const owner = Object.values(users).find(user => user.id === row.user_id);
    if (!owner) return;
    owner.predictions = row.data || {};
    owner.awards = row.awards || {};
    owner.savedAt = row.saved_at;
  });

  const adminUser = Object.values(users).find(user => isAdminUser(user));
  const firstActiveUser = Object.values(users).find(user => isActivePlayer(user));
  const currentUser = users[preferredUser]?.username || adminUser?.username || firstActiveUser?.username || null;

  return {
    currentUser,
    users: normalizeUsers(users),
    realResults: data.real_results?.[0]?.data || {},
    appSettings: {
      ...emptyState.appSettings,
      ...(data.app_settings?.[0]?.data || {})
    }
  };
}

function seedLocalDemoUsers() {
  if (!["localhost", "127.0.0.1"].includes(window.location.hostname)) return;
  const demos = [
    { username: "demo_lucia", seed: 1, awards: { topScorer: "Lionel Messi", topScorerTeam: "ARG", goldenBall: "Kylian Mbappe", goldenBallTeam: "FRA", goldenGlove: "Emiliano Martinez", goldenGloveTeam: "ARG" } },
    { username: "demo_mateo", seed: 2, awards: { topScorer: "Harry Kane", topScorerTeam: "ENG", goldenBall: "Jude Bellingham", goldenBallTeam: "ENG", goldenGlove: "Thibaut Courtois", goldenGloveTeam: "BEL" } },
    { username: "demo_sofia", seed: 3, awards: { topScorer: "Kylian Mbappe", topScorerTeam: "FRA", goldenBall: "Lamine Yamal", goldenBallTeam: "ESP", goldenGlove: "Alisson", goldenGloveTeam: "BRA" } }
  ];
  let changed = false;
  demos.forEach(demo => {
    state.users[demo.username] = {
      username: demo.username,
      password: "demo2026",
      role: "player",
      active: true,
      predictions: buildDemoPredictions(demo.seed),
      awards: demo.awards,
      savedAt: new Date().toISOString()
    };
    changed = true;
  });
  state.realResults = buildDemoOfficialResults();
  state.appSettings.viewPredictionsEnabled = true;
  changed = true;
  if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function buildDemoPredictions(seed) {
  const predictions = {};
  MATCHES.forEach(match => {
    predictions[scoreKey(match.id)] = {
      home: (match.id + seed) % 4,
      away: (match.id * seed + 1) % 3
    };
  });
  return predictions;
}

function buildDemoOfficialResults() {
  const results = {};
  MATCHES.forEach(match => {
    results[scoreKey(match.id)] = {
      home: (match.id + 2) % 4,
      away: (match.id + 1) % 3
    };
  });
  return results;
}

async function initSupabase() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return;
    const config = await response.json();
    if (!config.supabaseUrl || !config.supabaseAnonKey) return;
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
    storageMode = "supabase";
  } catch {
    storageMode = "local";
  }
}

function usernameEmail(username) {
  return `${username.trim().toLowerCase()}@prode.local`;
}

async function loadSupabaseState(authUser) {
  const username = authUser.user_metadata?.username || authUser.email?.replace("@prode.local", "") || "usuario";
  let { data: profile } = await supabase.from("profiles").select("*").eq("user_id", authUser.id).maybeSingle();
  if (!profile) {
    const insert = { user_id: authUser.id, username, role: "player", active: true };
    await supabase.from("profiles").insert(insert);
    profile = insert;
  }
  currentProfile = profile;

  const profilesResult = await supabase.from("profiles").select("*").order("username");
  const predictionsResult = await supabase.from("predictions").select("*");
  const realResult = await supabase.from("real_results").select("*").eq("id", "official").maybeSingle();
  const settingsResult = await supabase.from("app_settings").select("*").eq("id", "public").maybeSingle();

  const users = {};
  (profilesResult.data || [profile]).forEach(row => {
    users[row.username] = {
      id: row.user_id,
      username: row.username,
      password: "",
      role: row.role,
      active: row.active !== false,
      predictions: {},
      awards: {},
      savedAt: null
    };
  });
  (predictionsResult.data || []).forEach(row => {
    const owner = Object.values(users).find(user => user.id === row.user_id);
    if (!owner) return;
    owner.predictions = row.data || {};
    owner.awards = row.awards || {};
    owner.savedAt = row.saved_at;
  });

  state = {
    currentUser: profile.username,
    users,
    realResults: realResult.data?.data || {},
    appSettings: {
      ...emptyState.appSettings,
      ...(settingsResult.data?.data || {})
    }
  };
}

function scheduleSupabaseSync() {
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(syncSupabaseState, 350);
}

async function syncSupabaseState() {
  if (!supabase || !currentProfile || !state.currentUser) return;
  const user = state.users[state.currentUser];
  if (!user) return;
  if (!state.appSettings.predictionsLocked) {
    await supabase.from("predictions").upsert({
      user_id: currentProfile.user_id,
      data: user.predictions || {},
      awards: user.awards || {},
      saved_at: user.savedAt || new Date().toISOString()
    });
  }
  if (isAdminUser(user)) {
    await supabase.from("real_results").upsert({
      id: "official",
      data: state.realResults || {},
      updated_at: new Date().toISOString()
    });
    await supabase.from("app_settings").upsert({
      id: "public",
      data: state.appSettings || {},
      updated_at: new Date().toISOString()
    });
  }
}

const byId = (id) => document.getElementById(id);
const scoreKey = (id) => `m${id}`;
const teamName = (code) => code ? `${TEAMS[code]?.flag || ""} ${TEAMS[code]?.name || code}` : "Por definir";
const teamBadge = (code) => code
  ? `<span class="teamName"><span class="flag">${flagMarkup(code)}</span><span>${TEAMS[code]?.name || code}</span></span>`
  : `<span class="teamName mutedTeam"><span>Por definir</span></span>`;
const isCompleteScore = (score) => Number.isInteger(score?.home) && Number.isInteger(score?.away);
const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const LEGACY_AWARD_TEAMS = {
  "Lionel Messi": "ARG",
  "Kylian Mbappe": "FRA",
  "Erling Haaland": "NOR",
  "Vinicius Junior": "BRA",
  "Jude Bellingham": "ENG",
  "Lamine Yamal": "ESP",
  "Harry Kane": "ENG",
  "Cristiano Ronaldo": "POR",
  "Pedri": "ESP",
  "Federico Valverde": "URU",
  "Mohamed Salah": "EGY",
  "Florian Wirtz": "GER",
  "Jamal Musiala": "GER",
  "Achraf Hakimi": "MAR",
  "Emiliano Martinez": "ARG",
  "Thibaut Courtois": "BEL",
  "Alisson Becker": "BRA",
  "Manuel Neuer": "GER"
};

function flagMarkup(code) {
  if (code === "SCO") return '<span class="scotlandFlag" aria-label="Escocia"></span>';
  return TEAMS[code]?.flag || "";
}

function formatArt(match, timeOnly = false) {
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6 };
  const monthNames = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const [dayRaw, monthRaw, yearRaw] = match.date.split(" ");
  const [hourRaw, minuteRaw] = match.time.split(":");
  const date = new Date(Date.UTC(Number(yearRaw), months[monthRaw], Number(dayRaw), Number(hourRaw) + 1, Number(minuteRaw)));
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  if (timeOnly) return `${hh}:${mm} ARG`;
  return `${date.getUTCDate()} ${monthNames[date.getUTCMonth()]} 2026 · ${hh}:${mm} ARG`;
}

function render() {
  if (!state.currentUser) {
    renderAuth();
    return;
  }

  const user = state.users[state.currentUser];
  const predictionsLocked = state.appSettings.predictionsLocked;
  const projection = buildProjection(user.predictions);
  const leaderboard = buildLeaderboard();
  const canViewPredictions = canViewOtherPredictions(user);
  if (activeTab === "player" && (!viewedUsername || !canViewPredictions || !state.users[viewedUsername])) {
    activeTab = "ranking";
    viewedUsername = null;
  }
  const viewedUser = viewedUsername ? state.users[viewedUsername] : null;
  const viewedProjection = viewedUser ? buildProjection(viewedUser.predictions) : null;

  app.innerHTML = `
    <header class="topbar">
      <div>
        <p class="eyebrow">FIFA World Cup 26 Prode</p>
        <h1>Prode Mundial 2026</h1>
      </div>
      <div class="session">
        <span>${isAdminUser(user) ? "Administrador" : "Jugador"}: <strong>${user.username}</strong></span>
        <button class="ghost" id="logoutBtn">Salir</button>
      </div>
    </header>
    <main class="shell">
      <section class="hero">
        <div>
          <div class="brandMark" aria-label="Prode Mundial 2026"><span>2026</span><strong>Prode Mundial</strong></div>
          <p class="eyebrow">Del 11 de junio al 19 de julio</p>
          <h2>Completa fase de grupos, arma la llave y guarda tu camino al campeon.</h2>
          <p>Los cruces se recalculan con tus resultados, incluyendo los ocho mejores terceros. Horarios en Argentina.</p>
        </div>
        ${renderHeroMedia()}
      </section>

      <nav class="tabs" aria-label="Secciones">
        <button class="tab ${activeTab === "prode" ? "active" : ""}" data-tab="prode">Mi prode</button>
        <button class="tab ${activeTab === "bracket" ? "active" : ""}" data-tab="bracket">Llave</button>
        <button class="tab ${["ranking", "player"].includes(activeTab) ? "active" : ""}" data-tab="ranking">Ranking</button>
        <button class="tab ${activeTab === "info" ? "active" : ""}" data-tab="info">Info</button>
        ${isAdminUser(user) ? `<button class="tab ${activeTab === "admin" ? "active" : ""}" data-tab="admin">Admin</button>` : ""}
      </nav>

      <section id="view-prode" class="view ${activeTab === "prode" ? "active" : ""}">
        ${predictionsLocked ? renderLockedNotice() : renderAutosave(user)}
        ${renderReadonlyQualificationSummary(user.predictions)}
        ${renderGroupNavigation()}
        ${renderGroups(user.predictions, projection, predictionsLocked, true)}
        ${renderReadonlyThirdPlaces(user.predictions)}
        ${renderAwards(user, predictionsLocked)}
      </section>
      <section id="view-bracket" class="view ${activeTab === "bracket" ? "active" : ""}">
        ${predictionsLocked ? renderLockedNotice() : ""}
        ${renderBracket(user.predictions, projection, predictionsLocked)}
      </section>
      <section id="view-ranking" class="view ${activeTab === "ranking" ? "active" : ""}">
        ${renderLeaderboard(leaderboard, user)}
      </section>
      ${viewedUser ? `<section id="view-player" class="view ${activeTab === "player" ? "active" : ""}">${renderReadonlyProde(viewedUser, viewedProjection)}</section>` : ""}
      <section id="view-info" class="view ${activeTab === "info" ? "active" : ""}">${renderInfo()}</section>
      ${isAdminUser(user) ? `<section id="view-admin" class="view ${activeTab === "admin" ? "active" : ""}">${renderAdmin()}</section>` : ""}
    </main>
  `;

  bindEvents();
  restorePendingFocus();
}

function renderAuth() {
  app.innerHTML = `
    <main class="authPage">
      <section class="authPanel">
        <div class="authVisual">
          <div>
            <div class="brandMark" aria-label="Prode Mundial 2026"><span>2026</span><strong>Prode Mundial</strong></div>
            <p class="eyebrow">Prode privado</p>
            <h1>Mundial 2026</h1>
            <p>Entra con tu usuario o crea uno nuevo.</p>
          </div>
          ${renderHeroMedia()}
        </div>
        <div class="authGrid">
          <form id="loginForm" class="card">
            <h2>Iniciar sesion</h2>
            <input name="username" placeholder="Usuario" autocomplete="username" required />
            <input name="password" placeholder="Contrasena" type="password" autocomplete="current-password" required />
            <button type="submit">Entrar</button>
          </form>
          <form id="registerForm" class="card">
            <h2>Crear usuario</h2>
            <input name="username" placeholder="Usuario" autocomplete="username" required />
            <input name="password" placeholder="Contrasena" type="password" autocomplete="new-password" required />
            <button type="submit">Crear y entrar</button>
          </form>
        </div>
        <p id="authError" class="error"></p>
      </section>
    </main>
  `;

  byId("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (storageMode === "supabase") {
      const result = await supabase.auth.signInWithPassword({
        email: usernameEmail(data.username),
        password: data.password
      });
      if (result.error) {
        byId("authError").textContent = "Usuario o contrasena incorrectos.";
        return;
      }
      await loadSupabaseState(result.data.user);
      render();
      return;
    }
    const user = state.users[data.username];
    if (!user || user.password !== data.password) {
      byId("authError").textContent = "Usuario o contrasena incorrectos.";
      return;
    }
    state.currentUser = user.username;
    saveState();
    render();
  });

  byId("registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (storageMode === "supabase") {
      const result = await supabase.auth.signUp({
        email: usernameEmail(data.username),
        password: data.password,
        options: { data: { username: data.username } }
      });
      if (result.error) {
        byId("authError").textContent = result.error.message;
        return;
      }
      if (!result.data.session) {
        byId("authError").textContent = "Usuario creado. Si Supabase pide confirmar email, desactiva esa opcion para este prode.";
        return;
      }
      await loadSupabaseState(result.data.user);
      render();
      return;
    }
    if (state.users[data.username]) {
      byId("authError").textContent = "Ese usuario ya existe.";
      return;
    }
    state.users[data.username] = { username: data.username, password: data.password, role: "player", active: true, predictions: {}, awards: {}, savedAt: null };
    state.currentUser = data.username;
    saveState();
    render();
  });
}

function renderHeroMedia() {
  return `
    <div class="heroMedia">
      <article class="stadiumCard">
        <img src="${FEATURED_ASSETS.stadium.image}" alt="MetLife Stadium en New Jersey" />
      </article>
    </div>
  `;
}

function renderAutosave(user) {
  return `
    <div class="saveBar">
      <div>
        <strong>${user.savedAt ? `Guardado: ${new Date(user.savedAt).toLocaleString()}` : "Todavia no guardaste este prode"}</strong>
        <span>Los cambios quedan en pantalla y se consolidan con el boton guardar.</span>
      </div>
      <button id="saveBtn">Guardar prode</button>
    </div>
  `;
}

function renderLockedNotice() {
  return `
    <div class="lockedNotice" role="status">
      <strong>El prode esta cerrado</strong>
      <span>Los pronosticos quedaron en modo lectura y ya no se pueden modificar.</span>
    </div>
  `;
}

function renderGroupNavigation() {
  return `
    <div class="groupNavigation">
      <span>Navegacion de grupos</span>
      <button class="ghost compactButton" type="button" data-collapse-all-groups>Cerrar todos</button>
      <button class="ghost compactButton" type="button" data-expand-all-groups>Abrir todos</button>
    </div>
  `;
}

function renderGroups(predictions, projection, readOnly = false, showQualificationPoints = false) {
  return Object.entries(GROUPS).map(([group, teams]) => `
    <section class="groupBlock collapsibleGroup ${collapsedGroups.has(group) ? "collapsed" : ""}">
      <div class="groupHeader">
        <button class="groupToggle" type="button" data-toggle-group="${group}" aria-expanded="${!collapsedGroups.has(group)}">
          <span class="groupToggleArrow" aria-hidden="true">${collapsedGroups.has(group) ? "▸" : "▾"}</span>
          <span>Grupo ${group}</span>
        </button>
        <div class="teamStrip">${teams.map(code => `<span>${teamBadge(code)}</span>`).join("")}</div>
      </div>
      <div class="groupContent">
        <div class="matchGrid">
          ${MATCHES.filter(match => match.group === group).map(match => renderPredictionMatch(match, predictions, readOnly)).join("")}
        </div>
        ${showQualificationPoints ? renderGroupQualificationPoints(group, projection) : ""}
        ${renderTable(projection.tables[group])}
      </div>
    </section>
  `).join("");
}

function renderReadonlyQualificationSummary(predictions) {
  const summary = qualificationPointsSummary(predictions);
  const closedLabel = summary.closedGroups === 1 ? "1 grupo definido" : `${summary.closedGroups} grupos definidos`;
  const total = summary.points + summary.perfectOrderPoints;
  return `
    <section class="groupBlock qualificationSummary">
      <div class="groupHeader">
        <div>
          <h2>Puntos por grupos</h2>
          <p>${closedLabel}. Clasificados: ${SCORING.groupQualified} puntos por equipo. Orden exacto: ${SCORING.perfectGroupOrder} puntos por grupo.</p>
        </div>
        <strong class="summaryScore">${total} pts</strong>
      </div>
      <div class="qualificationBreakdown">
        <span>Clasificados: <strong>${summary.points} pts</strong></span>
        <span>Orden exacto: <strong>${summary.perfectOrderPoints} pts</strong></span>
      </div>
      <div class="qualificationLegend">
        <span><i class="legendDot hit"></i>Sumo puntos</span>
        <span><i class="legendDot miss"></i>No sumo</span>
        <span><i class="legendDot pending"></i>Grupo pendiente</span>
      </div>
    </section>
  `;
}

function renderGroupQualificationPoints(group, projection) {
  const realProjection = buildProjection(state.realResults);
  const closed = Boolean(realProjection.groupComplete[group]);
  const realQualified = new Set(closed ? realProjection.tables[group].slice(0, 2).map(row => row.code) : []);
  const predictedQualified = projection.groupComplete[group]
    ? projection.tables[group].slice(0, 2).map(row => row.code)
    : [];
  const earned = predictedQualified.filter(code => realQualified.has(code)).length * SCORING.groupQualified;
  const orderHit = closed && projection.groupComplete[group] && isExactGroupOrder(group, projection, realProjection);
  const orderStatus = !closed ? "pending" : orderHit ? "hit" : "miss";
  return `
    <div class="qualificationPanel ${closed ? "closed" : "pending"}">
      <div class="qualificationPanelHeader">
        <strong>Clasificados pronosticados</strong>
        <span>${closed ? `${earned} pts` : "Pendiente de resultado oficial"}</span>
      </div>
      <div class="qualificationChips">
        ${predictedQualified.length ? predictedQualified.map(code => renderQualificationChip(code, closed, realQualified.has(code))).join("") : `<span class="mutedTeam">Este grupo no esta completo en el prode.</span>`}
      </div>
      <div class="exactOrderPanel ${orderStatus}">
        <span>Orden exacto del grupo</span>
        <strong>${!closed ? "-" : orderHit ? `+${SCORING.perfectGroupOrder}` : "+0"}</strong>
      </div>
    </div>
  `;
}

function renderQualificationChip(code, closed, hit) {
  const status = !closed ? "pending" : hit ? "hit" : "miss";
  const points = !closed ? "-" : hit ? `+${SCORING.groupQualified}` : "+0";
  const label = !closed ? "pendiente" : hit ? "sumo" : "no sumo";
  return `
    <span class="qualificationChip ${status}" title="${label}">
      ${teamBadge(code)}
      <strong>${points}</strong>
    </span>
  `;
}

function renderReadonlyThirdPlaces(predictions) {
  const predictedProjection = buildProjection(predictions);
  const realProjection = buildProjection(state.realResults);
  const predictedComplete = Object.values(predictedProjection.groupComplete).every(Boolean);
  const realComplete = Object.values(realProjection.groupComplete).every(Boolean);
  const predictedQualified = new Set(predictedProjection.thirdGroups.map(row => row.code));
  const rows = predictedProjection.thirdRankings;
  return `
    <section class="groupBlock thirdPlacesBlock">
      <div class="groupHeader">
        <div>
          <h2>Tabla de terceros</h2>
          <p>Los terceros se definen recien cuando terminan todos los grupos. Pasan los mejores 8 de 12.</p>
        </div>
        <strong class="thirdStatus ${realComplete ? "closed" : "pending"}">${realComplete ? "Definido" : "En curso"}</strong>
      </div>
      ${predictedComplete ? `
        <table class="standings thirdPlacesTable">
          <thead><tr><th>Orden</th><th>Grupo</th><th>Equipo</th><th>Pts</th><th>DG</th><th>GF</th><th>Puntos</th></tr></thead>
          <tbody>
            ${rows.map((row, index) => renderThirdPlaceRow(row, index, predictedQualified, realProjection, realComplete)).join("")}
          </tbody>
        </table>
      ` : `
        <div class="pendingThirds">
          <strong>Faltan grupos en este prode.</strong>
          <span>Cuando esten cargados todos los partidos de fase de grupos se ordenan los 12 terceros.</span>
        </div>
      `}
    </section>
  `;
}

function renderThirdPlaceRow(row, index, predictedQualified, realProjection, realComplete) {
  const predictedPass = predictedQualified.has(row.code);
  const result = thirdPlaceQualificationResult(row.code, predictedPass, realProjection, realComplete);
  return `
    <tr class="${predictedPass ? "qualified" : ""}">
      <td>${index + 1}</td>
      <td>Grupo ${row.group}</td>
      <td>${teamBadge(row.code)}</td>
      <td>${row.pts}</td>
      <td>${row.gd}</td>
      <td>${row.gf}</td>
      <td>${result.points ? `<span class="thirdPill ${result.status}">${result.points}</span>` : ""}</td>
    </tr>
  `;
}

function thirdPlaceQualificationResult(code, predictedPass, realProjection, realComplete) {
  if (!predictedPass) return { status: "empty", points: "" };
  const group = Object.entries(GROUPS).find(([, teams]) => teams.includes(code))?.[0];
  const realGroupClosed = Boolean(group && realProjection.groupComplete[group]);
  if (!realGroupClosed) return { status: "pending", points: "-" };

  const realPosition = realProjection.tables[group].findIndex(row => row.code === code);
  if (realPosition < 2) return { status: "hit", points: `+${SCORING.groupQualified}` };
  if (realPosition > 2) return { status: "miss", points: "+0" };

  if (!realComplete) return { status: "pending", points: "-" };
  const realQualified = collectProgress(realProjection).groupQualified;
  return realQualified.has(code)
    ? { status: "hit", points: `+${SCORING.groupQualified}` }
    : { status: "miss", points: "+0" };
}

function renderPredictionMatch(match, predictions, readOnly = false) {
  const score = predictions[scoreKey(match.id)] || {};
  return `
    <article class="matchCard">
      <div class="matchMeta"><span>#${match.id} ${match.label}</span><span>${formatArt(match)}</span>${renderPointsBadge(match, predictions)}</div>
      <div class="venue">${match.venue}</div>
      <div class="scoreLine">
        <label>${teamBadge(match.home)}${renderScoreInput("match", match.id, "home", score.home, readOnly)}</label>
        <span class="vs">vs</span>
        <label>${renderScoreInput("match", match.id, "away", score.away, readOnly)}${teamBadge(match.away)}</label>
      </div>
    </article>
  `;
}

function renderScoreInput(kind, id, side, value, readOnly = false) {
  const attr = kind === "real" ? "data-real" : "data-match";
  const disabled = readOnly ? "disabled" : "";
  return `<input ${attr}="${id}" data-side="${side}" class="scoreInput" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" autocomplete="off" value="${value ?? ""}" ${disabled} />`;
}

function renderTable(rows = []) {
  return `
    <table class="standings">
      <thead><tr><th>Pos</th><th>Equipo</th><th>Pts</th><th>DG</th><th>GF</th></tr></thead>
      <tbody>
        ${rows.map((row, index) => `<tr class="${index < 2 ? "qualified" : index === 2 ? "third" : ""}"><td>${index + 1}</td><td>${teamBadge(row.code)}</td><td>${row.pts}</td><td>${row.gd}</td><td>${row.gf}</td></tr>`).join("")}
      </tbody>
    </table>
  `;
}

function renderAwards(user, readOnly = false) {
  if (readOnly) {
    const awards = user.awards || {};
    return `
      <section class="groupBlock">
        <div class="groupHeader"><h2>Premios</h2><p>Pronostico individual de ${user.username}.</p></div>
        <div class="awardGrid">
          ${renderReadonlyAward("Goleador", awards.topScorer)}
          ${renderReadonlyAward("Balon de Oro", awards.goldenBall)}
          ${renderReadonlyAward("Mejor arquero", awards.goldenGlove)}
        </div>
      </section>
    `;
  }
  return `
    <section class="groupBlock">
      <div class="groupHeader">
        <h2>Premios</h2>
        <p>Primero elegi el pais y despues el jugador.</p>
      </div>
      <div class="awardGrid">
        ${renderAwardSelect("topScorer", "Goleador", user.awards?.topScorer, user.awards?.topScorerTeam, false)}
        ${renderAwardSelect("goldenBall", "Balon de Oro", user.awards?.goldenBall, user.awards?.goldenBallTeam, false)}
        ${renderAwardSelect("goldenGlove", "Mejor arquero", user.awards?.goldenGlove, user.awards?.goldenGloveTeam, true)}
      </div>
    </section>
  `;
}

function renderReadonlyAward(label, value) {
  return `<div class="award readonlyAward"><span>${label}</span><strong>${escapeHtml(value || "Sin elegir")}</strong></div>`;
}

function normalizePlayerName(value) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
}

function comparablePlayerName(value) {
  const aliases = {
    "alisson becker": "alisson"
  };
  const normalized = normalizePlayerName(value);
  return aliases[normalized] || normalized;
}

function playerTeam(value) {
  if (!value) return "";
  const normalizedValue = normalizePlayerName(value);
  const squadTeam = Object.entries(SQUADS).find(([, players]) =>
    players.some(player => normalizePlayerName(player.name) === normalizedValue)
  )?.[0];
  return squadTeam || LEGACY_AWARD_TEAMS[value] || "";
}

function renderTeamOptions(selectedTeam) {
  return Object.keys(SQUADS)
    .sort((a, b) => (TEAMS[a]?.name || a).localeCompare(TEAMS[b]?.name || b, "es"))
    .map(code => {
      const selected = code === selectedTeam ? " selected" : "";
      return `<option value="${code}"${selected}>${TEAMS[code]?.flag || ""} ${escapeHtml(TEAMS[code]?.name || code)}</option>`;
    })
    .join("");
}

function renderSquadOptions(team, value, goalkeepersOnly) {
  if (!team) {
    return value
      ? `<option value="${escapeHtml(value)}" selected>Eleccion guardada: ${escapeHtml(value)}</option>`
      : "";
  }
  const availablePlayers = (SQUADS[team] || []).filter(player =>
    goalkeepersOnly ? player.position === "PO" : player.position !== "PO"
  );
  const hasSavedPlayer = availablePlayers.some(player =>
    normalizePlayerName(player.name) === normalizePlayerName(value || "")
  );
  const savedOption = value && !hasSavedPlayer
    ? `<option value="${escapeHtml(value)}" selected>Eleccion guardada: ${escapeHtml(value)}</option>`
    : "";
  return savedOption + availablePlayers.map(player => {
    const selected = normalizePlayerName(player.name) === normalizePlayerName(value || "") ? " selected" : "";
    return `<option value="${escapeHtml(player.name)}"${selected}>${escapeHtml(player.name)}</option>`;
  }).join("");
}

function renderAwardSelect(key, label, value, savedTeam, goalkeepersOnly) {
  const selectedTeam = SQUADS[savedTeam] ? savedTeam : playerTeam(value);
  const playerDisabled = selectedTeam ? "" : " disabled";
  return `
    <fieldset class="award">
      <legend>${label}</legend>
      <label>
        <span>Pais</span>
        <select data-award-team="${key}">
          <option value="">Elegir pais</option>
          ${renderTeamOptions(selectedTeam)}
        </select>
      </label>
      <label>
        <span>${goalkeepersOnly ? "Arquero" : "Jugador"}</span>
        <select data-award="${key}"${playerDisabled}>
          <option value="">Elegir ${goalkeepersOnly ? "arquero" : "jugador"}</option>
          ${renderSquadOptions(selectedTeam, value, goalkeepersOnly)}
        </select>
      </label>
    </fieldset>
  `;
}

function renderAdminAwardSelect(key, label, value, savedTeam, goalkeepersOnly) {
  const selectedTeam = SQUADS[savedTeam] ? savedTeam : playerTeam(value);
  const playerDisabled = selectedTeam ? "" : " disabled";
  return `
    <fieldset class="award">
      <legend>${label}</legend>
      <label>
        <span>Pais</span>
        <select data-real-award-team="${key}">
          <option value="">Elegir pais</option>
          ${renderTeamOptions(selectedTeam)}
        </select>
      </label>
      <label>
        <span>${goalkeepersOnly ? "Arquero ganador" : "Jugador ganador"}</span>
        <select data-real-award="${key}"${playerDisabled}>
          <option value="">Elegir ${goalkeepersOnly ? "arquero" : "jugador"}</option>
          ${renderSquadOptions(selectedTeam, value, goalkeepersOnly)}
        </select>
      </label>
    </fieldset>
  `;
}

function renderBracket(predictions, projection, readOnly = false) {
  const rounds = {
    r32: KNOCKOUT.filter(match => match.stage === "r32"),
    r16: KNOCKOUT.filter(match => match.stage === "r16"),
    qf: KNOCKOUT.filter(match => match.stage === "qf"),
    sf: KNOCKOUT.filter(match => match.stage === "sf"),
    final: KNOCKOUT.filter(match => ["final", "third"].includes(match.stage))
  };
  return `
    <section class="bracketBoard">
      ${renderRound("Dieciseisavos", rounds.r32, predictions, projection, "", readOnly)}
      ${renderRound("Octavos", rounds.r16, predictions, projection, "", readOnly)}
      ${renderRound("Cuartos", rounds.qf, predictions, projection, "", readOnly)}
      ${renderRound("Semifinales", rounds.sf, predictions, projection, "", readOnly)}
      ${renderRound("Final y tercer puesto", rounds.final, predictions, projection, "centerRound", readOnly)}
    </section>
  `;
}

function renderRound(title, matches, predictions, projection, extraClass = "", readOnly = false) {
  return `
    <div class="round ${extraClass}">
      <h2>${title}</h2>
      ${matches.map(match => renderKnockoutMatch(match, predictions, projection, readOnly)).join("")}
    </div>
  `;
}

function renderKnockoutMatch(match, predictions, projection, readOnly = false) {
  const home = resolveSlot(match.homeSlot, projection);
  const away = resolveSlot(match.awaySlot, projection);
  const scoreControls = home && away ? `
    ${renderWinnerPicker(match, predictions, home, away, readOnly)}
  ` : `
    <div class="pendingLine">
      <span>${teamBadge(home)}</span>
      <strong>vs</strong>
      <span>${teamBadge(away)}</span>
    </div>
  `;
  return `
    <article class="matchCard knockout">
      <div class="matchMeta"><span>#${match.id} ${match.label}</span><span>${formatArt(match, false)}</span>${renderPointsBadge(match, predictions)}</div>
      <div class="venue">${match.venue} · ${formatArt(match, true)}</div>
      ${scoreControls}
      <small>Origen: ${match.homeSlot} vs ${match.awaySlot}</small>
    </article>
  `;
}

function renderWinnerPicker(match, predictions, home, away, readOnly = false, real = false) {
  const winner = selectedWinner(match, predictions, home, away);
  const attr = real ? "data-real-winner" : "data-winner";
  const disabled = readOnly ? "disabled" : "";
  return `
    <div class="winnerPicker">
      <button type="button" class="winnerChoice ${winner === home ? "selected" : ""}" ${attr}="${match.id}" data-team="${home}" ${disabled}>
        <span class="choiceMark">${winner === home ? "X" : ""}</span>
        ${teamBadge(home)}
      </button>
      <span class="vs">vs</span>
      <button type="button" class="winnerChoice ${winner === away ? "selected" : ""}" ${attr}="${match.id}" data-team="${away}" ${disabled}>
        <span class="choiceMark">${winner === away ? "X" : ""}</span>
        ${teamBadge(away)}
      </button>
    </div>
  `;
}

function renderLeaderboard(rows, currentUser) {
  const canViewPredictions = canViewOtherPredictions(currentUser);
  const canManagePlayers = isAdminUser(currentUser);
  const showPodium = state.appSettings.viewPredictionsEnabled || canManagePlayers;
  const nextMatch = nextPendingMatch();
  const awardHeaders = rankingAwardsVisible ? "<th>Goleador</th><th>Balon de Oro</th><th>Mejor arquero</th>" : "";
  return `
    <section class="groupBlock">
      <div class="groupHeader">
        <div>
          <h2>Ranking</h2>
          <p>${state.appSettings.viewPredictionsEnabled ? "Ya se pueden ver los prodes guardados de otros participantes." : "Calculado contra resultados reales cargados por admin."}</p>
          <div class="rankingHint">
            <strong>Proximo partido:</strong>
            <span>muestra que equipo de ese cruce elegiste que pase a la proxima fase. Si aparece "-", no tenes a ninguno; si aparece "Ambos", tenes a los dos.</span>
          </div>
        </div>
        <button class="ghost compactButton" id="toggleRankingAwards">${rankingAwardsVisible ? "Ocultar premios de jugadores" : "Mostrar premios de jugadores"}</button>
      </div>
      <table class="standings big">
        <thead><tr><th>#</th><th>Usuario</th><th>Puntos</th><th class="nextMatchHeading">Proximo partido${nextMatch ? `<small>${nextMatchLabel(nextMatch)}</small>` : "<small>Todos finalizados</small>"}</th><th>Campeon</th><th>Subcampeon</th><th>Tercero</th>${awardHeaders}${canViewPredictions ? "<th>Prode</th>" : ""}${canManagePlayers ? "<th>Admin</th>" : ""}</tr></thead>
        <tbody>${rows.map((row, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>${row.username}</td>
            <td>${row.points}</td>
            <td>${renderNextMatchPrediction(row.predictions, nextMatch, showPodium)}</td>
            <td>${renderPodiumCell(row.podium.champion, showPodium)}</td>
            <td>${renderPodiumCell(row.podium.runnerUp, showPodium)}</td>
            <td>${renderPodiumCell(row.podium.thirdPlace, showPodium)}</td>
            ${rankingAwardsVisible ? `
              <td>${renderLeaderboardAward(row.awards, "topScorer", showPodium)}</td>
              <td>${renderLeaderboardAward(row.awards, "goldenBall", showPodium)}</td>
              <td>${renderLeaderboardAward(row.awards, "goldenGlove", showPodium)}</td>
            ` : ""}
            ${canViewPredictions ? `<td><button class="linkButton" data-view-predictions="${row.username}">Ver prode</button></td>` : ""}
            ${canManagePlayers ? `<td><button class="linkButton dangerButton" data-hide-user-ranking="${row.username}">Ocultar</button></td>` : ""}
          </tr>
        `).join("")}</tbody>
      </table>
    </section>
  `;
}

function renderPointsBadge(match, predictions) {
  const points = matchScorePoints(match, predictions);
  const label = points === null ? "-" : String(points);
  const tone = points === null ? "pending" : points > 0 ? "positive" : "zero";
  return `<span class="pointsBadge ${tone}" title="Puntos del partido">${label}</span>`;
}

function renderPodiumCell(code, visible) {
  if (!visible) return `<span class="mutedTeam">oculto</span>`;
  return code ? teamBadge(code) : `<span class="mutedTeam">Sin definir</span>`;
}

function renderLeaderboardAward(awards = {}, key, visible) {
  if (!visible) return `<span class="mutedTeam">oculto</span>`;
  const player = awards[key];
  const team = awards[`${key}Team`] || playerTeam(player);
  if (!player) return `<span class="mutedTeam">Sin elegir</span>`;
  return `
    <span class="rankingAward">
      <span class="flag">${flagMarkup(team)}</span>
      <span>${escapeHtml(player)}</span>
    </span>
  `;
}

function matchTimestamp(match) {
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6 };
  const [day, month, year] = match.date.split(" ");
  const [hour, minute] = match.time.split(":");
  // El fixture se muestra una hora adelantado y en Argentina (UTC-3).
  return Date.UTC(Number(year), months[month], Number(day), Number(hour) + 4, Number(minute));
}

function nextPendingMatch() {
  const now = Date.now();
  const matchVisibilityMs = (2 * 60 + 15) * 60 * 1000;
  return [...MATCHES, ...KNOCKOUT]
    .sort((a, b) => matchTimestamp(a) - matchTimestamp(b))
    .find(match => {
      const real = state.realResults[scoreKey(match.id)];
      const hasOfficialResult = match.stage === "groups" ? isCompleteScore(real) : Boolean(real?.winner);
      return now < matchTimestamp(match) + matchVisibilityMs && !hasOfficialResult;
    }) || null;
}

function nextMatchLabel(match) {
  if (match.stage === "groups") {
    return `${teamName(match.home)} vs ${teamName(match.away)}`;
  }
  const projection = buildProjection(state.realResults);
  const home = resolveSlot(match.homeSlot, projection);
  const away = resolveSlot(match.awaySlot, projection);
  return `${teamName(home)} vs ${teamName(away)}`;
}

function renderNextMatchPrediction(predictions, match, visible) {
  if (!match) return `<span class="mutedTeam">Finalizado</span>`;
  if (!visible) return `<span class="mutedTeam">oculto</span>`;
  if (match.stage === "groups") {
    const score = predictions[scoreKey(match.id)];
    return isCompleteScore(score)
      ? `<strong class="nextPrediction">${score.home} - ${score.away}</strong>`
      : `<span class="mutedTeam">Sin pronostico</span>`;
  }
  return renderKnockoutStakePrediction(predictions, match);
}

function renderKnockoutStakePrediction(predictions, match) {
  const realProjection = buildProjection(state.realResults);
  const home = resolveSlot(match.homeSlot, realProjection);
  const away = resolveSlot(match.awaySlot, realProjection);
  const stage = stageTarget(match.stage);
  if (!home || !away || !stage) return `<span class="mutedTeam">Por definir</span>`;

  const userProgress = collectProgress(buildProjection(predictions));
  const advancing = [home, away].filter(code => userProgress[stage]?.has(code));
  if (advancing.length === 2) return `<strong class="nextPrediction">Ambos</strong>`;
  if (advancing.length === 1) return teamBadge(advancing[0]);
  return `<span class="mutedTeam">-</span>`;
}

function canViewOtherPredictions(currentUser) {
  return Boolean(state.appSettings.viewPredictionsEnabled || isAdminUser(currentUser));
}

function isAdminUser(user) {
  return Boolean(user && (user.role === "admin" || user.username === ADMIN.username));
}

function isActivePlayer(user) {
  return !isAdminUser(user) && user.active !== false;
}

function renderReadonlyProde(user, projection) {
  return `
    <section class="saveBar readonlyNotice">
      <div>
        <strong>Prode de ${user.username}</strong>
        <span>Vista solo lectura. ${user.savedAt ? `Guardado: ${new Date(user.savedAt).toLocaleString()}` : "Todavia no guardo su prode."}</span>
      </div>
      <button class="ghost" id="backToRankingBtn">Volver al ranking</button>
    </section>
    ${renderReadonlyQualificationSummary(user.predictions)}
    ${renderGroupNavigation()}
    ${renderReadonlyGroups(user.predictions, projection)}
    ${renderReadonlyThirdPlaces(user.predictions)}
    ${renderBracket(user.predictions, projection, true)}
    ${renderAwards(user, true)}
  `;
}

function renderReadonlyGroups(predictions, projection) {
  return renderGroups(predictions, projection, true, true);
}

function renderInfo() {
  const rows = [
    ["Resultado exacto", SCORING.exactScore, "Acertar goles de ambos equipos en fase de grupos."],
    ["Ganador o empate", SCORING.outcome, "Acertar quien gana, o que empatan, en fase de grupos."],
    ["Orden exacto del grupo", SCORING.perfectGroupOrder, "Bonus por acertar 1, 2, 3 y 4 de un grupo."],
    ["Clasificado a dieciseisavos", SCORING.groupQualified, "Por cada seleccionado que pase de fase de grupos."],
    ["Equipo en octavos", SCORING.round16, "Por cada seleccionado que llegue a octavos."],
    ["Equipo en cuartos", SCORING.quarterFinal, "Por cada seleccionado que llegue a cuartos."],
    ["Equipo en semifinales", SCORING.semiFinal, "Por cada seleccionado que llegue a semifinales."],
    ["Finalista", SCORING.finalist, "Por cada seleccionado que llegue a la final."],
    ["Campeon", SCORING.champion, "Por acertar el campeon."],
    ["Tercero", SCORING.thirdPlace, "Por acertar el ganador del partido por tercer puesto."],
    ["Goleador", SCORING.topScorer, "Premio individual."],
    ["Balon de Oro", SCORING.goldenBall, "Premio individual."],
    ["Mejor arquero", SCORING.goldenGlove, "Premio individual."]
  ];
  return `
    <section class="rules">
      <div class="groupHeader"><h2>Info y puntos</h2><p>Horario argentino y reglas sugeridas para esta primera version.</p></div>
      <article class="prizeInfo">
        <strong>Premio del ganador: $160.000</strong>
        <p>Somos 16 participantes y cada uno puso $10.000. El pozo completo queda para quien termine primero en el ranking final.</p>
      </article>
      <div class="rulesGrid">
        ${rows.map(([title, points, detail]) => `
          <article class="ruleCard">
            <strong>${points}</strong>
            <div><h3>${title}</h3><p>${detail}</p></div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderAdmin() {
  const realProjection = buildProjection(state.realResults);
  const realAwards = state.realResults.awards || {};
  return `
    <section class="groupBlock lockSettings ${state.appSettings.predictionsLocked ? "locked" : ""}">
      <div class="groupHeader">
        <h2>Cierre del prode</h2>
        <p>Bloquea todos los pronosticos cuando empiece el Mundial. Los usuarios podran seguir viendolos.</p>
      </div>
      <label class="switchRow">
        <input id="predictionsLockToggle" type="checkbox" ${state.appSettings.predictionsLocked ? "checked" : ""} />
        <span>
          <strong>${state.appSettings.predictionsLocked ? "Prode cerrado" : "Prode abierto"}</strong>
          <small>${state.appSettings.predictionsLocked ? "Nadie puede editar marcadores, clasificados ni premios." : "Los participantes todavia pueden modificar y guardar sus pronosticos."}</small>
        </span>
      </label>
    </section>
    <section class="groupBlock">
      <div class="groupHeader">
        <h2>Visibilidad de prodes</h2>
        <p>Activa los enlaces del ranking para que todos puedan ver pronosticos ajenos en modo lectura.</p>
      </div>
      <label class="switchRow">
        <input id="viewPredictionsToggle" type="checkbox" ${state.appSettings.viewPredictionsEnabled ? "checked" : ""} />
        <span>
          <strong>${state.appSettings.viewPredictionsEnabled ? "Prodes ajenos visibles" : "Prodes ajenos ocultos"}</strong>
          <small>${state.appSettings.viewPredictionsEnabled ? "Los participantes ven el boton Ver prode en el ranking." : "Solo admin puede revisar prodes ajenos."}</small>
        </span>
      </label>
    </section>
    <section class="groupBlock">
      <div class="groupHeader">
        <h2>Premios oficiales</h2>
        <p>Selecciona los ganadores para comparar con cada participante y sumar los puntos definidos.</p>
      </div>
      <div class="awardGrid">
        ${renderAdminAwardSelect("topScorer", `Goleador · ${SCORING.topScorer} puntos`, realAwards.topScorer, realAwards.topScorerTeam, false)}
        ${renderAdminAwardSelect("goldenBall", `Balon de Oro · ${SCORING.goldenBall} puntos`, realAwards.goldenBall, realAwards.goldenBallTeam, false)}
        ${renderAdminAwardSelect("goldenGlove", `Mejor arquero · ${SCORING.goldenGlove} puntos`, realAwards.goldenGlove, realAwards.goldenGloveTeam, true)}
      </div>
    </section>
    <section class="groupBlock">
      <div class="groupHeader"><h2>Resultados reales</h2><p>Carga marcadores oficiales para calcular el ranking.</p></div>
      <div class="matchGrid">
        ${MATCHES.map(match => {
          const real = state.realResults[scoreKey(match.id)] || {};
          return `
            <article class="matchCard">
              <div class="matchMeta"><span>#${match.id} ${match.label}</span><span>${formatArt(match, false)}</span></div>
              <div class="scoreLine adminScore">
                ${renderScoreInput("real", match.id, "home", real.home)}
                <span>${match.home || match.homeSlot} vs ${match.away || match.awaySlot}</span>
                ${renderScoreInput("real", match.id, "away", real.away)}
              </div>
            </article>
          `;
        }).join("")}
      </div>
    </section>
    <section class="groupBlock">
      <div class="groupHeader"><h2>Clasificados reales</h2><p>Desde dieciseisavos, marca solo quien avanza.</p></div>
      <div class="matchGrid">
        ${KNOCKOUT.map(match => renderAdminKnockoutResult(match, realProjection)).join("")}
      </div>
    </section>
    <section class="groupBlock">
      <div class="groupHeader"><h2>Prodes guardados</h2><p>${Object.keys(state.users).length} usuarios registrados.</p></div>
      <div class="adminUserList">${Object.values(state.users).map(user => renderAdminUserRow(user)).join("")}</div>
    </section>
  `;
}

function renderAdminKnockoutResult(match, projection) {
  const home = resolveSlot(match.homeSlot, projection);
  const away = resolveSlot(match.awaySlot, projection);
  return `
    <article class="matchCard knockout">
      <div class="matchMeta"><span>#${match.id} ${match.label}</span><span>${formatArt(match, false)}</span></div>
      <div class="venue">${match.venue} · ${formatArt(match, true)}</div>
      ${home && away ? renderWinnerPicker(match, state.realResults, home, away, false, true) : `
        <div class="pendingLine">
          <span>${teamBadge(home)}</span>
          <strong>vs</strong>
          <span>${teamBadge(away)}</span>
        </div>
      `}
      <small>Origen: ${match.homeSlot} vs ${match.awaySlot}</small>
    </article>
  `;
}

function renderAdminUserRow(user) {
  const savedAt = user.savedAt ? new Date(user.savedAt).toLocaleString() : "sin guardar";
  const activeText = user.active !== false ? "Activo en ranking" : "Oculto del ranking";
  const toggle = isAdminUser(user) ? "" : `
    <label class="miniSwitch">
      <input type="checkbox" data-user-active="${user.username}" ${user.active !== false ? "checked" : ""} />
      <span>${activeText}</span>
    </label>
  `;
  return `
    <article class="adminUserRow ${user.active === false ? "inactive" : ""}">
      <div>
        <strong>${user.username}</strong>
        <small>${user.role} · ${savedAt}</small>
      </div>
      ${toggle}
    </article>
  `;
}

function bindEvents() {
  byId("logoutBtn")?.addEventListener("click", async () => {
    if (storageMode === "supabase") {
      await supabase.auth.signOut();
      currentProfile = null;
    }
    state.currentUser = null;
    saveState();
    render();
  });

  byId("saveBtn")?.addEventListener("click", () => {
    if (state.appSettings.predictionsLocked) return;
    state.users[state.currentUser].savedAt = new Date().toISOString();
    saveState();
    render();
  });

  document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => {
      activeTab = button.dataset.tab;
      document.querySelectorAll(".tab, .view").forEach(el => el.classList.remove("active"));
      button.classList.add("active");
      byId(`view-${button.dataset.tab}`).classList.add("active");
    });
  });

  document.querySelectorAll("[data-view-predictions]").forEach(button => {
    button.addEventListener("click", () => {
      viewedUsername = button.dataset.viewPredictions;
      activeTab = "player";
      render();
    });
  });

  byId("backToRankingBtn")?.addEventListener("click", () => {
    viewedUsername = null;
    activeTab = "ranking";
    render();
  });

  byId("toggleRankingAwards")?.addEventListener("click", () => {
    rankingAwardsVisible = !rankingAwardsVisible;
    render();
  });

  document.querySelectorAll("[data-collapse-all-groups]").forEach(button => {
    button.addEventListener("click", () => {
      Object.keys(GROUPS).forEach(group => collapsedGroups.add(group));
      render();
    });
  });

  document.querySelectorAll("[data-expand-all-groups]").forEach(button => {
    button.addEventListener("click", () => {
      collapsedGroups.clear();
      render();
    });
  });

  document.querySelectorAll("[data-toggle-group]").forEach(button => {
    button.addEventListener("click", () => {
      const group = button.dataset.toggleGroup;
      if (collapsedGroups.has(group)) collapsedGroups.delete(group);
      else collapsedGroups.add(group);
      render();
    });
  });

  document.querySelectorAll("[data-match]").forEach(input => {
    input.addEventListener("input", updatePredictionScore);
    input.addEventListener("keydown", captureTabTarget);
    input.addEventListener("change", () => render());
  });

  document.querySelectorAll("[data-real]").forEach(input => {
    input.addEventListener("input", updateRealScore);
  });

  document.querySelectorAll("[data-winner]").forEach(button => {
    button.addEventListener("click", updatePredictionWinner);
  });

  document.querySelectorAll("[data-real-winner]").forEach(button => {
    button.addEventListener("click", updateRealWinner);
  });

  document.querySelectorAll("[data-award]").forEach(select => {
    select.addEventListener("change", (event) => {
      if (state.appSettings.predictionsLocked) return;
      state.users[state.currentUser].awards[event.target.dataset.award] = event.target.value;
      saveState();
    });
  });

  document.querySelectorAll("[data-award-team]").forEach(select => {
    select.addEventListener("change", (event) => {
      if (state.appSettings.predictionsLocked) return;
      const awardKey = event.target.dataset.awardTeam;
      state.users[state.currentUser].awards[awardKey] = "";
      state.users[state.currentUser].awards[`${awardKey}Team`] = event.target.value;
      saveState();
      render();
    });
  });

  document.querySelectorAll("[data-real-award]").forEach(select => {
    select.addEventListener("change", (event) => {
      state.realResults.awards ||= {};
      state.realResults.awards[event.target.dataset.realAward] = event.target.value;
      saveState();
      render();
    });
  });

  document.querySelectorAll("[data-real-award-team]").forEach(select => {
    select.addEventListener("change", (event) => {
      const awardKey = event.target.dataset.realAwardTeam;
      state.realResults.awards ||= {};
      state.realResults.awards[awardKey] = "";
      state.realResults.awards[`${awardKey}Team`] = event.target.value;
      saveState();
      render();
    });
  });

  byId("viewPredictionsToggle")?.addEventListener("change", (event) => {
    state.appSettings.viewPredictionsEnabled = event.target.checked;
    saveState();
    render();
  });

  byId("predictionsLockToggle")?.addEventListener("change", (event) => {
    state.appSettings.predictionsLocked = event.target.checked;
    saveState();
    render();
  });

  document.querySelectorAll("[data-user-active]").forEach(input => {
    input.addEventListener("change", updateUserActive);
  });

  document.querySelectorAll("[data-hide-user-ranking]").forEach(button => {
    button.addEventListener("click", hideUserFromRanking);
  });
}

async function hideUserFromRanking(event) {
  const username = event.target.dataset.hideUserRanking;
  const target = state.users[username];
  if (!target || isAdminUser(target)) return;
  target.active = false;
  if (viewedUsername === username) {
    viewedUsername = null;
    activeTab = "ranking";
  }
  saveState();
  if (storageMode === "supabase" && supabase && isAdminUser(state.users[state.currentUser])) {
    await supabase.from("profiles").update({ active: false }).eq("username", username);
  }
  render();
}

async function updateUserActive(event) {
  const username = event.target.dataset.userActive;
  const target = state.users[username];
  if (!target || isAdminUser(target)) return;
  target.active = event.target.checked;
  if (viewedUsername === username && target.active === false && !isAdminUser(state.users[state.currentUser])) {
    viewedUsername = null;
    activeTab = "ranking";
  }
  saveState();
  if (storageMode === "supabase" && supabase && isAdminUser(state.users[state.currentUser])) {
    await supabase.from("profiles").update({ active: target.active }).eq("username", username);
  }
  render();
}

function captureTabTarget(event) {
  if (event.key !== "Tab") return;
  const inputs = [...document.querySelectorAll("[data-match]:not([disabled])")];
  const currentIndex = inputs.indexOf(event.currentTarget);
  const nextIndex = currentIndex + (event.shiftKey ? -1 : 1);
  const next = inputs[nextIndex];
  if (!next) return;
  event.preventDefault();
  pendingFocus = { match: next.dataset.match, side: next.dataset.side };
  render();
}

function restorePendingFocus() {
  if (!pendingFocus) return;
  const selector = `[data-match="${pendingFocus.match}"][data-side="${pendingFocus.side}"]`;
  pendingFocus = null;
  window.setTimeout(() => document.querySelector(selector)?.focus(), 0);
}

function updatePredictionScore(event) {
  if (state.appSettings.predictionsLocked) return;
  const user = state.users[state.currentUser];
  const id = event.target.dataset.match;
  const key = scoreKey(id);
  user.predictions[key] ||= {};
  const value = sanitizeScoreInput(event.target);
  if (value === null) delete user.predictions[key][event.target.dataset.side];
  else user.predictions[key][event.target.dataset.side] = value;
  saveState();
}

function updatePredictionWinner(event) {
  if (state.appSettings.predictionsLocked) return;
  const user = state.users[state.currentUser];
  const id = event.currentTarget.dataset.winner;
  const key = scoreKey(id);
  user.predictions[key] ||= {};
  user.predictions[key].winner = event.currentTarget.dataset.team;
  delete user.predictions[key].home;
  delete user.predictions[key].away;
  saveState();
  render();
}

function updateRealScore(event) {
  const id = event.target.dataset.real;
  const key = scoreKey(id);
  state.realResults[key] ||= {};
  const value = sanitizeScoreInput(event.target);
  if (value === null) delete state.realResults[key][event.target.dataset.side];
  else state.realResults[key][event.target.dataset.side] = value;
  saveState();
}

function updateRealWinner(event) {
  const id = event.currentTarget.dataset.realWinner;
  const key = scoreKey(id);
  state.realResults[key] ||= {};
  state.realResults[key].winner = event.currentTarget.dataset.team;
  delete state.realResults[key].home;
  delete state.realResults[key].away;
  saveState();
  render();
}

function sanitizeScoreInput(input) {
  const digits = input.value.replace(/\D/g, "").slice(0, 2);
  if (!digits) {
    input.value = "";
    return null;
  }
  const value = Math.min(15, Number(digits));
  input.value = String(value);
  return value;
}

function buildProjection(predictions) {
  const tables = {};
  const groupComplete = {};
  for (const [group, teams] of Object.entries(GROUPS)) {
    const rows = Object.fromEntries(teams.map(code => [code, { code, pts: 0, gf: 0, ga: 0, gd: 0 }]));
    const groupMatches = MATCHES.filter(match => match.group === group);
    groupComplete[group] = groupMatches.every(match => isCompleteScore(predictions[scoreKey(match.id)]));
    groupMatches.forEach(match => {
      const score = predictions[scoreKey(match.id)];
      if (!isCompleteScore(score)) return;
      rows[match.home].gf += score.home;
      rows[match.home].ga += score.away;
      rows[match.away].gf += score.away;
      rows[match.away].ga += score.home;
      if (score.home > score.away) rows[match.home].pts += 3;
      else if (score.home < score.away) rows[match.away].pts += 3;
      else {
        rows[match.home].pts += 1;
        rows[match.away].pts += 1;
      }
    });
    tables[group] = Object.values(rows).map(row => ({ ...row, gd: row.gf - row.ga }))
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || teams.indexOf(a.code) - teams.indexOf(b.code));
  }

  const allGroupsComplete = Object.values(groupComplete).every(Boolean);
  const thirdRankings = allGroupsComplete ? Object.entries(tables).map(([group, rows]) => ({ group, ...rows[2] }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.group.localeCompare(b.group)) : [];
  const thirdGroups = thirdRankings.slice(0, 8);
  const thirdMap = allGroupsComplete ? assignThirdPlaces(thirdGroups.map(row => row.group), tables) : {};
  const winners = {};
  const losers = {};
  KNOCKOUT.forEach(match => {
    const home = resolveSlot(match.homeSlot, { tables, groupComplete, thirdMap, winners, losers });
    const away = resolveSlot(match.awaySlot, { tables, groupComplete, thirdMap, winners, losers });
    const winner = selectedWinner(match, predictions, home, away);
    if (!home || !away || !winner) return;
    winners[match.id] = winner;
    losers[match.id] = winner === home ? away : home;
  });
  return { tables, groupComplete, thirdRankings, thirdGroups, thirdMap, winners, losers };
}

function selectedWinner(match, predictions, home, away) {
  const prediction = predictions[scoreKey(match.id)] || {};
  if ([home, away].includes(prediction.winner)) return prediction.winner;
  if (isCompleteScore(prediction) && prediction.home !== prediction.away) {
    return prediction.home > prediction.away ? home : away;
  }
  return null;
}

function assignThirdPlaces(qualifiedGroups, tables) {
  const slots = KNOCKOUT.filter(match => /^3/.test(match.awaySlot));
  const assignment = findThirdPlaceAssignment(slots, qualifiedGroups);
  return Object.fromEntries(Object.entries(assignment).map(([slot, group]) => [slot, tables[group][2].code]));
}

function findThirdPlaceAssignment(slots, groups) {
  const orderedSlots = [...slots].sort((a, b) => {
    const aCount = a.awaySlot.slice(1).split("").filter(group => groups.includes(group)).length;
    const bCount = b.awaySlot.slice(1).split("").filter(group => groups.includes(group)).length;
    return aCount - bCount;
  });
  const used = new Set();
  const result = {};

  function backtrack(index) {
    if (index === orderedSlots.length) return true;
    const slot = orderedSlots[index].awaySlot;
    const allowed = slot.slice(1).split("").filter(group => groups.includes(group) && !used.has(group));
    for (const group of allowed) {
      used.add(group);
      result[slot] = group;
      if (backtrack(index + 1)) return true;
      used.delete(group);
      delete result[slot];
    }
    return false;
  }

  backtrack(0);
  return result;
}

function resolveSlot(slot, projection) {
  if (!slot) return null;
  if (/^[12][A-L]$/.test(slot)) {
    if (!projection.groupComplete?.[slot[1]]) return null;
    const pos = Number(slot[0]) - 1;
    return projection.tables[slot[1]]?.[pos]?.code;
  }
  if (/^3/.test(slot)) return projection.thirdMap?.[slot] || null;
  if (/^W/.test(slot)) return projection.winners?.[slot.slice(1)] || null;
  if (/^L/.test(slot)) return projection.losers?.[slot.slice(1)] || null;
  return null;
}

function stageLabel(stage) {
  return {
    r32: "Dieciseisavos",
    r16: "Octavos",
    qf: "Cuartos",
    sf: "Semis",
    third: "Tercer puesto",
    final: "Final"
  }[stage];
}

function outcome(score) {
  if (score.home === score.away) return "D";
  return score.home > score.away ? "H" : "A";
}

function buildLeaderboard() {
  return Object.values(state.users).filter(isActivePlayer).map(user => ({
    username: user.username,
    points: scoreUser(user),
    podium: predictedPodium(user),
    awards: user.awards || {},
    predictions: user.predictions || {}
  })).sort((a, b) => b.points - a.points || a.username.localeCompare(b.username));
}

function scoreUser(user) {
  let points = 0;
  MATCHES.forEach(match => {
    points += matchScorePoints(match, user.predictions) || 0;
  });
  const predictedProgress = collectProgress(buildProjection(user.predictions));
  const realProgress = collectProgress(buildProjection(state.realResults));
  points += perfectGroupMatches(predictedProgress.groupOrder, realProgress.groupOrder) * SCORING.perfectGroupOrder;
  points += intersectionSize(predictedProgress.groupQualified, realProgress.groupQualified) * SCORING.groupQualified;
  points += intersectionSize(predictedProgress.round16, realProgress.round16) * SCORING.round16;
  points += intersectionSize(predictedProgress.quarterFinal, realProgress.quarterFinal) * SCORING.quarterFinal;
  points += intersectionSize(predictedProgress.semiFinal, realProgress.semiFinal) * SCORING.semiFinal;
  points += intersectionSize(predictedProgress.finalist, realProgress.finalist) * SCORING.finalist;
  points += intersectionSize(predictedProgress.champion, realProgress.champion) * SCORING.champion;
  points += intersectionSize(predictedProgress.thirdPlace, realProgress.thirdPlace) * SCORING.thirdPlace;
  points += awardPoints(user.awards, state.realResults.awards);
  return points;
}

function qualificationPointsSummary(predictions = {}) {
  const predictedProgress = collectProgress(buildProjection(predictions));
  const realProgress = collectProgress(buildProjection(state.realResults));
  return {
    points: intersectionSize(predictedProgress.groupQualified, realProgress.groupQualified) * SCORING.groupQualified,
    perfectOrderPoints: perfectGroupMatches(predictedProgress.groupOrder, realProgress.groupOrder) * SCORING.perfectGroupOrder,
    closedGroups: Object.keys(realProgress.groupOrder).length
  };
}

function isExactGroupOrder(group, predictedProjection, realProjection) {
  const predicted = predictedProjection.tables[group]?.map(row => row.code).join("|");
  const real = realProjection.tables[group]?.map(row => row.code).join("|");
  return Boolean(predicted && real && predicted === real);
}

function awardPoints(predictedAwards = {}, realAwards = {}) {
  return [
    ["topScorer", SCORING.topScorer],
    ["goldenBall", SCORING.goldenBall],
    ["goldenGlove", SCORING.goldenGlove]
  ].reduce((points, [key, value]) => {
    const predicted = predictedAwards[key];
    const real = realAwards[key];
    if (!predicted || !real) return points;
    return comparablePlayerName(predicted) === comparablePlayerName(real) ? points + value : points;
  }, 0);
}

function matchScorePoints(match, predictions) {
  if (match.stage !== "groups") return knockoutMatchPoints(match, predictions);
  const pred = predictions[scoreKey(match.id)];
  const real = state.realResults[scoreKey(match.id)];
  if (!isCompleteScore(real)) return null;
  if (!isCompleteScore(pred)) return 0;
  if (pred.home === real.home && pred.away === real.away) return SCORING.exactScore;
  if (outcome(pred) === outcome(real)) return SCORING.outcome;
  return 0;
}

function knockoutMatchPoints(match, predictions) {
  const projection = buildProjection(predictions);
  const home = resolveSlot(match.homeSlot, projection);
  const away = resolveSlot(match.awaySlot, projection);
  const winner = selectedWinner(match, predictions, home, away);
  const realProgress = collectProgress(buildProjection(state.realResults));
  const target = stageTarget(match.stage);
  if (!target || !isRealStageClosed(match.stage, realProgress)) return null;
  if (!winner) return 0;
  return realProgress[target].has(winner) ? stagePoints(match.stage) : 0;
}

function stageTarget(stage) {
  return {
    r32: "round16",
    r16: "quarterFinal",
    qf: "semiFinal",
    sf: "finalist",
    final: "champion",
    third: "thirdPlace"
  }[stage];
}

function stagePoints(stage) {
  return {
    r32: SCORING.round16,
    r16: SCORING.quarterFinal,
    qf: SCORING.semiFinal,
    sf: SCORING.finalist,
    final: SCORING.champion,
    third: SCORING.thirdPlace
  }[stage] || 0;
}

function isRealStageClosed(stage, realProgress) {
  const expected = {
    r32: 16,
    r16: 8,
    qf: 4,
    sf: 2,
    final: 1,
    third: 1
  }[stage];
  const target = stageTarget(stage);
  return Boolean(target && realProgress[target].size >= expected);
}

function predictedPodium(user) {
  const projection = buildProjection(user.predictions);
  return {
    champion: projection.winners[104] || null,
    runnerUp: projection.losers[104] || null,
    thirdPlace: projection.winners[103] || null
  };
}

function collectProgress(projection) {
  const groupQualified = new Set();
  const groupOrder = {};
  Object.entries(projection.groupComplete).forEach(([group, complete]) => {
    if (!complete) return;
    groupOrder[group] = projection.tables[group].map(row => row.code);
    projection.tables[group].slice(0, 2).forEach(row => groupQualified.add(row.code));
  });
  projection.thirdGroups.forEach(row => groupQualified.add(row.code));

  const winnersByStage = (stage) => new Set(KNOCKOUT
    .filter(match => match.stage === stage && projection.winners[match.id])
    .map(match => projection.winners[match.id]));

  return {
    groupOrder,
    groupQualified,
    round16: winnersByStage("r32"),
    quarterFinal: winnersByStage("r16"),
    semiFinal: winnersByStage("qf"),
    finalist: winnersByStage("sf"),
    champion: new Set(projection.winners[104] ? [projection.winners[104]] : []),
    thirdPlace: new Set(projection.winners[103] ? [projection.winners[103]] : [])
  };
}

function perfectGroupMatches(predicted, real) {
  return Object.keys(GROUPS).filter(group => {
    const left = predicted[group];
    const right = real[group];
    return left && right && left.join("|") === right.join("|");
  }).length;
}

function intersectionSize(left, right) {
  let total = 0;
  left.forEach(value => {
    if (right.has(value)) total += 1;
  });
  return total;
}

initApp().catch(error => {
  console.error("No se pudo iniciar el prode", error);
  app.innerHTML = `<main class="authPage"><p class="error">No se pudo iniciar el prode. Recarga la pagina.</p></main>`;
});
