// Prépare le dossier web embarqué dans l'app native (www-native/) :
// copie public/ puis pointe config.js vers le serveur en ligne.
// Lancer avec : npm run cap:build   (fait automatiquement par npm run cap:sync)
const fs = require("fs");
const path = require("path");

const SERVEUR = "https://rami-royal.onrender.com"; // adresse du serveur de jeu en ligne

const SRC = path.join(__dirname, "..", "public");
const DEST = path.join(__dirname, "..", "www-native");

fs.rmSync(DEST, { recursive: true, force: true });
fs.cpSync(SRC, DEST, { recursive: true });

// Dans l'app native, l'origine n'est pas le serveur : config.js doit donner l'adresse absolue
fs.writeFileSync(path.join(DEST, "config.js"),
  "// Généré par scripts/build-native.js — ne pas modifier à la main\n" +
  "window.RAMI_CONFIG = { server: \"" + SERVEUR + "\" };\n");

// Pas de service worker dans l'app native (les fichiers sont déjà embarqués ;
// un SW ne ferait que servir d'anciennes versions après une mise à jour de l'app)
fs.rmSync(path.join(DEST, "sw.js"), { force: true });

// Moteur + hôte de partie : nécessaires au multijoueur local (le téléphone hôte fait tourner la partie)
fs.copyFileSync(path.join(__dirname, "..", "engine.js"), path.join(DEST, "lib", "engine.js"));
fs.copyFileSync(path.join(__dirname, "..", "gamehost.js"), path.join(DEST, "lib", "gamehost.js"));

console.log("www-native/ prêt (serveur : " + SERVEUR + ")");
