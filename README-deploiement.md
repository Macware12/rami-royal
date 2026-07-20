# Serveur multijoueur Rami Royal — guide de mise en ligne

## Contenu
- `server.js` — le serveur (salons à code, tours, minuteur, achats hors tour, reconnexion)
- `engine.js` — le moteur de règles (le même que le jeu solo, source de vérité anti-triche)
- `package.json` — les dépendances (Express + Socket.io)
- `public/index.html` — le client multijoueur (page d'accueil du site)
- `public/solo.html` — le jeu solo contre l'IA (accessible depuis l'accueil)

## Réglages intégrés (modifiables en tête de server.js)
- Minuteur : 30/45/60 s par tour au choix de l'hôte (défaut 45 s) ; temps écoulé → pioche + défausse automatiques ; 3 timeouts → mode auto avec « Reprendre la main »
- Fenêtre d'achat : 3 s après chaque défausse, priorité dans le sens du jeu depuis le jeteur
- Déconnexion : l'IA joue à la place du joueur, sa main est conservée, reconnexion à tout moment avec le code du salon
- Départ volontaire : remplacement par l'IA jusqu'à la fin
- Salons : 3 à 6 joueurs, l'hôte peut ajouter des bots, fermeture après 2 h d'inactivité

## Mise en ligne gratuite (Render)
1. Crée un compte gratuit sur github.com, puis un nouveau dépôt (bouton « New repository », nom `rami-royal`, public)
2. Clique « uploading an existing file » et glisse `server.js`, `engine.js`, `package.json` et le dossier `public` (avec son index.html)
3. Crée un compte gratuit sur render.com → « New » → « Web Service » → connecte ton dépôt GitHub
4. Réglages : Build Command `npm install` · Start Command `npm start` · Instance Type `Free`
5. Render te donne une adresse `https://rami-royal-xxxx.onrender.com` — c'est l'adresse du jeu à partager

Note sur le plan gratuit : le serveur s'endort après 15 min sans visite et met ~1 min à se réveiller à la première connexion. Suffisant pour tester entre amis ; un plan à ~7 $/mois supprime cette limite si le jeu prend.

## Test en local (optionnel, sur ton Mac)
```
npm install
npm start
```
Puis ouvre http://localhost:3000

## Jouer
L'adresse Render EST le jeu : la première page propose « Jouer en solo contre l'IA » ou le multijoueur. Pour le multijoueur, entre ton nom, « Créer un salon », partage le code de 5 lettres à tes amis — ils le saisissent sur la même adresse et vous jouez. L'hôte peut compléter la table avec des bots. En cas de déconnexion, on revient avec « Reprendre la partie ».

## Mettre à jour une version déjà en ligne
1. Sur GitHub, remplace les fichiers du dépôt par ceux de cette archive (server.js, engine.js, package.json et TOUT le dossier public)
2. Sur Render : « Manual Deploy » → « Deploy latest commit »
Important : si la page en ligne ne montre pas le multijoueur, c'est que le dossier `public` du dépôt ne contient pas le bon index.html.
