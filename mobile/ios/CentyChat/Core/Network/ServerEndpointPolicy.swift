import Foundation

enum ServerEndpointPolicy {
    static func configuredURL(from rawValue: String) -> URL? {
#if DEBUG
        if LaunchTestFixture.allowsInsecureLoopback {
            return debugFixtureURL(from: rawValue)
        }
#endif
        return productionURL(from: rawValue)
    }

    static func productionURL(from rawValue: String) -> URL? {
        guard let url = parsedURL(from: rawValue), url.scheme?.lowercased() == "https" else {
            return nil
        }
        return url
    }

#if DEBUG
    static func debugFixtureURL(from rawValue: String) -> URL? {
        guard let url = parsedURL(from: rawValue) else {
            return nil
        }

        switch url.scheme?.lowercased() {
        case "https":
            return url
        case "http" where isLoopback(url.host):
            return url
        default:
            return nil
        }
    }
#endif

    static func allowsConnection(to url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), url.host != nil else {
            return false
        }

        if scheme == "https" {
            return true
        }

#if DEBUG
        return scheme == "http" && LaunchTestFixture.allowsInsecureLoopback && isLoopback(url.host)
#else
        return false
#endif
    }

    static func allowsAuthorization(to url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "https", "wss":
            return true
        default:
            return false
        }
    }

    static func webSocketURL(for serverURL: URL) -> URL? {
        guard allowsConnection(to: serverURL), var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else {
            return nil
        }

        switch components.scheme?.lowercased() {
        case "https":
            components.scheme = "wss"
#if DEBUG
        case "http" where LaunchTestFixture.allowsInsecureLoopback && isLoopback(components.host):
            components.scheme = "ws"
#endif
        default:
            return nil
        }

        components.path = "/ws"
        // Mobile clients always connect with `?avatars=url` (`ws-protocol.md`): photos as links.
        components.queryItems = [AvatarOptIn.webSocketQuery]
        components.fragment = nil
        return components.url
    }

    private static func parsedURL(from rawValue: String) -> URL? {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let components = URLComponents(string: trimmed),
              components.host != nil,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              let url = components.url else {
            return nil
        }
        return url
    }

    private static func isLoopback(_ host: String?) -> Bool {
        guard let host else { return false }
        let normalizedHost = host.lowercased()
        if normalizedHost == "localhost" || normalizedHost == "::1" {
            return true
        }

        let octets = normalizedHost.split(separator: ".")
        guard octets.count == 4, octets[0] == "127" else { return false }
        return octets.allSatisfy { UInt8($0) != nil }
    }
}
