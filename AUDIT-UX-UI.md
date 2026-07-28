# Audit UX/UI — Ramy Gasy (v2256)

*Regard d'un designer produit 2026 après un parcours complet du jeu (web + app). Classé par impact.*

---

## 🎯 Les 10 priorités (impact fort, effort raisonnable)

**1. Ordre des cartes de l'accueil.** Un nouveau venu lit de haut en bas : il doit voir « Apprendre à jouer » AVANT « Jouer en solo ». Mieux : rendre l'accueil adaptatif — premier lancement = « Apprendre » en tête avec un liseré lumineux ; visites suivantes = « Jouer en solo » en tête. C'est le standard 2026 (onboarding adaptatif), et c'est 10 lignes de code (un drapeau localStorage).

**2. « Reprendre la partie en cours » est enterré.** C'est l'intention n°1 d'un joueur qui revient, et le bouton est tout en bas de l'écran solo, sous la politique de confidentialité. Il doit être EN HAUT, premier élément visible — voire directement sur la page d'accueil (carte verte « ▶ Reprendre ta partie — manche 3/8 »).

**3. L'écran solo est un formulaire, pas une invitation à jouer.** Sept décisions avant de jouer (nom, emoji, adversaires, niveau, mode…). Standard 2026 : un gros bouton « Jouer » qui reprend les derniers réglages, et les options repliées derrière un « Personnaliser ». Le taux de mise en jeu grimpe toujours avec ce pattern.

**4. Le tapis de jeu sur grand écran est vide au centre.** Sur desktop/iPad, adversaires petits en haut à gauche, immense zone verte inutilisée, main en bas : la mise en page mobile est simplement étirée. À terme : disposer les adversaires autour du tapis (comme une vraie table) et borner la largeur utile. Quick win : centrer et agrandir la zone des combinaisons posées.

**5. Démarrage à froid du serveur (web).** Render gratuit s'endort : le premier visiteur attend parfois 30-50 s devant une page blanche — mortel pour l'acquisition. Quick win : page de chargement brandée (logo + « Préparation de la table… ») affichée immédiatement. Vrai fix : offre payante Render ou hébergement à démarrage instantané au lancement officiel.

**6. Icône d'app par défaut (X bleu Capacitor).** C'est la première impression sur l'écran d'accueil du téléphone. Priorité absolue avant toute distribution, même à des amis.

**7. Textes trop petits, contrastes limites.** Beaucoup de libellés en 9-11 px (`text-[9px]`, `text-[10px]`) et de vert clair sur vert foncé sous les seuils d'accessibilité WCAG AA. Sur mobile en plein soleil (usage réel à Madagascar !), c'est illisible. Passer le minimum à 12 px et éclaircir `text-emerald-400/500` d'un cran sur les textes informatifs.

**8. Jargon pour les novices.** « Préparer ma pose », « Tri 0/2 », « 68 en pioche », « 45s/tour » : clair pour toi, opaque pour un débutant. Ajouter des micro-explications au premier contact (infobulle unique « Le tri = 3 cartes identiques » qui ne s'affiche qu'une fois), et renommer « Préparer ma pose » en quelque chose d'évident (« ✨ Classer mes cartes »).

**9. La fenêtre « Comment jouer » est un mur de texte.** Les 4 étapes numérotées sont bien ; le paragraphe compact qui suit (gestes, achats, priorités) est indigeste. Le découper en sections dépliables (« Les gestes », « L'achat », « Le joker ») avec une mini-illustration chacune.

**10. Grille d'emojis bancale.** 7 emojis sur la première ligne, 3 sur la seconde (panneau multijoueur). Une grille 5×2 régulière est plus propre — détail, mais visible à chaque partie.

---

## 🧭 Parcours et navigation

- **Après le tutoriel** (diplôme) : enchaîner sur un CTA « 🎉 Ta première vraie partie » pré-réglée en Facile/Court. Ne jamais laisser un novice retomber sur un menu.
- **Version visible sur l'accueil** (v2256-U) : utile en bêta, à déplacer dans un écran « À propos » à la publication.
- **La pastille compte** dit « Se connecter » — bien. Une fois connecté, elle pourrait afficher un point de notification quand un succès vient d'être débloqué (renforcement positif, standard 2026).
- **Multijoueur : « 45s/60s/90s par tour »** sans explication. Une ligne « Temps de réflexion par tour » suffit.
- **Cohérence des retours** : « ← Accueil » ramène parfois à la première page, parfois à l'écran précédent. Règle simple à fixer : toujours l'écran parent.

## 🎨 Interface (UI)

- **Identité forte** : le vert tapis + or + Georgia serif, c'est distinctif et chaleureux — à garder absolument. Le problème n'est pas le style, c'est la **cohérence** : on trouve des angles `rounded-lg`, `rounded-xl`, `rounded-2xl`, `rounded-full` mélangés, des ombres 3D fortes à côté d'éléments plats, 6+ tailles de texte dans un même écran. Définir une petite échelle (2 rayons, 3 ombres, 4 tailles de texte) et s'y tenir.
- **Boutons** : le relief « bouton qui s'enfonce » est sympa et tactile — le conserver, mais l'appliquer partout pareil (certains boutons n'ont pas l'état enfoncé).
- **La bannière jaune « À toi de jouer »** est efficace mais crie en permanence. Piste : la réserver aux moments d'action (ton tour), et la remplacer par un libellé discret quand on attend.
- **Cartes à jouer** : belles et lisibles ✓. Le joker violet ressort bien ✓.
- **Écrans intermédiaires** (fin de manche, scores) non audités en profondeur — à revoir dans une passe 2.

## ♿ Accessibilité (souvent négligée, différenciant en 2026)

- Cibles tactiles : certaines pastilles (points d'achat, ✕ de fermeture) font moins de 44×44 pt — le minimum Apple.
- Prévoir un mode « grandes cartes » : il existe ✓ (bonne surprise dans « Comment jouer ») — le rendre plus visible.
- Le rouge/vert est utilisé pour gagné/perdu : ajouter une icône (🏆/✗) pour les daltoniens — en partie fait ✓.
- Aucune trap : `user-select: none` partout est bien pour le rendu app, vérifier que les champs restent copiables (fait ✓).

## 📱 App native

- **iPad** : interface iPhone étirée. Un réglage Capacitor + une passe de mise en page adaptative (2 colonnes dans les menus) rendrait l'app « native iPad » — argument App Store.
- **Splash screen** : encore celui de Capacitor par défaut — à brander avec le logo en même temps que l'icône.
- **Haptique** : le jeu vibre déjà aux bons moments ✓ — étendre aux victoires (pattern de célébration).

## 💡 Idées 2026 (différenciantes, pour plus tard)

- **Défis quotidiens** (main imposée du jour, même pour tous) — rétention énorme, se marie avec les comptes.
- **Reprise de séance** : notification locale douce « Ta partie t'attend » après 24 h d'inactivité (app).
- **Partage de fin de partie** : carte-image générée (score, contrat préféré) à partager WhatsApp — canal n°1 à Madagascar.
- **Mode spectateur** dans les salons pour apprendre en regardant.

---

*Recommandation de séquence : 1-2-3 (accueil/reprise/formulaire) en une session, puis 6 (icône), 5 (chargement), 7-8 (lisibilité/jargon). Le reste au fil de l'eau.*
