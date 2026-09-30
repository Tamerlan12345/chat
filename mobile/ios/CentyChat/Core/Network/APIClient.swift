import Foundation

/// Сетевой HTTP-клиент CentyChat на основе нативного URLSession с поддержкой Swift Concurrency
public actor APIClient {
    public static let shared = APIClient()
    
    private let session: URLSession
    private let jsonDecoder: JSONDecoder
    private let jsonEncoder: JSONEncoder
    private var isRefreshingToken = false
    
    public init(session: URLSession = .shared) {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 20.0
        configuration.timeoutIntervalForResource = 60.0
        self.session = URLSession(configuration: configuration)
        
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
        let serverUrlString = KeychainManager.shared.serverUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        
        guard var components = URLComponents(string: "\(serverUrlString)/api\(endpoint)") else {
            throw APIError.invalidURL("\(serverUrlString)/api\(endpoint)")
        }
        
        if let queryItems = queryItems, !queryItems.isEmpty {
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
        
        if requiresAuth, let token = KeychainManager.shared.authToken {
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        if let headers = headers {
            for (key, val) in headers {
                urlRequest.setValue(val, forHTTPHeaderField: key)
            }
        }
        
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch {
            throw APIError.noConnection
        }
        
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        
        // 401 Unauthorized -> Handle token refresh and retry
        if httpResponse.statusCode == 401 && requiresAuth && !isRetry {
            do {
                try await performTokenRefresh()
                return try await request(
                    endpoint: endpoint,
                    method: method,
                    queryItems: queryItems,
                    body: body,
                    headers: headers,
                    requiresAuth: requiresAuth,
                    isRetry: true
                )
            } catch {
                KeychainManager.shared.clearAllAuthData()
                throw APIError.unauthorized
            }
        }
        
        // 403 Forbidden -> Check for MUST_CHANGE_PASSWORD
        if httpResponse.statusCode == 403 {
            if let serverError = try? jsonDecoder.decode(ServerErrorResponse.self, from: data),
               serverError.code == "MUST_CHANGE_PASSWORD" {
                throw APIError.mustChangePassword(message: serverError.error)
            }
        }
        
        // Error handling
        guard (200...299).contains(httpResponse.statusCode) else {
            var errorMessage = "Ошибка запроса"
            var errorCode: String? = nil
            if let serverErr = try? jsonDecoder.decode(ServerErrorResponse.self, from: data) {
                errorMessage = serverErr.error
                errorCode = serverErr.code
            } else if let raw = String(data: data, encoding: .utf8), !raw.isEmpty {
                errorMessage = raw
            }
            throw APIError.httpError(statusCode: httpResponse.statusCode, message: errorMessage, code: errorCode)
        }
        
        // Decode expected response
        do {
            return try jsonDecoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error.localizedDescription)
        }
    }
    
    // MARK: - Auto-Refresh Logic
    
    private func performTokenRefresh() async throws {
        guard !isRefreshingToken else { return }
        isRefreshingToken = true
        defer { isRefreshingToken = false }
        
        let serverUrlString = KeychainManager.shared.serverUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(serverUrlString)/api/auth/refresh") else {
            throw APIError.invalidURL("/api/auth/refresh")
        }
        
        guard let currentToken = KeychainManager.shared.authToken else {
            throw APIError.unauthorized
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(currentToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200...299).contains(httpResponse.statusCode) else {
            throw APIError.unauthorized
        }
        
        let refreshResponse = try jsonDecoder.decode(RefreshTokenResponse.self, from: data)
        KeychainManager.shared.authToken = refreshResponse.token
    }
    
    // MARK: - Endpoints Implementation
    
    /// Проверка доступности сервера
    public func checkHealth() async throws -> HealthResponse {
        try await request(endpoint: "/health", requiresAuth: false)
    }
    
    /// Общедоступные сведения о сервере
    public func getServerInfo() async throws -> ServerInfo {
        try await request(endpoint: "/settings/info", requiresAuth: false)
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
        KeychainManager.shared.authToken = res.token
        return res
    }
    
    /// Выход из системы
    public func logout() async throws {
        let deviceId = KeychainManager.shared.deviceId
        let body = try? JSONSerialization.data(withJSONObject: ["device_id": deviceId])
        struct LogoutResponse: Codable { let success: Bool }
        let _: LogoutResponse? = try? await request(endpoint: "/auth/logout", method: "POST", body: body)
        KeychainManager.shared.clearAllAuthData()
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
        KeychainManager.shared.authToken = res.token
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
        let serverUrlString = KeychainManager.shared.serverUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(serverUrlString)/api/files/upload") else {
            throw APIError.invalidURL("/api/files/upload")
        }
        
        let boundary = "Boundary-\(UUID().uuidString)"
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        
        if let token = KeychainManager.shared.authToken {
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
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
        
        guard (200...299).contains(httpResponse.statusCode) else {
            var msg = "Ошибка загрузки файла"
            if let serverErr = try? jsonDecoder.decode(ServerErrorResponse.self, from: data) {
                msg = serverErr.error
            }
            throw APIError.httpError(statusCode: httpResponse.statusCode, message: msg, code: nil)
        }
        
        return try jsonDecoder.decode(FileUploadResponse.self, from: data)
    }
}
