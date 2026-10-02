import Foundation

/// Сетевой HTTP-клиент CentyChat на основе нативного URLSession с поддержкой Swift Concurrency
public actor APIClient {
    public static let shared = APIClient()
    
    private let session: URLSession
    private let keychain: KeychainManager
    private let jsonDecoder: JSONDecoder
    private let jsonEncoder: JSONEncoder
    private let refreshCoordinator = TokenRefreshCoordinator()
    
    public init(session: URLSession? = nil, keychain: KeychainManager = .shared) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = 20.0
            configuration.timeoutIntervalForResource = 60.0
            self.session = URLSession(configuration: configuration)
        }

        self.keychain = keychain
        self.jsonDecoder = JSONDecoder()
        self.jsonEncoder = JSONEncoder()
    }
    
    // MARK: - Core Request Dispatcher
    
    public func request<T: Decodable>(
        endpoint: String,
        method: String = "GET",
        queryItems: [URLQueryItem]? = nil,
        body: Data? = nil,
        headers: [String: String]? = nil,
        requiresAuth: Bool = true,
        isRetry: Bool = false
    ) async throws -> T {
        try await performRequest(
            endpoint: endpoint,
            method: method,
            queryItems: queryItems,
            body: body,
            headers: headers,
            requiresAuth: requiresAuth,
            isRetry: isRetry,
            serverURL: try configuredServerURL()
        )
    }

    private func performRequest<T: Decodable>(
        endpoint: String,
        method: String = "GET",
        queryItems: [URLQueryItem]? = nil,
        body: Data? = nil,
        headers: [String: String]? = nil,
        requiresAuth: Bool = true,
        isRetry: Bool = false,
        serverURL: URL
    ) async throws -> T {
        guard var components = URLComponents(url: try apiURL(serverURL: serverURL, endpoint: endpoint), resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL(endpoint)
        }
        if let queryItems, !queryItems.isEmpty {
            components.queryItems = queryItems
        }
        guard let url = components.url else {
            throw APIError.invalidURL(endpoint)
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.httpBody = body
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil && urlRequest.value(forHTTPHeaderField: "Content-Type") == nil {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let requestToken: String?
        if requiresAuth {
            guard ServerEndpointPolicy.allowsAuthorization(to: url) else {
                throw APIError.insecureTransport
            }
            guard let token = keychain.authToken else {
                throw APIError.unauthorized
            }
            requestToken = token
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        } else {
            requestToken = nil
        }

        if let headers {
            let containsAuthorization = headers.keys.contains { $0.caseInsensitiveCompare("Authorization") == .orderedSame }
            guard !containsAuthorization || ServerEndpointPolicy.allowsAuthorization(to: url) else {
                throw APIError.insecureTransport
            }
            for (key, value) in headers {
                urlRequest.setValue(value, forHTTPHeaderField: key)
            }
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch {
            throw APIError.noConnection
        }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        if httpResponse.statusCode == 401 && requiresAuth {
            guard let requestToken else {
                throw APIError.unauthorized
            }
            if isRetry {
                if keychain.authToken == requestToken {
                    try keychain.clearAllAuthData()
                }
                throw APIError.unauthorized
            }
            do {
                try await refreshAccessToken(after: requestToken)
                return try await performRequest(
                    endpoint: endpoint,
                    method: method,
                    queryItems: queryItems,
                    body: body,
                    headers: headers,
                    requiresAuth: requiresAuth,
                    isRetry: true,
                    serverURL: serverURL
                )
            } catch APIError.unauthorized {
                if keychain.authToken == requestToken {
                    try keychain.clearAllAuthData()
                }
                throw APIError.unauthorized
            }
        }

        if httpResponse.statusCode == 403,
           let serverError = try? jsonDecoder.decode(ServerErrorResponse.self, from: data),
           serverError.code == "MUST_CHANGE_PASSWORD" {
            throw APIError.mustChangePassword(message: serverError.error)
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            var errorMessage = String(localized: "Запрос не выполнен")
            var errorCode: String?
            if let serverError = try? jsonDecoder.decode(ServerErrorResponse.self, from: data) {
                errorMessage = serverError.error
                errorCode = serverError.code
            } else if let raw = String(data: data, encoding: .utf8), !raw.isEmpty {
                errorMessage = raw
            }
            throw APIError.httpError(statusCode: httpResponse.statusCode, message: errorMessage, code: errorCode)
        }

        do {
            return try jsonDecoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error.localizedDescription)
        }
    }

    private func configuredServerURL() throws -> URL {
        guard let serverURL = ServerEndpointPolicy.configuredURL(from: keychain.serverUrl) else {
            throw APIError.invalidURL(String(localized: "требуется защищённый адрес сервера (https)"))
        }
        return serverURL
    }

    private func validatedServerURL(_ serverURL: URL) throws -> URL {
        guard ServerEndpointPolicy.allowsConnection(to: serverURL) else {
            throw APIError.insecureTransport
        }
        return serverURL
    }

    private func apiURL(serverURL: URL, endpoint: String) throws -> URL {
        guard endpoint.hasPrefix("/"), var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL(endpoint)
        }
        let basePath = components.path == "/" ? "" : components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = "/" + [basePath, "api" + endpoint].filter { !$0.isEmpty }.joined(separator: "/")
        components.query = nil
        components.fragment = nil
        guard let url = components.url else {
            throw APIError.invalidURL(endpoint)
        }
        return url
    }

    private func refreshAccessToken(after staleToken: String) async throws {
        guard keychain.authToken == staleToken else { return }
        let serverURL = try configuredServerURL()
        guard ServerEndpointPolicy.allowsAuthorization(to: serverURL) else {
            throw APIError.insecureTransport
        }
        let refreshURL = try apiURL(serverURL: serverURL, endpoint: "/auth/refresh")
        let session = session
        let keychain = self.keychain
        let refreshedToken = try await refreshCoordinator.token(for: staleToken) {
            var request = URLRequest(url: refreshURL)
            request.httpMethod = "POST"
            request.setValue("Bearer \(staleToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIError.invalidResponse
            }
            guard (200...299).contains(httpResponse.statusCode) else {
                if httpResponse.statusCode == 401 || httpResponse.statusCode == 403 {
                    throw APIError.unauthorized
                }
                throw APIError.httpError(statusCode: httpResponse.statusCode, message: String(localized: "Не удалось продлить сессию"), code: nil)
            }
            let refreshedToken = try JSONDecoder().decode(RefreshTokenResponse.self, from: data).token
            if keychain.authToken == staleToken {
                try keychain.saveAuthToken(refreshedToken)
            }
            return refreshedToken
        }
        if keychain.authToken == staleToken {
            try keychain.saveAuthToken(refreshedToken)
        }
    }
    
    // MARK: - Endpoints Implementation
    
    /// Проверка доступности сервера
    public func checkHealth() async throws -> HealthResponse {
        try await request(endpoint: "/health", requiresAuth: false)
    }

    public func checkHealth(serverURL: URL) async throws -> HealthResponse {
        try await performRequest(endpoint: "/health", requiresAuth: false, serverURL: try validatedServerURL(serverURL))
    }
    
    /// Общедоступные сведения о сервере
    public func getServerInfo() async throws -> ServerInfo {
        try await request(endpoint: "/settings/info", requiresAuth: false)
    }

    public func getServerInfo(serverURL: URL) async throws -> ServerInfo {
        try await performRequest(endpoint: "/settings/info", requiresAuth: false, serverURL: try validatedServerURL(serverURL))
    }
    
    /// Device Knock при запуске
    public func knock(request knockReq: KnockRequest) async throws -> KnockResponse {
        let body = try jsonEncoder.encode(knockReq)
        return try await request(endpoint: "/auth/knock", method: "POST", body: body, requiresAuth: false)
    }
    
    /// Привязка секрета устройства после логина
    public func claimDevice(deviceId: String, deviceSecret: String) async throws -> Bool {
        let req = DeviceClaimRequest(deviceId: deviceId, deviceSecret: deviceSecret)
        let body = try jsonEncoder.encode(req)
        struct ClaimResponse: Codable { let claimed: Bool }
        let res: ClaimResponse = try await request(endpoint: "/auth/device/claim", method: "POST", body: body)
        return res.claimed
    }
    
    /// Вход по логину и паролю
    public func login(request loginReq: LoginRequest) async throws -> AuthSuccessResponse {
        let body = try jsonEncoder.encode(loginReq)
        let res: AuthSuccessResponse = try await request(endpoint: "/auth/login", method: "POST", body: body, requiresAuth: false)
        try keychain.saveAuthToken(res.token)
        return res
    }
    
    /// Выход из системы
    public func logout() async throws {
        let deviceId = try keychain.deviceID()
        let body = try? JSONSerialization.data(withJSONObject: ["device_id": deviceId])
        struct LogoutResponse: Codable { let success: Bool }
        let _: LogoutResponse? = try? await request(endpoint: "/auth/logout", method: "POST", body: body)
        try keychain.clearAllAuthData()
    }
    
    /// Профиль текущего пользователя
    public func getCurrentUser() async throws -> User {
        struct MeResponse: Codable { let user: User }
        let res: MeResponse = try await request(endpoint: "/auth/me")
        return res.user
    }
    
    /// Справочник сотрудников
    public func getUsers() async throws -> [PublicUser] {
        try await request(endpoint: "/users")
    }
    
    /// Список корпоративных каналов
    public func getChannels() async throws -> [Channel] {
        try await request(endpoint: "/channels")
    }
    
    /// Создание нового канала
    public func createChannel(name: String, topic: String?, type: ChannelType) async throws -> Channel {
        var dict: [String: Any] = ["name": name, "type": type.rawValue]
        if let topic = topic { dict["topic"] = topic }
        let body = try JSONSerialization.data(withJSONObject: dict)
        return try await request(endpoint: "/channels", method: "POST", body: body)
    }
    
    /// Список личных диалогов
    public func getDirectConversations() async throws -> [DirectConversation] {
        try await request(endpoint: "/conversations/direct")
    }
    
    /// Универсальная загрузка сообщений
    public func getMessages(conversationType: ConversationType, targetId: Int64, limit: Int = 50, beforeId: Int64? = nil) async throws -> [Message] {
        var queryItems = [
            URLQueryItem(name: "conversationType", value: conversationType.rawValue),
            URLQueryItem(name: "targetId", value: "\(targetId)"),
            URLQueryItem(name: "limit", value: "\(limit)")
        ]
        if let beforeId = beforeId {
            queryItems.append(URLQueryItem(name: "beforeId", value: "\(beforeId)"))
        }
        return try await request(endpoint: "/messages", queryItems: queryItems)
    }
    
    /// Отправка прямого сообщения по HTTP
    public func sendDirectMessage(targetId: Int64, text: String, type: MessageType = .text, replyToId: Int64? = nil, metadata: MessageMetadata? = nil) async throws -> Message {
        var dict: [String: Any] = ["text": text, "type": type.rawValue]
        if let replyToId = replyToId { dict["reply_to_id"] = replyToId }
        if let meta = metadata, let metaData = try? jsonEncoder.encode(meta), let metaObj = try? JSONSerialization.jsonObject(with: metaData) {
            dict["metadata"] = metaObj
        }
        let body = try JSONSerialization.data(withJSONObject: dict)
        return try await request(endpoint: "/messages/direct/\(targetId)", method: "POST", body: body)
    }
    
    /// Отправка сообщения в канал по HTTP
    public func sendChannelMessage(channelId: Int64, text: String, type: MessageType = .text, replyToId: Int64? = nil, metadata: MessageMetadata? = nil) async throws -> Message {
        var dict: [String: Any] = ["text": text, "type": type.rawValue]
        if let replyToId = replyToId { dict["reply_to_id"] = replyToId }
        if let meta = metadata, let metaData = try? jsonEncoder.encode(meta), let metaObj = try? JSONSerialization.jsonObject(with: metaData) {
            dict["metadata"] = metaObj
        }
        let body = try JSONSerialization.data(withJSONObject: dict)
        return try await request(endpoint: "/messages/channels/\(channelId)", method: "POST", body: body)
    }
    
    /// Список корпоративных объявлений
    public func getAnnouncements() async throws -> [Announcement] {
        try await request(endpoint: "/announcements")
    }
    
    /// Подтверждение ознакомления с объявлением
    public func acknowledgeAnnouncement(id: Int64) async throws -> AnnouncementAckResponse {
        try await request(endpoint: "/announcements/\(id)/acknowledge", method: "POST")
    }
    
    /// Смена пароля сотрудником
    public func changePassword(request changeReq: ChangePasswordRequest) async throws -> ChangePasswordResponse {
        let body = try jsonEncoder.encode(changeReq)
        let res: ChangePasswordResponse = try await request(endpoint: "/users/password", method: "POST", body: body)
        try keychain.saveAuthToken(res.token)
        return res
    }
    
    /// Обновление профиля сотрудника
    public func updateProfile(email: String?, phone: String?, customStatus: String?, avatarUrl: String?) async throws -> User {
        var dict: [String: Any] = [:]
        if let email = email { dict["email"] = email }
        if let phone = phone { dict["phone"] = phone }
        if let customStatus = customStatus { dict["custom_status"] = customStatus }
        if let avatarUrl = avatarUrl { dict["avatar_url"] = avatarUrl }
        let body = try JSONSerialization.data(withJSONObject: dict)
        return try await request(endpoint: "/users/profile", method: "PUT", body: body)
    }
    
    /// Получение политики разрешенных файлов
    public func getFilePolicy() async throws -> FilePolicyEffectiveResponse {
        try await request(endpoint: "/files/policy")
    }
    
    /// Загрузка файла/вложения (multipart/form-data)
    public func uploadFile(fileData: Data, fileName: String, mimeType: String) async throws -> FileUploadResponse {
        try await performUploadFile(fileData: fileData, fileName: fileName, mimeType: mimeType, isRetry: false)
    }

    private func performUploadFile(
        fileData: Data,
        fileName: String,
        mimeType: String,
        isRetry: Bool
    ) async throws -> FileUploadResponse {
        let serverURL = try configuredServerURL()
        let url = try apiURL(serverURL: serverURL, endpoint: "/files/upload")
        guard ServerEndpointPolicy.allowsAuthorization(to: url) else {
            throw APIError.insecureTransport
        }
        guard let token = keychain.authToken else {
            throw APIError.unauthorized
        }
        
        let boundary = "Boundary-\(UUID().uuidString)"
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        urlRequest.httpBody = body
        
        let (data, response) = try await session.data(for: urlRequest)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        if httpResponse.statusCode == 401 {
            if isRetry {
                if keychain.authToken == token {
                    try keychain.clearAllAuthData()
                }
                throw APIError.unauthorized
            }
            do {
                try await refreshAccessToken(after: token)
                return try await performUploadFile(fileData: fileData, fileName: fileName, mimeType: mimeType, isRetry: true)
            } catch APIError.unauthorized {
                if keychain.authToken == token {
                    try keychain.clearAllAuthData()
                }
                throw APIError.unauthorized
            }
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            var message = String(localized: "Не удалось загрузить файл")
            if let serverError = try? jsonDecoder.decode(ServerErrorResponse.self, from: data) {
                message = serverError.error
            }
            throw APIError.httpError(statusCode: httpResponse.statusCode, message: message, code: nil)
        }
        return try jsonDecoder.decode(FileUploadResponse.self, from: data)
    }
}
