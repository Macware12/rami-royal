// Contrôleur principal de l'app : identique à celui de Capacitor,
// mais il enregistre en plus notre plugin Multipeer (jeu local sans internet).
// C'est la méthode officielle Capacitor 6 pour les plugins écrits dans l'app.

import UIKit
import Capacitor

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MultipeerPlugin())
    }
}
