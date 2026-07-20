// Serveur multijoueur Rami Royal — salons privés à code, minuteur, achats hors tour, reconnexion
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const E = require("./engine");

const app = express();
app.use(express.static(path.join(__dirname, "public"))); // sert le client web
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const BUY_WINDOW_MS = 4000;       // fenêtre d'achat après chaque défausse
const AI_DELAY_MS = 1400;         // rythme des tours joués par l'IA
const ROOM_IDLE_LIMIT_MS = 2 * 60 * 60 * 1000; // salon fermé après 2h d'inactivité
const rooms = new Map();          // code → room

const genCode = () => {
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 5; i++) c += letters[Math.floor(Math.random() * letters.length)];
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
      turnSeconds: [30, 45, 60].includes(options?.turnSeconds) ? options.turnSeconds : 45,
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

function addPlayer(room, name, isBot) {
  const player = {
    token: genToken(), name: sanitizeName(name), isBot: !!isBot,
    socketId: null, connected: !!isBot, absent: false, timeouts: 0,
    hand: [], posed: false, buysLeft: E.MAX_ACHATS, lastTaken: null, total: 0, justPosed: false,
  };
  room.players.push(player);
  return player;
}

function sanitizeName(n) {
  return String(n || "").trim().slice(0, 14) || "Joueur";
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
  clearTimeout(room.turnTimer); clearTimeout(room.buyTimer); clearTimeout(room.aiTimer);
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
  room.game.log = [...room.game.log.slice(-60), text];
}

// ---------- État personnalisé envoyé à chaque joueur ----------
function publicPlayer(p, idx) {
  return {
    idx, name: p.name, isBot: p.isBot, connected: p.connected, absent: p.absent,
    handCount: p.hand.length, posed: p.posed, buysLeft: p.buysLeft,
    lastTaken: p.lastTaken, total: p.total,
  };
}

function broadcast(room) {
  const g = room.game;
  room.players.forEach((p, idx) => {
    if (!p.socketId) return;
    io.to(p.socketId).emit("state", {
      code: room.code,
      state: room.state,
      options: room.options,
      youIdx: idx,
      yourHand: p.hand,
      players: room.players.map(publicPlayer),
      game: g ? {
        mancheIdx: g.mancheIdx,
        contract: E.MANCHES[g.mancheIdx],
        stockCount: g.stock.length,
        discardTop: g.discard[g.discard.length - 1] || null,
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
    room.aiTimer = setTimeout(() => aiPlayTurn(room), AI_DELAY_MS);
  } else {
    room.turnTimer = setTimeout(() => onTurnTimeout(room), room.options.turnSeconds * 1000);
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

function drawFromStock(room, idx) {
  const g = room.game;
  if (g.stock.length === 0) {
    const top = g.discard.pop();
    g.stock = g.discard.sort(() => Math.random() - 0.5);
    g.discard = [top];
  }
  const card = g.stock.pop();
  room.players[idx].hand.push(card);
  g.phase = "play";
  io.to(room.code).emit("fx", { kind: "draw", source: "stock", idx });
  return card;
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
    const topD = g.discard[g.discard.length - 1];
    if (topD.joker) return "Impossible de récupérer un joker jeté — il est perdu !";
    const card = g.discard.pop();
    p.hand.push(card);
    p.lastTaken = card;
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
function botBuyer(room, discarderIdx, nextIdx) {
  const g = room.game;
  const top = g.discard[g.discard.length - 1];
  if (!top || top.joker) return null;
  const n = room.players.length;
  const level = room.options.level;
  if (level === "facile") return null;
  let best = null, bestD = 99;
  room.players.forEach((p, i) => {
    if (i === discarderIdx || i === nextIdx || p.buysLeft <= 0) return;
    if (!(p.isBot || p.absent || !p.connected)) return; // seulement les mains jouées par l'IA
    const nonJ = p.hand.filter((c) => !c.joker);
    const mates = nonJ.filter((c) => c.rank === top.rank).length;
    const neigh = nonJ.filter((c) => c.suit === top.suit && Math.abs(c.rank - top.rank) <= 1).length;
    const wants = level === "difficile" ? mates >= 2 || neigh >= 2 : mates >= 2;
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
    g.stock = g.discard.sort(() => Math.random() - 0.5);
    g.discard = t2 ? [t2] : [];
  }
  const penalty = g.stock.pop();
  p.hand.push(bought, penalty);
  p.buysLeft--;
  p.lastTaken = bought;
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
  const someoneCanBuy = Boolean(top) && !top.joker && room.players.some((p, i) =>
    i !== discarderIdx && i !== nextIdx && !p.isBot && p.connected && !p.absent && p.buysLeft > 0);
  if (!someoneCanBuy) {
    if (bBuyer != null) doBuy(room, bBuyer);
    advanceTurn(room, discarderIdx);
    return;
  }
  g.phase = "buyWindow";
  g.lastDiscarderIdx = discarderIdx;
  g.buyRequests = [];
  g.botBuyer = bBuyer;
  g.buyWindowUntil = Date.now() + BUY_WINDOW_MS;
  broadcast(room);
  room.buyTimer = setTimeout(() => resolveBuyWindow(room), BUY_WINDOW_MS);
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

function resolveBuyWindow(room) {
  const g = room.game;
  if (!g || g.phase !== "buyWindow") return;
  const n = room.players.length;
  const requests = [...new Set(g.buyRequests)];
  if (g.botBuyer != null && !requests.includes(g.botBuyer)) requests.push(g.botBuyer);
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
  log(room, `${p.name} gagne la manche !`);
}

// ---------- Tour complet joué par l'IA (bots, absents, déconnectés) ----------
function aiPlayTurn(room) {
  const g = room.game;
  if (!g || g.roundOver || room.state !== "playing") return;
  const idx = g.turn;
  const p = room.players[idx];
  const contract = E.MANCHES[g.mancheIdx];
  const level = room.options.level;

  // Piocher ou prendre
  const top = g.discard[g.discard.length - 1];
  const mates = top && !top.joker ? p.hand.filter((c) => !c.joker && c.rank === top.rank).length : 0;
  const neigh = top && !top.joker ? p.hand.filter((c) => !c.joker && c.suit === top.suit && Math.abs(c.rank - top.rank) <= 1).length : 0;
  const wantsTake = level === "facile" ? false : level === "difficile" ? Boolean(top && !top.joker && (mates >= 2 || neigh >= 2)) : Boolean(top && !top.joker && mates >= 2);
  if (wantsTake) {
    const card = g.discard.pop();
    p.hand.push(card);
    p.lastTaken = card;
    g.phase = "play";
    log(room, `${p.name} prend ${E.cardName(card)} dans la défausse`);
    io.to(room.code).emit("fx", { kind: "take", idx, card });
  } else {
    drawFromStock(room, idx);
    log(room, `${p.name} pioche une carte`);
  }

  // Poser
  if (!p.posed) {
    const plan = contract.poseTout ? E.aiPlanFullHand(p.hand) : E.aiPlanContract(p.hand, contract, level);
    const planOk = plan && (!contract.poseTout || plan.reduce((s, m) => s + m.cards.length, 0) === p.hand.length);
    if (planOk) {
      plan.forEach((m, i) => g.melds.push({ id: Date.now() + idx * 100 + i, type: m.type, cards: E.normMeld(m.type, m.cards), owner: idx }));
      const usedIds = new Set(plan.flatMap((m) => m.cards.map((c) => c.id)));
      p.hand = p.hand.filter((c) => !usedIds.has(c.id));
      p.posed = true;
      p.justPosed = true;
      log(room, `${p.name} pose son contrat !`);
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
  const toss = E.aiDiscardChoice(p.hand, level);
  doDiscard(room, idx, toss.id, false);
  broadcast(room);
}

// ---------- Socket.io ----------
io.on("connection", (socket) => {
  let myRoom = null;
  let myToken = null;

  const findMe = () => {
    if (!myRoom) return null;
    const idx = myRoom.players.findIndex((p) => p.token === myToken);
    return idx >= 0 ? { idx, p: myRoom.players[idx] } : null;
  };

  socket.on("createRoom", ({ name, options }, cb) => {
    const room = createRoom(name, options);
    const player = addPlayer(room, name, false);
    player.socketId = socket.id;
    player.connected = true;
    myRoom = room; myToken = player.token;
    socket.join(room.code);
    touch(room);
    cb({ ok: true, code: room.code, token: player.token });
    broadcast(room);
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb({ ok: false, error: "Salon introuvable. Vérifie le code." });
    if (room.state !== "lobby") return cb({ ok: false, error: "La partie a déjà commencé (utilise « Reprendre » si tu en faisais partie)." });
    if (room.players.length >= 6) return cb({ ok: false, error: "Salon complet (6 joueurs max)." });
    const player = addPlayer(room, name, false);
    player.socketId = socket.id;
    player.connected = true;
    myRoom = room; myToken = player.token;
    socket.join(room.code);
    touch(room);
    cb({ ok: true, code: room.code, token: player.token });
    broadcast(room);
  });

  socket.on("rejoin", ({ code, token }, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb({ ok: false, error: "Ce salon n'existe plus." });
    const player = room.players.find((p) => p.token === token);
    if (!player) return cb({ ok: false, error: "Joueur inconnu dans ce salon." });
    player.socketId = socket.id;
    player.connected = true;
    player.absent = false;
    player.timeouts = 0;
    myRoom = room; myToken = token;
    socket.join(room.code);
    touch(room);
    if (room.game) log(room, `${player.name} est de retour !`);
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
    if (!me || me.idx !== 0) return;
    touch(myRoom);
    startRound(myRoom, myRoom.game.mancheIdx + 1);
  });

  socket.on("action", (a) => {
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
    if (myRoom.game && myRoom.state === "playing" && myRoom.game.turn === me.idx) {
      clearTimeout(myRoom.turnTimer);
      myRoom.aiTimer = setTimeout(() => aiPlayTurn(myRoom), AI_DELAY_MS);
    }
    broadcast(myRoom);
  });

  socket.on("disconnect", () => {
    if (!myRoom) return;
    const me = findMe();
    if (!me) return;
    me.p.connected = false;
    me.p.socketId = null;
    if (myRoom.state === "playing") {
      log(myRoom, `${me.p.name} est déconnecté — l'IA joue à sa place en attendant son retour`);
      if (myRoom.game.turn === me.idx && !myRoom.game.roundOver) {
        clearTimeout(myRoom.turnTimer);
        myRoom.aiTimer = setTimeout(() => aiPlayTurn(myRoom), AI_DELAY_MS);
      }
    }
    broadcast(myRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Serveur Rami Royal sur le port " + PORT));
