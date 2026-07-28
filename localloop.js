// =====================================================================
// LocalLoop — transport « boucle locale » pour GameHost
// ---------------------------------------------------------------------
// Relie un GameHost à des clients DANS LE MÊME processus (aucun réseau).
// Sert : aux tests automatisés, et à l'écran « partie locale » du
// navigateur (plusieurs joueurs simulés sur un seul appareil).
// Le futur transport Bluetooth/Multipeer exposera la même interface :
//   send(idx, event, payload) / sendAll(event, payload) côté hôte,
//   onEvent(event, payload) côté client.
// =====================================================================

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.RamyLocalLoop = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function createLocalLoop() {
    const clients = new Map(); // idx -> onEvent(event, payload)

    return {
      // Côté hôte : à passer à createGameHost({ send, sendAll })
      send(idx, event, payload) {
        const h = clients.get(idx);
        if (h) h(event, payload);
      },
      sendAll(event, payload) {
        clients.forEach((h) => h(event, payload));
      },
      // Côté client : chaque joueur humain branche son écouteur
      connectClient(idx, onEvent) { clients.set(idx, onEvent); },
      disconnectClient(idx) { clients.delete(idx); },
    };
  }

  return { createLocalLoop };
});
