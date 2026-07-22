// Banc de tests du moteur de règles — lancer avec : npm test
const E = require("../engine");

let ID = 1000;
const mk = (rank, suit) => ({ id: ++ID, rank, suit, joker: false });
const jk = () => ({ id: ++ID, rank: 0, suit: "★", joker: true });

let ok = 0, ko = 0;
function check(nom, cond) {
  if (cond) { ok++; console.log("  ✓ " + nom); }
  else { ko++; console.error("  ✗ ÉCHEC : " + nom); }
}

console.log("— Points des cartes —");
check("2-9 valent 5", E.cardPoints(mk(5, "♠")) === 5);
check("10-R valent 10", E.cardPoints(mk(12, "♥")) === 10);
check("As vaut 15", E.cardPoints(mk(1, "♦")) === 15);
check("Joker vaut 20", E.cardPoints(jk()) === 20);
check("handPoints additionne", E.handPoints([mk(2, "♠"), mk(1, "♠"), jk()]) === 40);

console.log("— Tris —");
check("3 cartes de même valeur = tri", E.isTri([mk(7, "♠"), mk(7, "♥"), mk(7, "♦")]));
check("4 cartes de même valeur = tri", E.isTri([mk(7, "♠"), mk(7, "♥"), mk(7, "♦"), mk(7, "♣")]));
check("5 cartes de même valeur = tri", E.isTri([mk(7, "♠"), mk(7, "♥"), mk(7, "♦"), mk(7, "♣"), mk(7, "♠")]));
check("2 cartes + joker ≠ tri (min 3 vraies)", !E.isTri([mk(7, "♠"), mk(7, "♥"), jk()]));
check("3 vraies + joker = tri", E.isTri([mk(7, "♠"), mk(7, "♥"), mk(7, "♦"), jk()]));
check("valeurs différentes ≠ tri", !E.isTri([mk(7, "♠"), mk(8, "♥"), mk(7, "♦")]));

console.log("— Escaliers —");
check("5-6-7 même couleur = escalier", E.isEscalier([mk(5, "♠"), mk(6, "♠"), mk(7, "♠")]));
check("couleurs mélangées ≠ escalier", !E.isEscalier([mk(5, "♠"), mk(6, "♥"), mk(7, "♠")]));
check("A-2-3 = escalier", E.isEscalier([mk(1, "♦"), mk(2, "♦"), mk(3, "♦")]));
check("D-R-A = escalier", E.isEscalier([mk(12, "♣"), mk(13, "♣"), mk(1, "♣")]));
check("R-A-2 (boucle) = escalier", E.isEscalier([mk(13, "♥"), mk(1, "♥"), mk(2, "♥")]));
check("5-6-8 + joker = escalier", E.isEscalier([mk(5, "♠"), mk(6, "♠"), mk(8, "♠"), jk()]));
check("5-7 + joker ≠ escalier (2 vraies)", !E.isEscalier([mk(5, "♠"), mk(7, "♠"), jk()]));
check("trou de 2 sans jokers ≠ escalier", !E.isEscalier([mk(5, "♠"), mk(6, "♠"), mk(9, "♠")]));

console.log("— Escaliers ordonnés (position du joker) —");
check("5-6-7 ordonné", E.isOrderedEscalier([mk(5, "♠"), mk(6, "♠"), mk(7, "♠")]));
check("7-6-5 non ordonné", !E.isOrderedEscalier([mk(7, "♠"), mk(6, "♠"), mk(5, "♠")]));
check("5-JK-7 refusé (2 vraies cartes seulement)", !E.isOrderedEscalier([mk(5, "♠"), jk(), mk(7, "♠")]));
check("5-JK-7-8 : joker = 6", E.isOrderedEscalier([mk(5, "♠"), jk(), mk(7, "♠"), mk(8, "♠")]));
check("deux jokers côte à côte interdits", !E.isOrderedEscalier([mk(5, "♠"), jk(), jk(), mk(8, "♠"), mk(9, "♠")]));

console.log("— sortEscalier —");
const tri1 = E.sortEscalier([mk(7, "♠"), mk(5, "♠"), mk(6, "♠")]);
check("remet 5-6-7 dans l'ordre", tri1.map((c) => c.rank).join(",") === "5,6,7");
const avecJoker = E.sortEscalier([mk(8, "♦"), jk(), mk(6, "♦")]);
check("place le joker à la position 7", avecJoker[1].joker === true && avecJoker[0].rank === 6 && avecJoker[2].rank === 8);

console.log("— Planificateur de contrat —");
// Cas régression : le long escalier ne doit plus voler la carte du tri
const mainConflit = [mk(6, "♠"), mk(7, "♠"), mk(8, "♠"), mk(9, "♠"), mk(9, "♥"), mk(9, "♦"), mk(2, "♣"), mk(4, "♥")];
const planConflit = E.aiPlanContract(mainConflit, { tri: 1, esc: 1 }, "difficile");
check("1 tri + 1 escalier trouvés malgré le conflit 9♠", Boolean(planConflit));
if (planConflit) {
  check("le plan contient bien un tri et un escalier",
    planConflit.some((m) => m.type === "tri") && planConflit.some((m) => m.type === "esc"));
}
// Tri de 4 : toutes les cartes identiques sont prises
const main4D = [mk(12, "♠"), mk(12, "♥"), mk(12, "♦"), mk(12, "♣"), mk(2, "♠"), mk(5, "♥")];
const plan4D = E.aiPlanContract(main4D, { tri: 1, esc: 0 }, "difficile");
check("tri de 4 dames pris en entier", Boolean(plan4D) && plan4D[0].cards.length === 4);
// Escalier avec joker (difficile uniquement)
const mainJK = [mk(4, "♣"), mk(5, "♣"), mk(7, "♣"), jk(), mk(11, "♠"), mk(2, "♥")];
check("escalier à joker trouvé en difficile", Boolean(E.aiPlanContract(mainJK, { tri: 0, esc: 1 }, "difficile")));
check("contrat impossible → null", E.aiPlanContract([mk(2, "♠"), mk(5, "♥"), mk(9, "♦")], { tri: 1, esc: 0 }, "difficile") === null);

console.log("— Pose-tout —");
const mainFull = [mk(3, "♠"), mk(3, "♥"), mk(3, "♦"), mk(9, "♣"), mk(10, "♣"), mk(11, "♣")];
const planFull = E.aiPlanFullHand(mainFull);
check("main entièrement combinable détectée", Boolean(planFull) && planFull.reduce((s, m) => s + m.cards.length, 0) === 6);
check("main non combinable → null", E.aiPlanFullHand([mk(3, "♠"), mk(4, "♥"), mk(9, "♦")]) === null);

console.log("— Paquet —");
const deck = E.buildDeck();
check("108 cartes (2 paquets + 4 jokers)", deck.length === 108);
check("4 jokers", deck.filter((c) => c.joker).length === 4);

console.log("");
if (ko > 0) { console.error(ko + " test(s) en échec, " + ok + " réussi(s)"); process.exit(1); }
console.log("✅ " + ok + " tests réussis");
