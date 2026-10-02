import Foundation

/// The CentyChat server this build talks to.
public struct ServerEnvironment: Sendable, Equatable {
    /// Origin of the server (`https://host[:port]`); the API lives under `/api`.
    public let serverURL: URL
    public let apiBaseURL: URL
    public let webSocketURL: URL
    /// Lower-cased `scheme://host[:port]`, used to bind stored credentials to their issuer.
    public let origin: String

    static let productionURLString = "https://server.invalid"

    public static let production = ServerEnvironment(validating: productionURLString)!

    public static let current: ServerEnvironment = .production

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
        .production
    }

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
