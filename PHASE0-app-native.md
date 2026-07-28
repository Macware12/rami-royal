# Phase 0 — Créer l'app native Ramy Gasy (iOS + Android)

*Tout est déjà préparé dans le projet (config Capacitor, script de build, dépendances). Il ne reste que les commandes ci-dessous à exécuter sur ton Mac.*

---

## Ce qui est déjà en place

- `capacitor.config.json` — identité de l'app : **Ramy Gasy** (`com.ramygasy.app`), fond vert du jeu.
- `scripts/build-native.js` — copie le jeu web dans `www-native/` et pointe `config.js` vers le serveur en ligne (`https://rami-royal.onrender.com`) pour que le multijoueur et les comptes marchent dans l'app.
- Dépendances Capacitor installées (`@capacitor/core`, `ios`, `android`, `cli`).
- Le serveur accepte déjà les origines `capacitor://` (CORS), et les librairies (React, socket.io…) sont locales — l'app fonctionne même sans internet pour le mode solo.

## Étape 1 — iPhone (15 min)

Prérequis : Xcode installé (✅ tu viens d'accepter la licence).

```bash
cd ~/Desktop/RAMI/rami-royal-serveur
npm install
npm run cap:build
npx cap add ios
npx cap sync ios
npx cap open ios
```

Si `npx cap sync ios` se plaint de **CocoaPods** : installe-le avec `brew install cocoapods` (ou `sudo gem install cocoapods`), puis relance `npx cap sync ios`.

Dans **Xcode** qui s'ouvre :
1. Clique sur **App** (racine, panneau de gauche) → onglet **Signing & Capabilities**.
2. **Team** : choisis ton Apple ID (ajoute-le via *Xcode > Settings > Accounts* si absent). Le compte Apple **gratuit** suffit pour tester sur ton iPhone.
3. Branche ton iPhone en USB, choisis-le comme cible en haut, puis **▶ Run**.
4. Premier lancement : sur l'iPhone, va dans *Réglages > Général > VPN et gestion de l'appareil* pour faire confiance à ton certificat de développeur.

## Étape 2 — Android (optionnel, plus tard)

Prérequis : Android Studio installé.

```bash
cd ~/Desktop/RAMI/rami-royal-serveur
npm run cap:build
npx cap add android
npx cap sync android
npx cap open android
```

Dans Android Studio : attendre la synchronisation Gradle, brancher un téléphone (mode développeur + débogage USB activés), puis **▶ Run**.

## Au quotidien — mettre l'app à jour après une modif du jeu

```bash
npm run cap:sync
```

(reconstruit `www-native/` puis synchronise iOS et Android — ensuite ▶ Run dans Xcode/Android Studio)

## À savoir

- Compte Apple gratuit : l'app installée sur ton iPhone **expire au bout de 7 jours** (il suffit de relancer ▶ Run). Pour distribuer à tes amis (TestFlight) puis sur l'App Store, il faudra le compte développeur Apple à 99 $/an — on en reparle au lancement officiel, comme convenu.
- Les dossiers `ios/` et `android/` générés par `cap add` **doivent être commités** (c'est le projet natif). `www-native/` est généré à chaque build et reste hors git.
- La Phase 2 (Bluetooth/Multipeer pour jouer dans l'avion) se branchera sur ce projet natif.
