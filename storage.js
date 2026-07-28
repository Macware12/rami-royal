// =====================================================================
// storage — persistance des données du serveur (comptes, salons)
// ---------------------------------------------------------------------
// Deux modes, choisis automatiquement :
//   - DATABASE_URL défini  → Postgres (Neon…) : survit aux déploiements ✔
//   - sinon               → fichiers locaux : pratique en développement
//
// Le disque de Render (offre gratuite) est EFFACÉ à chaque déploiement :
// sans base externe, les comptes des joueurs disparaîtraient à chaque
// mise à jour du jeu. D'où ce module.
//
// Modèle volontairement minimal : une table clé → valeur JSON.
//   kv(k TEXT PRIMARY KEY, v JSONB, maj TIMESTAMPTZ)
// =====================================================================

const fs = require("fs");

const DB_URL = process.env.DATABASE_URL || "";
let pool = null;

// À appeler une fois au démarrage. Renvoie "postgres" ou "fichier".
async function init() {
  if (!DB_URL) return "fichier";
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false }, // Neon/Render imposent SSL
    max: 3,                             // largement assez : écritures rares et différées
    idleTimeoutMillis: 30000,
  });
  pool.on("error", (e) => console.error("Postgres (pool):", e.message));
  await pool.query("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB NOT NULL, maj TIMESTAMPTZ NOT NULL DEFAULT now())");
  return "postgres";
}

// Charge une clé. `file` est le repli fichier du mode développement.
async function load(key, file) {
  if (pool) {
    const r = await pool.query("SELECT v FROM kv WHERE k = $1", [key]);
    return r.rows.length ? r.rows[0].v : null;
  }
  try {
    if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) { console.error("Lecture " + file + " impossible:", e.message); }
  return null;
}

// Sauvegarde une clé (écrasement complet — les données sont petites).
async function save(key, value, file) {
  if (pool) {
    await pool.query(
      "INSERT INTO kv (k, v, maj) VALUES ($1, $2, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, maj = now()",
      [key, JSON.stringify(value)]
    );
    return;
  }
  if (file) fs.writeFileSync(file, JSON.stringify(value));
}

module.exports = { init, load, save, get mode() { return pool ? "postgres" : "fichier"; } };
