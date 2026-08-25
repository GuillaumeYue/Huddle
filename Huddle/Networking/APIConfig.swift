import Foundation

/// One switch for where the backend lives. Debug builds talk to the
/// dev server on this Mac; Release (TestFlight / App Store) builds get
/// the deployed origin — fill it in at deploy time, before the first
/// TestFlight build. The key stays server-side either way.
enum APIConfig {
    #if DEBUG
    static let httpBase = URL(string: "http://localhost:3000")!
    static let wsBase = URL(string: "ws://localhost:3000")!
    #else
    static let httpBase = URL(string: "https://REPLACE-AT-DEPLOY.example.com")!
    static let wsBase = URL(string: "wss://REPLACE-AT-DEPLOY.example.com")!
    #endif
}
