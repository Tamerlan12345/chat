import Foundation

/// Сетевой HTTP-клиент CentyChat на основе нативного URLSession с поддержкой Swift Concurrency
public actor APIClient {
    public static let shared = APIClient()
    
    private let session: URLSession
    private let keychain: KeychainManager
    private let environment: ServerEnvironment
    private let jsonDecoder: JSONDecoder
    private let jsonEncoder: JSONEncoder
    private let refreshCoordinator = TokenRefreshCoordinator()
    /// The token each refresh produced for the token it replaced: a request that got 401 is retried
    /// only with its own session's renewed token, never with whatever the keychain holds by then
    /// (another account may have signed in meanwhile).
    private var refreshedTokens: [(stale: String, fresh: String)] = []
    
    public init(
        session: URLSession? = nil,
        keychain: KeychainManager = .shared,
        environment: ServerEnvironment = .current
    ) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = 20.0
            configuration.timeoutIntervalForResource = 60.0
            self.session = URLSession(configuration: configuration)
        }

        self.keychain = keychain
        self.environment = environment
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
        isRetry: Bool = false,
        unauthorizedMeansRejected: Bool = false
    ) async throws -> T {
        try await performRequest(
            endpoint: endpoint,
            method: method,
            queryItems: queryItems,
            body: body,
            headers: headers,
            requiresAuth: requiresAuth,
            isRetry: isRetry,
            unauthorizedMeansRejected: unauthorizedMeansRejected,
            serverURL: environment.serverURL
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
        unauthorizedMeansRejected: Bool = false,
        serverURL: URL,
        retryToken: String? = nil
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
        // Colleagues' photos as `/api/users/<id>/avatar?v=…` links, not data URLs (`openapi.yaml`).
        urlRequest.setValue(AvatarOptIn.value, forHTTPHeaderField: AvatarOptIn.header)
        if body != nil && urlRequest.value(forHTTPHeaderField: "Content-Type") == nil {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let requestToken: String?
        if requiresAuth {
            guard ServerEndpointPolicy.allowsAuthorization(to: url) else {
                throw APIError.insecureTransport
            }
            guard let token = retryToken ?? keychain.authToken else {
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

        if httpResponse.statusCode == 401 && requiresAuth && !unauthorizedMeansRejected {
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
                // Only this session's renewed token; another account's ends this request.
                guard let renewed = try await renewedToken(after: requestToken) else { throw APIError.unauthorized }
                return try await performRequest(
                    endpoint: endpoint,
                    method: method,
                    queryItems: queryItems,
                    body: body,
                    headers: headers,
                    requiresAuth: requiresAuth,
                    isRetry: true,
                    unauthorizedMeansRejected: unauthorizedMeansRejected,
                    serverURL: serverURL,
                    retryToken: renewed
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
                if let attemptsLeft = serverError.attemptsLeft {
                    throw APIError.rejectedWithAttempts(
                        statusCode: httpResponse.statusCode,
                        message: errorMessage,
                        code: errorCode,
                        attemptsLeft: attemptsLeft
                    )
                }
            }
            throw APIError.httpError(
                statusCode: httpResponse.statusCode,
                message: errorMessage,
                code: errorCode,
                retryAfter: RetryAfter.seconds(from: httpResponse.value(forHTTPHeaderField: "Retry-After"), now: Date())
            )
        }

        if let ignored = IgnoredBody() as? T {
            return ignored
        }
        do {
            return try jsonDecoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error.localizedDescription)
        }
    }

    // MARK: - Raw requests (the delivery engine reads statuses itself)

    /// An answer read as is: any HTTP status with its body; status 0 when the server could not be
    /// reached (no network, timeout, a token refresh that got no answer).
    public struct RawResponse: Sendable, Equatable {
        public let status: Int
        public let body: Data
        public let retryAfterSeconds: TimeInterval?

        static let unreachable = RawResponse(status: 0, body: Data(), retryAfterSeconds: nil)
    }

    /// Like `request`, without turning statuses into errors. A 401 refreshes the token once; only a
    /// refresh the server refuses (401/403) ends the stored session — a refresh without an answer is
    /// a network failure (status 0) and never signs the user out.
    public func raw(method: String, endpoint: String, queryItems: [URLQueryItem]? = nil, body: Data? = nil) async -> RawResponse {
        await performRaw(method: method, endpoint: endpoint, queryItems: queryItems, body: body, retryToken: nil)
    }

    private func performRaw(method: String, endpoint: String, queryItems: [URLQueryItem]?, body: Data?, retryToken: String?) async -> RawResponse {
        let isRetry = retryToken != nil
        guard let base = try? apiURL(serverURL: environment.serverURL, endpoint: endpoint),
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return .unreachable
        }
        if let queryItems, !queryItems.isEmpty { components.queryItems = queryItems }
        guard let url = components.url, ServerEndpointPolicy.allowsAuthorization(to: url) else {
            return .unreachable
        }
        guard let token = retryToken ?? keychain.authToken else {
            return RawResponse(status: 401, body: Data(), retryAfterSeconds: nil)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(AvatarOptIn.value, forHTTPHeaderField: AvatarOptIn.header)
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let data: Data
        let http: HTTPURLResponse
        do {
            let (received, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse else { return .unreachable }
            data = received
            http = response
        } catch {
            return .unreachable
        }

        if http.statusCode == 401 {
            if isRetry {
                if keychain.authToken == token { try? keychain.clearAllAuthData() }
                return RawResponse(status: 401, body: data, retryAfterSeconds: nil)
            }
            let renewed: String?
            do {
                renewed = try await renewedToken(after: token)
            } catch APIError.unauthorized {
                if keychain.authToken == token { try? keychain.clearAllAuthData() }
                return RawResponse(status: 401, body: data, retryAfterSeconds: nil)
            } catch {
                // The refresh got no answer: not a rejection, the session stays.
                return .unreachable
            }
            // Another account signed in meanwhile: this request of the old session is not repeated.
            guard let renewed else { return RawResponse(status: 401, body: data, retryAfterSeconds: nil) }
            return await performRaw(method: method, endpoint: endpoint, queryItems: queryItems, body: body, retryToken: renewed)
        }
        let retryAfter = RetryAfter.seconds(from: http.value(forHTTPHeaderField: "Retry-After"), now: Date())
        return RawResponse(status: http.statusCode, body: data, retryAfterSeconds: retryAfter)
    }

    /// Raw server records of a conversation page (`openapi.yaml` `Message`), oldest first.
    public func getMessageRecords(
        conversationType: ConversationType,
        targetId: Int64,
        limit: Int,
        beforeId: Int64? = nil,
        afterId: Int64? = nil
    ) async throws -> [JSONObject] {
        var queryItems = [
            URLQueryItem(name: "conversationType", value: conversationType.rawValue),
            URLQueryItem(name: "targetId", value: "\(targetId)"),
            URLQueryItem(name: "limit", value: "\(limit)"),
        ]
        if let beforeId { queryItems.append(URLQueryItem(name: "beforeId", value: "\(beforeId)")) }
        if let afterId { queryItems.append(URLQueryItem(name: "afterId", value: "\(afterId)")) }
        let values: [JSONValue] = try await request(endpoint: "/messages", queryItems: queryItems)
        return values.compactMap(\.object)
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

    /// The token to repeat a request that got 401 with `staleToken`: the one a refresh produced for
    /// this session (now or by a concurrent request); nil when the keychain holds another session's
    /// token. Throws `unauthorized` when the server refused the refresh.
    private func renewedToken(after staleToken: String) async throws -> String? {
        try await refreshAccessToken(after: staleToken)
        guard let current = keychain.authToken,
              refreshedTokens.contains(where: { $0.stale == staleToken && $0.fresh == current }) else { return nil }
        return current
    }

    private func remember(_ fresh: String, replacing stale: String) {
        refreshedTokens.removeAll { $0.stale == stale }
        refreshedTokens.append((stale, fresh))
        if refreshedTokens.count > 16 { refreshedTokens.removeFirst(refreshedTokens.count - 16) }
    }

    private func refreshAccessToken(after staleToken: String) async throws {
        guard keychain.authToken == staleToken else { return }
        let serverURL = environment.serverURL
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
        remember(refreshedToken, replacing: staleToken)
        if keychain.authToken == staleToken {
            try keychain.saveAuthToken(refreshedToken)
        }
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
        let res: DeviceClaimResponse = try await request(endpoint: "/auth/device/claim", method: "POST", body: body)
        return res.claimed
    }
    
    /// Вход по логину и паролю
    public func login(request loginReq: LoginRequest) async throws -> AuthSuccessResponse {
        let body = try jsonEncoder.encode(loginReq)
        let res: AuthSuccessResponse = try await request(endpoint: "/auth/login", method: "POST", body: body, requiresAuth: false)
        try keychain.saveAuthToken(res.token)
        return res
    }
    
    // MARK: - Registration

    /// Шаг 1: код подтверждения на почту. Сессии ещё нет.
    public func requestRegistration(_ body: RegisterRequestBody) async throws -> RegistrationChallenge {
        let data = try jsonEncoder.encode(body)
        return try await request(endpoint: "/auth/register/request", method: "POST", body: data, requiresAuth: false)
    }

    /// Шаг 2: код из письма. 200 — вход (токен сохраняется), 202 — заявка ждёт администратора.
    public func verifyRegistration(registrationId: String, code: String) async throws -> RegistrationOutcome {
        let data = try jsonEncoder.encode(RegisterVerifyBody(registrationId: registrationId, code: code))
        let response: RegisterVerifyResponse = try await request(
            endpoint: "/auth/register/verify", method: "POST", body: data, requiresAuth: false
        )
        if case .signedIn(let auth) = response.outcome {
            try keychain.saveAuthToken(auth.token)
        }
        return response.outcome
    }

    // MARK: - Account, reports, blocks

    /// Безвозвратное удаление своей учётной записи. После успеха локальные учётные данные стираются.
    /// 401 здесь означает отказ (неверный пароль), а не истёкшую сессию: сессия не сбрасывается.
    public func deleteAccount(password: String) async throws {
        let data = try jsonEncoder.encode(DeleteAccountBody(password: password))
        let _: IgnoredBody = try await request(
            endpoint: "/users/me", method: "DELETE", body: data, unauthorizedMeansRejected: true
        )
        try keychain.clearAllUserData()
    }

    public func report(_ body: ReportBody) async throws {
        let data = try jsonEncoder.encode(body)
        let _: IgnoredBody = try await request(endpoint: "/reports", method: "POST", body: data)
    }

    public func blockUser(id: Int64) async throws {
        let data = try jsonEncoder.encode(BlockBody(userId: id))
        let _: IgnoredBody = try await request(endpoint: "/blocks", method: "POST", body: data)
    }

    public func unblockUser(id: Int64) async throws {
        let _: IgnoredBody = try await request(endpoint: "/blocks/\(id)", method: "DELETE")
    }

    public func getBlockedUsers() async throws -> [BlockedUser] {
        let response: BlockListResponse = try await request(endpoint: "/blocks")
        return response.blocked
    }

    // MARK: - Push token

    /// `POST /devices/push-token` (`push.md` §2): idempotent; a new token of the same device and kind replaces the old one.
    func registerPushToken(_ registration: PushTokenRegistration) async throws -> PushTokenRegisterResponse {
        let body = try jsonEncoder.encode(registration)
        return try await request(endpoint: "/devices/push-token", method: "POST", body: body)
    }

    /// `DELETE /devices/push-token`: `true` for this user's token; someone else's or an unknown one is `false`.
    func unregisterPushToken(_ token: String) async throws -> Bool {
        let body = try jsonEncoder.encode(["token": token])
        let response: PushTokenDeleteResponse = try await request(endpoint: "/devices/push-token", method: "DELETE", body: body)
        return response.removed
    }

    /// Выход из системы
    public func logout() async throws {
        let deviceId = try keychain.deviceID()
        let body = try? JSONSerialization.data(withJSONObject: ["device_id": deviceId])
        let _: SuccessResponse? = try? await request(endpoint: "/auth/logout", method: "POST", body: body)
        try keychain.clearAllAuthData()
    }
    
    /// Профиль текущего пользователя
    public func getCurrentUser() async throws -> User {
        let res: CurrentUserResponse = try await request(endpoint: "/auth/me")
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
    public func getMessages(
        conversationType: ConversationType,
        targetId: Int64,
        limit: Int = 50,
        beforeId: Int64? = nil,
        afterId: Int64? = nil
    ) async throws -> [Message] {
        var queryItems = [
            URLQueryItem(name: "conversationType", value: conversationType.rawValue),
            URLQueryItem(name: "targetId", value: "\(targetId)"),
            URLQueryItem(name: "limit", value: "\(limit)")
        ]
        if let beforeId = beforeId {
            queryItems.append(URLQueryItem(name: "beforeId", value: "\(beforeId)"))
        }
        if let afterId = afterId {
            queryItems.append(URLQueryItem(name: "afterId", value: "\(afterId)"))
        }
        return try await request(endpoint: "/messages", queryItems: queryItems)
    }

    /// Поиск по тексту сообщений в доступных каналах и личной переписке (сервер принимает до 200 символов).
    public func searchMessages(query: String) async throws -> [Message] {
        try await request(endpoint: "/messages/search", queryItems: [URLQueryItem(name: "q", value: String(query.prefix(200)))])
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
        try await performUploadFile(fileData: fileData, fileName: fileName, mimeType: mimeType, retryToken: nil)
    }

    /// `POST /files/upload` streaming a file from disk: the multipart body is written to a temporary
    /// file and sent with `upload(fromFile:)`, so memory stays flat and `progress` (0…1) is real.
    /// No answer — `APIError.noConnection`; any refusal — `APIError.httpError` with the server's
    /// words, code and `Retry-After`.
    public func uploadFile(at file: URL, fileName: String, mimeType: String, progress: @escaping @Sendable (Double) -> Void) async throws -> FileUploadResponse {
        let boundary = "Boundary-\(UUID().uuidString)"
        let body = try MultipartFile.write(file: file, fieldName: "file", fileName: fileName, mimeType: mimeType, boundary: boundary, in: FileManager.default.temporaryDirectory)
        defer { try? FileManager.default.removeItem(at: body) }
        return try await performStreamingUpload(body: body, boundary: boundary, progress: progress, retryToken: nil)
    }

    private func performStreamingUpload(body: URL, boundary: String, progress: @escaping @Sendable (Double) -> Void, retryToken: String?) async throws -> FileUploadResponse {
        let isRetry = retryToken != nil
        let url = try apiURL(serverURL: environment.serverURL, endpoint: "/files/upload")
        guard ServerEndpointPolicy.allowsAuthorization(to: url) else { throw APIError.insecureTransport }
        guard let token = retryToken ?? keychain.authToken else { throw APIError.unauthorized }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(AvatarOptIn.value, forHTTPHeaderField: AvatarOptIn.header)

        let data: Data
        let http: HTTPURLResponse
        do {
            let (received, response) = try await session.upload(for: request, fromFile: body, delegate: UploadProgressDelegate(report: progress))
            guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
            data = received
            http = response
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.noConnection
        }
        if http.statusCode == 401 {
            if isRetry {
                if keychain.authToken == token { try keychain.clearAllAuthData() }
                throw APIError.unauthorized
            }
            let renewed: String?
            do {
                renewed = try await renewedToken(after: token)
            } catch APIError.unauthorized {
                if keychain.authToken == token { try keychain.clearAllAuthData() }
                throw APIError.unauthorized
            } catch {
                // The refresh got no answer: not a rejection, the file waits.
                throw APIError.noConnection
            }
            // Another account signed in meanwhile: its token never carries this account's file.
            guard let renewed else { throw APIError.unauthorized }
            return try await performStreamingUpload(body: body, boundary: boundary, progress: progress, retryToken: renewed)
        }
        guard (200...299).contains(http.statusCode) else {
            let serverError = try? jsonDecoder.decode(ServerErrorResponse.self, from: data)
            throw APIError.httpError(
                statusCode: http.statusCode,
                message: serverError?.error ?? String(localized: "Не удалось загрузить файл"),
                code: serverError?.code,
                retryAfter: RetryAfter.seconds(from: http.value(forHTTPHeaderField: "Retry-After"), now: Date())
            )
        }
        do {
            return try jsonDecoder.decode(FileUploadResponse.self, from: data)
        } catch {
            throw APIError.decodingError(error.localizedDescription)
        }
    }

    private func performUploadFile(
        fileData: Data,
        fileName: String,
        mimeType: String,
        retryToken: String?
    ) async throws -> FileUploadResponse {
        let isRetry = retryToken != nil
        let url = try apiURL(serverURL: environment.serverURL, endpoint: "/files/upload")
        guard ServerEndpointPolicy.allowsAuthorization(to: url) else {
            throw APIError.insecureTransport
        }
        guard let token = retryToken ?? keychain.authToken else {
            throw APIError.unauthorized
        }
        
        let boundary = "Boundary-\(UUID().uuidString)"
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue(AvatarOptIn.value, forHTTPHeaderField: AvatarOptIn.header)
        
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
                guard let renewed = try await renewedToken(after: token) else { throw APIError.unauthorized }
                return try await performUploadFile(fileData: fileData, fileName: fileName, mimeType: mimeType, retryToken: renewed)
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
