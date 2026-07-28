// Enregistrement du plugin Multipeer auprès de Capacitor
// (le jeu l'appelle via window.Capacitor.Plugins.Multipeer)
#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(MultipeerPlugin, "Multipeer",
  CAP_PLUGIN_METHOD(startHosting, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(startBrowsing, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(joinHost, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(send, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(connectedPeers, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(stopAll, CAPPluginReturnPromise);
)
