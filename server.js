// Serveur multijoueur Ramy Gasy — salons privés à code, minuteur, achats hors tour, reconnexion
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const E = require("./engine");

const app = express();

// ---------- Durcissement HTTP ----------
app.set("trust proxy", 1); // Render est derrière un proxy : nécessaire pour connaître la vraie IP du visiteur
app.disable("x-powered-by"); // ne pas révéler Express/Node aux scanners

// Redirection HTTPS (active seulement derrière un proxy comme Render ; sans effet en local)
// + en-têtes de sécurité sur toutes les réponses
app.use((req, res, next) => {
  if (req.headers["x-forwarded-proto"] === "http")
    return res.redirect(301, "https://" + req.headers.host + req.url);
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); // force HTTPS pour 1 an
  res.setHeader("X-Content-Type-Options", "nosniff"); // pas de devinette de type MIME
  res.setHeader("X-Frame-Options", "DENY"); // anti-clickjacking : pas d'iframe
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

// Limite de débit HTTP : 300 requêtes / minute / IP (anti-flood, sans dépendance externe)
const httpHits = new Map();
setInterval(() => httpHits.clear(), 60 * 1000);
app.use((req, res, next) => {
  const ip = req.ip || "?";
  const n = (httpHits.get(ip) || 0) + 1;
  httpHits.set(ip, n);
  if (n > 300) return res.status(429).send("Trop de requêtes — réessaie dans une minute.");
  if (httpHits.size > 10000) httpHits.clear(); // borne mémoire dure
  next();
});

app.get("/ping", (req, res) => res.send("ok"));

// ---------- Statistiques temps réel ----------
const presence = new Map(); // id → { t: dernier signal, m: mode, p: pseudo }
// Clé pour voir les pseudos sur /stats.html — à définir dans les variables d'environnement Render.
// Pas de valeur par défaut : un secret en dur dans un dépôt GitHub public n'est pas un secret.
const STATS_KEY = process.env.STATS_KEY || null;
app.get("/presence", (req, res) => {
  const id = String(req.query.id || "").slice(0, 40);
  const now = Date.now();
  if (presence.size > 300) for (const [k, v] of presence) if (now - v.t > 70000) presence.delete(k); // purge même sans visite de /stats
  if (id && (presence.has(id) || presence.size < 3000)) // borne dure contre le gonflement malveillant
    presence.set(id, { t: now, m: String(req.query.m || "?").slice(0, 10), p: String(req.query.p || "").slice(0, 20) });
  res.send("ok");
});
app.get("/stats.json", (req, res) => {
  const now = Date.now();
  for (const [id, v] of presence) if (now - v.t > 70000) presence.delete(id);
  let salons = 0, parties = 0, joueursEnSalon = 0;
  for (const room of rooms.values()) {
    salons++;
    if (room.state === "playing" || room.state === "roundEnd") parties++;
    joueursEnSalon += room.players.filter((p) => p.connected && !p.isBot).length;
  }
  const soloActifs = [...presence.values()].filter((v) => v.m === "solo").length;
  const out = {
    connectes: io.engine.clientsCount,
    salons, parties, joueursEnSalon, soloActifs,
    total: io.engine.clientsCount + soloActifs,
    heure: new Date().toISOString(),
  };
  // Détail des pseudos : uniquement avec la bonne clé (la page est publique)
  if (STATS_KEY && String(req.query.cle || "") === STATS_KEY) {
    out.pseudosMulti = [];
    for (const room of rooms.values())
      for (const p of room.players)
        if (p.connected && !p.isBot) out.pseudosMulti.push(p.name);
    out.pseudosSolo = [...presence.values()]
      .filter((v) => v.m === "solo" && v.p)
      .map((v) => v.p);
  }
  res.json(out);
});

// ---------- Précompilation Babel au démarrage : chargement bien plus rapide côté client ----------
const PRECOMPILED = {};
try {
  const fsBoot = require("fs");
  const Babel = require("@babel/standalone");
  ["index.html", "solo.html"].forEach((f) => {
    const raw = fsBoot.readFileSync(path.join(__dirname, "public", f), "utf8");
    const m = raw.match(/<script type="text\/babel" data-presets="react">([\s\S]*?)<\/script>/);
    if (!m) return;
    const compiled = Babel.transform(m[1], { presets: ["react"] }).code;
    if (compiled.includes("</script>")) return; // sécurité : on garde la version originale
    PRECOMPILED[f] = raw
      .replace(m[0], "<script>\n" + compiled + "\n</script>")
      .replace(/<script src="\/lib\/babel\.min\.js"><\/script>\s*/, "");
    console.log("Précompilé : " + f);
  });
} catch (e) { console.error("Précompilation impossible (fallback client) :", e.message); }
const serveCompiled = (f) => (req, res, next) => {
  if (!PRECOMPILED[f]) return next();
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.setHeader("Content-Type", "text/html; charset=UTF-8");
  res.send(PRECOMPILED[f]);
};
app.get("/", serveCompiled("index.html"));
app.get("/index.html", serveCompiled("index.html"));
app.get("/solo.html", serveCompiled("solo.html"));

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache, must-revalidate");
    else res.setHeader("Cache-Control", "public, max-age=86400");
  },
})); // sert le client web
const server = http.createServer(app);

// CORS verrouillé : seules les pages servies par CE serveur (même domaine) peuvent se connecter.
// Pour autoriser un autre domaine (ex. domaine personnalisé), définir sur Render :
// ALLOWED_ORIGINS="https://mondomaine.com,https://www.mondomaine.com"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
// Origines des apps natives Capacitor (iOS : capacitor://localhost, Android : https://localhost)
["capacitor://localhost", "ionic://localhost", "https://localhost", "http://localhost"].forEach((o) => {
  if (!ALLOWED_ORIGINS.includes(o)) ALLOWED_ORIGINS.push(o);
});
const io = new Server(server, {
  maxHttpBufferSize: 16 * 1024, // les actions du jeu sont minuscules : rejette les payloads géants (défaut 1 Mo)
  cors: { origin: true, credentials: false },
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    if (!origin) return cb(null, true); // même origine stricte ou client hors navigateur
    try {
      const oHost = new URL(origin).host;
      if (oHost === req.headers.host || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    } catch (e) { /* origine illisible → refus */ }
    cb("origine non autorisée", false);
  },
});

const BUY_WINDOW_MS = 5000;       // fenêtre d'achat après chaque défausse
const AI_DELAY_MS = 1400;         // rythme des tours joués par l'IA
const ROOM_IDLE_LIMIT_MS = 2 * 60 * 60 * 1000; // salon fermé après 2h d'inactivité
const MAX_ROOMS = 300;            // borne dure anti-flood (300 salons = largement assez, protège la mémoire)
const rooms = new Map();          // code → room

const genCode = () => {
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 5; i++) c += letters[crypto.randomInt(letters.length)]; // aléa cryptographique : codes non prédictibles
  return rooms.has(c) ? genCode() : c;
};
const genToken = () => crypto.randomBytes(16).toString("hex");

// ---------- Cycle de vie d'un salon ----------
function createRoom(hostName, options) {
  const code = genCode();
  const room = {
    code,
    state: "lobby", // lobby | playing | roundEnd | over
    options: {
      turnSeconds: [45, 60, 90].includes(options?.turnSeconds) ? options.turnSeconds : 45,
      level: ["facile", "moyen", "difficile"].includes(options?.level) ? options.level : "moyen",
    },
    players: [], // {token, name, isBot, socketId, connected, absent, timeouts, hand, posed, buysLeft, lastTaken, total, justPosed}
    game: null,
    turnTimer: null,
    buyTimer: null,
    aiTimer: null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function freeAvatar(room, wanted) {
  const used = room.players.map((p) => p.avatar);
  if (wanted && AVATARS_POOL.includes(wanted) && !used.includes(wanted)) return wanted;
  return AVATARS_POOL.find((a) => !used.includes(a)) || "🙂";
}

function addPlayer(room, name, isBot, wantedAvatar) {
  const player = {
    token: genToken(), name: sanitizeName(name), isBot: !!isBot,
    avatar: freeAvatar(room, wantedAvatar),
    socketId: null, connected: !!isBot, absent: false, timeouts: 0,
    hand: [], posed: false, buysLeft: E.MAX_ACHATS, lastTaken: null, total: 0, justPosed: false,
  };
  room.players.push(player);
  return player;
}

function sanitizeName(n) {
  // Retire les chevrons (anti-HTML) et les caractères de contrôle invisibles, puis borne la longueur
  return String(n || "").replace(/[<>\u0000-\u001f\u007f]/g, "").trim().slice(0, 14) || "Joueur";
}

function touch(room) { room.lastActivity = Date.now(); }

setInterval(() => {
  for (const [code, room] of rooms) {
    if (Date.now() - room.lastActivity > ROOM_IDLE_LIMIT_MS) {
      clearTimers(room);
      io.to(code).emit("roomClosed");
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

function clearTimers(room) {
  clearTimeout(room.turnTimer); clearTimeout(room.buyTimer); clearTimeout(room.aiTimer); clearTimeout(room.rematchTimer);
  room.turnTimer = room.buyTimer = room.aiTimer = null;
}

// ---------- Démarrage d'une manche ----------
function startRound(room, mancheIdx) {
  const deck = E.buildDeck();
  room.players.forEach((p) => {
    p.hand = deck.splice(0, 13);
    p.posed = false; p.buysLeft = E.MAX_ACHATS; p.lastTaken = null; p.justPosed = false; p.timeouts = 0;
  });
  room.game = {
    mancheIdx,
    stock: deck,
    discard: [deck.pop()],
    melds: [],
    turn: mancheIdx % room.players.length,
    phase: "draw", // draw | play | buyWindow
    buyRequests: [],
    lastDiscarderIdx: null,
    history: room.game ? room.game.history : [],
    log: [`— Manche ${mancheIdx + 1} : ${E.MANCHES[mancheIdx].label} —`],
    turnDeadline: null,
    roundOver: null,
  };
  room.state = "playing";
  log(room, `La manche ${mancheIdx + 1} commence (contrat : ${E.MANCHES[mancheIdx].label})`);
  startTurn(room);
}

function log(room, text) {
  if (!room.game) return;
  room.game.log = [...room.game.log.slice(-60), text];
}

// ---------- État personnalisé envoyé à chaque joueur ----------
function publicPlayer(p, idx) {
  return {
    idx, name: p.name, isBot: p.isBot, connected: p.connected, absent: p.absent,
    handCount: p.hand.length, posed: p.posed, buysLeft: p.buysLeft,
    lastTaken: p.lastTaken, total: p.total, wins: p.wins || 0, avatar: p.avatar,
  };
}

function broadcast(room) {
  const g = room.game;
  room.players.forEach((p, idx) => {
    if (!p.socketId) return;
    io.to(p.socketId).emit("state", {
      code: room.code,
      serverNow: Date.now(), // pour que le client corrige le décalage d'horloge dans les comptes à rebours
      state: room.state,
      options: room.options,
      rematch: room.rematch ? { accepted: room.rematch.accepted, declined: room.rematch.declined } : null,
      youIdx: idx,
      yourHand: p.hand,
      players: room.players.map(publicPlayer),
      game: g ? {
        mancheIdx: g.mancheIdx,
        contract: E.MANCHES[g.mancheIdx],
        stockCount: g.stock.length,
        discardTop: g.discard[g.discard.length - 1] || null,
      discardCount: g.discard.length,
      buyNextIdx: g.phase === "buyWindow" ? g.nextIdx : null,
        buyDiscarderIdx: g.phase === "buyWindow" ? g.lastDiscarderIdx : null,
        discardLocked: Boolean(g.discardLocked),
        melds: g.melds,
        turn: g.turn,
        phase: g.phase,
        turnDeadline: g.turnDeadline,
        buyWindowUntil: g.phase === "buyWindow" ? g.buyWindowUntil : null,
        log: g.log.slice(-25),
        roundOver: g.roundOver,
        history: g.history,
      } : null,
    });
  });
}

// ---------- Gestion des tours et du minuteur ----------
function startTurn(room) {
  const g = room.game;
  g.phase = "draw";
  g.turnDeadline = Date.now() + room.options.turnSeconds * 1000;
  clearTimeout(room.turnTimer);
  const p = room.players[g.turn];
  if (p.isBot || p.absent || !p.connected) {
    clearTimeout(room.aiTimer);
    room.aiTimer = setTimeout(() => safeRun(() => aiPlayTurn(room)), AI_DELAY_MS);
  } else {
    clearTimeout(room.aiTimer); // un timer IA périmé ne doit jamais jouer le tour d'un humain
    room.turnTimer = setTimeout(() => safeRun(() => onTurnTimeout(room)), room.options.turnSeconds * 1000);
  }
  broadcast(room);
}

function onTurnTimeout(room) {
  const g = room.game;
  if (!g || g.roundOver || room.state !== "playing") return;
  const p = room.players[g.turn];
  p.timeouts++;
  log(room, `⏱ Temps écoulé pour ${p.name} — jeu automatique`);
  if (p.timeouts >= 3 && !p.absent) {
    p.absent = true;
    log(room, `${p.name} est passé en mode automatique (3 temps écoulés). Il peut reprendre la main à tout moment.`);
  }
  // Jeu automatique minimal : piocher puis jeter
  if (g.phase === "draw") drawFromStock(room, g.turn);
  if (!g.roundOver) {
    const toss = E.aiDiscardChoice(room.players[g.turn].hand, "moyen");
    doDiscard(room, g.turn, toss.id, true);
  }
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawFromStock(room, idx) {
  const g = room.game;
  if (g.stock.length === 0) {
    const top = g.discard.pop();
    g.stock = shuffleInPlace(g.discard);
    g.discard = top ? [top] : [];
  }
  const card = g.stock.pop();
  if (card) room.players[idx].hand.push(card); // pioche ET défausse épuisées : on joue sans piocher plutôt que planter
  g.phase = "play";
  io.to(room.code).emit("fx", { kind: "draw", source: "stock", idx });
  return card || null;
}

// ---------- Actions des joueurs ----------
function handleDraw(room, idx, source) {
  const g = room.game;
  if (room.state !== "playing" || g.roundOver) return "La partie n'est pas en cours.";
  if (g.turn !== idx) return "Ce n'est pas ton tour.";
  if (g.phase === "buyWindow") return "Fenêtre d'achat en cours, un instant…";
  if (g.phase !== "draw") return "Tu as déjà pioché.";
  const p = room.players[idx];
  p.timeouts = 0;
  if (source === "discard") {
    if (g.discard.length === 0) return "La défausse est vide.";
    if (g.discardLocked) return "Une carte vient d'être achetée — pioche dans le tas.";
    const topD = g.discard[g.discard.length - 1];
    if (topD.joker) return "Impossible de récupérer un joker jeté — il est perdu !";
    const card = g.discard.pop();
    p.hand.push(card);
    p.lastTaken = card;
    g.takenCards = [...(g.takenCards || []), { idx, card }]; // mémoire pour la défausse défensive des bots
    g.phase = "play";
    log(room, `${p.name} prend ${E.cardName(card)} dans la défausse`);
    io.to(room.code).emit("fx", { kind: "take", idx, card });
  } else {
    drawFromStock(room, idx);
    log(room, `${p.name} pioche une carte`);
  }
  broadcast(room);
  return null;
}

function handlePose(room, idx, meldsSpec) {
  const g = room.game;
  const p = room.players[idx];
  const contract = E.MANCHES[g.mancheIdx];
  if (room.state !== "playing" || g.roundOver) return "La partie n'est pas en cours.";
  if (g.turn !== idx || g.phase !== "play") return "Tu ne peux pas poser maintenant.";
  if (p.posed) return "Tu as déjà posé ton contrat.";
  if (!Array.isArray(meldsSpec) || meldsSpec.length === 0) return "Aucune combinaison reçue.";

  const byId = new Map(p.hand.map((c) => [c.id, c]));
  const usedIds = new Set();
  const builtMelds = [];
  for (const spec of meldsSpec) {
    if (!spec || !Array.isArray(spec.cardIds) || !["tri", "esc"].includes(spec.type)) return "Combinaison mal formée.";
    const cards = [];
    for (const id of spec.cardIds) {
      const c = byId.get(id);
      if (!c || usedIds.has(id)) return "Carte invalide ou utilisée deux fois.";
      usedIds.add(id);
      cards.push(c);
    }
    if (!E.validGroup(spec.type, cards)) return `Un ${spec.type === "tri" ? "tri" : "escalier"} proposé est invalide.`;
    builtMelds.push({ type: spec.type, cards });
  }
  const triCount = builtMelds.filter((m) => m.type === "tri").length;
  const escCount = builtMelds.filter((m) => m.type === "esc").length;
  if (contract.poseTout) {
    if (usedIds.size !== p.hand.length) return "Au pose-tout, toutes tes cartes doivent être posées d'un coup.";
  } else {
    if (triCount < contract.tri || escCount < contract.esc)
      return `Contrat incomplet : il faut ${contract.label}.`;
  }
  builtMelds.forEach((m, i) => g.melds.push({ id: Date.now() + idx * 100 + i, type: m.type, cards: E.normMeld(m.type, m.cards), owner: idx }));
  p.hand = p.hand.filter((c) => !usedIds.has(c.id));
  p.posed = true;
  p.justPosed = true;
  p.timeouts = 0;
  log(room, `${p.name} pose son contrat !`);
  io.to(room.code).emit("fx", { kind: "pose", idx });
  checkRoundEnd(room, idx);
  broadcast(room);
  return null;
}

function handleComplete(room, idx, meldId, cardId) {
  const g = room.game;
  const p = room.players[idx];
  if (room.state !== "playing" || g.roundOver) return "La partie n'est pas en cours.";
  if (g.turn !== idx || g.phase !== "play") return "Tu ne peux pas compléter maintenant.";
  if (!p.posed) return "Pose d'abord ton contrat.";
  if (E.MANCHES[g.mancheIdx].poseTout) return "Pas de complétion à la manche du pose-tout.";
  const meld = g.melds.find((m) => m.id === meldId);
  const card = p.hand.find((c) => c.id === cardId);
  if (!meld || !card) return "Carte ou combinaison introuvable.";
  // Échange de joker : escalier uniquement, si la carte remplace exactement le joker
  if (meld.type === "esc" && !card.joker) {
    for (let ji = 0; ji < meld.cards.length; ji++) {
      if (!meld.cards[ji].joker) continue;
      const inPlace = meld.cards.map((c, i) => (i === ji ? card : c));
      if (E.isOrderedEscalier(inPlace)) {
        const jk = meld.cards[ji];
        meld.cards = inPlace;
        p.hand = p.hand.filter((c) => c.id !== cardId);
        p.hand.push(jk);
        p.timeouts = 0;
        log(room, p.name + " échange " + E.cardName(card) + " contre un Joker !");
        io.to(room.code).emit("fx", { kind: "exchange", idx });
        broadcast(room);
        return null;
      }
    }
  }
  if (!E.validGroup(meld.type, [...meld.cards, card])) return "Cette carte ne complète pas cette combinaison.";
  meld.cards = E.normMeld(meld.type, [...meld.cards, card]);
  p.hand = p.hand.filter((c) => c.id !== cardId);
  p.timeouts = 0;
  log(room, `${p.name} complète avec ${E.cardName(card)}`);
  checkRoundEnd(room, idx);
  broadcast(room);
  return null;
}

function doDiscard(room, idx, cardId, auto) {
  const g = room.game;
  const p = room.players[idx];
  const card = p.hand.find((c) => c.id === cardId);
  if (!card) return "Carte introuvable.";
  p.hand = p.hand.filter((c) => c.id !== cardId);
  g.discard.push(card);
  g.discardLocked = false; // nouvelle carte jetée : la défausse redevient disponible
  p.justPosed = p.justPosed && p.hand.length === 0; // le pose-tout reste valable si on finit dans le même tour
  log(room, `${p.name} jette ${E.cardName(card)}${auto ? " (auto)" : ""}`);
  io.to(room.code).emit("fx", { kind: "discard", idx, card });
  checkRoundEnd(room, idx);
  if (g.roundOver) { broadcast(room); return null; }
  openBuyWindow(room, idx);
  return null;
}

function handleDiscard(room, idx, cardId) {
  const g = room.game;
  if (room.state !== "playing" || g.roundOver) return "La partie n'est pas en cours.";
  if (g.turn !== idx || g.phase !== "play") return "Tu ne peux pas jeter maintenant.";
  room.players[idx].timeouts = 0;
  return doDiscard(room, idx, cardId, false);
}

// ---------- Fenêtre d'achat (hors tour, priorité dans le sens du jeu) ----------
// Difficile : à quel point la carte intéresse UN adversaire, d'après les cartes qu'il a prises
// ou achetées (mémoire takenCards). Sert au blocage : prendre la carte avant lui.
// +3 s'il collectionne ce rang (tri), +2 s'il construit dans cette couleur autour (escalier).
function hotForOpponents(top, takenCards, selfIdx, players) {
  if (!top || top.joker) return 0;
  const byPlayer = {};
  (takenCards || []).forEach((t) => {
    if (t.idx === selfIdx || !t.card) return;
    if (players && players[t.idx] && players[t.idx].posed) return; // déjà posé : plus de contrat à bloquer
    (byPlayer[t.idx] = byPlayer[t.idx] || []).push(t.card);
  });
  let best = 0;
  Object.keys(byPlayer).forEach((k) => {
    let s = 0;
    byPlayer[k].forEach((c) => {
      if (c.joker) return;
      const dd = Math.min(Math.abs(c.rank - top.rank), 13 - Math.abs(c.rank - top.rank)); // distance circulaire (K-A-2)
      if (c.rank === top.rank) s += 3;
      if (c.suit === top.suit && dd <= 2) s += 2;
    });
    best = Math.max(best, s);
  });
  return best;
}

function wantsTop(p, top, level, contract) {
  if (!top || top.joker || level === "facile") return false;
  if (p.posed) return false; // déjà posé : acheter ne sert plus à rien
  const nonJ = p.hand.filter((c) => !c.joker);
  const mates = nonJ.filter((c) => c.rank === top.rank).length;
  const neigh = nonJ.filter((c) => c.suit === top.suit && Math.abs(c.rank - top.rank) <= 1).length;
  if (level !== "difficile") return mates >= 2 || neigh >= 2; // moyen : tris ET escaliers
  // Difficile : on ne veut que ce qui sert le contrat
  const wantTri = !contract || (contract.tri || 0) > 0 || contract.poseTout;
  const wantEsc = !contract || (contract.esc || 0) > 0 || contract.poseTout;
  if ((wantTri && mates >= 2) || (wantEsc && neigh >= 2)) return true;
  // ...ou qui complète le contrat d'un coup
  if (contract && !contract.poseTout) {
    return !E.aiPlanContract(p.hand, contract, level) && Boolean(E.aiPlanContract([...p.hand, top], contract, level));
  }
  return false;
}

function botBuyer(room, discarderIdx, nextIdx) {
  const g = room.game;
  const top = g.discard[g.discard.length - 1];
  if (!top || top.joker) return null;
  const n = room.players.length;
  const level = room.options.level;
  if (level === "facile") return null;
  const contract = E.MANCHES[g.mancheIdx];
  let best = null, bestD = 99;
  room.players.forEach((p, i) => {
    if (i === discarderIdx || i === nextIdx || p.buysLeft <= 0 || p.posed) return;
    if (!(p.isBot || p.absent || !p.connected)) return; // seulement les mains jouées par l'IA
    const wants = level === "difficile"
      ? (wantsTop(p, top, level, contract) ||
        // Achat de blocage : carte très convoitée par un adversaire — s'il lui reste des achats de réserve
        (p.buysLeft >= 2 && hotForOpponents(top, g.takenCards, i, room.players) >= 5))
      : (p.hand.filter((c) => !c.joker && c.rank === top.rank).length >= 2 ||
         p.hand.filter((c) => !c.joker && c.suit === top.suit && Math.abs(c.rank - top.rank) <= 1).length >= 2);
    if (!wants) return;
    const d = (i - discarderIdx + n) % n;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function doBuy(room, idx) {
  const g = room.game;
  if (g.discard.length === 0) return;
  const p = room.players[idx];
  const bought = g.discard.pop();
  if (g.stock.length === 0) {
    const t2 = g.discard.pop();
    g.stock = shuffleInPlace(g.discard);
    g.discard = t2 ? [t2] : [];
  }
  const penalty = g.stock.pop();
  p.hand.push(bought);
  if (penalty) p.hand.push(penalty); // pas de pénalité possible si tout est épuisé
  p.buysLeft--;
  p.lastTaken = bought;
  g.takenCards = [...(g.takenCards || []), { idx, card: bought }]; // mémoire pour la défausse défensive des bots
  g.discardLocked = true; // après un achat, la carte du dessous ne peut pas être prise
  log(room, p.name + " achète " + E.cardName(bought) + " (+1 pénalité)");
  io.to(room.code).emit("fx", { kind: "buy", idx, card: bought });
}

function openBuyWindow(room, discarderIdx) {
  const g = room.game;
  clearTimeout(room.turnTimer);
  const n = room.players.length;
  const nextIdx = (discarderIdx + 1) % n;
  const top = g.discard[g.discard.length - 1];
  const bBuyer = botBuyer(room, discarderIdx, nextIdx);
  const nextP = room.players[nextIdx];
  const nextIsHuman = nextP && !nextP.isBot && nextP.connected && !nextP.absent;
  const someoneCanBuy = Boolean(top) && !top.joker && room.players.some((p, i) =>
    i !== discarderIdx && i !== nextIdx && !p.isBot && p.connected && !p.absent && p.buysLeft > 0); // un humain posé peut encore acheter (seuls les bots s'en privent)
  // si un bot veut acheter mais qu'un humain est le prochain joueur, on ouvre la fenêtre
  // pour qu'il puisse faire valoir sa priorité
  if (!someoneCanBuy && !(bBuyer != null && nextIsHuman)) {
    if (bBuyer != null && !(nextP && wantsTop(nextP, top, room.options.level, E.MANCHES[g.mancheIdx]) && !nextIsHuman)) doBuy(room, bBuyer);
    advanceTurn(room, discarderIdx);
    return;
  }
  g.phase = "buyWindow";
  g.lastDiscarderIdx = discarderIdx;
  g.buyRequests = [];
  g.nextIdx = nextIdx;
  g.botBuyer = bBuyer;
  g.buyWindowUntil = Date.now() + BUY_WINDOW_MS;
  broadcast(room);
  room.buyTimer = setTimeout(() => safeRun(() => resolveBuyWindow(room)), BUY_WINDOW_MS);
}

function handleBuyRequest(room, idx) {
  const g = room.game;
  if (g.phase !== "buyWindow") return "Il n'y a pas d'achat possible en ce moment.";
  const p = room.players[idx];
  const topD = g.discard[g.discard.length - 1];
  if (topD && topD.joker) return "Impossible de récupérer un joker jeté — il est perdu !";
  if (idx === g.lastDiscarderIdx) return "Tu ne peux pas racheter ta propre défausse.";
  if (idx === (g.lastDiscarderIdx + 1) % room.players.length) return "Tu es le joueur suivant : tu prendras la carte gratuitement à ton tour.";
  if (p.buysLeft <= 0) return "Plus d'achats disponibles (3 max par manche).";
  if (!g.buyRequests.includes(idx)) g.buyRequests.push(idx);
  return null;
}

function maybeResolveRematch(room) {
  const r = room.rematch;
  if (!r) return;
  const allVoted = room.players.every((p, i) => r.accepted.includes(i) || r.declined.includes(i));
  if (allVoted) resolveRematch(room, false);
}

function resolveRematch(room, timedOut) {
  const r = room.rematch;
  if (!r) return;
  clearTimeout(room.rematchTimer);
  room.rematch = null;
  // les joueurs qui déclinent quittent le salon
  r.declined.forEach((i) => {
    const p = room.players[i];
    if (p && p.socketId) {
      const ts = io.sockets.sockets.get(p.socketId);
      if (ts) { ts.emit("kicked", "Tu as décliné la revanche — à la prochaine !"); ts.leave(room.code); }
    }
  });
  room.players = room.players.filter((p, i) => !r.declined.includes(i));
  if (room.players.length === 0) return;
  room.players.forEach((p) => { p.total = 0; });
  if (room.players.length >= 3) {
    room.game = null; // nouvelle partie : l'historique des manches précédentes ne doit pas être conservé
    startRound(room, 0);
    log(room, "🔁 Revanche !" + (timedOut ? " (délai écoulé, les silencieux jouent quand même)" : ""));
    broadcast(room);
  } else {
    room.state = "lobby";
    room.game = null;
    broadcast(room);
  }
}

function resolveBuyWindow(room) {
  const g = room.game;
  if (!g || g.phase !== "buyWindow") return;
  const n = room.players.length;
  const requests = [...new Set(g.buyRequests)];
  if (g.botBuyer != null && !requests.includes(g.botBuyer)) requests.push(g.botBuyer);
  const nextP = g.nextIdx != null ? room.players[g.nextIdx] : null;
  const nextAIWants = nextP && (nextP.isBot || nextP.absent || !nextP.connected) &&
    wantsTop(nextP, g.discard[g.discard.length - 1], room.options.level, E.MANCHES[g.mancheIdx]);
  if (nextAIWants && requests.length > 0) {
    requests.forEach((i) => {
      const so = room.players[i] && room.players[i].socketId;
      if (so) io.to(so).emit("info", nextP.name + " (joueur suivant) est prioritaire — achat annulé.");
    });
    requests.length = 0;
  }
  if (requests.length > 0 && g.discard.length > 0) {
    const ordered = requests.sort((a, b) => ((a - g.lastDiscarderIdx + n) % n) - ((b - g.lastDiscarderIdx + n) % n));
    const winnerIdx = ordered[0];
    doBuy(room, winnerIdx);
    ordered.slice(1).forEach((i) => {
      const so = room.players[i].socketId;
      if (so) io.to(so).emit("info", room.players[winnerIdx].name + " était mieux placé dans le sens du jeu — achat manqué.");
    });
  }
  g.botBuyer = null;
  advanceTurn(room, g.lastDiscarderIdx);
}

function advanceTurn(room, fromIdx) {
  const g = room.game;
  g.buyRequests = [];
  g.turn = (fromIdx + 1) % room.players.length;
  room.players.forEach((p) => { p.justPosed = false; });
  startTurn(room);
}

// ---------- Fin de manche et scores ----------
function checkRoundEnd(room, idx) {
  const g = room.game;
  const p = room.players[idx];
  if (p.hand.length > 0 || g.roundOver) return;
  clearTimers(room);
  const isFinal = E.MANCHES[g.mancheIdx].poseTout;
  let bonusType = null;
  if (isFinal) bonusType = "final";
  else if (p.justPosed && !room.players.some((q, i) => i !== idx && q.posed)) bonusType = "anticipe";
  const n = room.players.length;
  const summary = room.players.map((q, i) => {
    let pts = i === idx ? 0 : E.handPoints(q.hand);
    let bonus = 0;
    if (i === idx && bonusType === "final") bonus = -50 * n;
    if (i === idx && bonusType === "anticipe") bonus = -10 * n;
    q.total += pts + bonus;
    return { name: q.name, pts, bonus, total: q.total };
  });
  g.history.push({ mancheIdx: g.mancheIdx, summary });
  g.roundOver = { winnerIdx: idx, bonusType, summary };
  room.state = g.mancheIdx + 1 >= E.MANCHES.length ? "over" : "roundEnd";
  if (room.state === "over") {
    const champ = room.players.reduce((a, b) => (b.total < a.total ? b : a));
    champ.wins = (champ.wins || 0) + 1;
    log(room, "👑 " + champ.name + " remporte la partie !");
  }
  log(room, `${p.name} gagne la manche !`);
}

// ---------- Tour complet joué par l'IA (bots, absents, déconnectés) ----------
function aiPlayTurn(room) {
  const g = room.game;
  if (!g || g.roundOver || room.state !== "playing") return;
  if (g.phase === "buyWindow") return; // la fenêtre d'achat se résout par son propre minuteur, jamais ici
  const idx = g.turn;
  const p = room.players[idx];
  if (!p || !(p.isBot || p.absent || !p.connected)) return; // jamais jouer à la place d'un humain actif (timer périmé)
  const contract = E.MANCHES[g.mancheIdx];
  const level = room.options.level;

  // Piocher ou prendre — sauf si la carte est déjà en main (phase "play" : relance du chien de garde)
  if (g.phase === "draw") {
  const top = g.discard[g.discard.length - 1];
  const mates = top && !top.joker ? p.hand.filter((c) => !c.joker && c.rank === top.rank).length : 0;
  const neigh = top && !top.joker ? p.hand.filter((c) => !c.joker && c.suit === top.suit && Math.abs(c.rank - top.rank) <= 1).length : 0;
  // Une fois posé : prendre la défausse seulement si la carte complète une combinaison de la table (main -1 garanti)
  const fitsMeld = (card) => Boolean(card) && !card.joker && g.melds.some((m) => E.validGroup(m.type, [...m.cards, card]));
  const wantsTake = g.discardLocked ? false
    : p.posed ? Boolean(level !== "facile" && !contract.poseTout && fitsMeld(top))
    : level === "facile" ? false
    : level === "difficile" ? (wantsTop(p, top, level, contract) ||
        // Blocage : la carte ne lui sert pas, mais un adversaire la collectionne — il la prend pour l'en priver
        // (garde-fous : jamais en fin de pioche, ni avec une main déjà chargée — son jeu reste la priorité)
        (Boolean(top) && !top.joker && g.stock.length > room.players.length * 2 && p.hand.length <= 16 &&
          hotForOpponents(top, g.takenCards, idx, room.players) >= 3))
    : Boolean(top && !top.joker && (mates >= 2 || neigh >= 2)); // moyen : tris ET escaliers
  if (wantsTake) {
    const card = g.discard.pop();
    p.hand.push(card);
    p.lastTaken = card;
    g.takenCards = [...(g.takenCards || []), { idx, card }];
    g.phase = "play";
    log(room, `${p.name} prend ${E.cardName(card)} dans la défausse`);
    io.to(room.code).emit("fx", { kind: "take", idx, card });
  } else {
    drawFromStock(room, idx);
    log(room, `${p.name} pioche une carte`);
  }
  }

  // Poser
  if (!p.posed) {
    const plan = contract.poseTout ? E.aiPlanFullHand(p.hand) : E.aiPlanContract(p.hand, contract, level);
    let planOk = plan && (!contract.poseTout || plan.reduce((s, m) => s + m.cards.length, 0) === p.hand.length);
    // Difficile : on retient la pose pour ne rien dévoiler et viser une fin éclair —
    // sauf si quelqu'un a déjà posé (la course est lancée) ou si la pioche s'épuise
    if (planOk && level === "difficile" && !contract.poseTout) {
      const othersPosed = room.players.some((q, i2) => i2 !== idx && q.posed);
      const leftover = p.hand.length - plan.reduce((s, m) => s + m.cards.length, 0);
      const lowStock = g.stock.length < room.players.length * 4;
      if (!othersPosed && leftover > 3 && !lowStock) planOk = false;
    }
    if (planOk) {
      plan.forEach((m, i) => g.melds.push({ id: Date.now() + idx * 100 + i, type: m.type, cards: E.normMeld(m.type, m.cards), owner: idx }));
      const usedIds = new Set(plan.flatMap((m) => m.cards.map((c) => c.id)));
      p.hand = p.hand.filter((c) => !usedIds.has(c.id));
      p.posed = true;
      p.justPosed = true;
      log(room, `${p.name} pose son contrat !`);
    }
  }

  // Échange de joker (niveau difficile) : récupérer un joker posé avec la carte exacte
  if (p.posed && level === "difficile" && !contract.poseTout) {
    let swapped = true;
    while (swapped) {
      swapped = false;
      for (const m of g.melds) {
        if (m.type !== "esc") continue;
        for (let ji = 0; ji < m.cards.length && !swapped; ji++) {
          if (!m.cards[ji].joker) continue;
          const c = p.hand.find((h) => !h.joker && E.isOrderedEscalier(m.cards.map((x, i2) => (i2 === ji ? h : x))));
          if (!c) continue;
          const jk = m.cards[ji];
          m.cards = m.cards.map((x, i2) => (i2 === ji ? c : x));
          p.hand.splice(p.hand.indexOf(c), 1);
          p.hand.push(jk);
          log(room, p.name + " échange " + E.cardName(c) + " contre un Joker !");
          io.to(room.code).emit("fx", { kind: "exchange", idx });
          swapped = true;
        }
        if (swapped) break;
      }
    }
  }

  // Compléter
  if (p.posed && !contract.poseTout) {
    let changed = true;
    while (changed && p.hand.length > 0) {
      changed = false;
      for (const c of p.hand) {
        if (level === "facile" && c.joker) continue;
        const m = g.melds.find((m) => (level !== "facile" || m.owner === idx) && E.validGroup(m.type, [...m.cards, c]));
        if (m) {
          m.cards = E.normMeld(m.type, [...m.cards, c]);
          p.hand = p.hand.filter((x) => x.id !== c.id);
          log(room, `${p.name} complète avec ${E.cardName(c)}`);
          changed = true;
          break;
        }
      }
    }
  }

  checkRoundEnd(room, idx);
  if (g.roundOver) { broadcast(room); return; }

  // Jeter
  const nonJokers = p.hand.filter((c) => !c.joker);
  let toss;
  if (p.posed && nonJokers.length > 0) {
    // Une fois posé : se débarrasser des cartes les plus chères (limiter les points)
    toss = [...nonJokers].sort((a, b) => E.cardPoints(b) - E.cardPoints(a))[0];
  } else if (level === "difficile" && nonJokers.length > 0) {
    // Défausse défensive : éviter de nourrir les adversaires
    const othersTaken = (g.takenCards || []).filter((t) => t.idx !== idx).map((t) => t.card);
    const anyOtherPosed = room.players.some((q, i2) => i2 !== idx && q.posed);
    const danger = (c) => {
      let d2 = 0;
      othersTaken.forEach((t) => {
        if (t.rank === c.rank) d2 += 3;
        if (t.suit === c.suit && Math.abs(t.rank - c.rank) <= 2) d2 += 2;
      });
      if (anyOtherPosed && g.melds.some((m) => E.validGroup(m.type, [...m.cards, c]))) d2 += 6;
      return d2;
    };
    const usefulness = (c) => {
      const m2 = nonJokers.filter((o) => o.id !== c.id && o.rank === c.rank).length;
      const n2 = nonJokers.filter((o) => o.id !== c.id && o.suit === c.suit && Math.abs(o.rank - c.rank) <= 2).length;
      return m2 * 4 + n2 * 3 - E.cardPoints(c) * 0.15;
    };
    toss = [...nonJokers].sort((a, b) => (usefulness(a) + danger(a)) - (usefulness(b) + danger(b)))[0];
  } else {
    toss = E.aiDiscardChoice(p.hand, level);
  }
  doDiscard(room, idx, toss.id, false);
  broadcast(room);
}

// ---------- Socket.io ----------
io.on("connection", (socket) => {
  // Limite de débit par connexion : 40 événements / 5 s. Un humain n'atteint jamais ça,
  // un bot de flood si — ses événements excédentaires sont simplement ignorés.
  let evCount = 0, evWindow = Date.now();
  const _on = socket.on.bind(socket);
  socket.on = (ev, fn) => _on(ev, (...args) => {
    if (ev !== "disconnect") {
      const now = Date.now();
      if (now - evWindow > 5000) { evWindow = now; evCount = 0; }
      if (++evCount > 40) {
        if (evCount === 41) console.error("Débit excessif ignoré (socket " + socket.id + ")");
        return;
      }
    }
    try { return fn(...args); } catch (e) { console.error("Erreur (" + ev + "):", (e && e.stack) || e); }
  });
  let myRoom = null;
  let myToken = null;

  const findMe = () => {
    if (!myRoom) return null;
    const idx = myRoom.players.findIndex((p) => p.token === myToken);
    return idx >= 0 ? { idx, p: myRoom.players[idx] } : null;
  };

  // Quitter proprement le salon courant avant d'en rejoindre un autre (sinon joueur fantôme double-abonné)
  const detachFromRoom = () => {
    if (!myRoom) return;
    const me = findMe();
    if (me && me.p.socketId === socket.id) {
      me.p.connected = false;
      me.p.socketId = null;
      if (myRoom.state === "playing") me.p.absent = true;
      broadcast(myRoom);
    }
    socket.leave(myRoom.code);
    myRoom = null; myToken = null;
  };

  let lastCreateAt = 0;
  socket.on("createRoom", ({ name, options, avatar } = {}, cb) => {
    if (typeof cb !== "function") cb = () => {};
    // Anti-flood : borne dure sur le nombre total de salons + délai entre deux créations
    if (rooms.size >= MAX_ROOMS) return cb({ ok: false, error: "Serveur très demandé — réessaie dans quelques minutes." });
    if (Date.now() - lastCreateAt < 5000) return cb({ ok: false, error: "Doucement — attends quelques secondes avant de créer un autre salon." });
    lastCreateAt = Date.now();
    detachFromRoom();
    const room = createRoom(name, options);
    const player = addPlayer(room, name, false, avatar);
    player.socketId = socket.id;
    player.connected = true;
    myRoom = room; myToken = player.token;
    socket.join(room.code);
    touch(room);
    cb({ ok: true, code: room.code, token: player.token });
    broadcast(room);
  });

  socket.on("joinRoom", ({ code, name, avatar } = {}, cb) => {
    if (typeof cb !== "function") cb = () => {};
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb({ ok: false, error: "Salon introuvable. Vérifie le code." });
    if (room !== myRoom) detachFromRoom();
    if (room.state !== "lobby") return cb({ ok: false, error: "La partie a déjà commencé (utilise « Reprendre » si tu en faisais partie)." });
    if (room.players.length >= 6) return cb({ ok: false, error: "Salon complet (6 joueurs max)." });
    const player = addPlayer(room, name, false, avatar);
    player.socketId = socket.id;
    player.connected = true;
    myRoom = room; myToken = player.token;
    socket.join(room.code);
    touch(room);
    cb({ ok: true, code: room.code, token: player.token });
    broadcast(room);
  });

  socket.on("rejoin", ({ code, token } = {}, cb) => {
    if (typeof cb !== "function") cb = () => {};
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb({ ok: false, error: "Ce salon n'existe plus." });
    const player = room.players.find((p) => p.token === token);
    if (!player) return cb({ ok: false, error: "Joueur inconnu dans ce salon." });
    if (room !== myRoom) detachFromRoom();
    const wasAway = !player.connected; // avant mise à jour : vraie coupure, ou simple re-synchronisation ?
    player.socketId = socket.id;
    player.connected = true;
    if (player.absent) { player.absent = false; player.timeouts = 0; log(room, player.name + " reprend la main"); }
    player.absent = false;
    player.timeouts = 0;
    myRoom = room; myToken = token;
    socket.join(room.code);
    touch(room);
    // Si l'IA s'apprêtait à jouer son tour, on lui rend la main
    const pIdx = room.players.indexOf(player);
    if (room.game && room.state === "playing" && room.game.turn === pIdx && room.game.phase === "draw" && !room.game.roundOver) {
      clearTimeout(room.aiTimer);
      clearTimeout(room.turnTimer);
      room.game.turnDeadline = Date.now() + room.options.turnSeconds * 1000;
      room.turnTimer = setTimeout(() => safeRun(() => onTurnTimeout(room)), room.options.turnSeconds * 1000);
    }
    if (room.game && wasAway) log(room, `${player.name} est de retour !`);
    cb({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on("addBot", () => {
    if (!myRoom || myRoom.state !== "lobby") return;
    const me = findMe();
    if (!me || me.idx !== 0) return; // seul l'hôte
    if (myRoom.players.length >= 6) return;
    const botNumber = myRoom.players.filter((p) => p.isBot).length + 1;
    addPlayer(myRoom, "Bot " + botNumber, true);
    touch(myRoom);
    broadcast(myRoom);
  });

  socket.on("setAvatar", (a) => {
    if (!myRoom || myRoom.state !== "lobby") return;
    const me = findMe();
    if (!me) return;
    if (!AVATARS_POOL.includes(a)) return;
    const ownerIdx = myRoom.players.findIndex((p, i) => i !== me.idx && p.avatar === a);
    if (ownerIdx !== -1) {
      const owner = myRoom.players[ownerIdx];
      if (!owner.isBot) return socket.emit("info", "Cet emoji est déjà pris par un autre joueur.");
      me.p.avatar = a;                      // l'humain récupère l'emoji
      owner.avatar = freeAvatar(myRoom, null); // le bot en prend un autre, poliment
    } else {
      me.p.avatar = a;
    }
    touch(myRoom);
    broadcast(myRoom);
  });

  socket.on("removePlayer", (targetIdx) => {
    if (!myRoom || myRoom.state !== "lobby") return;
    const me = findMe();
    if (!me || me.idx !== 0) return socket.emit("info", "Seul l'hôte peut retirer un joueur.");
    const i = Number(targetIdx);
    if (!Number.isInteger(i) || i <= 0 || i >= myRoom.players.length) return;
    const target = myRoom.players[i];
    if (!target.isBot && target.socketId) {
      const ts = io.sockets.sockets.get(target.socketId);
      if (ts) {
        ts.emit("kicked", "L'hôte t'a retiré du salon.");
        ts.leave(myRoom.code);
      }
    }
    myRoom.players.splice(i, 1);
    touch(myRoom);
    broadcast(myRoom);
  });

  let lastEmoteAt = 0;
  socket.on("emote", (text) => {
    if (!myRoom) return;
    const me = findMe();
    if (!me) return;
    const now = Date.now();
    if (now - lastEmoteAt < 1000) return; // anti-spam : 1 émote par seconde
    if (!EMOTES_AUTORISEES.includes(text)) return;
    lastEmoteAt = now;
    touch(myRoom);
    io.to(myRoom.code).emit("emote", { idx: me.idx, text, id: ++EMOTE_SEQ });
  });

  socket.on("rematch", () => {
    if (!myRoom || myRoom.state !== "over") return;
    const me = findMe();
    if (!me) return;
    const host = myRoom.players[0];
    const hostAway = !host || host.isBot || !host.connected;
    const firstActive = myRoom.players.findIndex((p) => !p.isBot && p.connected);
    if (me.idx !== 0 && !(hostAway && me.idx === firstActive)) return socket.emit("info", "Seul l'hôte peut proposer la revanche.");
    if (myRoom.rematch) return;
    // acceptations automatiques : le proposeur, les bots et les déconnectés (l'IA jouera pour eux)
    const accepted = [me.idx];
    myRoom.players.forEach((p, i) => { if (i !== me.idx && (p.isBot || !p.connected)) accepted.push(i); });
    myRoom.rematch = { accepted, declined: [] };
    log(myRoom, me.p.name + " propose une revanche !");
    touch(myRoom);
    clearTimeout(myRoom.rematchTimer);
    myRoom.rematchTimer = setTimeout(() => safeRun(() => resolveRematch(myRoom, true)), 30000);
    broadcast(myRoom);
    maybeResolveRematch(myRoom);
  });

  socket.on("rematchVote", (yes) => {
    if (!myRoom || myRoom.state !== "over" || !myRoom.rematch) return;
    const me = findMe();
    if (!me) return;
    const r = myRoom.rematch;
    r.accepted = r.accepted.filter((i) => i !== me.idx);
    r.declined = r.declined.filter((i) => i !== me.idx);
    (yes ? r.accepted : r.declined).push(me.idx);
    touch(myRoom);
    broadcast(myRoom);
    maybeResolveRematch(myRoom);
  });

  socket.on("claimNext", () => {
    if (!myRoom || !myRoom.game) return;
    const me = findMe();
    if (!me) return;
    const g = myRoom.game;
    if (g.phase !== "buyWindow" || me.idx !== g.nextIdx) return;
    const top = g.discard[g.discard.length - 1];
    if (!top || top.joker) return;
    clearTimeout(myRoom.buyTimer);
    const card = g.discard.pop();
    me.p.hand.push(card);
    me.p.lastTaken = card;
    me.p.timeouts = 0;
    g.buyRequests.forEach((i) => {
      const so = myRoom.players[i] && myRoom.players[i].socketId;
      if (so) io.to(so).emit("info", me.p.name + " a fait valoir sa priorité de joueur suivant — achat annulé.");
    });
    g.botBuyer = null;
    g.turn = g.nextIdx;
    g.phase = "play";
    g.turnDeadline = Date.now() + myRoom.options.turnSeconds * 1000;
    clearTimeout(myRoom.turnTimer);
    myRoom.turnTimer = setTimeout(() => safeRun(() => onTurnTimeout(myRoom)), myRoom.options.turnSeconds * 1000);
    log(myRoom, me.p.name + " prend " + E.cardName(card) + " (prioritaire)");
    io.to(myRoom.code).emit("fx", { kind: "take", idx: me.idx, card });
    broadcast(myRoom);
  });

  socket.on("passNext", () => {
    if (!myRoom || !myRoom.game) return;
    const me = findMe();
    if (!me) return;
    const g = myRoom.game;
    if (g.phase !== "buyWindow" || me.idx !== g.nextIdx) return;
    clearTimeout(myRoom.buyTimer);
    resolveBuyWindow(myRoom);
  });

  socket.on("resync", () => {
    if (myRoom) broadcast(myRoom);
  });

  socket.on("startGame", () => {
    if (!myRoom || myRoom.state !== "lobby") return;
    const me = findMe();
    if (!me || me.idx !== 0) return socket.emit("info", "Seul l'hôte peut lancer la partie.");
    if (myRoom.players.length < 3) return socket.emit("info", "Il faut au moins 3 joueurs (ajoute un bot si besoin).");
    touch(myRoom);
    startRound(myRoom, 0);
  });

  socket.on("nextRound", () => {
    if (!myRoom || myRoom.state !== "roundEnd") return;
    const me = findMe();
    if (!me) return;
    // L'hôte lance la manche suivante ; s'il est déconnecté, le premier humain connecté peut le faire
    const host = myRoom.players[0];
    const hostAway = !host || host.isBot || !host.connected;
    const firstActive = myRoom.players.findIndex((p) => !p.isBot && p.connected);
    if (me.idx !== 0 && !(hostAway && me.idx === firstActive)) return;
    touch(myRoom);
    startRound(myRoom, myRoom.game.mancheIdx + 1);
  });

  socket.on("action", (a) => {
    if (!a || typeof a !== "object") return; // payload malformé : ignoré
    if (!myRoom || !myRoom.game) return;
    const me = findMe();
    if (!me) return;
    touch(myRoom);
    if (me.p.absent && a.type !== "resume") {
      me.p.absent = false; // toute action volontaire redonne la main
      log(myRoom, `${me.p.name} reprend la main`);
    }
    let err = null;
    if (a.type === "draw") err = handleDraw(myRoom, me.idx, a.source);
    else if (a.type === "pose") err = handlePose(myRoom, me.idx, a.melds);
    else if (a.type === "complete") err = handleComplete(myRoom, me.idx, a.meldId, a.cardId);
    else if (a.type === "discard") err = handleDiscard(myRoom, me.idx, a.cardId);
    else if (a.type === "buy") { err = handleBuyRequest(myRoom, me.idx); if (!err) socket.emit("info", "Demande d'achat enregistrée…"); }
    else if (a.type === "resume") { me.p.absent = false; me.p.timeouts = 0; log(myRoom, `${me.p.name} reprend la main`); broadcast(myRoom); }
    if (err) socket.emit("info", err);
  });

  socket.on("leaveGame", () => {
    if (!myRoom) return;
    const me = findMe();
    if (!me) return;
    me.p.connected = false;
    me.p.absent = true;
    me.p.socketId = null;
    log(myRoom, `${me.p.name} a quitté la partie — l'IA le remplace`);
    if (myRoom.game && myRoom.state === "playing" && myRoom.game.turn === me.idx && myRoom.game.phase !== "buyWindow") {
      clearTimeout(myRoom.turnTimer);
      clearTimeout(myRoom.aiTimer);
      myRoom.aiTimer = setTimeout(() => safeRun(() => aiPlayTurn(myRoom)), AI_DELAY_MS);
    }
    broadcast(myRoom);
  });

  socket.on("disconnect", () => {
    if (!myRoom) return;
    const me = findMe();
    if (!me) return;
    if (me.p.socketId && me.p.socketId !== socket.id) return; // un socket plus récent a repris ce joueur : ignorer la mort de l'ancien
    me.p.connected = false;
    me.p.socketId = null;
    if (myRoom.state === "playing") {
      log(myRoom, `${me.p.name} est déconnecté — l'IA joue à sa place en attendant son retour`);
      if (myRoom.game.turn === me.idx && !myRoom.game.roundOver && myRoom.game.phase !== "buyWindow") {
        clearTimeout(myRoom.turnTimer);
        clearTimeout(myRoom.aiTimer);
        myRoom.aiTimer = setTimeout(() => safeRun(() => aiPlayTurn(myRoom)), AI_DELAY_MS);
      }
    }
    broadcast(myRoom);
  });
});

const PORT = process.env.PORT || 3000;
let EMOTE_SEQ = 0;
const AVATARS_POOL = ["🦁", "🐯", "🦊", "🐼", "🐸", "🦉", "🐙", "🦜", "🐢", "🦎"];
const EMOTES_AUTORISEES = ["😂", "👏", "😤", "🔥", "😱", "🤔", "Bien joué !", "Tu me l'as volée !", "Aïe aïe aïe…", "Trop lent !", "Chance de débutant !", "On se calme 😄"];

// Robustesse : une erreur imprévue ne doit jamais faire tomber toutes les tables
process.on("uncaughtException", (e) => console.error("ERREUR NON GÉRÉE:", (e && e.stack) || e));
function safeRun(fn) { try { fn(); } catch (e) { console.error("Erreur minuterie:", (e && e.stack) || e); } }

// Chien de garde : si une partie reste figée (minuterie perdue), on la relance
setInterval(() => {
  for (const room of rooms.values()) {
    try {
      const g = room.game;
      if (!g || room.state !== "playing") continue;
      const now = Date.now();
      if (g.phase === "buyWindow" && g.buyWindowUntil && now > g.buyWindowUntil + 3000) {
        console.error("Chien de garde : fenêtre d'achat figée dans " + room.code + ", résolution forcée");
        safeRun(() => resolveBuyWindow(room));
      } else if (g.phase !== "buyWindow" && g.turnDeadline && now > g.turnDeadline + 6000) {
        const p = room.players[g.turn];
        console.error("Chien de garde : tour figé dans " + room.code + " (" + (p ? p.name : "?") + "), relance");
        if (p && (p.isBot || p.absent || !p.connected)) safeRun(() => aiPlayTurn(room));
        else safeRun(() => onTurnTimeout(room));
      }
    } catch (e) { console.error("Erreur chien de garde:", e); }
  }
}, 10000);
process.on("unhandledRejection", (e) => console.error("PROMESSE REJETÉE:", e));

// ---------- Persistance des salons : les parties survivent aux redémarrages ----------
const fs = require("fs");
const SAVE_FILE = process.env.ROOMS_FILE || path.join(__dirname, "rooms-save.json");

function saveRooms() {
  try {
    const data = Array.from(rooms.values()).map((room) => ({
      code: room.code,
      state: room.state,
      options: room.options,
      lastActivity: room.lastActivity,
      players: room.players.map((p) => ({ ...p, socketId: null, connected: false })),
      game: room.game,
    }));
    fs.writeFileSync(SAVE_FILE, JSON.stringify(data));
  } catch (e) { console.error("Sauvegarde des salons impossible:", e.message); }
}

function loadRooms() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    let n = 0;
    data.forEach((r) => {
      if (!r || !r.code || rooms.has(r.code)) return;
      if (Date.now() - (r.lastActivity || 0) > ROOM_IDLE_LIMIT_MS) return;
      const room = { ...r, rematch: null, turnTimer: null, buyTimer: null, aiTimer: null, rematchTimer: null };
      rooms.set(room.code, room);
      n++;
      // Relance en douceur : les joueurs non revenus sont couverts par l'IA jusqu'à leur reconnexion
      if (room.state === "playing" && room.game && !room.game.roundOver) {
        setTimeout(() => safeRun(() => {
          const g = room.game;
          if (!g || room.state !== "playing" || g.roundOver) return;
          if (g.phase === "buyWindow") { resolveBuyWindow(room); return; }
          g.turnDeadline = Date.now() + room.options.turnSeconds * 1000;
          const p = room.players[g.turn];
          if (p && (p.isBot || p.absent || !p.connected)) {
            if (g.phase === "play") {
              // il avait déjà pioché : on termine son tour par un jet
              const toss = E.aiDiscardChoice(p.hand, "moyen");
              doDiscard(room, g.turn, toss.id, true);
            } else {
              aiPlayTurn(room);
            }
          } else {
            room.turnTimer = setTimeout(() => safeRun(() => onTurnTimeout(room)), room.options.turnSeconds * 1000);
          }
          broadcast(room);
        }), 3000);
      }
    });
    if (n > 0) console.log(n + " salon(s) restauré(s) après redémarrage");
  } catch (e) { console.error("Restauration des salons impossible:", e.message); }
}

loadRooms();
setInterval(saveRooms, 15000);
process.on("SIGTERM", () => { saveRooms(); process.exit(0); });
process.on("SIGINT", () => { saveRooms(); process.exit(0); });

server.listen(PORT, () => console.log("Serveur Ramy Gasy sur le port " + PORT));
