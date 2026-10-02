import Foundation

/// The CentyChat server this build talks to, fixed at build time.
///
/// - Release: the production server is a compile-time constant. Nothing at runtime (stored
///   values, deep links, launch arguments, environment, Info.plist) can change it, and the
///   override code below is not compiled in.
/// - Debug: `CENTYCHAT_SERVER_URL` from the build configuration (Info.plist key
///   `CentyChatServerURL`, default production), e.g. the dev stand `https://localhost:8443`.
///   UI tests may pass `-centychat-server-url <url>` together with `CENTYCHAT_UI_TESTING=1`.
///   Only `https` origins are accepted; anything else falls back to production.
/// There is no UI to change the server in any build.
public struct ServerEnvironment: Sendable, Equatable {
    /// Origin of the server (`https://host[:port]`); the API lives under `/api`.
    public let serverURL: URL
    public let apiBaseURL: URL
    public let webSocketURL: URL
    /// Lower-cased `scheme://host[:port]`, used to bind stored credentials to their issuer.
    public let origin: String

    static let productionURLString = "https://centychat-production.up.railway.app"

    public static let production = ServerEnvironment(validating: productionURLString)!

    public static let current: ServerEnvironment = {
#if DEBUG
        return resolve(
            .debug,
            infoPlistValue: Bundle.main.object(forInfoDictionaryKey: DebugOverride.infoPlistKey) as? String,
            arguments: ProcessInfo.processInfo.arguments,
            environment: ProcessInfo.processInfo.environment
        )
#else
        return .production
#endif
    }()

    enum BuildFlavor: Sendable {
        case debug
        case release
    }

    static func resolve(
        _ flavor: BuildFlavor,
        infoPlistValue: String?,
        arguments: [String],
        environment: [String: String]
    ) -> ServerEnvironment {
        switch flavor {
        case .release:
            return .production
        case .debug:
#if DEBUG
            if environment[DebugOverride.uiTestingFlag] == "1",
               let index = arguments.firstIndex(of: DebugOverride.launchArgument),
               arguments.indices.contains(index + 1),
               let override = ServerEnvironment(validating: arguments[index + 1]) {
                return override
            }
            if let infoPlistValue, let configured = ServerEnvironment(validating: infoPlistValue) {
                return configured
            }
#endif
            return .production
        }
    }

#if DEBUG
    /// Debug-only override points. Not compiled into Release builds.
    enum DebugOverride {
        static let infoPlistKey = "CentyChatServerURL"
        static let launchArgument = "-centychat-server-url"
        static let uiTestingFlag = "CENTYCHAT_UI_TESTING"
    }
#endif

    /// Accepts only an `https` origin without credentials, path, query or fragment.
    public init?(validating rawValue: String) {
        guard let url = ServerEndpointPolicy.productionURL(from: rawValue),
              url.path.isEmpty || url.path == "/",
              let origin = Self.origin(of: url),
              let serverURL = URL(string: origin),
              let host = serverURL.host else {
            return nil
        }
        let authority = serverURL.port.map { "\(host):\($0)" } ?? host
        guard let webSocketURL = URL(string: "wss://\(authority)/ws") else {
            return nil
        }
        self.serverURL = serverURL
        self.apiBaseURL = serverURL.appendingPathComponent("api")
        self.webSocketURL = webSocketURL
        self.origin = origin
    }

    public static func == (lhs: ServerEnvironment, rhs: ServerEnvironment) -> Bool {
        lhs.origin == rhs.origin
    }

    /// `scheme://host[:port]` in lower case; the default port is omitted.
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(), !host.isEmpty else {
            return nil
        }
        let defaultPort: Int? = switch scheme {
        case "https", "wss": 443
        case "http", "ws": 80
        default: nil
        }
        if let port = url.port, port != defaultPort {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }

    static func origin(of rawValue: String) -> String? {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return nil }
        return origin(of: url)
    }
}
