// =====================================================================
// moderation — filtre des pseudos (grossièretés, insultes, contenu sexuel)
// ---------------------------------------------------------------------
// Les pseudos sont visibles de tous : à la table de jeu, dans les classements
// et dans les résultats de défis. C'est le seul contenu librement écrit par les
// joueurs, donc le seul à modérer — et l'App Store l'exige (règle 1.2).
//
// Principe : on normalise le pseudo (accents, chiffres imitant des lettres,
// caractères de séparation) puis on cherche les termes interdits. La
// normalisation est essentielle : sans elle, « c0nn4rd », « c-o-n-n-a-r-d » et
// « ÇONNARD » passeraient tous à travers.
//
// Approche volontairement mesurée : on vise les termes sans ambiguïté. Un filtre
// trop zélé qui refuse « Assane » ou « Pénélope » est plus nuisible qu'utile.
// =====================================================================

// Lettres substituées par des chiffres ou symboles (leetspeak)
const SUBSTITUTIONS = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g",
  "@": "a", "$": "s", "!": "i", "|": "i", "+": "t", "€": "e", "£": "l",
};

// Ramène un texte à sa forme la plus « nue » possible : minuscules, sans accents,
// leetspeak défait, sans espaces ni ponctuation.
function normaliser(texte) {
  let t = String(texte || "").toLowerCase();
  t = t.normalize("NFD").replace(/[̀-ͯ]/g, "");        // enlève les accents : é → e
  t = t.replace(/[0-9@$!|+€£]/g, (c) => SUBSTITUTIONS[c] || c);  // défait le leetspeak
  t = t.replace(/[^a-z]/g, "");                                   // enlève espaces, points, tirets…
  return t;
}

// Variante qui écrase aussi les lettres répétées : « fuuuuck » → « fuck ».
// Attention : cette réduction ne doit JAMAIS être appliquée aux termes interdits
// eux-mêmes, sinon « kkk » deviendrait « k » et refuserait tout pseudo contenant
// un k (Rakoto, Mika…). On l'applique donc au seul pseudo, et on teste les termes
// contre les deux formes.
function normaliserSansRepetitions(texte) {
  return normaliser(texte).replace(/(.)\1+/g, "$1");
}

// Termes interdits — français, anglais, et quelques termes malgaches.
// Recherchés comme sous-chaînes dans le pseudo normalisé.
const INTERDITS = [
  // Insultes et vulgarités françaises
  "connard", "connasse", "conard", "encule", "enfoire", "salope", "salaud",
  "putain", "batard", "merde", "couille", "niquer", "niquez", "niquta", "ntm",
  "tapette", "pedale", "gouine", "trouduc", "ducon", "abruti", "cretin", "salopard",
  // Sexuel explicite
  "porno", "porn", "sexe", "sexy", "bite", "penis", "vagin", "nichon", "teton",
  "orgasme", "masturb", "branle", "sperme", "ejacul", "sodom", "fellation",
  "levrette", "prostitu", "escort", "xxx", "hentai", "nudes", "boobs", "pussy",
  "cunt", "fuck", "fucker", "fucking", "bitch", "asshole", "whore", "slut",
  "bastard", "blowjob", "handjob", "milf", "pedophil", "zoophil", "chatte",
  // Haine et discrimination
  "nazi", "hitler", "shoah", "negre", "nigger", "nigga", "bougnoule", "youpin",
  "chinetoque", "bicot", "genocide", "terroriste", "daesh",
  // Drogue
  "cocaine", "heroine", "cannabis",
  // Malgache (vulgarités courantes)
  "tsinay", "voatoto", "mamoso",
  // Usurpation d'identité / autorité
  "admin", "administrateur", "moderateur", "moderator", "officiel", "support",
  "staff", "systeme", "serveur", "ramygasy",
];

// Termes courts ou ambigus : cherchés en MOT ENTIER uniquement.
// Sans cette distinction, « Analia » serait refusé à cause d'« anal », « Dominique »
// à cause de « nique », « Violette » à cause de « viol » et « Sheila » à cause de « heil ».
const INTERDITS_EXACTS = [
  "cul", "con", "cons", "bit", "sex", "ass", "tit", "fk", "wtf", "pipi", "caca",
  "pd", "anal", "cum", "rape", "viol", "nude", "dick", "cock", "shit", "loli",
  "heil", "meth", "crack", "weed", "pedo", "nique", "pute", "putes", "seins",
  "raton", "kaka", "zizi", "kkk",
];

// Renvoie null si le pseudo est acceptable, sinon un message d'explication.
const REFUS = "Ce pseudo n'est pas autorisé — choisis-en un autre, plus sympathique !";

function verifierPseudo(pseudo) {
  const brut = String(pseudo || "").trim();
  if (!brut) return "Choisis un pseudo.";
  const n = normaliser(brut);                    // forme fidèle : « connard »
  const nr = normaliserSansRepetitions(brut);    // forme écrasée : « fuuuuck » → « fuck »
  if (!n) return "Ce pseudo doit contenir des lettres.";
  for (const mot of INTERDITS) {
    const cible = normaliser(mot); // jamais la version écrasée, sinon « kkk » → « k »
    if (cible && (n.includes(cible) || nr.includes(cible))) return REFUS;
  }
  if (INTERDITS_EXACTS.includes(n) || INTERDITS_EXACTS.includes(nr)) return REFUS;
  return null;
}

module.exports = { verifierPseudo, normaliser, INTERDITS, INTERDITS_EXACTS };
