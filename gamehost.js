// =====================================================================
// GameHost — le « serveur de partie » portable de Ramy Gasy
// ---------------------------------------------------------------------
// Toute la logique multijoueur (manches, tours, achats, pose, scores,
// IA, revanche) SANS aucune dépendance réseau. Le transport (socket.io,
// Bluetooth/Multipeer, boucle locale de test) est branché de l'extérieur
// via deux fonctions : send(idx, event, payload) et sendAll(event, payload).
//
// Utilisable :
//   - dans Node (tests, et à terme server.js)          → require("./gamehost")
//   - dans le navigateur (téléphone hôte, hors-ligne)  → window.RamyGameHost
//
// Événements émis vers le transport :
//   send(idx, "state", {...})   état personnalisé (main privée du joueur idx)
//   send(idx, "info", "...")    message d'information ciblé
//   send(idx, "kicked", "...")  le joueur est retiré du salon
//   sendAll("fx", {...})        effets sonores/visuels (draw, take, pose, buy…)
//   sendAll("gameOver")         partie terminée (après la dernière manche)
// =====================================================================

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./engine"));
  else root.RamyGameHost = factory(root.RamyEngine);
})(typeof self !== "undefined" ? self : this, function (E) {
  "use strict";

  const AVATARS_POOL = ["🦁", "🐯", "🦊", "🐼", "🐸", "🦉", "🐙", "🦜", "🐢", "🦎"];

  function createGameHost(deps) {
    deps = deps || {};
    const send = deps.send || function () {};
    const sendAll = deps.sendAll || function () {};
    const options = {
      turnSeconds: [45, 60, 90].includes(deps.options && deps.options.turnSeconds) ? deps.options.turnSeconds : 45,
      level: ["facile", "moyen", "difficile"].includes(deps.options && deps.options.level) ? deps.options.level : "moyen",
      shortMode: Boolean(deps.options && deps.options.shortMode),
    };
    // Rythmes surchargeables (les tests passent 0/1 ms pour jouer des parties en un éclair)
    const AI_DELAY_MS = deps.aiDelayMs != null ? deps.aiDelayMs : 1400;
    const BUY_WINDOW_MS = deps.buyWindowMs != null ? deps.buyWindowMs : 5000;
    const REMATCH_TIMEOUT_MS = deps.rematchTimeoutMs != null ? deps.rematchTimeoutMs : 30000;
    const WATCHDOG_MS = deps.watchdogMs != null ? deps.watchdogMs : 10000;
    const logError = deps.logError || function (m) { if (typeof console !== "undefined") console.error(m); };

    function safeRun(fn) { try { fn(); } catch (e) { logError("Erreur minuterie GameHost: " + ((e && e.stack) || e)); } }

    // ---------- Le « salon » local ----------
    const room = {
      state: "lobby", // lobby | playing | roundEnd | over
      options,
      players: [],
      game: null,
      startedAt: null,
      rematch: null,
      turnTimer: null, buyTimer: null, aiTimer: null, rematchTimer: null,
    };

    function contratCourant(g) { return (g.manches || E.MANCHES)[g.mancheIdx]; }

    function sanitizeName(n) {
      return String(n || "").replace(/[<>\u0000-\u001f\u007f]/g, "").trim().slice(0, 14) || "Joueur";
    }

    function freeAvatar(wanted) {
      const used = room.players.map((p) => p.avatar);
      if (wanted && AVATARS_POOL.includes(wanted) && !used.includes(wanted)) return wanted;
      return AVATARS_POOL.find((a) => !used.includes(a)) || "🙂";
    }

    function addPlayer(name, opts) {
      opts = opts || {};
      if (room.state !== "lobby") return { error: "La partie a déjà commencé." };
      if (room.players.length >= 6) return { error: "Salon complet (6 joueurs max)." };
      const player = {
        name: sanitizeName(name), isBot: Boolean(opts.isBot),
        avatar: freeAvatar(opts.avatar),
        connected: true, absent: false, timeouts: 0,
        hand: [], posed: false, buysLeft: E.MAX_ACHATS, lastTaken: null, total: 0, justPosed: false,
      };
      room.players.push(player);
      broadcast();
      return { idx: room.players.length - 1 };
    }

    function removePlayer(targetIdx) {
      if (room.state !== "lobby") return "La partie a déjà commencé.";
      const i = Number(targetIdx);
      if (!Number.isInteger(i) || i <= 0 || i >= room.players.length) return "Joueur introuvable.";
      const target = room.players[i];
      if (!target.isBot) send(i, "kicked", "L'hôte t'a retiré du salon.");
      room.players.splice(i, 1);
      broadcast();
      return null;
    }

    function clearTimers() {
      clearTimeout(room.turnTimer); clearTimeout(room.buyTimer);
      clearTimeout(room.aiTimer); clearTimeout(room.rematchTimer);
      room.turnTimer = room.buyTimer = room.aiTimer = room.rematchTimer = null;
    }

    // ---------- Démarrage d'une manche ----------
    function startRound(mancheIdx) {
      if (mancheIdx === 0) room.startedAt = Date.now();
      const deck = E.buildDeck();
      room.players.forEach((p) => {
        p.hand = deck.splice(0, 13);
        p.posed = false; p.buysLeft = E.MAX_ACHATS; p.lastTaken = null; p.justPosed = false; p.timeouts = 0;
      });
      let manchesFinales = room.game && room.game.manches;
      if (!manchesFinales) {
        if (room.options.shortMode) {
          const indices = [];
          for (let i = 0; i < 7; i++) indices.push(i); // exclut 7 = Pose-tout
          manchesFinales = [];
          for (let i = 0; i < 3 && indices.length > 0; i++) {
            const k = Math.floor(Math.random() * indices.length);
            manchesFinales.push(E.MANCHES[indices[k]]);
            indices.splice(k, 1);
          }
        } else {
          manchesFinales = E.MANCHES;
        }
      }
      room.game = {
        mancheIdx,
        stock: deck,
        discard: [deck.pop()],
        melds: [],
        turn: mancheIdx % room.players.length,
        phase: "draw",
        buyRequests: [],
        lastDiscarderIdx: null,
        history: room.game ? room.game.history : [],
        log: ["— Manche " + (mancheIdx + 1) + " : " + manchesFinales[mancheIdx].label + " —"],
        turnDeadline: null,
        roundOver: null,
        shortMode: room.options.shortMode,
        manches: manchesFinales,
      };
      room.state = "playing";
      log("La manche " + (mancheIdx + 1) + " commence (contrat : " + manchesFinales[mancheIdx].label + ")");
      startTurn();
    }

    function log(text) {
      if (!room.game) return;
      room.game.log = room.game.log.slice(-60).concat([text]);
    }

    // ---------- État personnalisé envoyé à chaque joueur ----------
    function publicPlayer(p, idx) {
      return {
        idx, name: p.name, isBot: p.isBot, connected: p.connected, absent: p.absent,
        handCount: p.hand.length, posed: p.posed, buysLeft: p.buysLeft,
        lastTaken: p.lastTaken, total: p.total, wins: p.wins || 0, avatar: p.avatar,
      };
    }

    function stateFor(idx) {
      const g = room.game;
      const p = room.players[idx];
      return {
        serverNow: Date.now(),
        state: room.state,
        options: room.options,
        rematch: room.rematch ? { accepted: room.rematch.accepted, declined: room.rematch.declined } : null,
        youIdx: idx,
        yourHand: p ? p.hand : [],
        players: room.players.map(publicPlayer),
        game: g ? {
          mancheIdx: g.mancheIdx,
          contract: contratCourant(g),
          nbManches: (g.manches || E.MANCHES).length,
          startedAt: room.startedAt || null,
          serverNow: Date.now(),
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
      };
    }

    function broadcast() {
      room.players.forEach((p, idx) => {
        if (p.isBot || !p.connected) return;
        send(idx, "state", stateFor(idx));
      });
    }

    // Manche insolvable : la pioche a été recyclée 3 fois sans vainqueur (les cartes restantes
    // ne complètent plus rien). Règle « pioche épuisée » : la main la plus légère gagne la manche.
    function endStalemate() {
      const g = room.game;
      if (!g || g.roundOver) return;
      clearTimers();
      let winnerIdx = 0, bestPts = Infinity;
      room.players.forEach((q, i) => {
        const pts = E.handPoints(q.hand);
        if (pts < bestPts) { bestPts = pts; winnerIdx = i; }
      });
      const summary = room.players.map((q, i) => {
        const pts = i === winnerIdx ? 0 : E.handPoints(q.hand);
        q.total += pts;
        return { name: q.name, pts, bonus: 0, total: q.total };
      });
      g.history.push({ mancheIdx: g.mancheIdx, label: contratCourant(g).label, summary });
      g.roundOver = { winnerIdx, bonusType: null, epuise: true, summary };
      const manches = g.manches || E.MANCHES;
      room.state = g.mancheIdx + 1 >= manches.length ? "over" : "roundEnd";
      log("🔚 Pioche épuisée 3 fois : fin de manche — la main la plus légère (" + room.players[winnerIdx].name + ") l'emporte");
      if (room.state === "over") {
        const champ = room.players.reduce((a, b) => (b.total < a.total ? b : a));
        champ.wins = (champ.wins || 0) + 1;
        log("👑 " + champ.name + " remporte la partie !");
        sendAll("gameOver", { winnerName: champ.name });
      }
      broadcast();
    }

    // ---------- Gestion des tours et du minuteur ----------
    function startTurn() {
      const g = room.game;
      if ((g.recycles || 0) >= 3) { endStalemate(); return; }
      g.phase = "draw";
      g.turnDeadline = Date.now() + room.options.turnSeconds * 1000;
      clearTimeout(room.turnTimer);
      const p = room.players[g.turn];
      if (p.isBot || p.absent || !p.connected) {
        clearTimeout(room.aiTimer);
        room.aiTimer = setTimeout(() => safeRun(aiPlayTurn), AI_DELAY_MS);
      } else {
        clearTimeout(room.aiTimer);
        room.turnTimer = setTimeout(() => safeRun(onTurnTimeout), room.options.turnSeconds * 1000);
      }
      broadcast();
    }

    function onTurnTimeout() {
      const g = room.game;
      if (!g || g.roundOver || room.state !== "playing") return;
      const p = room.players[g.turn];
      p.timeouts++;
      log("⏱ Temps écoulé pour " + p.name + " — jeu automatique");
      if (p.timeouts >= 3 && !p.absent) {
        p.absent = true;
        log(p.name + " est passé en mode automatique (3 temps écoulés). Il peut reprendre la main à tout moment.");
      }
      if (g.phase === "draw") drawFromStock(g.turn);
      if (!g.roundOver) {
        const toss = E.aiDiscardChoice(room.players[g.turn].hand, "moyen");
        doDiscard(g.turn, toss.id, true);
      }
    }

    function shuffleInPlace(a) {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    }

    function drawFromStock(idx) {
      const g = room.game;
      if (g.stock.length === 0) {
        const top = g.discard.pop();
        g.stock = shuffleInPlace(g.discard);
        g.discard = top ? [top] : [];
        g.recycles = (g.recycles || 0) + 1; // compteur anti-manche-infinie
      }
      const card = g.stock.pop();
      if (card) room.players[idx].hand.push(card);
      g.phase = "play";
      sendAll("fx", { kind: "draw", source: "stock", idx });
      return card || null;
    }

    // ---------- Actions des joueurs ----------
    function handleDraw(idx, source) {
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
        g.takenCards = (g.takenCards || []).concat([{ idx, card }]);
        g.phase = "play";
        log(p.name + " prend " + E.cardName(card) + " dans la défausse");
        sendAll("fx", { kind: "take", idx, card });
      } else {
        drawFromStock(idx);
        log(p.name + " pioche une carte");
      }
      broadcast();
      return null;
    }

    function handlePose(idx, meldsSpec) {
      const g = room.game;
      const p = room.players[idx];
      const contract = contratCourant(g);
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
        if (!E.validGroup(spec.type, cards)) return "Un " + (spec.type === "tri" ? "tri" : "escalier") + " proposé est invalide.";
        builtMelds.push({ type: spec.type, cards });
      }
      const triCount = builtMelds.filter((m) => m.type === "tri").length;
      const escCount = builtMelds.filter((m) => m.type === "esc").length;
      if (contract.poseTout) {
        if (usedIds.size !== p.hand.length) return "Au pose-tout, toutes tes cartes doivent être posées d'un coup.";
      } else {
        if (triCount < contract.tri || escCount < contract.esc)
          return "Contrat incomplet : il faut " + contract.label + ".";
      }
      builtMelds.forEach((m, i) => g.melds.push({ id: Date.now() + idx * 100 + i, type: m.type, cards: E.normMeld(m.type, m.cards), owner: idx }));
      p.hand = p.hand.filter((c) => !usedIds.has(c.id));
      p.posed = true;
      p.justPosed = true;
      p.timeouts = 0;
      log(p.name + " pose son contrat !");
      sendAll("fx", { kind: "pose", idx });
      checkRoundEnd(idx);
      broadcast();
      return null;
    }

    function handleComplete(idx, meldId, cardId) {
      const g = room.game;
      const p = room.players[idx];
      if (room.state !== "playing" || g.roundOver) return "La partie n'est pas en cours.";
      if (g.turn !== idx || g.phase !== "play") return "Tu ne peux pas compléter maintenant.";
      if (!p.posed) return "Pose d'abord ton contrat.";
      if (contratCourant(g).poseTout) return "Pas de complétion à la manche du pose-tout.";
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
            log(p.name + " échange " + E.cardName(card) + " contre un Joker !");
            sendAll("fx", { kind: "exchange", idx });
            broadcast();
            return null;
          }
        }
      }
      if (!E.validGroup(meld.type, meld.cards.concat([card]))) return "Cette carte ne complète pas cette combinaison.";
      meld.cards = E.normMeld(meld.type, meld.cards.concat([card]));
      p.hand = p.hand.filter((c) => c.id !== cardId);
      p.timeouts = 0;
      log(p.name + " complète avec " + E.cardName(card));
      checkRoundEnd(idx);
      broadcast();
      return null;
    }

    function doDiscard(idx, cardId, auto) {
      const g = room.game;
      const p = room.players[idx];
      const card = p.hand.find((c) => c.id === cardId);
      if (!card) return "Carte introuvable.";
      p.hand = p.hand.filter((c) => c.id !== cardId);
      g.discard.push(card);
      g.discardLocked = false;
      p.justPosed = p.justPosed && p.hand.length === 0;
      log(p.name + " jette " + E.cardName(card) + (auto ? " (auto)" : ""));
      sendAll("fx", { kind: "discard", idx, card });
      checkRoundEnd(idx);
      if (g.roundOver) { broadcast(); return null; }
      openBuyWindow(idx);
      return null;
    }

    function handleDiscard(idx, cardId) {
      const g = room.game;
      if (room.state !== "playing" || g.roundOver) return "La partie n'est pas en cours.";
      if (g.turn !== idx || g.phase !== "play") return "Tu ne peux pas jeter maintenant.";
      room.players[idx].timeouts = 0;
      return doDiscard(idx, cardId, false);
    }

    // ---------- Fenêtre d'achat ----------
    function hotForOpponents(top, takenCards, selfIdx, players) {
      if (!top || top.joker) return 0;
      const byPlayer = {};
      (takenCards || []).forEach((t) => {
        if (t.idx === selfIdx || !t.card) return;
        if (players && players[t.idx] && players[t.idx].posed) return;
        (byPlayer[t.idx] = byPlayer[t.idx] || []).push(t.card);
      });
      let best = 0;
      Object.keys(byPlayer).forEach((k) => {
        let s = 0;
        byPlayer[k].forEach((c) => {
          if (c.joker) return;
          const dd = Math.min(Math.abs(c.rank - top.rank), 13 - Math.abs(c.rank - top.rank));
          if (c.rank === top.rank) s += 3;
          if (c.suit === top.suit && dd <= 2) s += 2;
        });
        best = Math.max(best, s);
      });
      return best;
    }

    function wantsTop(p, top, level, contract) {
      if (!top || top.joker || level === "facile") return false;
      if (p.posed) return false;
      const nonJ = p.hand.filter((c) => !c.joker);
      const mates = nonJ.filter((c) => c.rank === top.rank).length;
      const neigh = nonJ.filter((c) => c.suit === top.suit && Math.abs(c.rank - top.rank) <= 1).length;
      if (level !== "difficile") return mates >= 2 || neigh >= 2;
      const wantTri = !contract || (contract.tri || 0) > 0 || contract.poseTout;
      const wantEsc = !contract || (contract.esc || 0) > 0 || contract.poseTout;
      if ((wantTri && mates >= 2) || (wantEsc && neigh >= 2)) return true;
      if (contract && !contract.poseTout) {
        return !E.aiPlanContract(p.hand, contract, level) && Boolean(E.aiPlanContract(p.hand.concat([top]), contract, level));
      }
      return false;
    }

    function botBuyer(discarderIdx, nextIdx) {
      const g = room.game;
      const top = g.discard[g.discard.length - 1];
      if (!top || top.joker) return null;
      const n = room.players.length;
      const level = room.options.level;
      if (level === "facile") return null;
      const contract = contratCourant(g);
      let best = null, bestD = 99;
      room.players.forEach((p, i) => {
        if (i === discarderIdx || i === nextIdx || p.buysLeft <= 0 || p.posed) return;
        if (!(p.isBot || p.absent || !p.connected)) return;
        const wants = level === "difficile"
          ? (wantsTop(p, top, level, contract) ||
            (p.buysLeft >= 2 && hotForOpponents(top, g.takenCards, i, room.players) >= 5))
          : (p.hand.filter((c) => !c.joker && c.rank === top.rank).length >= 2 ||
             p.hand.filter((c) => !c.joker && c.suit === top.suit && Math.abs(c.rank - top.rank) <= 1).length >= 2);
        if (!wants) return;
        const d = (i - discarderIdx + n) % n;
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    }

    function doBuy(idx) {
      const g = room.game;
      if (g.discard.length === 0) return;
      const p = room.players[idx];
      const bought = g.discard.pop();
      if (g.stock.length === 0) {
        const t2 = g.discard.pop();
        g.stock = shuffleInPlace(g.discard);
        g.discard = t2 ? [t2] : [];
        g.recycles = (g.recycles || 0) + 1; // compteur anti-manche-infinie
      }
      const penalty = g.stock.pop();
      p.hand.push(bought);
      if (penalty) p.hand.push(penalty);
      p.buysLeft--;
      p.lastTaken = bought;
      g.takenCards = (g.takenCards || []).concat([{ idx, card: bought }]);
      g.discardLocked = true;
      log(p.name + " achète " + E.cardName(bought) + " (+1 pénalité)");
      sendAll("fx", { kind: "buy", idx, card: bought });
    }

    function openBuyWindow(discarderIdx) {
      const g = room.game;
      clearTimeout(room.turnTimer);
      const n = room.players.length;
      const nextIdx = (discarderIdx + 1) % n;
      const top = g.discard[g.discard.length - 1];
      const bBuyer = botBuyer(discarderIdx, nextIdx);
      const nextP = room.players[nextIdx];
      const nextIsHuman = nextP && !nextP.isBot && nextP.connected && !nextP.absent;
      const someoneCanBuy = Boolean(top) && !top.joker && room.players.some((p, i) =>
        i !== discarderIdx && i !== nextIdx && !p.isBot && p.connected && !p.absent && p.buysLeft > 0);
      if (!someoneCanBuy && !(bBuyer != null && nextIsHuman)) {
        if (bBuyer != null && !(nextP && wantsTop(nextP, top, room.options.level, contratCourant(g)) && !nextIsHuman)) doBuy(bBuyer);
        advanceTurn(discarderIdx);
        return;
      }
      g.phase = "buyWindow";
      g.lastDiscarderIdx = discarderIdx;
      g.buyRequests = [];
      g.nextIdx = nextIdx;
      g.botBuyer = bBuyer;
      g.buyWindowUntil = Date.now() + BUY_WINDOW_MS;
      broadcast();
      room.buyTimer = setTimeout(() => safeRun(resolveBuyWindow), BUY_WINDOW_MS);
    }

    function handleBuyRequest(idx) {
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

    function resolveBuyWindow() {
      const g = room.game;
      if (!g || g.phase !== "buyWindow") return;
      const n = room.players.length;
      const requests = Array.from(new Set(g.buyRequests));
      if (g.botBuyer != null && !requests.includes(g.botBuyer)) requests.push(g.botBuyer);
      const nextP = g.nextIdx != null ? room.players[g.nextIdx] : null;
      const nextAIWants = nextP && (nextP.isBot || nextP.absent || !nextP.connected) &&
        wantsTop(nextP, g.discard[g.discard.length - 1], room.options.level, contratCourant(g));
      if (nextAIWants && requests.length > 0) {
        requests.forEach((i) => send(i, "info", nextP.name + " (joueur suivant) est prioritaire — achat annulé."));
        requests.length = 0;
      }
      if (requests.length > 0 && g.discard.length > 0) {
        const ordered = requests.sort((a, b) => ((a - g.lastDiscarderIdx + n) % n) - ((b - g.lastDiscarderIdx + n) % n));
        const winnerIdx = ordered[0];
        doBuy(winnerIdx);
        ordered.slice(1).forEach((i) => send(i, "info", room.players[winnerIdx].name + " était mieux placé dans le sens du jeu — achat manqué."));
      }
      g.botBuyer = null;
      advanceTurn(g.lastDiscarderIdx);
    }

    // Le joueur suivant fait valoir sa priorité pendant la fenêtre d'achat
    function claimNext(idx) {
      const g = room.game;
      if (!g || g.phase !== "buyWindow" || idx !== g.nextIdx) return "Tu n'es pas prioritaire en ce moment.";
      const top = g.discard[g.discard.length - 1];
      if (!top || top.joker) return "Impossible de récupérer un joker jeté.";
      clearTimeout(room.buyTimer);
      const p = room.players[idx];
      const card = g.discard.pop();
      p.hand.push(card);
      p.lastTaken = card;
      p.timeouts = 0;
      g.buyRequests.forEach((i) => send(i, "info", p.name + " a fait valoir sa priorité de joueur suivant — achat annulé."));
      g.botBuyer = null;
      g.turn = g.nextIdx;
      g.phase = "play";
      g.turnDeadline = Date.now() + room.options.turnSeconds * 1000;
      clearTimeout(room.turnTimer);
      room.turnTimer = setTimeout(() => safeRun(onTurnTimeout), room.options.turnSeconds * 1000);
      log(p.name + " prend " + E.cardName(card) + " (prioritaire)");
      sendAll("fx", { kind: "take", idx, card });
      broadcast();
      return null;
    }

    function passNext(idx) {
      const g = room.game;
      if (!g || g.phase !== "buyWindow" || idx !== g.nextIdx) return "Tu n'es pas prioritaire en ce moment.";
      clearTimeout(room.buyTimer);
      resolveBuyWindow();
      return null;
    }

    function advanceTurn(fromIdx) {
      const g = room.game;
      g.buyRequests = [];
      g.turn = (fromIdx + 1) % room.players.length;
      room.players.forEach((p) => { p.justPosed = false; });
      startTurn();
    }

    // ---------- Fin de manche et scores ----------
    function checkRoundEnd(idx) {
      const g = room.game;
      const p = room.players[idx];
      if (p.hand.length > 0 || g.roundOver) return;
      clearTimers();
      const isFinal = contratCourant(g).poseTout;
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
      g.history.push({ mancheIdx: g.mancheIdx, label: contratCourant(g).label, summary });
      g.roundOver = { winnerIdx: idx, bonusType, summary };
      const manches = g.manches || E.MANCHES;
      room.state = g.mancheIdx + 1 >= manches.length ? "over" : "roundEnd";
      if (room.state === "over") {
        const champ = room.players.reduce((a, b) => (b.total < a.total ? b : a));
        champ.wins = (champ.wins || 0) + 1;
        log("👑 " + champ.name + " remporte la partie !");
        sendAll("gameOver", { winnerName: champ.name });
      }
      log(p.name + " gagne la manche !");
    }

    // ---------- Tour complet joué par l'IA (bots, absents, déconnectés) ----------
    function aiPlayTurn() {
      const g = room.game;
      if (!g || g.roundOver || room.state !== "playing") return;
      if (g.phase === "buyWindow") return;
      const idx = g.turn;
      const p = room.players[idx];
      if (!p || !(p.isBot || p.absent || !p.connected)) return;
      const contract = contratCourant(g);
      const level = room.options.level;

      let tookNow = null;
      if (g.phase === "draw") {
        const top = g.discard[g.discard.length - 1];
        const mates = top && !top.joker ? p.hand.filter((c) => !c.joker && c.rank === top.rank).length : 0;
        const neigh = top && !top.joker ? p.hand.filter((c) => !c.joker && c.suit === top.suit && Math.abs(c.rank - top.rank) <= 1).length : 0;
        const fitsMeld = (card) => Boolean(card) && !card.joker && g.melds.some((m) => E.validGroup(m.type, m.cards.concat([card])));
        const wantsTake = g.discardLocked ? false
          : p.posed ? Boolean(level !== "facile" && !contract.poseTout && fitsMeld(top))
          : level === "facile" ? false
          : level === "difficile" ? (wantsTop(p, top, level, contract) ||
              (Boolean(top) && !top.joker && g.stock.length > room.players.length * 2 && p.hand.length <= 16 &&
                hotForOpponents(top, g.takenCards, idx, room.players) >= 3))
          : Boolean(top && !top.joker && (mates >= 2 || neigh >= 2));
        if (wantsTake) {
          const card = g.discard.pop();
          p.hand.push(card);
          p.lastTaken = card;
          tookNow = card;
          g.takenCards = (g.takenCards || []).concat([{ idx, card }]);
          g.phase = "play";
          log(p.name + " prend " + E.cardName(card) + " dans la défausse");
          sendAll("fx", { kind: "take", idx, card });
        } else {
          drawFromStock(idx);
          log(p.name + " pioche une carte");
        }
      }

      // Poser
      if (!p.posed) {
        const plan = contract.poseTout ? E.aiPlanFullHand(p.hand) : E.aiPlanContract(p.hand, contract, level);
        let planOk = plan && (!contract.poseTout || plan.reduce((s, m) => s + m.cards.length, 0) === p.hand.length);
        if (planOk && level === "difficile" && !contract.poseTout) {
          const othersPosed = room.players.some((q, i2) => i2 !== idx && q.posed);
          const minOpp = Math.min.apply(null, room.players.map((q, i2) => (i2 === idx ? 99 : q.hand.length)));
          const leftover = p.hand.length - plan.reduce((s, m) => s + m.cards.length, 0);
          const lowStock = g.stock.length < room.players.length * 4;
          if (!othersPosed && leftover > 3 && !lowStock && minOpp > 4) planOk = false;
        }
        if (planOk) {
          plan.forEach((m, i) => g.melds.push({ id: Date.now() + idx * 100 + i, type: m.type, cards: E.normMeld(m.type, m.cards), owner: idx }));
          const usedIds = new Set(plan.reduce((arr, m) => arr.concat(m.cards.map((c) => c.id)), []));
          p.hand = p.hand.filter((c) => !usedIds.has(c.id));
          p.posed = true;
          p.justPosed = true;
          log(p.name + " pose son contrat !");
        }
      }

      // Échange de joker (niveau difficile)
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
              log(p.name + " échange " + E.cardName(c) + " contre un Joker !");
              sendAll("fx", { kind: "exchange", idx });
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
            const m = g.melds.find((m) => (level !== "facile" || m.owner === idx) && E.validGroup(m.type, m.cards.concat([c])));
            if (m) {
              m.cards = E.normMeld(m.type, m.cards.concat([c]));
              p.hand = p.hand.filter((x) => x.id !== c.id);
              log(p.name + " complète avec " + E.cardName(c));
              changed = true;
              break;
            }
          }
        }
      }

      checkRoundEnd(idx);
      if (g.roundOver) { broadcast(); return; }

      // Jeter
      const nonJokers = p.hand.filter((c) => !c.joker);
      const endgame = g.stock.length <= room.players.length * 2 || room.players.some((q, i2) => i2 !== idx && q.hand.length <= 3);
      const jokerInHand = p.hand.find((c) => c.joker);
      const deadJoker = level === "difficile" && endgame && jokerInHand &&
        (p.posed || !E.aiPlanContract(p.hand, contract, level)) ? jokerInHand : null;
      let toss;
      if (deadJoker) {
        toss = deadJoker;
      } else if (p.posed && nonJokers.length > 0) {
        toss = nonJokers.slice().sort((a, b) => E.cardPoints(b) - E.cardPoints(a))[0];
      } else if (level === "difficile" && nonJokers.length > 0) {
        const othersTaken = (g.takenCards || []).filter((t) => t.idx !== idx).map((t) => t.card);
        const danger = (c) => {
          let d2 = 0;
          othersTaken.forEach((t) => {
            if (t.rank === c.rank) d2 += 4;
            if (t.suit === c.suit && Math.abs(t.rank - c.rank) <= 2) d2 += 3;
          });
          if (g.melds.some((m) => m.owner !== idx && E.validGroup(m.type, m.cards.concat([c])))) d2 += 14;
          return d2;
        };
        const wantTri = (contract.tri || 0) > 0 || contract.poseTout;
        const wantEsc = (contract.esc || 0) > 0 || contract.poseTout;
        const seen = {};
        const kk = (r, su) => ((((r - 1) % 13) + 13) % 13 + 1) + su;
        g.discard.forEach((c) => { if (!c.joker) seen[kk(c.rank, c.suit)] = (seen[kk(c.rank, c.suit)] || 0) + 1; });
        g.melds.forEach((m) => m.cards.forEach((c) => { if (!c.joker) seen[kk(c.rank, c.suit)] = (seen[kk(c.rank, c.suit)] || 0) + 1; }));
        const aliveS = (r, su) => Math.max(0, 2 - (seen[kk(r, su)] || 0));
        const usefulness = (c) => {
          const sameInHand = nonJokers.filter((o) => o.id !== c.id && o.rank === c.rank).length;
          const neighInHand = nonJokers.filter((o) => o.id !== c.id && o.suit === c.suit && Math.abs(o.rank - c.rank) <= 2).length;
          const rankAlive = ["♠", "♥", "♦", "♣"].reduce((n, su) => n + aliveS(c.rank, su), 0) - nonJokers.filter((o) => o.rank === c.rank).length;
          const escAlive = aliveS(c.rank - 1, c.suit) + aliveS(c.rank + 1, c.suit) + aliveS(c.rank - 2, c.suit) + aliveS(c.rank + 2, c.suit);
          const m2 = sameInHand >= 1 && rankAlive > 0 ? sameInHand : 0;
          const n2 = neighInHand >= 1 && escAlive > 0 ? neighInHand : 0;
          return m2 * (wantTri ? 4 : 1) + n2 * (wantEsc ? 3 : 1) - E.cardPoints(c) * 0.15;
        };
        const candidats = tookNow ? nonJokers.filter((c) => c.rank !== tookNow.rank) : nonJokers;
        toss = (candidats.length ? candidats : nonJokers).slice().sort((a, b) => (usefulness(a) + danger(a)) - (usefulness(b) + danger(b)))[0];
      } else {
        toss = E.aiDiscardChoice(p.hand, level);
      }
      doDiscard(idx, toss.id, false);
      broadcast();
    }

    // ---------- Revanche ----------
    function rematchPropose(idx) {
      if (room.state !== "over") return "La partie n'est pas terminée.";
      const host = room.players[0];
      const hostAway = !host || host.isBot || !host.connected;
      const firstActive = room.players.findIndex((p) => !p.isBot && p.connected);
      if (idx !== 0 && !(hostAway && idx === firstActive)) return "Seul l'hôte peut proposer la revanche.";
      if (room.rematch) return null;
      const accepted = [idx];
      room.players.forEach((p, i) => { if (i !== idx && (p.isBot || !p.connected)) accepted.push(i); });
      room.rematch = { accepted, declined: [] };
      log(room.players[idx].name + " propose une revanche !");
      clearTimeout(room.rematchTimer);
      room.rematchTimer = setTimeout(() => safeRun(() => resolveRematch(true)), REMATCH_TIMEOUT_MS);
      broadcast();
      maybeResolveRematch();
      return null;
    }

    function rematchVote(idx, yes) {
      if (room.state !== "over" || !room.rematch) return "Aucune revanche en cours.";
      const r = room.rematch;
      r.accepted = r.accepted.filter((i) => i !== idx);
      r.declined = r.declined.filter((i) => i !== idx);
      (yes ? r.accepted : r.declined).push(idx);
      broadcast();
      maybeResolveRematch();
      return null;
    }

    function maybeResolveRematch() {
      const r = room.rematch;
      if (!r) return;
      const allVoted = room.players.every((p, i) => r.accepted.includes(i) || r.declined.includes(i));
      if (allVoted) resolveRematch(false);
    }

    function resolveRematch(timedOut) {
      const r = room.rematch;
      if (!r) return;
      clearTimeout(room.rematchTimer);
      room.rematch = null;
      r.declined.forEach((i) => send(i, "kicked", "Tu as décliné la revanche — à la prochaine !"));
      room.players = room.players.filter((p, i) => !r.declined.includes(i));
      if (room.players.length === 0) return;
      room.players.forEach((p) => { p.total = 0; });
      if (room.players.length >= 3) {
        room.game = null;
        startRound(0);
        log("🔁 Revanche !" + (timedOut ? " (délai écoulé, les silencieux jouent quand même)" : ""));
        broadcast();
      } else {
        room.state = "lobby";
        room.game = null;
        broadcast();
      }
    }

    // ---------- Présence (un invité se déconnecte / revient) ----------
    function setConnected(idx, connected) {
      const p = room.players[idx];
      if (!p) return;
      p.connected = Boolean(connected);
      if (!connected) {
        if (room.state === "playing") {
          log(p.name + " est déconnecté — l'IA joue à sa place en attendant son retour");
          if (room.game && room.game.turn === idx && !room.game.roundOver && room.game.phase !== "buyWindow") {
            clearTimeout(room.turnTimer);
            clearTimeout(room.aiTimer);
            room.aiTimer = setTimeout(() => safeRun(aiPlayTurn), AI_DELAY_MS);
          }
        }
      } else {
        if (p.absent) { p.absent = false; p.timeouts = 0; log(p.name + " reprend la main"); }
        // Si l'IA s'apprêtait à jouer son tour, on lui rend la main
        if (room.game && room.state === "playing" && room.game.turn === idx && room.game.phase === "draw" && !room.game.roundOver) {
          clearTimeout(room.aiTimer);
          clearTimeout(room.turnTimer);
          room.game.turnDeadline = Date.now() + room.options.turnSeconds * 1000;
          room.turnTimer = setTimeout(() => safeRun(onTurnTimeout), room.options.turnSeconds * 1000);
        }
        if (room.game) log(p.name + " est de retour !");
      }
      broadcast();
    }

    // ---------- API publique ----------
    function action(idx, a) {
      if (!a || typeof a !== "object" || !room.game) return "Action invalide.";
      const p = room.players[idx];
      if (!p) return "Joueur inconnu.";
      if (p.absent && a.type !== "resume") {
        p.absent = false;
        log(p.name + " reprend la main");
      }
      let err = null;
      if (a.type === "draw") err = handleDraw(idx, a.source);
      else if (a.type === "pose") err = handlePose(idx, a.melds);
      else if (a.type === "complete") err = handleComplete(idx, a.meldId, a.cardId);
      else if (a.type === "discard") err = handleDiscard(idx, a.cardId);
      else if (a.type === "buy") { err = handleBuyRequest(idx); if (!err) send(idx, "info", "Demande d'achat enregistrée…"); }
      else if (a.type === "claimNext") err = claimNext(idx);
      else if (a.type === "passNext") err = passNext(idx);
      else if (a.type === "resume") { p.absent = false; p.timeouts = 0; log(p.name + " reprend la main"); broadcast(); }
      else err = "Action inconnue.";
      if (err) send(idx, "info", err);
      return err;
    }

    function startGame() {
      if (room.state !== "lobby") return "La partie a déjà commencé.";
      if (room.players.length < 3) return "Il faut au moins 3 joueurs (ajoute un bot si besoin).";
      startRound(0);
      return null;
    }

    function nextRound() {
      if (room.state !== "roundEnd") return "La manche n'est pas terminée.";
      startRound(room.game.mancheIdx + 1);
      return null;
    }

    // Chien de garde : si une partie reste figée (minuterie perdue), on la relance
    const watchdog = WATCHDOG_MS > 0 ? setInterval(() => {
      try {
        const g = room.game;
        if (!g || room.state !== "playing") return;
        const now = Date.now();
        if (g.phase === "buyWindow" && g.buyWindowUntil && now > g.buyWindowUntil + 3000) {
          safeRun(resolveBuyWindow);
        } else if (g.phase !== "buyWindow" && g.turnDeadline && now > g.turnDeadline + 6000) {
          const p = room.players[g.turn];
          if (p && (p.isBot || p.absent || !p.connected)) safeRun(aiPlayTurn);
          else safeRun(onTurnTimeout);
        }
      } catch (e) { logError("Erreur chien de garde GameHost: " + e); }
    }, WATCHDOG_MS) : null;

    function destroy() {
      clearTimers();
      if (watchdog) clearInterval(watchdog);
    }

    // Sauvegarde/restauration (app en arrière-plan sur le téléphone hôte)
    function serialize() {
      return JSON.parse(JSON.stringify({
        state: room.state, options: room.options, startedAt: room.startedAt,
        players: room.players, game: room.game,
      }));
    }
    function restore(data) {
      if (!data || !Array.isArray(data.players)) return "Sauvegarde invalide.";
      clearTimers();
      room.state = data.state || "lobby";
      room.startedAt = data.startedAt || null;
      room.players = data.players;
      room.game = data.game || null;
      room.rematch = null;
      if (room.state === "playing" && room.game && !room.game.roundOver) {
        if (room.game.phase === "buyWindow") safeRun(resolveBuyWindow);
        else {
          room.game.turnDeadline = Date.now() + room.options.turnSeconds * 1000;
          startTurn();
        }
      } else broadcast();
      return null;
    }

    return {
      addPlayer, removePlayer, startGame, nextRound, action,
      rematchPropose, rematchVote, setConnected,
      resync: (idx) => send(idx, "state", stateFor(idx)),
      stateFor, serialize, restore, destroy,
      get state() { return room.state; },
      get players() { return room.players; },
      get game() { return room.game; },
    };
  }

  return { createGameHost, AVATARS_POOL };
});
