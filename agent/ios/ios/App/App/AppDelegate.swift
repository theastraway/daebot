import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

// MARK: - Daebot WebView: microphone only for daebot.live

import WebKit
import AuthenticationServices

/// Forwards every WKUIDelegate message to Capacitor's own handler, except media-capture
/// permission, which is granted for daebot.live (and its subdomains) only.
final class DaebotUIDelegate: NSObject, WKUIDelegate {
    private weak var inner: WKUIDelegate?
    init(inner: WKUIDelegate?) { self.inner = inner }

    override func responds(to aSelector: Selector!) -> Bool {
        return super.responds(to: aSelector) || (inner?.responds(to: aSelector) ?? false)
    }
    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        return inner
    }

    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let host = origin.host.lowercased()
        let ok = host == "daebot.live" || host.hasSuffix(".daebot.live")
        decisionHandler(ok ? .grant : .deny)
    }
}

// MARK: - Sign-in: ASWebAuthenticationSession that returns to the app

/// JS: `await window.webkit.messageHandlers.daebotAuth.postMessage({ url })` opens the system auth sheet and resolves the
/// `daebot://auth/callback?...` URL the server finished on (rejects "CANCELLED" if the user closes the sheet). Plain WebKit, so it
/// does not depend on Capacitor discovering a plugin for a remote page. Only a message from a daebot.live page for Daebot's own
/// https sign-in start URL is honoured, so no other page can use it to open arbitrary sites. The sheet shares no state with the
/// WebView; the page trades the one-time code in the returned URL for its session over HTTPS.
final class DaebotAuthHandler: NSObject, WKScriptMessageHandlerWithReply, ASWebAuthenticationPresentationContextProviding {
    weak var anchorView: UIView?
    private var session: ASWebAuthenticationSession?
    init(anchorView: UIView?) { self.anchorView = anchorView }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        let originHost = origin.host.lowercased()
        guard origin.protocol == "https", originHost == "daebot.live" || originHost.hasSuffix(".daebot.live"),
              let body = message.body as? [String: Any], let raw = body["url"] as? String, let url = URL(string: raw),
              url.scheme == "https", let host = url.host?.lowercased(),
              host == "daebot.live" || host.hasSuffix(".daebot.live"),
              url.path == "/auth/mind/start" else {
            replyHandler(nil, "BAD_URL")
            return
        }
        DispatchQueue.main.async {
            self.session?.cancel()
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "daebot") { [weak self] callback, error in
                self?.session = nil
                if let callback = callback {
                    replyHandler(callback.absoluteString, nil)
                } else if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin {
                    replyHandler(nil, "CANCELLED")
                } else {
                    replyHandler(nil, error?.localizedDescription ?? "FAILED")
                }
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = false
            self.session = s
            if !s.start() {
                self.session = nil
                replyHandler(nil, "FAILED")
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return anchorView?.window ?? ASPresentationAnchor()
    }
}

class DaebotViewController: CAPBridgeViewController {
    private var uiProxy: DaebotUIDelegate?
    private var authHandler: DaebotAuthHandler?

    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let cfg = super.webViewConfiguration(for: instanceConfiguration)
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let auth = DaebotAuthHandler(anchorView: nil)
        authHandler = auth
        cfg.userContentController.addScriptMessageHandler(auth, contentWorld: .page, name: "daebotAuth")
        return cfg
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let wv = webView else { return }
        authHandler?.anchorView = wv
        let proxy = DaebotUIDelegate(inner: wv.uiDelegate)
        uiProxy = proxy // WKWebView holds uiDelegate weakly
        wv.uiDelegate = proxy
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.bounces = false
    }
}
