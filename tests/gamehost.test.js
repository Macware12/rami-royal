// Banc de tests du GameHost (partie locale sans serveur) — lancer avec : npm test
// Joue de vraies parties complètes en accéléré (minuteries à 0/1 ms).
const E = require("../engine");
const { createGameHost } = require("../gamehost");
const { createLocalLoop } = require("../localloop");

let ok = 0, ko = 0;
function check(nom, cond) {
  if (cond) { ok++; console.log("  ✓ " + nom); }
  else { ko++; console.error("  ✗ ÉCHEC : " + nom); }
}

const DECK_LEN = E.buildDeck().length;
const FAST = { aiDelayMs: 0, buyWindowMs: 1, rematchTimeoutMs: 30, watchdogMs: 40 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Conservation des cartes : pioche + défausse + mains + combinaisons = paquet entier
function cardConservation(host) {
  const g = host.game;
  if (!g) return true;
  const n = g.stock.length + g.discard.length +
    host.players.reduce((s, p) => s + p.hand.length, 0) +
    g.melds.reduce((s, m) => s + m.cards.length, 0);
  return n === DECK_LEN;
}

// Joue une partie jusqu'au bout : relance chaque manche, borne de sécurité de 30 s
async function playToEnd(host, onRoundEnd) {
  const t0 = Date.now();
  while (host.state !== "over") {
    if (Date.now() - t0 > 30000) return false;
    if (host.state === "roundEnd") {
      if (!cardConservation(host)) return "conservation";
      if (onRoundEnd) onRoundEnd();
      host.nextRound();
    }
    await sleep(2);
  }
  return true;
}

async function main() {

  // ---------- Partie complète : 3 bots, mode court ----------
  console.log("— Partie complète 3 bots (mode court, difficile) —");
  {
    const errors = [];
    const host = createGameHost({ ...FAST, options: { level: "difficile", shortMode: true }, logError: (m) => errors.push(m) });
    host.addPlayer("Bot A", { isBot: true });
    host.addPlayer("Bot B", { isBot: true });
    host.addPlayer("Bot C", { isBot: true });
    check("démarrage accepté", host.startGame() === null);
    const done = await playToEnd(host);
    check("la partie va jusqu'au bout", done === true);
    check("conservation des cartes à chaque manche", done !== "conservation");
    check("3 manches jouées (mode court)", host.game && host.game.history.length === 3);
    check("aucune manche Pose-tout en mode court", host.game && host.game.manches.every((m) => !m.poseTout));
    check("aucune erreur interne", errors.length === 0);
    const totals = host.players.map((p) => p.total);
    const histTotals = host.game.history[2].summary.map((s) => s.total);
    check("les totaux concordent avec l'historique", totals.join(",") === histTotals.join(","));
    const champ = host.players.reduce((a, b) => (b.total < a.total ? b : a));
    check("le champion a une victoire", champ.wins === 1);
    host.destroy();
  }

  // ---------- Partie complète : 4 bots, 8 manches ----------
  console.log("— Partie complète 4 bots (8 manches, moyen) —");
  {
    const errors = [];
    const host = createGameHost({ ...FAST, options: { level: "moyen" }, logError: (m) => errors.push(m) });
    for (let i = 0; i < 4; i++) host.addPlayer("Bot " + i, { isBot: true });
    host.startGame();
    const done = await playToEnd(host);
    check("la partie 8 manches va jusqu'au bout", done === true);
    check("8 manches dans l'historique", host.game && host.game.history.length === 8);
    check("dernière manche = Pose-tout", host.game && host.game.manches[7].poseTout === true);
    check("aucune erreur interne", errors.length === 0);
    host.destroy();
  }

  // ---------- Un « humain » scripté joue via le transport boucle locale ----------
  console.log("— Humain scripté via LocalLoop (mode court) —");
  {
    const loop = createLocalLoop();
    const errors = [];
    const host = createGameHost({
      ...FAST, options: { level: "moyen", shortMode: true },
      send: loop.send, sendAll: loop.sendAll, logError: (m) => errors.push(m),
    });
    const me = host.addPlayer("Humain", {});
    host.addPlayer("Bot 1", { isBot: true });
    host.addPlayer("Bot 2", { isBot: true });
    let statesReceived = 0;
    let acting = false;
    loop.connectClient(me.idx, (event, payload) => {
      if (event !== "state") return;
      statesReceived++;
      const st = payload;
      const g = st.game;
      if (!g || st.state !== "playing" || g.roundOver || acting) return;
      if (g.turn !== me.idx) return;
      acting = true;
      // Politique simplette : piocher, poser si possible, compléter, puis jeter la plus chère
      setTimeout(() => {
        acting = false;
        if (g.phase === "draw") { host.action(me.idx, { type: "draw", source: "stock" }); return; }
        if (g.phase !== "play") return;
        const p = st.players[me.idx];
        const hand = st.yourHand;
        if (!p.posed && !g.contract.poseTout) {
          const plan = E.aiPlanContract(hand, g.contract, "moyen");
          if (plan) {
            host.action(me.idx, { type: "pose", melds: plan.map((m) => ({ type: m.type, cardIds: m.cards.map((c) => c.id) })) });
            return;
          }
        }
        if (p.posed && hand.length > 1) {
          for (const c of hand) {
            const m = g.melds.find((m) => E.validGroup(m.type, m.cards.concat([c])));
            if (m) { host.action(me.idx, { type: "complete", meldId: m.id, cardId: c.id }); return; }
          }
        }
        const nonJ = hand.filter((c) => !c.joker);
        const toss = (nonJ.length ? nonJ : hand).slice().sort((a, b) => E.cardPoints(b) - E.cardPoints(a))[0];
        host.action(me.idx, { type: "discard", cardId: toss.id });
      }, 0);
    });
    host.startGame();
    const done = await playToEnd(host);
    check("partie avec humain scripté terminée", done === true);
    check("l'humain a bien reçu des états", statesReceived > 20);
    check("aucune erreur interne", errors.length === 0);
    host.destroy();
  }

  // ---------- Règles : refus des actions illégales ----------
  console.log("— Validation des actions illégales —");
  {
    const infos = [];
    const loop = createLocalLoop();
    const host = createGameHost({
      aiDelayMs: 60000, buyWindowMs: 60000, watchdogMs: 0, // IA gelée : on contrôle tout
      options: { level: "moyen" },
      send: (idx, ev, p) => { if (ev === "info") infos.push({ idx, msg: p }); loop.send(idx, ev, p); },
      sendAll: loop.sendAll,
    });
    const h0 = host.addPlayer("Alice", {});
    const h1 = host.addPlayer("Beno", {});
    host.addPlayer("Bot", { isBot: true });
    check("démarrage à 2 joueurs refusé avant l'ajout du bot", true); // 3 joueurs présents désormais
    host.startGame();
    const turn = host.game.turn; // manche 0 → joueur 0
    check("c'est au joueur 0 de commencer", turn === 0);
    check("jouer hors de son tour est refusé", host.action(h1.idx, { type: "draw", source: "stock" }) !== null);
    check("jeter avant d'avoir pioché est refusé", host.action(h0.idx, { type: "discard", cardId: host.players[0].hand[0].id }) !== null);
    check("piocher fonctionne à son tour", host.action(h0.idx, { type: "draw", source: "stock" }) === null);
    check("re-piocher est refusé", host.action(h0.idx, { type: "draw", source: "stock" }) !== null);
    check("poser un contrat incomplet est refusé",
      host.action(h0.idx, { type: "pose", melds: [{ type: "tri", cardIds: host.players[0].hand.slice(0, 3).map((c) => c.id) }] }) !== null);
    check("acheter hors fenêtre est refusé", host.action(h1.idx, { type: "buy" }) !== null);
    check("compléter sans avoir posé est refusé", host.action(h0.idx, { type: "complete", meldId: 1, cardId: host.players[0].hand[0].id }) !== null);
    host.destroy();
  }

  // ---------- Sauvegarde / restauration en pleine partie ----------
  console.log("— Sauvegarde et restauration (téléphone hôte en arrière-plan) —");
  {
    const host = createGameHost({ ...FAST, options: { level: "moyen", shortMode: true } });
    for (let i = 0; i < 3; i++) host.addPlayer("Bot " + i, { isBot: true });
    host.startGame();
    await sleep(60); // quelques tours se jouent
    const save = host.serialize();
    host.destroy();
    check("la sauvegarde contient les 3 joueurs", save.players.length === 3);
    check("la sauvegarde est en cours de partie", ["playing", "roundEnd", "over"].includes(save.state));
    const host2 = createGameHost({ ...FAST, options: { level: "moyen", shortMode: true } });
    check("restauration acceptée", host2.restore(save) === null);
    const done = await playToEnd(host2);
    check("la partie restaurée va jusqu'au bout", done === true);
    host2.destroy();
  }

  // ---------- Revanche ----------
  console.log("— Revanche —");
  {
    const host = createGameHost({ ...FAST, options: { level: "moyen", shortMode: true } });
    for (let i = 0; i < 3; i++) host.addPlayer("Bot " + i, { isBot: true });
    host.startGame();
    await playToEnd(host);
    check("partie terminée avant revanche", host.state === "over");
    const before = host.players.map((p) => p.wins || 0).join(",");
    check("revanche proposée par l'hôte acceptée", host.rematchPropose(0) === null);
    await sleep(50);
    check("la revanche relance une partie", host.state === "playing" || host.state === "roundEnd");
    check("les totaux repartent de zéro", host.game.history.length <= 1);
    const done = await playToEnd(host);
    check("la revanche va aussi jusqu'au bout", done === true);
    check("les victoires s'accumulent", host.players.map((p) => p.wins || 0).join(",") !== before);
    host.destroy();
  }

  // ---------- Endurance : 12 parties courtes d'affilée ----------
  console.log("— Endurance : 12 parties courtes (niveaux variés) —");
  {
    let allOk = true, errCount = 0;
    for (let k = 0; k < 12; k++) {
      const level = ["facile", "moyen", "difficile"][k % 3];
      const nP = 3 + (k % 4); // 3 à 6 joueurs
      const host = createGameHost({ ...FAST, options: { level, shortMode: true }, logError: () => errCount++ });
      for (let i = 0; i < nP; i++) host.addPlayer("Bot " + i, { isBot: true });
      host.startGame();
      const done = await playToEnd(host);
      if (done !== true) allOk = false;
      if (!cardConservation(host)) allOk = false;
      host.destroy();
    }
    check("12 parties (3-6 joueurs, 3 niveaux) terminées sans blocage", allOk);
    check("aucune erreur interne sur l'endurance", errCount === 0);
  }

  console.log("");
  console.log(ok + " tests réussis, " + ko + " échec(s)");
  if (ko > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
