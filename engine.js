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

// RÈGLE VOULUE : les escaliers « tournent le coin » (ex. D-R-A-2 est valide) — un escalier
// peut en théorie faire la boucle complète. C'est délibéré (règle maison Ramy Gasy), ne pas « corriger ».
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
  const seenSig = new Set();
  for (const s in bySuit) {
    const byRank = {};
    bySuit[s].forEach((c) => { if (!byRank[c.rank]) byRank[c.rank] = c; });
    const present = Object.keys(byRank).map(Number);
    if (present.length < 3) continue;
    // Deux tours (1..26) : gère toutes les boucles autour de l'As (D-R-A, R-A-2, D-R-A-2…)
    const line = [...new Set(present.flatMap((r) => [r, r + 13]))].sort((a, b) => a - b);
    let run = [line[0]];
    const flush = () => {
      if (run.length < 3) return;
      const seen = new Set(), cards = [];
      for (const v of run) {
        const card = byRank[((v - 1) % 13) + 1];
        if (!card || seen.has(card.id)) break; // une carte au plus une fois (pas de tour complet)
        seen.add(card.id); cards.push(card);
      }
      if (cards.length < 3) return;
      const sig = cards.map((c) => c.id).sort().join(",");
      if (seenSig.has(sig)) return; // le doublage produit chaque run 2× : dédoublonnage
      seenSig.add(sig);
      runs.push(cards);
    };
    for (let i = 1; i < line.length; i++) {
      if (line[i] === run[run.length - 1] + 1) run.push(line[i]);
      else { flush(); run = [line[i]]; }
    }
    flush();
  }
  runs.sort((a, b) => b.length - a.length); // les plus longs d'abord (poser un maximum de cartes)
  return runs;
}

function findJokerRuns(hand) {
  const bySuit = {};
  hand.filter((c) => !c.joker).forEach((c) => { (bySuit[c.suit] = bySuit[c.suit] || []).push(c); });
  const out = [];
  const seenSig = new Set();
  for (const s in bySuit) {
    const byRank = {};
    bySuit[s].forEach((c) => { if (!byRank[c.rank]) byRank[c.rank] = c; });
    const present = Object.keys(byRank).map(Number);
    if (present.length < 3) continue;
    const line = [...new Set(present.flatMap((r) => [r, r + 13]))].sort((a, b) => a - b);
    for (let i = 0; i + 2 < line.length; i++) {
      if (line[i + 2] - line[i] === 3) { // 3 cartes présentes sur 4 positions (un seul trou pour le joker)
        const cards = [line[i], line[i + 1], line[i + 2]].map((v) => byRank[((v - 1) % 13) + 1]);
        if (new Set(cards.map((c) => c.id)).size !== 3) continue;
        const sig = cards.map((c) => c.id).sort().join(",");
        if (seenSig.has(sig)) continue;
        seenSig.add(sig);
        out.push(cards);
      }
    }
  }
  return out;
}

// Tris candidats : groupe complet d'abord (poser un max), puis sous-ensembles de 3 (repli si conflit)
function enumTris(hand) {
  const byRank = {};
  hand.forEach((c) => { if (!c.joker) (byRank[c.rank] = byRank[c.rank] || []).push(c); });
  const out = [];
  for (const r in byRank) {
    const g = byRank[r];
    if (g.length < 3) continue;
    if (g.length > 3) out.push(g.slice()); // tri complet d'abord
    for (let a = 0; a < g.length; a++)
      for (let b = a + 1; b < g.length; b++)
        for (let d = b + 1; d < g.length; d++) out.push([g[a], g[b], g[d]]);
  }
  return out;
}
// Escaliers candidats : tous les sous-runs (>=3, boucles comprises), + escaliers à 1 joker (un seul trou)
function enumEscs(hand, withJoker) {
  const bySuit = {};
  hand.forEach((c) => { if (!c.joker) { bySuit[c.suit] = bySuit[c.suit] || {}; if (!bySuit[c.suit][c.rank]) bySuit[c.suit][c.rank] = c; } });
  const out = [];
  const seen = new Set();
  for (const s in bySuit) {
    const byRank = bySuit[s];
    const present = Object.keys(byRank).map(Number);
    if (present.length < 2) continue;
    const line = [...new Set(present.flatMap((r) => [r, r + 13]))].sort((a, b) => a - b);
    const segs = []; let seg = [line[0]];
    for (let i = 1; i < line.length; i++) { if (line[i] === seg[seg.length - 1] + 1) seg.push(line[i]); else { segs.push(seg); seg = [line[i]]; } }
    segs.push(seg);
    for (const g of segs) {
      for (let len = 3; len <= g.length && len <= 13; len++)
        for (let off = 0; off + len <= g.length; off++) {
          const cs = []; const idset = new Set(); let bad = false;
          for (let k = off; k < off + len; k++) { const c = byRank[((g[k] - 1) % 13) + 1]; if (!c || idset.has(c.id)) { bad = true; break; } idset.add(c.id); cs.push(c); }
          if (bad) continue;
          const sig = cs.map((c) => c.id).sort().join(",");
          if (!seen.has(sig)) { seen.add(sig); out.push({ cards: cs, jokerNeed: 0 }); }
        }
    }
    if (withJoker) {
      for (let i = 0; i + 2 < line.length; i++) {
        if (line[i + 2] - line[i] === 3) {
          const cs = [line[i], line[i + 1], line[i + 2]].map((v) => byRank[((v - 1) % 13) + 1]);
          if (new Set(cs.map((c) => c.id)).size !== 3) continue;
          const sig = "J" + cs.map((c) => c.id).sort().join(",");
          if (!seen.has(sig)) { seen.add(sig); out.push({ cards: cs, jokerNeed: 1 }); }
        }
      }
    }
  }
  out.sort((a, b) => (a.jokerNeed - b.jokerNeed) || (b.cards.length - a.cards.length)); // sans joker & longs d'abord
  return out;
}
// Planificateur avec retour arrière : trouve une combinaison DISJOINTE dès qu'elle existe
// (là où l'ancien planificateur glouton échouait quand un escalier « volait » une carte à un tri)
function aiPlanContract(hand, contract, level) {
  const needT = contract.tri || 0, needE = contract.esc || 0;
  if (needT === 0 && needE === 0) return [];
  const jokers = hand.filter((c) => c.joker);
  const triCands = enumTris(hand);
  const escCands = enumEscs(hand, level === "difficile" && jokers.length > 0);
  const used = new Set();
  let jokersLeft = jokers.length, steps = 0;
  function dfs(melds, ti, ei) {
    if (ti >= needT && ei >= needE) return melds;
    if (++steps > 200000) return null; // garde-fou CPU (rarement atteint)
    if (ti < needT) {
      for (const t of triCands) {
        if (t.some((c) => used.has(c.id))) continue;
        t.forEach((c) => used.add(c.id));
        const r = dfs([...melds, { type: "tri", cards: t }], ti + 1, ei);
        if (r) return r;
        t.forEach((c) => used.delete(c.id));
      }
      return null;
    }
    for (const e of escCands) {
      if (e.jokerNeed > jokersLeft) continue;
      if (e.cards.some((c) => used.has(c.id))) continue;
      let jk = null;
      if (e.jokerNeed) { jk = jokers.find((j) => !used.has(j.id)); if (!jk) continue; }
      e.cards.forEach((c) => used.add(c.id));
      let cards = e.cards;
      if (jk) { used.add(jk.id); jokersLeft--; cards = sortEscalier([...e.cards, jk]); }
      const r = dfs([...melds, { type: "esc", cards }], ti, ei + 1);
      if (r) return r;
      e.cards.forEach((c) => used.delete(c.id));
      if (jk) { used.delete(jk.id); jokersLeft++; }
    }
    return null;
  }
  return dfs([], 0, 0);
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
