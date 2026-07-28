# Ramy Gasy — Multijoueur hors-ligne (P2P local)

*Objectif : jouer à plusieurs, chacun sur son téléphone, sans internet (avion, camping, réseau coupé). Feuille de route technique et répartition du travail.*

---

## 1. Le principe

Aujourd'hui, c'est **le serveur** (Render) qui arbitre les parties : chaque téléphone se connecte en WebSocket, envoie ses coups, reçoit l'état du jeu.

Hors-ligne, il n'y a plus de serveur. La solution : **un des téléphones devient « l'hôte »** et fait tourner la partie localement (exactement comme le mode solo tourne déjà entièrement dans le navigateur). Les autres téléphones (« invités ») lui envoient leurs coups par un lien direct **Bluetooth / WiFi de proximité**, et reçoivent l'état en retour.

```
   AVEC INTERNET (actuel)          SANS INTERNET (à construire)

   📱 ── \                          📱 invité ──\
   📱 ──── 🖥️ serveur Render         📱 invité ──── 📱 HÔTE (fait tourner la partie)
   📱 ── /                          📱 invité ──/
```

Bonne nouvelle : **le moteur de jeu (`engine.js`) est déjà partagé** entre le serveur et les clients, et **le mode solo fait déjà tourner une partie complète en local**. L'hôte fera donc « comme le solo », mais avec de vrais joueurs à la place des bots. La logique du jeu est donc déjà à 80 % en place ; ce qui manque, c'est **le tuyau** entre les téléphones.

---

## 2. Pourquoi pas « juste du Bluetooth » ?

- Le **Bluetooth du navigateur** (Web Bluetooth) sert à parler à des objets (montre, capteur), **pas à relier deux téléphones**. Et **iOS/Safari ne le supporte pas du tout**. → Impossible dans la version web actuelle.
- La vraie voie passe par **l'application native** (chantier Capacitor) et les technologies de proximité de chaque système :
  - **iOS → Multipeer Connectivity** : l'outil d'Apple, combine automatiquement Bluetooth + WiFi direct, aucun internet requis. Idéal avion.
  - **Android → Nearby Connections** : l'équivalent Google.
- On expose ces deux briques natives derrière **une seule interface JavaScript** commune, pour que le reste du jeu ne voie aucune différence.

---

## 3. Architecture cible : un « transport » interchangeable

On introduit une couche d'abstraction unique — le **Transport** — avec 3 fonctions : `envoyer(message)`, `surReception(callback)`, `diffuser(message)`. Trois implémentations, la même logique de jeu au-dessus :

| Transport | Techno | État |
|---|---|---|
| **En ligne** | socket.io (Render) | ✅ existe déjà |
| **Local (natif)** | Multipeer (iOS) / Nearby (Android) | 🔨 à construire |
| **Boucle de test** | en mémoire, un seul onglet | 🔨 à construire (pour tester sans matériel) |

La **boucle de jeu de l'hôte** est écrite une seule fois et fonctionne au-dessus de n'importe lequel de ces transports.

---

## 4. Les phases

### Phase 0 — Application native (prérequis)
Empaqueter le jeu web actuel en app iOS + Android via **Capacitor**. Sans ça, aucun accès aux fonctions Bluetooth natives. Nécessite un **Mac avec Xcode** (iOS) et **Android Studio** (Android).

### Phase 1 — Refonte « hôte local » *(pur JavaScript, faisable et testable ici)*
Extraire la logique multijoueur du serveur dans un module **`GameHost`** indépendant de socket.io, piloté par le Transport. Ajouter un **transport « boucle de test »** qui simule plusieurs joueurs dans un seul onglet → on peut **jouer et tester une partie locale complète sans aucun matériel**. C'est l'étape qui **dérisque tout le reste**.

### Phase 2 — Le plugin natif de proximité
Un plugin Capacitor exposant une API JS unique (`avertir()`, `découvrir()`, `connecter()`, `envoyer()`, événements `pairArrivé` / `pairParti` / `données`), avec deux implémentations natives :
- **iOS** : Swift + `MultipeerConnectivity`.
- **Android** : Kotlin + `Nearby.getConnectionsClient`.

Je peux **écrire ce code natif**, mais il devra être **compilé et testé sur ton Mac** (Xcode / Android Studio) avec de vrais téléphones — je ne peux pas builder ni signer une app native depuis ici.

### Phase 3 — Salon local + intégration
Écran « partie locale » : créer une table → les joueurs à proximité apparaissent → ils rejoignent → l'hôte lance la partie via `GameHost`. Gestion des cas : **un invité se déconnecte**, **l'hôte quitte** (fin de partie propre, ou migration de l'hôte plus tard).

### Phase 4 — Tests sur vrais appareils
QA en mode avion, portée Bluetooth, reconnexions, 2 à 6 joueurs. Ajustements.

---

## 5. Qui fait quoi

| Tâche | Moi (ici) | Toi (ton Mac / tes appareils) |
|---|---|---|
| Refonte `GameHost` + transport de test (Phase 1) | ✅ code + tests | — |
| Écran salon local, logique d'intégration (Phase 3) | ✅ code | — |
| Code Swift (iOS) et Kotlin (Android) du plugin (Phase 2) | ✅ j'écris | ▶️ compiler/signer dans Xcode & Android Studio |
| Scaffold Capacitor (Phase 0) | ✅ config + commandes pas-à-pas | ▶️ exécuter sur ton Mac |
| Tests sur téléphones réels (Phase 4) | — | ▶️ toi (2+ appareils) |

En clair : **toute la partie jeu et l'interface, je les fais ici et je peux les tester.** La partie strictement native (Bluetooth) demandera quelques allers-retours où tu lances les builds sur ton Mac et me dis ce qui s'affiche.

---

## 6. Par où commencer

La Phase 1 est **100 % faisable et vérifiable ici, sans rien installer**, et c'est elle qui débloque tout le reste. Elle apporte aussi un bonus immédiat : une **partie locale jouable en test** dans le navigateur. Je propose de démarrer par là.
