// =====================================================================
// RamyLocalNet — « prise réseau » du multijoueur LOCAL (sans internet)
// ---------------------------------------------------------------------
// Présente la même interface qu'un socket serveur (on/off/emit), mais :
//   - le téléphone hôte fait tourner la partie lui-même (GameHost),
//   - les échanges passent par Multipeer (Bluetooth/WiFi direct).
// L'interface du jeu (index.html) ne voit aucune différence.
//
// Événements supplémentaires : "localTables" (liste des tables proches).
// Émissions supplémentaires : "browseLocal" {name}, "joinLocal" {id, name, avatar}.
// =====================================================================

(function () {
  "use strict";

  function available() {
    return Boolean(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Multipeer &&
      window.RamyGameHost && window.RamyEngine);
  }

  function create(hostOpts) { // hostOpts : réglages de minuteries (tests) — vide en usage normal
    hostOpts = hostOpts || {};
    const MP = window.Capacitor.Plugins.Multipeer;
    const handlers = {};      // ev -> Set de fonctions
    const pluginSubs = [];    // abonnements au plugin (pour destroy)
    let role = null;          // "host" | "guest"
    let host = null;          // GameHost (côté hôte uniquement)
    const peerByPlayer = new Map(); // objet joueur -> peerId
    const playerByPeer = new Map(); // peerId -> objet joueur
    const tables = new Map();       // id -> nom (côté invité)
    let myName = "", myAvatar = null;
    let guestHostId = null;
    let joinCb = null;
    let emoteSeq = 0;
    let dead = false;

    function on(ev, fn) { (handlers[ev] = handlers[ev] || new Set()).add(fn); }
    function off(ev, fn) { if (!handlers[ev]) return; if (fn) handlers[ev].delete(fn); else delete handlers[ev]; }
    function dispatch(ev, payload) {
      (handlers[ev] ? Array.from(handlers[ev]) : []).forEach((fn) => { try { fn(payload); } catch (e) {} });
    }
    function tablesList() { return Array.from(tables, (kv) => ({ id: kv[0], name: kv[1] })); }

    // ---------- Côté hôte : routage des messages du GameHost vers chacun ----------
    function hostSend(idx, ev, payload) {
      if (!host) return;
      if (ev === "state") payload = Object.assign({}, payload, { code: "LOCAL" });
      const p = host.players[idx];
      if (!p) return;
      if (idx === 0) { dispatch(ev, payload); return; }
      const peer = peerByPlayer.get(p);
      if (peer != null) MP.send({ to: peer, data: JSON.stringify({ t: "ev", ev, payload }) }).catch(() => {});
    }
    function hostSendAll(ev, payload) {
      dispatch(ev, payload);
      MP.send({ data: JSON.stringify({ t: "ev", ev, payload }) }).catch(() => {});
    }

    function becomeHost(arg, cb) {
      role = "host";
      myName = arg.name; myAvatar = arg.avatar;
      host = window.RamyGameHost.createGameHost(Object.assign({
        options: arg.options || {},
        send: hostSend,
        sendAll: hostSendAll,
      }, hostOpts));
      host.addPlayer(arg.name, { avatar: arg.avatar });
      MP.startHosting({ name: arg.name }).catch(() => {});
      cb({ ok: true, code: "LOCAL", token: "local" });
    }

    // Messages reçus PAR L'HÔTE depuis un invité
    function onGuestMessage(fromPeer, msg) {
      if (!host) return;
      if (msg.t === "hello") {
        const res = host.addPlayer(msg.name, { avatar: msg.avatar });
        if (res.error) {
          MP.send({ to: fromPeer, data: JSON.stringify({ t: "ev", ev: "kicked", payload: res.error }) }).catch(() => {});
          return;
        }
        const p = host.players[res.idx];
        peerByPlayer.set(p, fromPeer);
        playerByPeer.set(fromPeer, p);
        host.resync(res.idx); // la diffusion d'addPlayer est partie avant l'inscription du pair : on renvoie son état
        return;
      }
      if (msg.t !== "emit") return;
      const p = playerByPeer.get(fromPeer);
      const idx = p ? host.players.indexOf(p) : -1;
      if (idx < 0) return;
      const ev = msg.ev, arg = msg.arg;
      if (ev === "action") host.action(idx, arg);
      else if (ev === "claimNext") host.action(idx, { type: "claimNext" });
      else if (ev === "passNext") host.action(idx, { type: "passNext" });
      else if (ev === "nextRound") host.nextRound();
      else if (ev === "rematchVote") host.rematchVote(idx, Boolean(arg));
      else if (ev === "setAvatar") host.setAvatar(idx, arg);
      else if (ev === "emote") hostSendAll("emote", { idx, text: String(arg).slice(0, 40), id: ++emoteSeq });
      else if (ev === "resync") host.resync(idx);
      else if (ev === "leaveGame") host.setConnected(idx, false);
    }

    // ---------- Abonnements au plugin natif ----------
    function sub(name, fn) { MP.addListener(name, fn).then((h) => { if (dead) h.remove(); else pluginSubs.push(h); }); }

    sub("peerFound", (p) => {
      if (role === "host") return;
      tables.set(p.id, p.name);
      dispatch("localTables", tablesList());
    });
    sub("peerLost", (p) => {
      tables.delete(p.id);
      if (role !== "host") dispatch("localTables", tablesList());
    });
    sub("peerConnected", (p) => {
      if (role === "guest") {
        guestHostId = p.id;
        MP.send({ to: p.id, data: JSON.stringify({ t: "hello", name: myName, avatar: myAvatar }) }).catch(() => {});
        if (joinCb) { joinCb({ ok: true, code: "LOCAL", token: "local" }); joinCb = null; }
      }
      // côté hôte : on attend le « hello » de l'invité pour l'asseoir à la table
    });
    sub("peerDisconnected", (p) => {
      if (role === "host") {
        const q = playerByPeer.get(p.id);
        if (q && host) { const i = host.players.indexOf(q); if (i >= 0) host.setConnected(i, false); }
      } else if (role === "guest" && p.id === guestHostId) {
        guestHostId = null;
        dispatch("roomClosed");
      }
    });
    sub("message", (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (role === "host") onGuestMessage(m.from, msg);
      else if (msg && msg.t === "ev") dispatch(msg.ev, msg.payload);
    });

    // ---------- Interface « socket » ----------
    function emit(ev, arg, cb) {
      if (dead) return;
      if (ev === "createRoom") return becomeHost(arg, cb || function () {});
      if (ev === "browseLocal") {
        role = "guest";
        myName = (arg && arg.name) || "Joueur";
        tables.clear();
        dispatch("localTables", []);
        MP.startBrowsing({ name: myName }).catch(() => {});
        return;
      }
      if (ev === "joinLocal") {
        myName = arg.name; myAvatar = arg.avatar;
        joinCb = cb || null;
        MP.joinHost({ id: arg.id }).catch(() => {
          if (joinCb) { joinCb({ ok: false, error: "Connexion impossible — relance la recherche." }); joinCb = null; }
        });
        return;
      }
      if (ev === "joinRoom" || ev === "rejoin") { if (cb) cb({ ok: false, error: "Indisponible en partie locale." }); return; }

      if (role === "host" && host) {
        if (ev === "action") return void host.action(0, arg);
        if (ev === "claimNext") return void host.action(0, { type: "claimNext" });
        if (ev === "passNext") return void host.action(0, { type: "passNext" });
        if (ev === "addBot") { const n = host.players.filter((p) => p.isBot).length + 1; host.addPlayer("Bot " + n, { isBot: true }); return; }
        if (ev === "removePlayer") {
          const p = host.players[arg];
          const peer = p && peerByPlayer.get(p);
          host.removePlayer(arg);
          if (peer != null) { playerByPeer.delete(peer); peerByPlayer.delete(p); }
          return;
        }
        if (ev === "startGame") { const err = host.startGame(); if (err) dispatch("info", err); return; }
        if (ev === "nextRound") return void host.nextRound();
        if (ev === "rematch") { const err = host.rematchPropose(0); if (err) dispatch("info", err); return; }
        if (ev === "rematchVote") return void host.rematchVote(0, Boolean(arg));
        if (ev === "setAvatar") return void host.setAvatar(0, arg);
        if (ev === "emote") return void hostSendAll("emote", { idx: 0, text: String(arg).slice(0, 40), id: ++emoteSeq });
        if (ev === "resync") return void host.resync(0);
        if (ev === "leaveGame") { hostSendAll("roomClosed"); return; }
        return;
      }

      if (role === "guest") {
        if (guestHostId != null) MP.send({ to: guestHostId, data: JSON.stringify({ t: "emit", ev, arg }) }).catch(() => {});
        return;
      }
    }

    function destroy() {
      dead = true;
      try { MP.stopAll(); } catch (e) {}
      pluginSubs.forEach((h) => { try { h.remove(); } catch (e) {} });
      pluginSubs.length = 0;
      if (host) { host.destroy(); host = null; }
      role = null;
    }

    return { on, off, emit, destroy, tablesList, get connected() { return true; } };
  }

  window.RamyLocalNet = { available, create };
})();
