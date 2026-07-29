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

// CORS : autorise l'app native (capacitor://localhost…) à appeler les routes compte/stats.
// La liste ALLOWED_ORIGINS est la même que celle du multijoueur socket.io (définie plus bas).
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
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

// ---------- Keep-alive : empêche la mise en veille Render (offre gratuite) ----------
// Render endort le service après ~15 min sans trafic ENTRANT externe. On se pingue via l'URL
// publique (fournie automatiquement par Render) toutes les 10 min pour rester réveillé.
// Actif seulement en production (RENDER_EXTERNAL_URL absent en local → aucun effet).
(function keepAlive() {
  const base = process.env.RENDER_EXTERNAL_URL;
  if (!base) return;
  const https = require("https");
  const http = require("http");
  const url = base.replace(/\/$/, "") + "/ping";
  setInterval(() => {
    try {
      (url.startsWith("https") ? https : http).get(url, (r) => r.resume()).on("error", () => {});
    } catch (_) {}
  }, 10 * 60 * 1000); // toutes les 10 minutes
})();

// ---------- Statistiques temps réel ----------
const presence = new Map(); // id → { t: dernier signal, m: mode, p: pseudo }
// Clé pour voir les pseudos sur /stats.html — à définir dans les variables d'environnement Render.
// Pas de valeur par défaut : un secret en dur dans un dépôt GitHub public n'est pas un secret.
const STATS_KEY = process.env.STATS_KEY || null;
// Aperçu d'un salon pour l'écran d'invitation : qui invite, combien de joueurs (rien de sensible)
app.get("/salon-info", (req, res) => {
  const code = String(req.query.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
  const room = code.length === 5 ? rooms.get(code) : null;
  if (!room) return res.json({ ok: false });
  const humains = room.players.filter((p) => !p.isBot);
  res.json({
    ok: true,
    hote: (humains[0] && humains[0].name) || "un joueur",
    joueurs: humains.filter((p) => p.connected).length,
    enPartie: room.state === "playing" || room.state === "roundEnd",
  });
});

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
// ---------- Comptes joueurs (pseudo + code secret à 6 chiffres) ----------
// Deux modes côté client : invité (rien n'est gardé) ou connecté (stats retrouvables partout).
// Persistance via storage.js : Postgres si DATABASE_URL est défini (survit aux déploiements
// Render), fichier local sinon (développement).
const storage = require("./storage");
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || path.join(__dirname, "comptes-save.json");
const comptes = new Map(); // code → { code, pseudo, stats, succes, createdAt, lastSeen }
const MAX_COMPTES = 100000;
let comptesTimer = null;
function saveComptes() {
  clearTimeout(comptesTimer);
  comptesTimer = setTimeout(() => {
    storage.save("comptes", [...comptes.values()], ACCOUNTS_FILE)
      .catch((e) => console.error("Sauvegarde des comptes impossible:", e.message));
  }, 1000);
}

// Un « bucket » de stats (solo à la racine, multi sous .mp)
function cleanBucket(s) {
  const out = {};
  if (!s || typeof s !== "object") return out;
  ["games", "wins", "streak", "bestStreak", "bestScore", "sumScore", "fastestWinMs"].forEach((k) => {
    if (typeof s[k] === "number" && isFinite(s[k])) out[k] = Math.max(0, Math.min(1e12, Math.round(s[k])));
  });
  // bestManche peut être négatif (bonus pose-tout) → on autorise les valeurs négatives
  if (typeof s.bestManche === "number" && isFinite(s.bestManche)) out.bestManche = Math.max(-1e6, Math.min(1e6, Math.round(s.bestManche)));
  // contracts : { "libellé": { n, sum } } pour le contrat préféré
  if (s.contracts && typeof s.contracts === "object") {
    const co = {};
    Object.keys(s.contracts).slice(0, 20).forEach((k) => {
      if (typeof k !== "string" || k.length > 40) return;
      const c = s.contracts[k];
      if (c && typeof c === "object" && typeof c.n === "number" && typeof c.sum === "number" && isFinite(c.n) && isFinite(c.sum))
        co[k] = { n: Math.max(0, Math.min(1e9, Math.round(c.n))), sum: Math.round(c.sum) };
    });
    out.contracts = co;
  }
  return out;
}
function cleanStats(s) {
  const out = cleanBucket(s);              // solo (racine, rétrocompatible)
  if (s && s.mp) out.mp = cleanBucket(s.mp); // multijoueur (sous-objet séparé)
  return out;
}
function cleanSucces(s) {
  const out = {};
  if (!s || typeof s !== "object") return out;
  Object.keys(s).slice(0, 50).forEach((k) => {
    if (typeof k === "string" && k.length <= 40 && typeof s[k] === "number") out[k] = s[k];
  });
  return out;
}
// Fusion prudente multi-appareils : les compteurs ne reculent jamais, le record est le plus bas
function mergeBucket(a, b) {
  a = a || {}; b = b || {};
  const out = {};
  ["games", "wins", "bestStreak", "sumScore"].forEach((k) => { const v = Math.max(a[k] || 0, b[k] || 0); if (v) out[k] = v; });
  if (b.streak != null) out.streak = b.streak; // la série en cours suit le dernier appareil
  else if (a.streak != null) out.streak = a.streak;
  const scores = [a.bestScore, b.bestScore].filter((x) => x != null);
  if (scores.length) out.bestScore = Math.min(...scores);
  const temps = [a.fastestWinMs, b.fastestWinMs].filter((x) => x != null);
  if (temps.length) out.fastestWinMs = Math.min(...temps); // on garde la victoire la plus rapide
  const bm = [a.bestManche, b.bestManche].filter((x) => x != null);
  if (bm.length) out.bestManche = Math.min(...bm);
  // Chaque appareil envoie son cumul complet : on garde, par contrat, la version au plus grand n
  // (comme games/wins en Math.max) pour ne pas double-compter à chaque synchro
  const ca = a.contracts || {}, cb = b.contracts || {};
  const labels = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  if (labels.size) {
    out.contracts = {};
    labels.forEach((l) => {
      const x = ca[l] || { n: 0, sum: 0 }, y = cb[l] || { n: 0, sum: 0 };
      out.contracts[l] = (y.n || 0) >= (x.n || 0) ? { n: y.n || 0, sum: y.sum || 0 } : { n: x.n || 0, sum: x.sum || 0 };
    });
  }
  return out;
}
function mergeStats(a, b) {
  a = a || {}; b = b || {};
  const out = mergeBucket(a, b);                 // solo (racine)
  if (a.mp || b.mp) out.mp = mergeBucket(a.mp, b.mp); // multijoueur
  return out;
}
function mergeSucces(a, b) {
  const out = { ...(b || {}), ...(a || {}) }; // union, en gardant la date la plus ancienne (a = serveur)
  return out;
}

app.use("/compte", express.json({ limit: "120kb" })); // assez pour la photo de profil (≤ 80 Ko, validée par la route)
app.use("/defi", express.json({ limit: "4kb" }));     // scores du défi du jour
// Erreur de lecture du corps (trop lourd, JSON invalide…) : réponse JSON propre plutôt qu'une page HTML
app.use("/compte", (err, req, res, next) => {
  if (!err) return next();
  res.status(err.status || 400).json({ erreur: err.type === "entity.too.large" ? "Photo trop lourde — réessaie avec une image plus petite." : "Requête invalide." });
});
const compteTries = new Map(); // anti force-brute sur les codes (toutes requêtes)
setInterval(() => compteTries.clear(), 60 * 1000);
function tropDEssais(req, res) {
  const n = (compteTries.get(req.ip) || 0) + 1;
  compteTries.set(req.ip, n);
  if (compteTries.size > 10000) compteTries.clear();
  if (n > 12) { res.status(429).json({ erreur: "Trop d'essais — réessaie dans une minute." }); return true; }
  return false;
}

// Deuxième verrou, bien plus serré : compte SEULEMENT les codes refusés.
// Un joueur honnête se trompe une ou deux fois ; un script qui balaie les 900 000 codes
// possibles enchaîne les échecs. 10 échecs par heure et par IP suffisent à rendre
// le balayage inopérant (il faudrait des siècles), sans jamais gêner un vrai joueur.
const codeEchecs = new Map(); // ip → { n, jusqu: horodatage de fin de blocage }
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of codeEchecs) if (now > v.jusqu) codeEchecs.delete(ip);
}, 10 * 60 * 1000);
const MAX_ECHECS_CODE = 10;
const FENETRE_ECHECS_MS = 60 * 60 * 1000; // 1 heure
function bloquePourEchecs(req, res) {
  const v = codeEchecs.get(req.ip);
  if (v && v.n >= MAX_ECHECS_CODE && Date.now() < v.jusqu) {
    res.status(429).json({ erreur: "Trop de codes incorrects — réessaie dans une heure." });
    return true;
  }
  return false;
}
function noteEchecCode(req) {
  const now = Date.now();
  const v = codeEchecs.get(req.ip);
  if (!v || now > v.jusqu) codeEchecs.set(req.ip, { n: 1, jusqu: now + FENETRE_ECHECS_MS });
  else v.n++;
  if (codeEchecs.size > 20000) codeEchecs.clear(); // borne mémoire
}

const MOD = require("./moderation"); // filtre des pseudos (grossièretés, insultes)
const MESSAGE_BANNI = "Ce compte a été suspendu pour non-respect des règles de la communauté.";
// Un pseudo doit rester lisible : ni chevrons (anti-HTML), ni caractères de contrôle invisibles
const CARACTERES_INTERDITS = /[<>\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\ufeff]/;
const pseudoValide = (p) => typeof p === "string" && p.trim().length >= 2 && p.trim().length <= 20
  && !CARACTERES_INTERDITS.test(p);
// Anti-squat de pseudos : un même appareil ne crée pas 50 comptes par jour.
// 5 créations par IP et par jour couvre largement une famille sur le même wifi.
const comptesCrees = new Map(); // ip → { n, jusqu }
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of comptesCrees) if (now > v.jusqu) comptesCrees.delete(ip);
}, 60 * 60 * 1000);
function tropDeComptes(req, res) {
  const v = comptesCrees.get(req.ip);
  if (v && v.n >= 5 && Date.now() < v.jusqu) {
    res.status(429).json({ erreur: "Trop de comptes créés depuis cet appareil — réessaie demain." });
    return true;
  }
  return false;
}
function noteCompteCree(req) {
  const now = Date.now();
  const v = comptesCrees.get(req.ip);
  if (!v || now > v.jusqu) comptesCrees.set(req.ip, { n: 1, jusqu: now + 24 * 3600 * 1000 });
  else v.n++;
  if (comptesCrees.size > 20000) comptesCrees.clear();
}

function trouveCompte(req) {
  const { pseudo, code } = req.body || {};
  const c = typeof code === "string" && /^[0-9]{6}$/.test(code.trim()) ? comptes.get(code.trim()) : null;
  if (!c || !pseudoValide(pseudo) || c.pseudo.toLowerCase() !== pseudo.trim().toLowerCase()) return null;
  return c;
}

app.post("/compte/creer", (req, res) => {
  if (tropDEssais(req, res)) return;
  if (tropDeComptes(req, res)) return;
  if (!pseudoValide(req.body && req.body.pseudo)) return res.status(400).json({ erreur: "Pseudo invalide (2 à 20 caractères)." });
  const refus = MOD.verifierPseudo(req.body.pseudo);
  if (refus) return res.status(400).json({ erreur: refus });
  if (comptes.size >= MAX_COMPTES) return res.status(503).json({ erreur: "Plus de place pour de nouveaux comptes." });
  // Un pseudo = un seul compte (comparaison sans tenir compte des majuscules)
  const voulu = req.body.pseudo.trim().toLowerCase();
  for (const c of comptes.values()) {
    if (c.pseudo.toLowerCase() === voulu) return res.status(409).json({ erreur: "Ce pseudo est déjà pris — choisis-en un autre." });
  }
  let code;
  do { code = String(crypto.randomInt(100000, 1000000)); } while (comptes.has(code));
  const compte = { code, pseudo: req.body.pseudo.trim(), stats: cleanStats(req.body.stats),
    succes: cleanSucces(req.body.succes), createdAt: Date.now(), lastSeen: Date.now() };
  comptes.set(code, compte);
  noteCompteCree(req);
  saveComptes();
  res.json(compteJson(compte));
});

// Suppression du compte — obligatoire pour l'App Store (règle 5.1.1(v) d'Apple : toute app
// permettant de créer un compte doit permettre de le supprimer depuis l'app) et pour le RGPD
// (droit à l'effacement). Efface le compte, ses scores de classement et ses résultats de défis.
app.post("/compte/supprimer", (req, res) => {
  if (tropDEssais(req, res) || bloquePourEchecs(req, res)) return;
  const c = trouveCompte(req); // exige pseudo + code : on ne supprime pas le compte d'un autre
  if (!c) { noteEchecCode(req); return res.status(404).json({ erreur: "Pseudo ou code incorrect." }); }
  comptes.delete(c.code);
  for (const jour of defiScores.values()) jour.delete(c.code);       // classement du défi du jour
  for (const d of defisPrives.values()) delete d.scores[c.code];     // résultats des défis entre amis
  saveComptes(); saveDefi(); saveDefisPrives();
  res.json({ ok: true });
});

app.post("/compte/connexion", (req, res) => {
  if (tropDEssais(req, res) || bloquePourEchecs(req, res)) return;
  const c = trouveCompte(req);
  if (!c) { noteEchecCode(req); return res.status(404).json({ erreur: "Pseudo ou code incorrect." }); }
  if (c.banni) return res.status(403).json({ erreur: MESSAGE_BANNI });
  c.lastSeen = Date.now(); saveComptes();
  res.json(compteJson(c));
});

// ---------- Pièces et série quotidienne ----------
// Récompenses SERVEUR uniquement : le client ne fait qu'afficher. Montants :
// partie terminée 10, victoire +25, succès débloqué +25, défi du jour 15 (+10 si gagné),
// série quotidienne croissante (jour 1 → 7+). Plafond anti-farm : 15 parties payées par jour.
const PIECES = { partie: 10, victoire: 25, succes: 25, defi: 15, defiVictoire: 10, defiAmi: 10, defiAmiVictoire: 5 };
const SERIE_RECOMPENSES = [10, 15, 20, 25, 30, 40, 50];
const PARTIES_PAYEES_MAX = 15;
const dateDuJour = () => new Date().toISOString().slice(0, 10);
function crediterPieces(c, montant) { if (montant > 0) c.pieces = (c.pieces || 0) + montant; }
// Première activité du jour : la série avance (ou repart à 1) et rapporte des pièces
function majSerie(c) {
  const auj = dateDuJour();
  const s = c.serie && typeof c.serie === "object" ? c.serie : { jours: 0, dernier: null };
  if (s.dernier === auj) { c.serie = s; return { jours: s.jours, gain: 0 }; }
  const hier = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  s.jours = s.dernier === hier ? (s.jours || 0) + 1 : 1;
  s.dernier = auj;
  c.serie = s;
  const gain = SERIE_RECOMPENSES[Math.min(s.jours - 1, SERIE_RECOMPENSES.length - 1)];
  crediterPieces(c, gain);
  return { jours: s.jours, gain };
}
// Nombre de parties déjà récompensées aujourd'hui (plafond anti-farm)
function partieRecompensee(c) {
  const auj = dateDuJour();
  const pj = c.pjour && c.pjour.d === auj ? c.pjour : { d: auj, n: 0 };
  pj.n += 1; c.pjour = pj;
  return pj.n <= PARTIES_PAYEES_MAX;
}
const nbSucces = (s) => (s && typeof s === "object" ? Object.keys(s).length : 0);

// Réponse standard des routes compte (avatar et photo de profil inclus)
const compteJson = (c) => ({ code: c.code, pseudo: c.pseudo, stats: c.stats || {}, succes: c.succes || {},
  avatar: c.avatar || null, photo: c.photo || null, renamedAt: c.renamedAt || null,
  pieces: c.pieces || 0, serie: (c.serie && c.serie.jours) || 0 });

// Changer de pseudo sans perdre sa progression (le compte reste identifié par son code).
// Limite anti-abus : 1 changement par semaine (le premier est libre — faute de frappe pardonnée).
const RENOMMAGE_DELAI_MS = 7 * 24 * 60 * 60 * 1000;
app.post("/compte/renommer", (req, res) => {
  if (tropDEssais(req, res) || bloquePourEchecs(req, res)) return;
  const code = String((req.body && req.body.code) || "").trim();
  const c = /^[0-9]{6}$/.test(code) ? comptes.get(code) : null;
  if (!c) { noteEchecCode(req); return res.status(404).json({ erreur: "Code inexistant." }); }
  if (c.renamedAt && Date.now() - c.renamedAt < RENOMMAGE_DELAI_MS) {
    const jours = Math.ceil((RENOMMAGE_DELAI_MS - (Date.now() - c.renamedAt)) / 86400000);
    return res.status(429).json({ erreur: "Pseudo modifiable une fois par semaine — réessaie dans " + jours + " jour" + (jours > 1 ? "s" : "") + "." });
  }
  if (!pseudoValide(req.body && req.body.pseudo)) return res.status(400).json({ erreur: "Pseudo invalide (2 à 20 caractères)." });
  const refusRenom = MOD.verifierPseudo(req.body.pseudo);
  if (refusRenom) return res.status(400).json({ erreur: refusRenom });
  const voulu = req.body.pseudo.trim();
  for (const a of comptes.values()) {
    if (a !== c && a.pseudo.toLowerCase() === voulu.toLowerCase())
      return res.status(409).json({ erreur: "Ce pseudo est déjà pris — choisis-en un autre." });
  }
  if (voulu !== c.pseudo) c.renamedAt = Date.now(); // reprendre le même pseudo ne consomme pas le quota
  c.pseudo = voulu;
  c.lastSeen = Date.now();
  saveComptes();
  res.json(compteJson(c));
});

// Profil : avatar (parmi les 10 du jeu) et/ou photo (petite image envoyée par le client)
app.post("/compte/profil", (req, res) => {
  if (tropDEssais(req, res) || bloquePourEchecs(req, res)) return;
  const code = String((req.body && req.body.code) || "").trim();
  const c = /^[0-9]{6}$/.test(code) ? comptes.get(code) : null;
  if (!c) { noteEchecCode(req); return res.status(404).json({ erreur: "Code inexistant." }); }
  const { avatar, photo } = req.body || {};
  if (avatar !== undefined) {
    if (avatar !== null && !AVATARS_PROFIL.includes(avatar)) return res.status(400).json({ erreur: "Avatar inconnu." });
    c.avatar = avatar;
  }
  if (photo !== undefined) {
    if (photo === null) c.photo = null; // suppression de la photo
    else {
      if (typeof photo !== "string" || !/^data:image\/(jpeg|png);base64,/.test(photo))
        return res.status(400).json({ erreur: "Format de photo invalide." });
      if (photo.length > 80000) return res.status(400).json({ erreur: "Photo trop lourde." });
      // Vérifier que c'est VRAIMENT une image : base64 valide + signature de fichier JPEG/PNG.
      // Sans ce contrôle, le champ accepte 80 Ko de données arbitraires par compte
      // (détournement du serveur en espace de stockage gratuit, saturation de la base).
      const b64 = photo.slice(photo.indexOf(",") + 1);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return res.status(400).json({ erreur: "Format de photo invalide." });
      let entete;
      try { entete = Buffer.from(b64.slice(0, 16), "base64"); }
      catch (e) { return res.status(400).json({ erreur: "Format de photo invalide." }); }
      const estJpeg = entete[0] === 0xff && entete[1] === 0xd8 && entete[2] === 0xff;
      const estPng = entete[0] === 0x89 && entete[1] === 0x50 && entete[2] === 0x4e && entete[3] === 0x47;
      if (!estJpeg && !estPng) return res.status(400).json({ erreur: "Format de photo invalide." });
      c.photo = photo;
    }
  }
  c.lastSeen = Date.now();
  saveComptes();
  res.json(compteJson(c));
});

// ---------- Signalements et modération ----------
// L'App Store (règle 1.2) impose, pour tout contenu écrit par les utilisateurs :
// un filtre, un moyen de signaler, et la possibilité d'écarter un joueur abusif.
// Les signalements sont toujours stockés (rien ne se perd), et un email est envoyé
// en plus si SMTP_PASS est configuré sur Render (voir la section « Envoi d'email » plus bas).
const SIGNALEMENTS_FILE = process.env.SIGNALEMENTS_FILE || path.join(__dirname, "signalements-save.json");
const signalements = []; // { id, cible, pseudoCible, motif, details, par, at, traite }
let signalementsTimer = null;
function saveSignalements() {
  clearTimeout(signalementsTimer);
  signalementsTimer = setTimeout(() => {
    while (signalements.length > 2000) signalements.shift(); // garde les plus récents
    storage.save("signalements", signalements, SIGNALEMENTS_FILE)
      .catch((e) => console.error("Sauvegarde des signalements impossible:", e.message));
  }, 1000);
}

const MOTIFS = ["pseudo", "photo", "triche", "harcelement", "autre"];
const MOTIFS_LISIBLES = {
  pseudo: "Pseudo offensant", photo: "Photo inappropriée", triche: "Triche présumée",
  harcelement: "Harcèlement", autre: "Autre",
  // Messages envoyés via la page « Nous contacter » (même circuit que les signalements)
  suggestion: "💡 Suggestion", probleme: "🐞 Problème / bug", question: "❓ Question", message: "💬 Message",
};

// ---------- Envoi d'email des signalements (facultatif) ----------
// SMTP direct, sans dépendance. Expéditeur : la boîte Gmail dédiée aux envois.
// Destinataire : la boîte de contact. Seul SMTP_PASS doit être défini sur Render.
//
// Côté Google : le mot de passe habituel du compte est REFUSÉ. Il faut activer la validation
// en deux étapes sur signalement.ramygasy@gmail.com, puis créer un « mot de passe
// d'application » (myaccount.google.com/apppasswords) et le mettre dans SMTP_PASS.
const SMTP = {
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT, 10) || 465, // 465 = TLS direct ; 587 = STARTTLS
  user: process.env.SMTP_USER || "signalement.ramygasy@gmail.com",
  pass: process.env.SMTP_PASS || "",
  dest: process.env.MODERATION_EMAIL || "contact.ramygasy@gmail.com",
};

function envoyerEmail(sujet, corps) {
  // Render bloque les ports SMTP (25/465/587) : on passe par une API HTTPS (Brevo, port 443).
  // Le SMTP brut reste disponible en secours pour un hébergeur qui ne bloque pas.
  const cleApi = process.env.BREVO_API_KEY || "";
  if (cleApi) {
    fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": cleApi, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { name: "Ramy Gasy", email: process.env.EMAIL_FROM || SMTP.dest },
        to: [{ email: SMTP.dest }],
        subject: sujet,
        textContent: String(corps),
      }),
    })
      .then((r) => {
        if (!r.ok) r.text().then((t) => console.error("Email (API Brevo) refusé:", r.status, t.slice(0, 300)));
        else console.log("Email de signalement envoyé ✔ (API)");
      })
      .catch((e) => console.error("Email (API Brevo) non envoyé:", e.message));
    return;
  }
  if (!SMTP.pass) return; // non configuré : les signalements restent consultables sur /moderation.html
  const net = require("net"), tls = require("tls");
  const enc = (s) => Buffer.from(s, "utf8").toString("base64");
  const message =
    "From: Ramy Gasy <" + SMTP.user + ">\r\nTo: " + SMTP.dest +
    "\r\nSubject: =?UTF-8?B?" + enc(sujet) + "?=" +
    "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" +
    String(corps).replace(/\r?\n\./g, "\n..") + "\r\n."; // un point seul en début de ligne fermerait le message
  const dialogue = [
    "EHLO ramygasy", "AUTH LOGIN", enc(SMTP.user), enc(SMTP.pass),
    "MAIL FROM:<" + SMTP.user + ">", "RCPT TO:<" + SMTP.dest + ">", "DATA", message, "QUIT",
  ];

  // TLS d'emblée (465) ou connexion claire puis STARTTLS (587). Forçable par SMTP_TLS=direct|starttls.
  const direct = process.env.SMTP_TLS ? process.env.SMTP_TLS === "direct" : SMTP.port === 465;
  let etapes = direct ? dialogue.slice() : ["EHLO ramygasy", "STARTTLS"];
  let i = 0, tampon = "", chiffre = direct, sock;

  // Une réponse SMTP peut tenir sur plusieurs lignes : « 250-… » annonce une suite,
  // « 250 … » est la ligne finale. On n'avance qu'à la ligne finale, sinon le dialogue
  // se désynchronise (les serveurs répondent en plusieurs lignes à EHLO).
  function brancher(s) {
    sock = s;
    s.setTimeout(20000, () => { console.error("Email de signalement : délai dépassé (le serveur SMTP ne répond pas — port bloqué ?)"); s.destroy(); });
    s.on("error", (e) => console.error("Email de signalement non envoyé:", (e && e.code) || "?", (e && e.message) || "(sans message)", e));
    s.on("data", (buf) => {
      if (process.env.SMTP_DEBUG) console.log("SMTP <", buf.toString().trim().slice(0, 200)); // dialogue visible avec SMTP_DEBUG=1
      tampon += buf.toString();
      const lignes = tampon.split(/\r?\n/);
      tampon = lignes.pop() || "";
      for (const ligne of lignes) {
        if (!/^\d{3} /.test(ligne)) continue; // ligne intermédiaire : on attend la fin
        const code = parseInt(ligne.slice(0, 3), 10);
        if (code >= 400) { console.error("Email de signalement refusé par le serveur :", ligne); s.destroy(); return; }
        // Réponse au STARTTLS : on passe la connexion en chiffré, puis on reprend le dialogue
        if (!chiffre && i >= etapes.length) {
          chiffre = true;
          const sur = tls.connect({ socket: s, servername: SMTP.host }, () => {
            etapes = dialogue.slice(); i = 1; tampon = "";
            sur.write(etapes[0] + "\r\n"); // après l'upgrade, pas de salutation : on relance l'EHLO
          });
          brancher(sur);
          return;
        }
        if (i >= etapes.length) { if (process.env.SMTP_DEBUG) console.log("SMTP : dialogue terminé, email transmis"); s.end(); return; }
        if (process.env.SMTP_DEBUG) console.log("SMTP >", i === 3 ? "(mot de passe)" : etapes[i].slice(0, 60));
        s.write(etapes[i++] + "\r\n");
      }
    });
  }

  brancher(direct ? tls.connect(SMTP.port, SMTP.host, () => {}) : net.connect(SMTP.port, SMTP.host));
}

app.use("/signaler", express.json({ limit: "4kb" }));
app.post("/signaler", (req, res) => {
  if (tropDEssais(req, res)) return;
  const { cible, motif, details, par } = req.body || {};
  const cibleP = String(cible || "").trim().slice(0, 20);
  if (!cibleP) return res.status(400).json({ erreur: "Indique le pseudo du joueur concerné." });
  if (!MOTIFS.includes(String(motif))) return res.status(400).json({ erreur: "Motif invalide." });
  if (signalements.length >= 2000) signalements.shift();
  // Le compte visé est retrouvé par son pseudo (c'est ce que voit le joueur qui signale)
  const vise = [...comptes.values()].find((c) => c.pseudo.toLowerCase() === cibleP.toLowerCase());
  const s = {
    id: crypto.randomBytes(6).toString("hex"),
    cible: vise ? vise.code : null, pseudoCible: cibleP,
    motif: String(motif), details: String(details || "").slice(0, 500),
    par: String(par || "").slice(0, 20) || "anonyme",
    at: Date.now(), traite: false,
  };
  signalements.push(s);
  saveSignalements();
  envoyerEmail(
    "Ramy Gasy — signalement : " + MOTIFS_LISIBLES[s.motif],
    "Joueur signalé : " + s.pseudoCible + (vise ? " (compte " + vise.code + ")" : " (compte introuvable)") +
    "\nMotif : " + MOTIFS_LISIBLES[s.motif] +
    "\nSignalé par : " + s.par +
    "\nDate : " + new Date(s.at).toLocaleString("fr-FR") +
    "\n\nDétails :\n" + (s.details || "(aucun)") +
    "\n\nPage de modération : " + (process.env.RENDER_EXTERNAL_URL || "") + "/moderation.html"
  );
  res.json({ ok: true });
});

// ---------- « Nous contacter » : suggestions, bugs, questions ----------
// Les messages empruntent le circuit des signalements : stockés au même endroit,
// visibles sur /moderation.html et comptés dans l'alerte du tableau de bord.
app.use("/contact", express.json({ limit: "4kb" }));
app.post("/contact", (req, res) => {
  if (tropDEssais(req, res)) return;
  const { motif, message, par } = req.body || {};
  const m = ["suggestion", "probleme", "question"].includes(String(motif)) ? String(motif) : "message";
  const texte = String(message || "").trim().slice(0, 1000);
  if (!texte) return res.status(400).json({ erreur: "Écris ton message avant d'envoyer." });
  if (signalements.length >= 2000) signalements.shift();
  const s = {
    id: crypto.randomBytes(6).toString("hex"),
    cible: null, pseudoCible: "✉️ Nous contacter",
    motif: m, details: texte,
    par: String(par || "").slice(0, 20) || "anonyme",
    at: Date.now(), traite: false,
  };
  signalements.push(s);
  saveSignalements();
  envoyerEmail(
    "Ramy Gasy — " + MOTIFS_LISIBLES[m],
    "De : " + s.par +
    "\nDate : " + new Date(s.at).toLocaleString("fr-FR") +
    "\n\nMessage :\n" + texte +
    "\n\nPage de modération : " + (process.env.RENDER_EXTERNAL_URL || "") + "/moderation.html"
  );
  res.json({ ok: true });
});

// --- Routes d'administration (protégées par STATS_KEY) ---
function adminOk(req, res) {
  const cle = String(req.query.cle || (req.body && req.body.cle) || "");
  if (!STATS_KEY || cle !== STATS_KEY) { res.status(403).json({ erreur: "Accès refusé." }); return false; }
  return true;
}

// Résumé pour le tableau de bord admin : /admin/resume?cle=CLE
app.get("/admin/resume", (req, res) => {
  if (!adminOk(req, res)) return;
  const now = Date.now();
  let nouveaux24h = 0, actifs7j = 0;
  for (const c of comptes.values()) {
    if (now - (c.createdAt || 0) < 86400000) nouveaux24h++;
    if (now - (c.lastSeen || 0) < 7 * 86400000) actifs7j++;
  }
  const d = new Date();
  const cleJour = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  res.json({
    comptes: { total: comptes.size, nouveaux24h, actifs7j },
    signalements: { total: signalements.length, aTraiter: signalements.filter((s) => !s.traite).length },
    defiJour: (defiScores.get(cleJour) || new Map()).size,
    defisPrives: defisPrives.size,
    salons: rooms.size,
    emailConfigure: Boolean(process.env.BREVO_API_KEY || SMTP.pass),
  });
});

// Test de la configuration email (admin) : /moderation/test-email?cle=CLE
app.get("/moderation/test-email", (req, res) => {
  if (!adminOk(req, res)) return;
  if (!process.env.BREVO_API_KEY && !SMTP.pass) return res.json({ ok: false, info: "Ni BREVO_API_KEY ni SMTP_PASS ne sont définis — aucun envoi possible." });
  envoyerEmail("Test Ramy Gasy ✔", "Si tu lis ceci, l'envoi d'emails de signalement fonctionne.\nEnvoyé le " + new Date().toISOString());
  res.json({ ok: true, info: "Tentative d'envoi lancée vers " + SMTP.dest + " (expéditeur " + SMTP.user + "). Vérifie ta boîte (et les spams) ainsi que les logs Render en cas d'échec." });
});

app.get("/moderation/liste", (req, res) => {
  if (!adminOk(req, res)) return;
  res.json({
    signalements: [...signalements].reverse().slice(0, 200).map((s) => {
      const c = s.cible ? comptes.get(s.cible) : null;
      return { ...s, motifLisible: MOTIFS_LISIBLES[s.motif] || s.motif,
        existe: Boolean(c), banni: Boolean(c && c.banni), aPhoto: Boolean(c && c.photo) };
    }),
  });
});

app.use("/moderation", express.json({ limit: "4kb" }));
app.post("/moderation/action", (req, res) => {
  if (!adminOk(req, res)) return;
  const { action, code, id } = req.body || {};
  if (action === "traiter") {
    const s = signalements.find((x) => x.id === id);
    if (!s) return res.status(404).json({ erreur: "Signalement introuvable." });
    s.traite = true; saveSignalements();
    return res.json({ ok: true });
  }
  const c = comptes.get(String(code || "").trim());
  if (!c) return res.status(404).json({ erreur: "Compte introuvable." });
  if (action === "bannir") {
    c.banni = true;
    for (const jour of defiScores.values()) jour.delete(c.code);   // retire ses scores des classements
    for (const d of defisPrives.values()) delete d.scores[c.code];
    saveComptes(); saveDefi(); saveDefisPrives();
    return res.json({ ok: true, message: "Compte banni et retiré des classements." });
  }
  if (action === "debannir") { c.banni = false; saveComptes(); return res.json({ ok: true, message: "Compte réactivé." }); }
  if (action === "renommer") {
    c.pseudo = "Joueur" + crypto.randomInt(1000, 10000);
    c.renamedAt = null; // le joueur pourra choisir un nouveau pseudo correct sans attendre
    for (const jour of defiScores.values()) { const e = jour.get(c.code); if (e) e.pseudo = c.pseudo; }
    for (const d of defisPrives.values()) if (d.scores[c.code]) d.scores[c.code].pseudo = c.pseudo;
    saveComptes(); saveDefi(); saveDefisPrives();
    return res.json({ ok: true, message: "Pseudo remplacé par « " + c.pseudo + " »." });
  }
  if (action === "photo") { c.photo = null; saveComptes(); return res.json({ ok: true, message: "Photo supprimée." }); }
  res.status(400).json({ erreur: "Action inconnue." });
});

// ---------- Partie solo en cours liée au compte (reprise sur n'importe quel appareil) ----------
app.post("/compte/sauvegarde", (req, res) => {
  if (tropDEssais(req, res)) return;
  const { code, g } = req.body || {};
  const c = typeof code === "string" && /^[0-9]{6}$/.test(code.trim()) ? comptes.get(code.trim()) : null;
  if (!c) return res.status(404).json({ erreur: "Code inexistant." });
  if (g === null || g === undefined) {
    delete c.partieSolo; // partie terminée ou abandonnée
  } else {
    const taille = JSON.stringify(g).length;
    if (taille > 100000) return res.status(400).json({ erreur: "Sauvegarde trop lourde." });
    c.partieSolo = { g, maj: Date.now() };
  }
  c.lastSeen = Date.now();
  saveComptes();
  res.json({ ok: true });
});

app.post("/compte/reprendre", (req, res) => {
  if (tropDEssais(req, res)) return;
  const { code } = req.body || {};
  const c = typeof code === "string" && /^[0-9]{6}$/.test(code.trim()) ? comptes.get(code.trim()) : null;
  if (!c) return res.status(404).json({ erreur: "Code inexistant." });
  if (!c.partieSolo || Date.now() - c.partieSolo.maj > 7 * 86400000) return res.json({ g: null }); // 7 jours max
  res.json({ g: c.partieSolo.g, maj: c.partieSolo.maj });
});

// Salon multijoueur en cours du compte (repris automatiquement sur tout appareil)
app.post("/compte/salon", (req, res) => {
  if (tropDEssais(req, res)) return;
  const { code } = req.body || {};
  const c = typeof code === "string" && /^[0-9]{6}$/.test(code.trim()) ? comptes.get(code.trim()) : null;
  if (!c) return res.status(404).json({ erreur: "Code inexistant." });
  if (c.salonEnCours) {
    const room = rooms.get(c.salonEnCours);
    const siege = room && room.players.find((p) => p.compte === c.code);
    if (room && siege) {
      return res.json({
        salon: room.code,
        hote: room.players[0] ? room.players[0].name : "?",
        joueurs: room.players.filter((p) => !p.isBot).length,
        enPartie: room.state === "playing",
      });
    }
    delete c.salonEnCours; // salon disparu : on oublie
    saveComptes();
  }
  res.json({ salon: null });
});

// ---------- Enregistrement d'une partie terminée (comptage par deltas) ----------
// Chaque partie est envoyée individuellement : le comptage reste juste même si le joueur
// est connecté sur deux appareils en même temps (l'ancienne synchro par cumuls prenait le max).
app.post("/compte/partie", (req, res) => {
  if (tropDEssais(req, res)) return;
  const { code, mode, win, score, dureeMs, manches, succes } = req.body || {};
  const c = typeof code === "string" && /^[0-9]{6}$/.test(code.trim()) ? comptes.get(code.trim()) : null;
  if (!c) return res.status(404).json({ erreur: "Code inexistant." });
  if (c.banni) return res.status(403).json({ erreur: MESSAGE_BANNI });
  if (mode !== "solo" && mode !== "mp") return res.status(400).json({ erreur: "Mode invalide." });
  c.stats = c.stats || {};
  const b = mode === "mp" ? (c.stats.mp = c.stats.mp || {}) : c.stats;
  const w = Boolean(win);
  b.games = (b.games || 0) + 1;
  if (w) b.wins = (b.wins || 0) + 1;
  b.streak = w ? (b.streak || 0) + 1 : 0;
  b.bestStreak = Math.max(b.bestStreak || 0, b.streak);
  const sc = Math.max(0, Math.min(5000, parseInt(score, 10) || 0));
  b.sumScore = (b.sumScore || 0) + sc;
  if (w) b.bestScore = b.bestScore == null ? sc : Math.min(b.bestScore, sc);
  const dur = parseInt(dureeMs, 10);
  if (w && isFinite(dur) && dur > 30000 && dur < 24 * 3600000)
    b.fastestWinMs = b.fastestWinMs == null ? dur : Math.min(b.fastestWinMs, dur);
  if (Array.isArray(manches)) {
    manches.slice(0, 10).forEach((m) => {
      const pts = parseInt(m && m.pts, 10);
      if (!isFinite(pts) || pts < -1000 || pts > 1000) return;
      b.bestManche = b.bestManche == null ? pts : Math.min(b.bestManche, pts);
      b.contracts = b.contracts || {};
      const label = String((m && m.label) || "?").slice(0, 30);
      if (!b.contracts[label] && Object.keys(b.contracts).length >= 20) return; // borne mémoire
      const cc = b.contracts[label] || { n: 0, sum: 0 };
      cc.n += 1; cc.sum += pts;
      b.contracts[label] = cc;
    });
  }
  c.stats = cleanStats(c.stats);
  const succesAvant = nbSucces(c.succes);
  if (succes) c.succes = mergeSucces(c.succes, cleanSucces(succes));
  // Pièces : partie + victoire (plafonnées par jour), succès nouveaux, série quotidienne
  const payee = partieRecompensee(c);
  const gains = {
    partie: payee ? PIECES.partie : 0,
    victoire: payee && w ? PIECES.victoire : 0,
    succes: (nbSucces(c.succes) - succesAvant) * PIECES.succes,
  };
  const serie = majSerie(c);
  gains.serie = serie.gain;
  gains.serieJours = serie.jours;
  gains.total = gains.partie + gains.victoire + gains.succes + gains.serie;
  crediterPieces(c, gains.total - gains.serie); // la série est déjà créditée par majSerie
  c.lastSeen = Date.now();
  saveComptes();
  res.json({ stats: c.stats, succes: c.succes || {}, pieces: c.pieces || 0, gains });
});

// ---------- Dépense de pièces (aide payante, boutique à venir) ----------
app.post("/compte/depenser", (req, res) => {
  if (tropDEssais(req, res)) return;
  const { code, montant } = req.body || {};
  const c = typeof code === "string" && /^[0-9]{6}$/.test(code.trim()) ? comptes.get(code.trim()) : null;
  if (!c) return res.status(404).json({ erreur: "Code inexistant." });
  if (c.banni) return res.status(403).json({ erreur: MESSAGE_BANNI });
  const m = parseInt(montant, 10);
  if (!isFinite(m) || m < 1 || m > 500) return res.status(400).json({ erreur: "Montant invalide." });
  if ((c.pieces || 0) < m) return res.status(400).json({ erreur: "Pas assez de pièces." });
  c.pieces -= m;
  c.lastSeen = Date.now();
  saveComptes();
  res.json({ pieces: c.pieces });
});

// ---------- Défi du jour : classement mondial ----------
// Un score par compte et par jour (le PREMIER essai seul compte — même donne pour tous,
// rejouer pour améliorer serait tricher). Classement : victoires d'abord, puis petit total.
const DEFI_FILE = process.env.DEFI_FILE || path.join(__dirname, "defi-save.json");
const defiScores = new Map(); // "AAAA-MM-JJ" → Map(code → { pseudo, total, won, at })
let defiTimer = null;
function saveDefi() {
  clearTimeout(defiTimer);
  defiTimer = setTimeout(() => {
    // Sérialisation + purge des jours de plus d'une semaine
    const limite = Date.now() - 8 * 86400000;
    const out = {};
    for (const [date, jour] of defiScores) {
      const t = new Date(date + "T12:00:00Z").getTime();
      if (isFinite(t) && t < limite) { defiScores.delete(date); continue; }
      out[date] = Object.fromEntries(jour);
    }
    storage.save("defi", out, DEFI_FILE).catch((e) => console.error("Sauvegarde défi impossible:", e.message));
  }, 1000);
}

// ---------- Jetons de partie : preuve qu'un défi a réellement été joué ----------
// Sans cela, les scores sont simplement déclarés par le client : une requête suffit pour
// s'annoncer premier mondial sans avoir joué. Le jeton est délivré au DÉBUT de la partie et
// exigé à la soumission : il faut donc avoir ouvert le défi, et avoir mis un temps plausible.
// Cela n'arrête pas un attaquant déterminé (le jeu tourne chez le joueur), mais élimine la
// triche opportuniste — celle qui, elle, arriverait à coup sûr.
const jetons = new Map(); // jeton → { compte, cible, emisA }
const JETON_VIE_MS = 6 * 3600 * 1000;     // une partie peut être commencée puis finie plus tard
// Durée minimale d'une partie de défi. En dessous, personne n'a joué honnêtement.
// Ajustable par variable d'environnement (PARTIE_MIN_S) si les parties courtes s'avèrent
// plus rapides que prévu chez les joueurs rapides.
const PARTIE_MIN_MS = (parseInt(process.env.PARTIE_MIN_S, 10) || 45) * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [j, v] of jetons) if (now - v.emisA > JETON_VIE_MS) jetons.delete(j);
}, 10 * 60 * 1000);

// Le client appelle cette route au lancement d'un défi (du jour ou entre amis)
app.post("/defi/commencer", (req, res) => {
  if (tropDEssais(req, res) || bloquePourEchecs(req, res)) return;
  const { code, cible } = req.body || {};
  const c = typeof code === "string" && /^[0-9]{6}$/.test(code.trim()) ? comptes.get(code.trim()) : null;
  if (!c) { noteEchecCode(req); return res.status(403).json({ erreur: "Compte requis." }); }
  if (typeof cible !== "string" || !cible || cible.length > 40) return res.status(400).json({ erreur: "Défi invalide." });
  if (jetons.size > 200000) return res.status(503).json({ erreur: "Serveur occupé — réessaie." });
  const jeton = crypto.randomBytes(16).toString("hex");
  jetons.set(jeton, { compte: c.code, cible, emisA: Date.now() });
  res.json({ jeton });
});

// Vérifie et consomme un jeton. Renvoie un message d'erreur, ou null si tout va bien.
function consommeJeton(jeton, compteCode, cible) {
  if (typeof jeton !== "string" || !jeton) return "Partie non reconnue — relance le défi depuis l'accueil.";
  const v = jetons.get(jeton);
  if (!v) return "Partie expirée ou déjà enregistrée.";
  if (v.compte !== compteCode || v.cible !== cible) return "Partie non reconnue.";
  const duree = Date.now() - v.emisA;
  if (duree > JETON_VIE_MS) { jetons.delete(jeton); return "Partie trop ancienne — le score n'a pas pu être enregistré."; }
  if (duree < PARTIE_MIN_MS) return "Partie trop rapide pour être enregistrée.";
  jetons.delete(jeton); // usage unique
  return null;
}

app.post("/defi/score", (req, res) => {
  if (tropDEssais(req, res) || bloquePourEchecs(req, res)) return;
  const { code, date, total, won } = req.body || {};
  const c = typeof code === "string" && /^[0-9]{6}$/.test(code.trim()) ? comptes.get(code.trim()) : null;
  if (!c) { noteEchecCode(req); return res.status(403).json({ erreur: "Compte requis pour entrer au classement." }); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return res.status(400).json({ erreur: "Date invalide." });
  const dC = new Date(date + "T12:00:00Z").getTime();
  if (!isFinite(dC) || Math.abs(Date.now() - dC) > 36 * 3600 * 1000) return res.status(400).json({ erreur: "Ce défi est clos." });
  let jour = defiScores.get(date);
  if (!jour) { jour = new Map(); defiScores.set(date, jour); }
  if (jour.has(c.code)) return res.json({ ok: true, deja: true }); // seul le premier essai compte
  if (jour.size >= 100000) return res.status(503).json({ erreur: "Classement complet." });
  const pb = consommeJeton(req.body && req.body.jeton, c.code, "jour-" + date);
  if (pb) return res.status(403).json({ erreur: pb });
  jour.set(c.code, { pseudo: c.pseudo, total: Math.max(0, Math.min(5000, parseInt(total, 10) || 0)), won: Boolean(won), at: Date.now() });
  saveDefi();
  // Pièces du défi (le premier essai seul compte, donc pas de farm possible ici)
  const gains = { defi: PIECES.defi, victoire: won ? PIECES.defiVictoire : 0 };
  const serie = majSerie(c);
  gains.serie = serie.gain;
  gains.serieJours = serie.jours;
  gains.total = gains.defi + gains.victoire + gains.serie;
  crediterPieces(c, gains.defi + gains.victoire);
  saveComptes();
  res.json({ ok: true, pieces: c.pieces || 0, gains });
});

app.get("/defi/classement", (req, res) => {
  const date = String(req.query.date || "");
  const jour = defiScores.get(date);
  const entries = jour ? [...jour.entries()].map(([code, e]) => ({ code, ...e })) : [];
  entries.sort((a, b) => ((b.won ? 1 : 0) - (a.won ? 1 : 0)) || (a.total - b.total) || (a.at - b.at));
  const moiCode = String(req.query.code || "").trim();
  const rang = moiCode ? entries.findIndex((e) => e.code === moiCode) + 1 : 0;
  res.json({
    date, participants: entries.length,
    top: entries.slice(0, 20).map((e, i) => ({ rang: i + 1, pseudo: e.pseudo, total: e.total, won: e.won })),
    rang: rang || null,
  });
});

// ---------- Défis entre amis : même donne pour tous les participants ----------
// Le créateur obtient un code à 5 caractères + une graine secrète ; chaque participant
// joue la MÊME distribution (graine) et le premier essai seul compte. Expire après 7 jours.
const DEFIS_PRIVES_FILE = process.env.DEFIS_PRIVES_FILE || path.join(__dirname, "defis-prives-save.json");
const defisPrives = new Map(); // id → { graine, createur, createdAt, scores: { codeCompte: { pseudo, total, won, at } } }
let defisPrivesTimer = null;
function saveDefisPrives() {
  clearTimeout(defisPrivesTimer);
  defisPrivesTimer = setTimeout(() => {
    const limite = Date.now() - 8 * 86400000;
    for (const [id, d] of defisPrives) if (d.createdAt < limite) defisPrives.delete(id);
    storage.save("defis-prives", Object.fromEntries(defisPrives), DEFIS_PRIVES_FILE)
      .catch((e) => console.error("Sauvegarde défis privés impossible:", e.message));
  }, 1000);
}
function genDefiId() {
  const lettres = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let id = "";
  do { id = ""; for (let i = 0; i < 5; i++) id += lettres[crypto.randomInt(lettres.length)]; } while (defisPrives.has(id));
  return id;
}

app.post("/defi/creer", (req, res) => {
  if (tropDEssais(req, res) || bloquePourEchecs(req, res)) return;
  const code = String((req.body && req.body.code) || "").trim();
  const c = /^[0-9]{6}$/.test(code) ? comptes.get(code) : null;
  if (!c) { noteEchecCode(req); return res.status(403).json({ erreur: "Compte requis pour créer un défi." }); }
  if (defisPrives.size >= 20000) return res.status(503).json({ erreur: "Trop de défis en cours — réessaie plus tard." });
  const id = genDefiId();
  defisPrives.set(id, { graine: id + "-" + crypto.randomBytes(6).toString("hex"), createur: c.pseudo, createdAt: Date.now(), scores: {} });
  saveDefisPrives();
  res.json({ id });
});

app.get("/defi/prive", (req, res) => {
  const id = String(req.query.id || "").trim().toUpperCase();
  const d = defisPrives.get(id);
  if (!d) return res.status(404).json({ erreur: "Défi introuvable — vérifie le code (il expire après 7 jours)." });
  const entries = Object.keys(d.scores).map((k) => ({ code: k, ...d.scores[k] }));
  entries.sort((a, b) => ((b.won ? 1 : 0) - (a.won ? 1 : 0)) || (a.total - b.total) || (a.at - b.at));
  const moiCode = String(req.query.code || "").trim();
  const rang = moiCode ? entries.findIndex((e) => e.code === moiCode) + 1 : 0;
  res.json({
    id, createur: d.createur, graine: d.graine,
    joursRestants: Math.max(0, Math.ceil((d.createdAt + 7 * 86400000 - Date.now()) / 86400000)),
    participants: entries.length,
    top: entries.slice(0, 20).map((e, i) => ({ rang: i + 1, pseudo: e.pseudo, total: e.total, won: e.won })),
    rang: rang || null,
    dejaJoue: Boolean(moiCode && d.scores[moiCode]),
  });
});

app.post("/defi/prive-score", (req, res) => {
  if (tropDEssais(req, res) || bloquePourEchecs(req, res)) return;
  const { code, id, total, won } = req.body || {};
  const c = typeof code === "string" && /^[0-9]{6}$/.test(code.trim()) ? comptes.get(code.trim()) : null;
  if (!c) { noteEchecCode(req); return res.status(403).json({ erreur: "Compte requis pour entrer aux résultats." }); }
  const d = defisPrives.get(String(id || "").trim().toUpperCase());
  if (!d) return res.status(404).json({ erreur: "Défi introuvable ou expiré." });
  if (Date.now() - d.createdAt > 7 * 86400000) return res.status(400).json({ erreur: "Ce défi est clos." });
  if (d.scores[c.code]) return res.json({ ok: true, deja: true }); // premier essai seul compté
  if (Object.keys(d.scores).length >= 500) return res.status(503).json({ erreur: "Défi complet." });
  const pb = consommeJeton(req.body && req.body.jeton, c.code, "ami-" + String(id || "").trim().toUpperCase());
  if (pb) return res.status(403).json({ erreur: pb });
  d.scores[c.code] = { pseudo: c.pseudo, total: Math.max(0, Math.min(5000, parseInt(total, 10) || 0)), won: Boolean(won), at: Date.now() };
  saveDefisPrives();
  // Pièces du défi entre amis (le premier essai seul compte : pas de farm possible)
  const gains = { defi: PIECES.defiAmi, victoire: won ? PIECES.defiAmiVictoire : 0 };
  const serie = majSerie(c);
  gains.serie = serie.gain;
  gains.serieJours = serie.jours;
  gains.total = gains.defi + gains.victoire + gains.serie;
  crediterPieces(c, gains.defi + gains.victoire);
  saveComptes();
  res.json({ ok: true, pieces: c.pieces || 0, gains });
});

// Lookup par code seul (pour reconnexion multi-appareil) : retourne le compte complet si code valide
app.post("/compte/info", (req, res) => {
  if (tropDEssais(req, res) || bloquePourEchecs(req, res)) return;
  const code = (req.body && req.body.code) || "";
  if (!/^[0-9]{6}$/.test(String(code).trim())) return res.status(400).json({ erreur: "Code invalide." });
  const c = comptes.get(String(code).trim());
  if (!c) { noteEchecCode(req); return res.status(404).json({ erreur: "Code inexistant." }); }
  if (c.banni) return res.status(403).json({ erreur: MESSAGE_BANNI });
  c.lastSeen = Date.now(); saveComptes();
  res.json(compteJson(c));
});

app.post("/compte/stats", (req, res) => {
  if (tropDEssais(req, res) || bloquePourEchecs(req, res)) return; // ce verrou manquait sur cette route
  const c = trouveCompte(req);
  if (!c) { noteEchecCode(req); return res.status(404).json({ erreur: "Pseudo ou code incorrect." }); }
  c.stats = mergeStats(c.stats, cleanStats(req.body.stats));
  c.succes = mergeSucces(c.succes, cleanSucces(req.body.succes));
  c.lastSeen = Date.now(); saveComptes();
  res.json({ stats: c.stats, succes: c.succes });
});

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

// Moteur et hôte de partie partagés (utilisés par le multijoueur local de l'app ; à la racine du projet).
// Le moteur est encapsulé : chargé tel quel, ses constantes globales (SUITS…) entreraient en
// collision avec celles du client et feraient planter toute la page.
const engineNavigateur = "// Version navigateur (portée isolée) — générée depuis engine.js\n" +
  "(function(){var module={exports:{}};\n" +
  require("fs").readFileSync(path.join(__dirname, "engine.js"), "utf8") +
  "\n})();\n";
app.get("/lib/engine.js", (req, res) => { res.type("application/javascript").send(engineNavigateur); });
app.get("/lib/gamehost.js", (req, res) => res.sendFile(path.join(__dirname, "gamehost.js")));

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
// Contrat courant d'une partie : tient compte des manches aléatoires du mode court
function contratCourant(g) { return (g.manches || E.MANCHES)[g.mancheIdx]; }

function createRoom(hostName, options) {
  const code = genCode();
  const room = {
    code,
    state: "lobby", // lobby | playing | roundEnd | over
    options: {
      turnSeconds: [45, 60, 90].includes(options?.turnSeconds) ? options.turnSeconds : 45,
      level: ["facile", "moyen", "difficile"].includes(options?.level) ? options.level : "moyen",
      shortMode: options?.shortMode === true, // Mode court : 3 manches au lieu de 8
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

// Nom saisi dans un salon multijoueur (mode invité) : visible de toute la table.
// Pas de canal d'erreur ici, donc un nom refusé est simplement remplacé.
function sanitizeName(n) {
  const propre = sanitizeNameBrut(n);
  return MOD.verifierPseudo(propre) ? "Joueur" : propre;
}
function sanitizeNameBrut(n) {
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
  if (mancheIdx === 0) room.startedAt = Date.now(); // début de partie (chrono affiché aux joueurs)
  const deck = E.buildDeck();
  room.players.forEach((p) => {
    p.hand = deck.splice(0, 13);
    p.posed = false; p.buysLeft = E.MAX_ACHATS; p.lastTaken = null; p.justPosed = false; p.timeouts = 0;
  });
  // Mode court : 3 manches aléatoires parmi les 7 premières (exclut Pose-tout)
  let manchesFinales = room.game?.manches; // Garde les manches si on passe à la manche suivante
  if (!manchesFinales) {
    if (room.options.shortMode) {
      const indices = [];
      for (let i = 0; i < 7; i++) indices.push(i); // 0-6 (exclut 7 = Pose-tout)
      manchesFinales = [];
      for (let i = 0; i < 3 && indices.length > 0; i++) {
        const idx = Math.floor(Math.random() * indices.length);
        manchesFinales.push(E.MANCHES[indices[idx]]);
        indices.splice(idx, 1);
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
    phase: "draw", // draw | play | buyWindow
    buyRequests: [],
    lastDiscarderIdx: null,
    history: room.game ? room.game.history : [],
    log: [`— Manche ${mancheIdx + 1} : ${manchesFinales[mancheIdx].label} —`],
    turnDeadline: null,
    roundOver: null,
    shortMode: room.options.shortMode, // Mode court : 3 manches au lieu de 8
    manches: manchesFinales, // Manches à jouer (8 normales ou 3 aléatoires)
  };
  room.state = "playing";
  log(room, `La manche ${mancheIdx + 1} commence (contrat : ${manchesFinales[mancheIdx].label})`);
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
        contract: contratCourant(g),
        nbManches: (g.manches || E.MANCHES).length, // 3 en mode court, 8 sinon
        startedAt: room.startedAt || null, // chrono de partie
        serverNow: Date.now(),             // pour aligner l'horloge du client
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

// Manche insolvable : la pioche a été recyclée 3 fois sans vainqueur (les cartes restantes
// ne complètent plus rien — tous posés, mains bloquées). Règle « pioche épuisée » :
// la main la plus légère gagne la manche. Sans cela, la manche serait mathématiquement infinie.
function endStalemate(room) {
  const g = room.game;
  if (!g || g.roundOver) return;
  clearTimers(room);
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
  log(room, "🔚 Pioche épuisée 3 fois : fin de manche — la main la plus légère (" + room.players[winnerIdx].name + ") l'emporte");
  if (room.state === "over") {
    const champ = room.players.reduce((a, b) => (b.total < a.total ? b : a));
    champ.wins = (champ.wins || 0) + 1;
    log(room, "👑 " + champ.name + " remporte la partie !");
  }
  broadcast(room);
}

// ---------- Gestion des tours et du minuteur ----------
function startTurn(room) {
  const g = room.game;
  if ((g.recycles || 0) >= 3) { endStalemate(room); return; }
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
    g.recycles = (g.recycles || 0) + 1; // compteur anti-manche-infinie
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
  const contract = contratCourant(g);
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
    g.recycles = (g.recycles || 0) + 1; // compteur anti-manche-infinie
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
    if (bBuyer != null && !(nextP && wantsTop(nextP, top, room.options.level, contratCourant(g)) && !nextIsHuman)) doBuy(room, bBuyer);
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
    wantsTop(nextP, g.discard[g.discard.length - 1], room.options.level, contratCourant(g));
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
  g.history.push({ mancheIdx: g.mancheIdx, label: contratCourant(g).label, summary }); // label = contrat réel (correct même en mode court)
  g.roundOver = { winnerIdx: idx, bonusType, summary };
  const manches = g.manches || E.MANCHES;
  room.state = g.mancheIdx + 1 >= manches.length ? "over" : "roundEnd";
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
  const contract = contratCourant(g);
  const level = room.options.level;

  // Piocher ou prendre — sauf si la carte est déjà en main (phase "play" : relance du chien de garde)
  let tookNow = null; // carte prise dans la défausse CE tour-ci : interdite de re-défausse (sinon le blocage est annulé)
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
    tookNow = card;
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
    // Difficile : on RETIENT la pose pour cacher son jeu — sauf si quelqu'un a déjà posé, si la pioche
    // s'épuise, ou si un adversaire est près de finir (fin de course : on pose vite pour compléter).
    if (planOk && level === "difficile" && !contract.poseTout) {
      const othersPosed = room.players.some((q, i2) => i2 !== idx && q.posed);
      const minOpp = Math.min(...room.players.map((q, i2) => (i2 === idx ? 99 : q.hand.length)));
      const leftover = p.hand.length - plan.reduce((s, m) => s + m.cards.length, 0);
      const lowStock = g.stock.length < room.players.length * 4;
      if (!othersPosed && leftover > 3 && !lowStock && minOpp > 4) planOk = false;
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
  // Fin de course : pioche presque vide ou un adversaire près de finir
  const endgame = g.stock.length <= room.players.length * 2 || room.players.some((q, i2) => i2 !== idx && q.hand.length <= 3);
  // Joker mort : en fin de course, un joker inutilisable = 20 pts de pénalité → on le jette (perdu pour tous)
  const jokerInHand = p.hand.find((c) => c.joker);
  const deadJoker = level === "difficile" && endgame && jokerInHand &&
    (p.posed || !E.aiPlanContract(p.hand, contract, level)) ? jokerInHand : null;
  let toss;
  if (deadJoker) {
    toss = deadJoker;
  } else if (p.posed && nonJokers.length > 0) {
    // Une fois posé : se débarrasser des cartes les plus chères (limiter les points)
    toss = [...nonJokers].sort((a, b) => E.cardPoints(b) - E.cardPoints(a))[0];
  } else if (level === "difficile" && nonJokers.length > 0) {
    // Défausse défensive « zéro cadeau » : ne jamais nourrir les adversaires
    const othersTaken = (g.takenCards || []).filter((t) => t.idx !== idx).map((t) => t.card);
    const danger = (c) => {
      let d2 = 0;
      othersTaken.forEach((t) => {
        if (t.rank === c.rank) d2 += 4;                                     // un adversaire collectionne ce rang
        if (t.suit === c.suit && Math.abs(t.rank - c.rank) <= 2) d2 += 3;   // …ou cette couleur autour de ce rang
      });
      if (g.melds.some((m) => m.owner !== idx && E.validGroup(m.type, [...m.cards, c]))) d2 += 14; // complète un jeu adverse posé
      return d2;
    };
    // Utilité selon le contrat : dans une manche 100 % tris, les voisins de couleur ne valent rien (et inversement)
    const wantTri = (contract.tri || 0) > 0 || contract.poseTout;
    const wantEsc = (contract.esc || 0) > 0 || contract.poseTout;
    // COMPTAGE DE CARTES : un « début » ne vaut que si une carte qui le complète est encore disponible.
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
    // Jamais rejeter le rang qu'on vient de prendre : ça annulerait la prise (ou le blocage)
    const candidats = tookNow ? nonJokers.filter((c) => c.rank !== tookNow.rank) : nonJokers;
    toss = [...(candidats.length ? candidats : nonJokers)].sort((a, b) => (usefulness(a) + danger(a)) - (usefulness(b) + danger(b)))[0];
  } else {
    toss = E.aiDiscardChoice(p.hand, level);
  }
  doDiscard(room, idx, toss.id, false);
  broadcast(room);
}

// Compte joueur transmis à l'entrée d'un salon : pseudo authentique, anti-usurpation
function compteJoueur(code) {
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code.trim())) return null;
  const c = comptes.get(code.trim());
  return c && !c.banni ? c : null;
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
  socket.on("createRoom", ({ name, options, avatar, compte } = {}, cb) => {
    if (typeof cb !== "function") cb = () => {};
    const cptC = compteJoueur(compte);
    if (compte && !cptC) return cb({ ok: false, error: "Compte invalide ou suspendu — déconnecte-toi et réessaie." });
    if (cptC) name = cptC.pseudo; // pseudo authentique : impossible d'usurper
    // Anti-flood : borne dure sur le nombre total de salons + délai entre deux créations
    if (rooms.size >= MAX_ROOMS) return cb({ ok: false, error: "Serveur très demandé — réessaie dans quelques minutes." });
    if (Date.now() - lastCreateAt < 5000) return cb({ ok: false, error: "Doucement — attends quelques secondes avant de créer un autre salon." });
    lastCreateAt = Date.now();
    detachFromRoom();
    const room = createRoom(name, options);
    const player = addPlayer(room, name, false, avatar);
    if (cptC) { player.compte = cptC.code; cptC.salonEnCours = room.code; saveComptes(); } // jamais diffusé (publicPlayer ne l'expose pas)
    player.socketId = socket.id;
    player.connected = true;
    myRoom = room; myToken = player.token;
    socket.join(room.code);
    touch(room);
    cb({ ok: true, code: room.code, token: player.token });
    broadcast(room);
  });

  socket.on("joinRoom", ({ code, name, avatar, compte } = {}, cb) => {
    if (typeof cb !== "function") cb = () => {};
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb({ ok: false, error: "Salon introuvable. Vérifie le code." });
    if (room !== myRoom) detachFromRoom();
    const cptJ = compteJoueur(compte);
    if (compte && !cptJ) return cb({ ok: false, error: "Compte invalide ou suspendu — déconnecte-toi et réessaie." });
    if (cptJ) {
      name = cptJ.pseudo; // pseudo authentique
      const siege = room.players.find((p) => p.compte === cptJ.code);
      if (siege && siege.connected)
        return cb({ ok: false, error: "Ce compte est déjà à la table sur un autre appareil." });
      if (siege) {
        // Reprise du siège depuis un autre appareil (même en cours de partie)
        cptJ.salonEnCours = room.code; saveComptes();
        siege.socketId = socket.id;
        siege.connected = true;
        siege.absent = false;
        siege.timeouts = 0;
        myRoom = room; myToken = siege.token;
        socket.join(room.code);
        touch(room);
        log(room, siege.name + " reprend sa place depuis un autre appareil");
        cb({ ok: true, code: room.code, token: siege.token });
        broadcast(room);
        return;
      }
    }
    if (room.state !== "lobby") return cb({ ok: false, error: "La partie a déjà commencé (utilise « Reprendre » si tu en faisais partie)." });
    if (room.players.length >= 6) return cb({ ok: false, error: "Salon complet (6 joueurs max)." });
    const player = addPlayer(room, name, false, avatar);
    if (cptJ) { player.compte = cptJ.code; cptJ.salonEnCours = room.code; saveComptes(); }
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
    if (me.p.compte) { const cptL = comptes.get(me.p.compte); if (cptL && cptL.salonEnCours === myRoom.code) { delete cptL.salonEnCours; saveComptes(); } }
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
const AVATARS_POOL = ["🦁", "🐯", "🦊", "🐼", "🐸", "🦉", "🐙", "🦜", "🐢", "🦎"]; // avatars de table (uniques par salon)
const AVATARS_PROFIL = ["😎", "🤠", "🥷", "🧙", "🤖", "👽", "🧞", "🦹", "👑", "🃏"]; // avatars de profil (partagés, différents de la table)
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
    storage.save("rooms", data, SAVE_FILE).catch((e) => console.error("Sauvegarde des salons impossible:", e.message));
  } catch (e) { console.error("Sauvegarde des salons impossible:", e.message); }
}

async function loadRooms() {
  try {
    const data = await storage.load("rooms", SAVE_FILE);
    if (!Array.isArray(data)) return;
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

// Sauvegarde immédiate à l'arrêt (déploiement Render : SIGTERM avant extinction)
function flushComptes() {
  clearTimeout(comptesTimer);
  clearTimeout(defiTimer);
  const outDefi = {};
  for (const [date, jour] of defiScores) outDefi[date] = Object.fromEntries(jour);
  clearTimeout(defisPrivesTimer);
  return Promise.all([
    storage.save("comptes", [...comptes.values()], ACCOUNTS_FILE),
    storage.save("defi", outDefi, DEFI_FILE),
    storage.save("defis-prives", Object.fromEntries(defisPrives), DEFIS_PRIVES_FILE),
    storage.save("signalements", signalements, SIGNALEMENTS_FILE),
  ]).catch(() => {});
}
process.on("SIGTERM", () => { saveRooms(); Promise.resolve(flushComptes()).finally(() => setTimeout(() => process.exit(0), 800)); });
process.on("SIGINT", () => { saveRooms(); Promise.resolve(flushComptes()).finally(() => setTimeout(() => process.exit(0), 300)); });

// ---------- Démarrage : stockage d'abord, puis restauration, puis écoute ----------
(async () => {
  try {
    const mode = await storage.init();
    if (mode === "postgres") console.log("Stockage : Postgres (les comptes survivent aux déploiements)");
    else console.log("Stockage : fichiers locaux (définir DATABASE_URL pour Postgres)");
    const data = await storage.load("comptes", ACCOUNTS_FILE);
    if (Array.isArray(data)) data.forEach((c) => c && c.code && comptes.set(c.code, c));
    // Ménage des doublons historiques (avant la règle « un pseudo = un compte ») :
    // par pseudo, on garde le compte vu le plus récemment
    const parPseudo = new Map();
    let purges = 0;
    for (const c of comptes.values()) {
      const clef = (c.pseudo || "").toLowerCase();
      const autre = parPseudo.get(clef);
      if (!autre) { parPseudo.set(clef, c); continue; }
      const garde = (c.lastSeen || 0) >= (autre.lastSeen || 0) ? c : autre;
      const vire = garde === c ? autre : c;
      comptes.delete(vire.code);
      parPseudo.set(clef, garde);
      purges++;
    }
    if (purges > 0) { console.log(purges + " doublon(s) de pseudo purgé(s)"); saveComptes(); }
    if (comptes.size) console.log(comptes.size + " compte(s) chargé(s)");
    const dataDefi = await storage.load("defi", DEFI_FILE);
    if (dataDefi && typeof dataDefi === "object")
      Object.keys(dataDefi).forEach((date) => defiScores.set(date, new Map(Object.entries(dataDefi[date] || {}))));
    if (defiScores.size) console.log(defiScores.size + " jour(s) de défi chargé(s)");
    const dataPrives = await storage.load("defis-prives", DEFIS_PRIVES_FILE);
    if (dataPrives && typeof dataPrives === "object")
      Object.keys(dataPrives).forEach((id) => defisPrives.set(id, dataPrives[id]));
    if (defisPrives.size) console.log(defisPrives.size + " défi(s) privé(s) chargé(s)");
    const dataSignal = await storage.load("signalements", SIGNALEMENTS_FILE);
    if (Array.isArray(dataSignal)) dataSignal.forEach((s) => s && s.id && signalements.push(s));
    const enAttente = signalements.filter((s) => !s.traite).length;
    if (signalements.length) console.log(signalements.length + " signalement(s) chargé(s)" + (enAttente ? " — " + enAttente + " à traiter" : ""));
    await loadRooms();
  } catch (e) {
    console.error("ATTENTION — stockage indisponible, démarrage en mémoire seule :", e.message);
  }
  setInterval(saveRooms, 15000);
  server.listen(PORT, () => console.log("Serveur Ramy Gasy sur le port " + PORT));
})();
