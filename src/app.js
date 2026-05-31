import { ADMIN, FIELD_PLAYERS, GOALKEEPERS, GROUPS, KNOCKOUT, MATCHES, SCORING, TEAMS } from "./data.js";

const STORAGE_KEY = "prode-wc26-state-v1";
const app = document.querySelector("#app");

const emptyState = {
  currentUser: null,
  users: {
    [ADMIN.username]: { username: ADMIN.username, password: ADMIN.password, role: "admin", active: true, predictions: {}, awards: {}, savedAt: null }
  },
  realResults: {},
  appSettings: {
    viewPredictionsEnabled: false
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
  }
  render();
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
  await supabase.from("predictions").upsert({
    user_id: currentProfile.user_id,
    data: user.predictions || {},
    awards: user.awards || {},
    saved_at: user.savedAt || new Date().toISOString()
  });
  if (user.role === "admin") {
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
        <span>${user.role === "admin" ? "Administrador" : "Jugador"}: <strong>${user.username}</strong></span>
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
        ${user.role === "admin" ? `<button class="tab ${activeTab === "admin" ? "active" : ""}" data-tab="admin">Admin</button>` : ""}
      </nav>

      <section id="view-prode" class="view ${activeTab === "prode" ? "active" : ""}">
        ${renderAutosave(user)}
        ${renderGroups(user.predictions, projection)}
        ${renderAwards(user)}
      </section>
      <section id="view-bracket" class="view ${activeTab === "bracket" ? "active" : ""}">
        ${renderBracket(user.predictions, projection)}
      </section>
      <section id="view-ranking" class="view ${activeTab === "ranking" ? "active" : ""}">
        ${renderLeaderboard(leaderboard, user)}
      </section>
      ${viewedUser ? `<section id="view-player" class="view ${activeTab === "player" ? "active" : ""}">${renderReadonlyProde(viewedUser, viewedProjection)}</section>` : ""}
      <section id="view-info" class="view ${activeTab === "info" ? "active" : ""}">${renderInfo()}</section>
      ${user.role === "admin" ? `<section id="view-admin" class="view ${activeTab === "admin" ? "active" : ""}">${renderAdmin()}</section>` : ""}
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
            <p>Entra con tu usuario o crea uno nuevo. El admin inicial es <strong>${ADMIN.username}</strong> / <strong>${ADMIN.password}</strong>.</p>
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

function renderGroups(predictions, projection) {
  return Object.entries(GROUPS).map(([group, teams]) => `
    <section class="groupBlock">
      <div class="groupHeader">
        <h2>Grupo ${group}</h2>
        <div class="teamStrip">${teams.map(code => `<span>${teamBadge(code)}</span>`).join("")}</div>
      </div>
      <div class="matchGrid">
        ${MATCHES.filter(match => match.group === group).map(match => renderPredictionMatch(match, predictions)).join("")}
      </div>
      ${renderTable(projection.tables[group])}
    </section>
  `).join("");
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
  const fieldOptions = renderPlayerOptions(FIELD_PLAYERS);
  const goalkeeperOptions = renderPlayerOptions(GOALKEEPERS);
  return `
    <section class="groupBlock">
      <div class="groupHeader">
        <h2>Premios</h2>
        ${user.role === "admin" ? "<p>Lista editable luego desde base de datos.</p>" : ""}
      </div>
      <div class="awardGrid">
        ${renderAwardSelect("topScorer", "Goleador", user.awards?.topScorer, fieldOptions)}
        ${renderAwardSelect("goldenBall", "Balon de Oro", user.awards?.goldenBall, fieldOptions)}
        ${renderAwardSelect("goldenGlove", "Mejor arquero", user.awards?.goldenGlove, goalkeeperOptions)}
      </div>
    </section>
  `;
}

function renderReadonlyAward(label, value) {
  return `<div class="award readonlyAward"><span>${label}</span><strong>${value || "Sin elegir"}</strong></div>`;
}

function renderPlayerOptions(players) {
  return players.map(player => `<option value="${player.name}">${TEAMS[player.team]?.flag || ""} ${player.name} · ${TEAMS[player.team]?.name || player.team}</option>`).join("");
}

function renderAwardSelect(key, label, value, options) {
  return `<label class="award">${label}<select data-award="${key}"><option value="">Elegir jugador</option>${options}</select></label>`.replace(`value="${value}"`, `value="${value}" selected`);
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
  const score = predictions[scoreKey(match.id)] || {};
  const home = resolveSlot(match.homeSlot, projection);
  const away = resolveSlot(match.awaySlot, projection);
  const scoreControls = home && away ? `
    <div class="scoreLine">
      <label>${teamBadge(home)}${renderScoreInput("match", match.id, "home", score.home, readOnly)}</label>
      <span class="vs">vs</span>
      <label>${renderScoreInput("match", match.id, "away", score.away, readOnly)}${teamBadge(away)}</label>
    </div>
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

function renderLeaderboard(rows, currentUser) {
  const canViewPredictions = canViewOtherPredictions(currentUser);
  const showPodium = state.appSettings.viewPredictionsEnabled;
  return `
    <section class="groupBlock">
      <div class="groupHeader">
        <h2>Ranking</h2>
        <p>${state.appSettings.viewPredictionsEnabled ? "Ya se pueden ver los prodes guardados de otros participantes." : "Calculado contra resultados reales cargados por admin."}</p>
      </div>
      <table class="standings big">
        <thead><tr><th>#</th><th>Usuario</th><th>Puntos</th><th>Campeon</th><th>Subcampeon</th><th>Tercero</th><th>Guardado</th>${canViewPredictions ? "<th>Prode</th>" : ""}</tr></thead>
        <tbody>${rows.map((row, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>${row.username}</td>
            <td>${row.points}</td>
            <td>${renderPodiumCell(row.podium.champion, showPodium)}</td>
            <td>${renderPodiumCell(row.podium.runnerUp, showPodium)}</td>
            <td>${renderPodiumCell(row.podium.thirdPlace, showPodium)}</td>
            <td>${row.savedAt || "-"}</td>
            ${canViewPredictions ? `<td><button class="linkButton" data-view-predictions="${row.username}">Ver prode</button></td>` : ""}
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

function canViewOtherPredictions(currentUser) {
  return Boolean(state.appSettings.viewPredictionsEnabled || currentUser?.role === "admin");
}

function isActivePlayer(user) {
  return user.role !== "admin" && user.active !== false;
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
    ${renderReadonlyGroups(user.predictions, projection)}
    ${renderBracket(user.predictions, projection, true)}
    ${renderAwards(user, true)}
  `;
}

function renderReadonlyGroups(predictions, projection) {
  return Object.entries(GROUPS).map(([group, teams]) => `
    <section class="groupBlock">
      <div class="groupHeader">
        <h2>Grupo ${group}</h2>
        <div class="teamStrip">${teams.map(code => `<span>${teamBadge(code)}</span>`).join("")}</div>
      </div>
      <div class="matchGrid">
        ${MATCHES.filter(match => match.group === group).map(match => renderPredictionMatch(match, predictions, true)).join("")}
      </div>
      ${renderTable(projection.tables[group])}
    </section>
  `).join("");
}

function renderInfo() {
  const rows = [
    ["Resultado exacto", SCORING.exactScore, "Acertar goles de ambos equipos."],
    ["Ganador o empate", SCORING.outcome, "Acertar quien gana, o que empatan, sin resultado exacto."],
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
  return `
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
      <div class="groupHeader"><h2>Resultados reales</h2><p>Carga marcadores oficiales para calcular el ranking.</p></div>
      <div class="matchGrid">
        ${[...MATCHES, ...KNOCKOUT].map(match => {
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
      <div class="groupHeader"><h2>Prodes guardados</h2><p>${Object.keys(state.users).length} usuarios registrados.</p></div>
      <div class="adminUserList">${Object.values(state.users).map(user => renderAdminUserRow(user)).join("")}</div>
    </section>
  `;
}

function renderAdminUserRow(user) {
  const savedAt = user.savedAt ? new Date(user.savedAt).toLocaleString() : "sin guardar";
  const activeText = user.active !== false ? "Activo en ranking" : "Oculto del ranking";
  const toggle = user.role === "admin" ? "" : `
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

  document.querySelectorAll("[data-match]").forEach(input => {
    input.addEventListener("input", updatePredictionScore);
    input.addEventListener("keydown", captureTabTarget);
    input.addEventListener("change", () => render());
  });

  document.querySelectorAll("[data-real]").forEach(input => {
    input.addEventListener("input", updateRealScore);
  });

  document.querySelectorAll("[data-award]").forEach(select => {
    select.addEventListener("change", (event) => {
      state.users[state.currentUser].awards[event.target.dataset.award] = event.target.value;
      saveState();
    });
  });

  byId("viewPredictionsToggle")?.addEventListener("change", (event) => {
    state.appSettings.viewPredictionsEnabled = event.target.checked;
    saveState();
    render();
  });

  document.querySelectorAll("[data-user-active]").forEach(input => {
    input.addEventListener("change", updateUserActive);
  });
}

async function updateUserActive(event) {
  const username = event.target.dataset.userActive;
  const target = state.users[username];
  if (!target || target.role === "admin") return;
  target.active = event.target.checked;
  if (viewedUsername === username && target.active === false && state.users[state.currentUser]?.role !== "admin") {
    viewedUsername = null;
    activeTab = "ranking";
  }
  saveState();
  if (storageMode === "supabase" && supabase && state.users[state.currentUser]?.role === "admin") {
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
  const user = state.users[state.currentUser];
  const id = event.target.dataset.match;
  const key = scoreKey(id);
  user.predictions[key] ||= {};
  const value = sanitizeScoreInput(event.target);
  if (value === null) delete user.predictions[key][event.target.dataset.side];
  else user.predictions[key][event.target.dataset.side] = value;
  saveState();
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
  const thirdGroups = allGroupsComplete ? Object.entries(tables).map(([group, rows]) => ({ group, ...rows[2] }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.group.localeCompare(b.group))
    .slice(0, 8) : [];
  const thirdMap = allGroupsComplete ? assignThirdPlaces(thirdGroups.map(row => row.group), tables) : {};
  const winners = {};
  const losers = {};
  KNOCKOUT.forEach(match => {
    const home = resolveSlot(match.homeSlot, { tables, groupComplete, thirdMap, winners, losers });
    const away = resolveSlot(match.awaySlot, { tables, groupComplete, thirdMap, winners, losers });
    const score = predictions[scoreKey(match.id)];
    if (!home || !away || !isCompleteScore(score) || score.home === score.away) return;
    winners[match.id] = score.home > score.away ? home : away;
    losers[match.id] = score.home > score.away ? away : home;
  });
  return { tables, groupComplete, thirdGroups, thirdMap, winners, losers };
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
    savedAt: user.savedAt ? new Date(user.savedAt).toLocaleDateString() : null
  })).sort((a, b) => b.points - a.points || a.username.localeCompare(b.username));
}

function scoreUser(user) {
  let points = 0;
  [...MATCHES, ...KNOCKOUT].forEach(match => {
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
  return points;
}

function matchScorePoints(match, predictions) {
  const pred = predictions[scoreKey(match.id)];
  const real = state.realResults[scoreKey(match.id)];
  if (!isCompleteScore(real)) return null;
  if (!isCompleteScore(pred)) return 0;
  if (pred.home === real.home && pred.away === real.away) return SCORING.exactScore;
  if (outcome(pred) === outcome(real)) return SCORING.outcome;
  return 0;
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

initApp();
