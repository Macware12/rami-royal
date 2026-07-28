// Génération du CSS Tailwind embarqué (public/lib/tailwind.css)
// Lancer après avoir ajouté de NOUVELLES classes dans les pages : npm run css
module.exports = {
  content: ["./public/*.html"],
  theme: { extend: {} },
  corePlugins: { preflight: true },
};
