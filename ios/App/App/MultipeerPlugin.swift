// =====================================================================
// MultipeerPlugin — pont entre le jeu (JavaScript) et Multipeer
// Connectivity, la technologie Apple qui relie des iPhones proches
// via Bluetooth + WiFi direct, SANS internet (avion, brousse…).
//
// Événements envoyés au JavaScript :
//   peerFound        { id, name }   un hôte est visible à proximité
//   peerLost         { id }         il a disparu
//   peerConnected    { id, name }   liaison établie
//   peerDisconnected { id, name }   liaison perdue
//   message          { from, data } message reçu (texte JSON)
// =====================================================================

import Foundation
import Capacitor
import MultipeerConnectivity

@objc(MultipeerPlugin)
public class MultipeerPlugin: CAPPlugin, CAPBridgedPlugin, MCSessionDelegate, MCNearbyServiceAdvertiserDelegate, MCNearbyServiceBrowserDelegate {

    // Déclaration Capacitor 6 : identité + liste des méthodes exposées au JavaScript
    public let identifier = "MultipeerPlugin"
    public let jsName = "Multipeer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startHosting", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBrowsing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "joinHost", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connectedPeers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopAll", returnType: CAPPluginReturnPromise),
    ]

    // Doit faire 1-15 caractères (minuscules, chiffres, tirets) et être déclaré dans Info.plist
    let serviceType = "ramygasy"

    var peerID: MCPeerID?
    var session: MCSession?
    var advertiser: MCNearbyServiceAdvertiser?
    var browser: MCNearbyServiceBrowser?
    var foundPeers: [String: MCPeerID] = [:]

    func ensureSession(_ name: String) {
        if session == nil || peerID?.displayName != name {
            session?.disconnect()
            let pid = MCPeerID(displayName: String(name.prefix(60)))
            peerID = pid
            session = MCSession(peer: pid, securityIdentity: nil, encryptionPreference: .required)
            session?.delegate = self
        }
    }

    // ---------- Méthodes appelées par le JavaScript ----------

    // L'hôte se rend visible aux téléphones voisins
    @objc func startHosting(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? "Hôte"
        DispatchQueue.main.async {
            self.ensureSession(name)
            self.advertiser?.stopAdvertisingPeer()
            self.advertiser = MCNearbyServiceAdvertiser(peer: self.peerID!, discoveryInfo: nil, serviceType: self.serviceType)
            self.advertiser?.delegate = self
            self.advertiser?.startAdvertisingPeer()
            call.resolve()
        }
    }

    // Un invité cherche les hôtes à proximité
    @objc func startBrowsing(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? "Joueur"
        DispatchQueue.main.async {
            self.ensureSession(name)
            self.foundPeers.removeAll()
            self.browser?.stopBrowsingForPeers()
            self.browser = MCNearbyServiceBrowser(peer: self.peerID!, serviceType: self.serviceType)
            self.browser?.delegate = self
            self.browser?.startBrowsingForPeers()
            call.resolve()
        }
    }

    // L'invité rejoint un hôte repéré (id renvoyé par l'événement peerFound)
    @objc func joinHost(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let peer = foundPeers[id], let sess = session else {
            call.reject("Hôte introuvable — relance la recherche.")
            return
        }
        DispatchQueue.main.async {
            self.browser?.invitePeer(peer, to: sess, withContext: nil, timeout: 20)
            call.resolve()
        }
    }

    // Envoi d'un message (texte JSON) — à tous, ou à un seul pair via "to"
    @objc func send(_ call: CAPPluginCall) {
        guard let data = call.getString("data"), let sess = session else {
            call.reject("Rien à envoyer ou session absente.")
            return
        }
        var targets = sess.connectedPeers
        if let to = call.getString("to") {
            targets = targets.filter { String($0.hash) == to }
        }
        guard !targets.isEmpty else { call.resolve(); return }
        do {
            try sess.send(Data(data.utf8), toPeers: targets, with: .reliable)
            call.resolve()
        } catch {
            call.reject("Envoi impossible : \(error.localizedDescription)")
        }
    }

    // Liste des pairs actuellement connectés
    @objc func connectedPeers(_ call: CAPPluginCall) {
        let peers = (session?.connectedPeers ?? []).map { ["id": String($0.hash), "name": $0.displayName] }
        call.resolve(["peers": peers])
    }

    // Tout arrêter (fin de partie, retour au menu)
    @objc func stopAll(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.advertiser?.stopAdvertisingPeer(); self.advertiser = nil
            self.browser?.stopBrowsingForPeers(); self.browser = nil
            self.session?.disconnect()
            self.session = nil; self.peerID = nil
            self.foundPeers.removeAll()
            call.resolve()
        }
    }

    // ---------- Côté hôte : invitations entrantes (acceptées automatiquement) ----------
    public func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID,
                           withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        invitationHandler(true, session)
    }

    // ---------- Côté invité : hôtes repérés / perdus ----------
    public func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        // Sa propre table (écho Bonjour local) : on l'ignore. L'identifiant change à chaque
        // découverte, seule la comparaison du nom est fiable ici.
        if peerID == self.peerID || peerID.displayName == self.peerID?.displayName { return }
        foundPeers[String(peerID.hash)] = peerID
        notifyListeners("peerFound", data: ["id": String(peerID.hash), "name": peerID.displayName])
    }
    public func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        foundPeers.removeValue(forKey: String(peerID.hash))
        notifyListeners("peerLost", data: ["id": String(peerID.hash)])
    }

    // ---------- Session : connexions et messages ----------
    public func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        let payload = ["id": String(peerID.hash), "name": peerID.displayName]
        if state == .connected { notifyListeners("peerConnected", data: payload) }
        else if state == .notConnected { notifyListeners("peerDisconnected", data: payload) }
    }
    public func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        notifyListeners("message", data: ["from": String(peerID.hash), "data": String(decoding: data, as: UTF8.self)])
    }

    // Flux non utilisés (obligatoires pour le protocole)
    public func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    public func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    public func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}
