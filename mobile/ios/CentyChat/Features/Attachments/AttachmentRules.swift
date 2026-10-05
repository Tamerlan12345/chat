import Foundation

/// What a file is, what may be sent, and which type it may be opened as — the server's own rules
/// (`server/src/api/index.js`: `acceptUpload`, `FilePolicyService.extensionOf`, `safeDownloadType`).
enum AttachmentRules {
    /// The server's hard ceiling (`UPLOAD_LIMIT_BYTES`); an administrator's lower limit is the server's to report.
    static let maxBytes: Int64 = 100 * 1_024 * 1_024

    /// Types another viewer may open a file as — exactly the server's `SAFE_DOWNLOAD_TYPES` (audit
    /// R4-14): images without SVG, PDF, plain text, CSV, audio, video, archives.
    static let safeOpenTypes: Set<String> = [
        "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
        "application/pdf", "text/plain", "text/csv",
        "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/webm",
        "video/mp4", "video/webm", "video/quicktime",
        "application/zip", "application/x-7z-compressed", "application/vnd.rar", "application/x-rar-compressed",
    ]

    /// Formats the server thumbnails (by signature): JPEG, PNG, GIF, WebP.
    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]
    private static let imageTypes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]

    static let noNetwork = "Нет связи с сервером"
    static let refused = "Сервер не принял файл"

    /// The server's rule: no dot, a leading dot or a trailing dot — no extension.
    static func extensionOf(_ name: String) -> String {
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex, name.index(after: dot) != name.endIndex else { return "" }
        return name[name.index(after: dot)...].lowercased()
    }

    static func isImage(name: String, mimeType: String?) -> Bool {
        let ext = extensionOf(name)
        if !ext.isEmpty { return imageExtensions.contains(ext) }
        return mimeType.map { imageTypes.contains($0.lowercased()) } ?? false
    }

    /// The type a downloaded file may be opened as inside the app: the type of its extension (the
    /// extensions are what the administrator's policy allows), kept only when it is one of
    /// `safeOpenTypes`. Never the sender's `mimeType` — any client can write it. Nil — not safe to
    /// show inside the app (it is offered to other apps instead).
    static func openType(forName name: String, typeForExtension: (String) -> String?) -> String? {
        let ext = extensionOf(name)
        guard !ext.isEmpty,
              let type = typeForExtension(ext)?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased(),
              safeOpenTypes.contains(type) else { return nil }
        return type
    }

    /// Nil — the file may be sent; otherwise the reason, in the server's words. `policy` nil — unknown
    /// (the server still checks).
    static func problem(name: String, size: Int64?, policy: FilePolicyEffectiveResponse?) -> String? {
        if size == 0 { return "Файл пустой" }
        if let size, size > maxBytes { return "Файл больше 100 МБ — такой файл загрузить нельзя" }
        guard let policy, policy.enabled else { return nil }
        let ext = extensionOf(name)
        if ext.isEmpty { return "У файла нет расширения" }
        let allowed = Set(policy.allowed.map { $0.trimmingCharacters(in: .whitespaces).lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) })
        if !allowed.contains(ext) { return "Файлы .\(ext) к отправке не разрешены" }
        return nil
    }

    /// The server could not be reached (or the session must be renewed first): the file is not
    /// refused, it waits for the connection and its account.
    static func isTransportFailure(_ error: any Error) -> Bool {
        if let api = error as? APIError {
            switch api {
            case .noConnection, .unauthorized: return true
            default: return false
            }
        }
        return error is URLError
    }

    /// How long to wait before a failed upload goes again; nil — the server refused the file for good.
    /// No answer, a session to renew, «Дождитесь окончания текущих загрузок» / the hourly quota (429),
    /// a full disk (507) and server errors (5xx) are waits, honouring the server's `Retry-After`.
    static func retryDelayMs(_ error: any Error) -> Int64? {
        if isTransportFailure(error) { return AttachmentUploads.retryDelayMs }
        guard let api = error as? APIError, case .httpError(let status, _, _, let retryAfter) = api,
              status == 408 || status == 429 || (500...599).contains(status) else { return nil }
        if let retryAfter, retryAfter > 0 { return Int64((retryAfter * 1_000).rounded(.up)) }
        return AttachmentUploads.retryDelayMs
    }

    /// The reason an upload failed, for the bubble and the notice.
    static func failureText(_ error: any Error) -> String {
        if isTransportFailure(error) { return noNetwork }
        if let api = error as? APIError, case .httpError(_, let message, _, _) = api {
            let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty || text.hasPrefix("HTTP error") ? refused : text
        }
        return refused
    }

    /// `metadata` of the message, as the desktop sends it: the server checks `file_id` belongs to the
    /// sender; the rest lets every client draw the tile before it asks for the file.
    static func metadata(fileId: Int64, size: Int64?, mimeType: String?, width: Int?, height: Int?) -> JSONValue {
        var object: JSONObject = ["file_id": .int(fileId), "url": .string("/api/files/download/\(fileId)")]
        if let size { object["size"] = .int(size) }
        if let mimeType { object["mimeType"] = .string(mimeType) }
        if let width, let height {
            object["width"] = .int(Int64(width))
            object["height"] = .int(Int64(height))
        }
        return .object(object)
    }

    private static let maxNameLength = 120

    /// A file name that stays inside its folder and is never one of the service files.
    static func safeFileName(_ name: String) -> String {
        let unsafe: Set<Character> = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"]
        var clean = String(name.trimmingCharacters(in: .whitespaces).map { character -> Character in
            if unsafe.contains(character) || character.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) {
                return "_"
            }
            return character
        })
        if clean.trimmingCharacters(in: .whitespaces).isEmpty || clean.allSatisfy({ $0 == "." }) { clean = "файл" }
        if clean.hasPrefix(".") { clean = "_" + clean }
        if clean.count > maxNameLength {
            var ext = ""
            if let dot = clean.lastIndex(of: "."), dot != clean.startIndex {
                ext = String(clean[clean.index(after: dot)...].prefix(16))
            }
            if ext.isEmpty {
                clean = String(clean.prefix(maxNameLength))
            } else {
                clean = String(clean.prefix(maxNameLength - ext.count - 1)) + "." + ext
            }
        }
        return clean
    }
}
