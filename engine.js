// Moteur de règles du Rami Royal — partagé par le serveur (source de vérité)
const SUITS = ["♠", "♥", "♦", "♣"];
const MANCHES = [
  { label: "2 tri", tri: 2, esc: 0 },
  { label: "1 tri + 1 escalier", tri: 1, esc: 1 },
  { label: "2 escaliers", tri: 0, esc: 2 },
  { label: "3 tri", tri: 3, esc: 0 },
  { label: "2 tri + 1 escalier", tri: 2, esc: 1 },
  { label: "2 escaliers + 1 tri", tri: 1, esc: 2 },
  { label: "3 escaliers", tri: 0, esc: 3 },
  { label: "Pose-tout", tri: 0, esc: 0, poseTout: true },
];
const MAX_ACHATS = 3;

let CARD_ID = 0;
function buildDeck() {
  const deck = [];
  for (let d = 0; d < 2; d++)
    for (const suit of SUITS)
      for (let rank = 1; rank <= 13; rank++)
        deck.push({ id: ++CARD_ID, rank, suit, joker: false });
  for (let j = 0; j < 4; j++) deck.push({ id: ++CARD_ID, rank: 0, suit: "★", joker: true });
  for (let i = deck.length - 1; i > 0; i--) {
    const k = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[k]] = [deck[k], deck[i]];
  }
  return deck;
}

function rankLabel(c) {
  if (c.joker) return "JK";
  return { 1: "A", 11: "V", 12: "D", 13: "R" }[c.rank] || String(c.rank);
}
function cardName(c) { return c.joker ? "Joker" : rankLabel(c) + c.suit; }
function cardPoints(c) {
  if (c.joker) return 20;
  if (c.rank === 1) return 15;
  if (c.rank >= 10) return 10;
  return 5;
}
function handPoints(hand) { return hand.reduce((s, c) => s + cardPoints(c), 0); }

function isTri(cards) {
  const reals = cards.filter((c) => !c.joker);
  if (reals.length < 3) return false;
  return reals.every((c) => c.rank === reals[0].rank);
}

function isEscalier(cards) {
  const jokers = cards.filter((c) => c.joker).length;
  const reals = cards.filter((c) => !c.joker);
  if (reals.length < 3) return false;
  const suit = reals[0].suit;
  if (!reals.every((c) => c.suit === suit)) return false;
  for (let off = 0; off < 13; off++) {
    const vals = reals.map((c) => (((c.rank - 1 - off) % 13) + 13) % 13).sort((a, b) => a - b);
    let ok = true;
    for (let i = 1; i < vals.length; i++) if (vals[i] === vals[i - 1]) { ok = false; break; }
    if (!ok) continue;
    let need = 0, feasible = true;
    for (let i = 1; i < vals.length; i++) {
      const gap = vals[i] - vals[i - 1] - 1;
      if (gap >= 2) { feasible = false; break; }
      need += gap;
    }
    if (!feasible) continue;
    const leftover = jokers - need;
    if (leftover < 0 || leftover > 2) continue;
    const span = vals[vals.length - 1] - vals[0] + 1;
    if (span + leftover > 13) continue;
    return true;
  }
  return false;
}

function validGroup(type, cards) { return type === "tri" ? isTri(cards) : isEscalier(cards); }

// ---------- IA (remplacement des absents et adversaires bots) ----------
function findRuns(hand) {
  const bySuit = {};
  hand.filter((c) => !c.joker).forEach((c) => { (bySuit[c.suit] = bySuit[c.suit] || []).push(c); });
  const runs = [];
  for (const s in bySuit) {
    const byRank = {};
    bySuit[s].forEach((c) => { if (!byRank[c.rank]) byRank[c.rank] = c; });
    let vals = Object.keys(byRank).map(Number).sort((a, b) => a - b);
    if (byRank[1]) vals = [...vals, 14];
    vals = [...new Set(vals)].sort((a, b) => a - b);
    let run = [vals[0]];
    const flush = () => {
      if (run.length >= 3) {
        const cards = run.map((v) => byRank[v === 14 ? 1 : v]);
        if (new Set(cards.map((c) => c.id)).size === cards.length) runs.push(cards);
      }
    };
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] === run[run.length - 1] + 1) run.push(vals[i]);
      else { flush(); run = [vals[i]]; }
    }
    flush();
  }
  return runs;
}

function findJokerRuns(hand) {
  const bySuit = {};
  hand.filter((c) => !c.joker).forEach((c) => { (bySuit[c.suit] = bySuit[c.suit] || []).push(c); });
  const out = [];
  for (const s in bySuit) {
    const byRank = {};
    bySuit[s].forEach((c) => { if (!byRank[c.rank]) byRank[c.rank] = c; });
    let vals = Object.keys(byRank).map(Number);
    if (byRank[1]) vals.push(14);
    vals = [...new Set(vals)].sort((a, b) => a - b);
    for (let i = 0; i + 2 < vals.length; i++) {
      const trio = [vals[i], vals[i + 1], vals[i + 2]];
      if (trio[2] - trio[0] === 3) out.push(trio.map((v) => byRank[v === 14 ? 1 : v]));
    }
  }
  return out;
}

function aiPlanContract(hand, contract, level) {
  // Deux passes : escaliers d'abord, puis tris d'abord — évite qu'un long escalier vole la carte d'un tri (et inversement)
  return aiPlanContractPass(hand, contract, level, false) || aiPlanContractPass(hand, contract, level, true);
}
function aiPlanContractPass(hand, contract, level, triFirst) {
  const used = new Set();
  const melds = [];
  let escNeed = contract.esc, triNeed = contract.tri;
  const jokers = hand.filter((c) => c.joker);
  let jokerIdx = 0;
  const takeTris = () => {
    const remaining = hand.filter((c) => !c.joker && !used.has(c.id));
    const byRank = {};
    remaining.forEach((c) => { (byRank[c.rank] = byRank[c.rank] || []).push(c); });
    for (const r in byRank) {
      if (triNeed <= 0) break;
      if (byRank[r].length >= 3) {
        const cards = byRank[r]; // toutes les cartes identiques : chaque carte posée = une de moins en main
        cards.forEach((c) => used.add(c.id));
        melds.push({ type: "tri", cards });
        triNeed--;
      }
    }
  };
  const takeEscs = () => {
    const pool = hand.filter((c) => !used.has(c.id));
    for (const run of findRuns(pool)) {
      if (escNeed <= 0) break;
      if (run.some((c) => used.has(c.id))) continue;
      run.forEach((c) => used.add(c.id));
      melds.push({ type: "esc", cards: run });
      escNeed--;
    }
    if (escNeed > 0 && level === "difficile") {
      for (const jr of findJokerRuns(pool)) {
        if (escNeed <= 0 || jokerIdx >= jokers.length) break;
        if (jr.some((c) => used.has(c.id))) continue;
        const jk = jokers[jokerIdx];
        if (used.has(jk.id)) continue;
        jokerIdx++;
        const cards = [...jr, jk];
        cards.forEach((c) => used.add(c.id));
        melds.push({ type: "esc", cards });
        escNeed--;
      }
    }
  };
  if (triFirst) { takeTris(); takeEscs(); } else { takeEscs(); takeTris(); }
  if (escNeed > 0 || triNeed > 0) return null;
  return melds;
}

function aiPlanFullHand(hand) {
  const used = new Set();
  const melds = [];
  for (const run of findRuns(hand)) {
    if (run.some((c) => used.has(c.id))) continue;
    run.forEach((c) => used.add(c.id));
    melds.push({ type: "esc", cards: run });
  }
  const byRank = {};
  hand.filter((c) => !c.joker && !used.has(c.id)).forEach((c) => {
    (byRank[c.rank] = byRank[c.rank] || []).push(c);
  });
  for (const r in byRank) {
    if (byRank[r].length >= 3) {
      byRank[r].forEach((c) => used.add(c.id));
      melds.push({ type: "tri", cards: byRank[r] });
    }
  }
  const leftover = hand.filter((c) => !used.has(c.id));
  const jokersLeft = leftover.filter((c) => c.joker);
  if (leftover.length !== jokersLeft.length) return null;
  if (jokersLeft.length > 0) {
    const tri = melds.find((m) => m.type === "tri");
    if (!tri) return null;
    tri.cards = [...tri.cards, ...jokersLeft];
  }
  return melds.length > 0 ? melds : null;
}

function aiDiscardChoice(hand, level) {
  const nonJ = hand.filter((c) => !c.joker);
  if (nonJ.length === 0) return hand[0];
  if (level === "facile") return nonJ[Math.floor(Math.random() * nonJ.length)];
  const w = level === "difficile" ? { mates: 4, neigh: 3, pts: 0.15 } : { mates: 3, neigh: 2, pts: 0.05 };
  const score = (c) => {
    const mates = nonJ.filter((o) => o.id !== c.id && o.rank === c.rank).length;
    const neigh = nonJ.filter((o) => o.id !== c.id && o.suit === c.suit && Math.abs(o.rank - c.rank) <= 2).length;
    return mates * w.mates + neigh * w.neigh - cardPoints(c) * w.pts;
  };
  return [...nonJ].sort((a, b) => score(a) - score(b))[0];
}

function isOrderedEscalier(cards) {
  if (cards.length < 3 || cards.length > 13) return false;
  for (let i = 1; i < cards.length; i++) if (cards[i].joker && cards[i - 1].joker) return false;
  const reals = cards.map((c, i) => ({ c, i })).filter((x) => !x.c.joker);
  if (reals.length < 3) return false;
  const suit = reals[0].c.suit;
  if (!reals.every((x) => x.c.suit === suit)) return false;
  const base = (reals[0].c.rank - 1) - reals[0].i;
  for (const x of reals) {
    if (((((x.c.rank - 1) - x.i - base) % 13) + 13) % 13 !== 0) return false;
  }
  return true;
}

function sortEscalier(cards) {
  if (isOrderedEscalier(cards)) return cards;
  const jokers = cards.filter((c) => c.joker);
  const reals = cards.filter((c) => !c.joker);
  if (reals.length === 0) return cards;
  for (let off = 0; off < 13; off++) {
    const items = reals.map((c) => ({ c, v: (((c.rank - 1 - off) % 13) + 13) % 13 })).sort((a, b) => a.v - b.v);
    let okDist = true;
    for (let i = 1; i < items.length; i++) if (items[i].v === items[i - 1].v) { okDist = false; break; }
    if (!okDist) continue;
    let need = 0, feasible = true;
    for (let i = 1; i < items.length; i++) {
      const gap = items[i].v - items[i - 1].v - 1;
      if (gap >= 2) { feasible = false; break; }
      need += gap;
    }
    if (!feasible) continue;
    const leftover = jokers.length - need;
    if (leftover < 0 || leftover > 2) continue;
    const span = items[items.length - 1].v - items[0].v + 1;
    if (span + leftover > 13) continue;
    const out = [];
    let ji = 0;
    if (leftover === 2) out.push(jokers[ji++]);
    for (let i = 0; i < items.length; i++) {
      if (i > 0) {
        const gap = items[i].v - items[i - 1].v - 1;
        for (let k = 0; k < gap; k++) out.push(jokers[ji++]);
      }
      out.push(items[i].c);
    }
    while (ji < jokers.length) out.push(jokers[ji++]);
    return out;
  }
  return cards;
}

function normMeld(type, cards) { return type === "esc" ? sortEscalier(cards) : cards; }

module.exports = {
  sortEscalier, normMeld, isOrderedEscalier,
  SUITS, MANCHES, MAX_ACHATS,
  buildDeck, rankLabel, cardName, cardPoints, handPoints,
  isTri, isEscalier, validGroup,
  findRuns, findJokerRuns, aiPlanContract, aiPlanFullHand, aiDiscardChoice,
};
