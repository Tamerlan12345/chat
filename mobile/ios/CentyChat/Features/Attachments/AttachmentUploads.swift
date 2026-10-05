import Foundation
import Observation

/// A file the user picked: where its bytes are, its name and type.
struct PickedAttachment: Sendable {
    enum Source: Sendable {
        /// A file the app may read now (the document picker's copy, a temporary file).
        case file(URL)
        /// Bytes already in memory (a photo).
        case data(Data)
    }

    let source: Source
    let name: String
    let mimeType: String
    var width: Int?
    var height: Int?
}

/// The app's private copies of files waiting to go up: `Application Support/Outbox/<key>/<name>`,
/// excluded from backup, deleted once the message is confirmed, cancelled or the account's data is
/// wiped.
struct AttachmentFiles: Sendable {
    let root: URL

    static func defaultRoot() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return base.appendingPathComponent("Outbox", isDirectory: true)
    }

    /// Copies the picked bytes; returns the copy's path (relative to `root`) and size.
    func keep(_ picked: PickedAttachment, key: String) throws -> (path: String, size: Int64) {
        let files = FileManager.default
        let folder = root.appendingPathComponent(key, isDirectory: true)
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        var excluded = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        let name = AttachmentRules.safeFileName(picked.name)
        let target = folder.appendingPathComponent(name)
        switch picked.source {
        case .data(let data):
            try data.write(to: target, options: .atomic)
        case .file(let url):
            if files.fileExists(atPath: target.path) { try files.removeItem(at: target) }
            try files.copyItem(at: url, to: target)
        }
        let size = (try files.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.int64Value ?? 0
        return ("\(key)/\(name)", size)
    }

    func url(_ path: String) -> URL {
        root.appendingPathComponent(path)
    }

    /// Deletes the copy of one file (its whole folder).
    func discard(_ path: String) {
        guard let key = path.split(separator: "/").first else { return }
        try? FileManager.default.removeItem(at: root.appendingPathComponent(String(key), isDirectory: true))
    }

    /// Deletes every copy whose key is not in `keys` (left from an earlier process).
    func prune(keeping keys: Set<String>) {
        let folders = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for folder in folders where !keys.contains(folder.lastPathComponent) {
            try? FileManager.default.removeItem(at: folder)
        }
    }

    func removeAll() throws {
        if FileManager.default.fileExists(atPath: root.path) {
            try FileManager.default.removeItem(at: root)
        }
    }
}

/// `POST /api/files/upload` (multipart, field `file`).
protocol AttachmentUploader: Sendable {
    func upload(file: URL, name: String, mimeType: String, progress: @escaping @Sendable (Double) -> Void) async throws -> FileUploadResponse
}

/// Files on their way into the outbox. A picked file is kept as the app's private copy and recorded
/// before anything else happens (so it survives termination), goes up when there is a connection,
/// and only then enters the delivery outbox as a `file`/`image` message with the same
/// `client_msg_id` (`delivery-state.md` §3.1). A network failure leaves it queued (it goes again by
/// itself); the server's refusal fails it with the server's reason («Повторить» / «Удалить»).
@MainActor
@Observable
final class AttachmentUploads {
    struct Item: Identifiable, Equatable {
        var id: String { pending.clientMsgId }
        var pending: PendingUpload
        /// 0…1 while it is going up.
        var progress: Double?
    }

    struct Notice: Equatable {
        let conversation: String
        let text: String
        let serial: Int
    }

    /// Pause before a queued file goes again while the connection stays up.
    static let retryDelayMs: Int64 = 15_000

    private(set) var items: [Item] = []
    /// Files already in the outbox (uploaded), until the server confirms them: the bubble keeps
    /// drawing the local copy instead of flashing to the server's thumbnail.
    private(set) var handedOver: [String: PendingUpload] = [:]
    /// The server refused a file (its reason, for the open chat).
    private(set) var lastNotice: Notice?

    @ObservationIgnored private let store: any PendingUploadStore
    @ObservationIgnored let files: AttachmentFiles
    @ObservationIgnored private let uploader: any AttachmentUploader
    @ObservationIgnored private let engine: DeliveryEngine
    @ObservationIgnored private let clock: any DeliveryClock
    @ObservationIgnored private let owner: @MainActor () -> Int64?
    @ObservationIgnored private let log: @Sendable (String) -> Void
    @ObservationIgnored private var online = false
    @ObservationIgnored private var started = false
    @ObservationIgnored private var restoreTask: Task<Void, Never>?
    @ObservationIgnored private var running: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var retries: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var noticeSerial = 0
    /// Bumped by a wipe: an upload of the old account that answers later is dropped.
    @ObservationIgnored private var epoch = 0

    init(
        store: any PendingUploadStore,
        files: AttachmentFiles,
        uploader: any AttachmentUploader,
        engine: DeliveryEngine,
        clock: any DeliveryClock = SystemDeliveryClock(),
        owner: @escaping @MainActor () -> Int64?,
        log: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.store = store
        self.files = files
        self.uploader = uploader
        self.engine = engine
        self.clock = clock
        self.owner = owner
        self.log = log
    }

    /// Loads the files that waited across a restart; forgets them when the queue is wiped.
    func start() {
        guard !started else { return }
        started = true
        engine.onWipe.append { [weak self] in self?.forget() }
        engine.onStateChange.append { [weak self] state in self?.dropConfirmed(state) }
        restoreTask = Task { [weak self] in await self?.restore() }
    }

    /// Returns once the stored files are loaded.
    func restored() async {
        await restoreTask?.value
    }

    private func restore() async {
        let stored: [PendingUpload]
        do {
            stored = try await store.uploads()
        } catch {
            log("waiting files could not be read: \(error)")
            return
        }
        let known = Set(items.map(\.id))
        items += stored.filter { !known.contains($0.clientMsgId) }.map { Item(pending: $0) }
        // A copy is needed only while its file waits; the rest are left from an earlier process.
        files.prune(keeping: Set(items.map(\.id)).union(engine.state.outbox.map(\.clientMsgId)))
        if online { pendingKeys().forEach { launch($0) } }
    }

    /// The socket is up (or not): waiting files go when it is.
    func setOnline(_ value: Bool) {
        online = value
        if value { pendingKeys().forEach { launch($0) } }
    }

    /// Keeps `picked` for `conversation` (a private copy and a stored row) and starts it when online.
    /// False when the file could not be kept: nothing was queued.
    func add(conversation: String, picked: PickedAttachment, replyToId: Int64?, owner: Int64) async -> Bool {
        await restored()
        let key = DeliveryEngine.newClientMsgId()
        let files = self.files
        let kept: (path: String, size: Int64)
        do {
            kept = try await Task.detached { try files.keep(picked, key: key) }.value
        } catch {
            log("a picked file could not be kept: \(error)")
            return false
        }
        let pending = PendingUpload(
            clientMsgId: key,
            conversation: conversation,
            owner: owner,
            createdAt: clock.now(),
            name: picked.name,
            size: kept.size,
            mimeType: picked.mimeType,
            width: picked.width,
            height: picked.height,
            localPath: kept.path,
            replyToId: replyToId
        )
        do {
            try await store.putUpload(pending)
        } catch {
            log("a picked file could not be recorded: \(error)")
            files.discard(kept.path)
            return false
        }
        items.append(Item(pending: pending))
        if online { launch(key) }
        return true
    }

    /// «Повторить» on a refused file: it goes up again.
    func retry(_ clientMsgId: String) {
        guard let index = items.firstIndex(where: { $0.id == clientMsgId }), items[index].pending.failed else { return }
        items[index].pending.failed = false
        items[index].pending.error = nil
        let again = items[index].pending
        let store = self.store
        Task { try? await store.putUpload(again) }
        launch(clientMsgId, ignoringConnection: true)
    }

    /// «Отменить» / «Удалить»: the upload stops and the file is forgotten.
    func cancel(_ clientMsgId: String) async {
        guard let item = items.first(where: { $0.id == clientMsgId }) else { return }
        running.removeValue(forKey: clientMsgId)?.cancel()
        retries.removeValue(forKey: clientMsgId)?.cancel()
        items.removeAll { $0.id == clientMsgId }
        do {
            try await store.removeUpload(clientMsgId)
        } catch {
            log("a cancelled file's row could not be deleted: \(error)")
        }
        files.discard(item.pending.localPath)
    }

    /// Every waiting file goes now, whatever the socket; returns when they settled (the flush
    /// without a socket).
    func flush() async {
        await restored()
        pendingKeys().forEach { launch($0, ignoringConnection: true) }
        for task in Array(running.values) { await task.value }
    }

    /// Waiting (not refused) files of `owner`.
    func waitingCount(of owner: Int64?) -> Int {
        items.filter { $0.pending.owner == owner }.count
    }

    /// Explicit sign-out or account deletion: uploads stop, the copies and rows are deleted.
    func reset() async throws {
        forget()
        try await store.clearUploads()
    }

    /// The queue was wiped (sign-out, another account): stop and forget the files.
    private func forget() {
        epoch += 1
        running.values.forEach { $0.cancel() }
        running.removeAll()
        retries.values.forEach { $0.cancel() }
        retries.removeAll()
        items.removeAll()
        handedOver.removeAll()
        let store = self.store
        let files = self.files
        let log = self.log
        Task {
            do {
                try await store.clearUploads()
            } catch {
                log("waiting files could not be deleted: \(error)")
            }
            files.prune(keeping: [])
        }
    }

    /// Once the outbox no longer holds a handed-over file (confirmed or dropped), its copy goes.
    private func dropConfirmed(_ state: DeliveryState) {
        guard !handedOver.isEmpty else { return }
        let inOutbox = Set(state.outbox.map(\.clientMsgId))
        for (key, pending) in handedOver where !inOutbox.contains(key) {
            handedOver[key] = nil
            files.discard(pending.localPath)
        }
    }

    private func pendingKeys() -> [String] {
        items.filter { !$0.pending.failed && $0.progress == nil }.map(\.id)
    }

    /// Files go up only for the account that picked them, never under another account's token.
    private func mayUpload(_ pending: PendingUpload) -> Bool {
        guard engine.ready, let user = owner(), user == pending.owner else { return false }
        return engine.state.me == nil || engine.state.me == user
    }

    private func launch(_ key: String, ignoringConnection: Bool = false) {
        guard ignoringConnection || online, running[key] == nil,
              let item = items.first(where: { $0.id == key }), !item.pending.failed, mayUpload(item.pending) else { return }
        retries.removeValue(forKey: key)?.cancel()
        let session = epoch
        running[key] = Task { [weak self] in
            await self?.upload(item.pending, session: session)
            if self?.epoch == session { self?.running[key] = nil }
        }
    }

    private func setProgress(_ key: String, _ progress: Double?) {
        guard let index = items.firstIndex(where: { $0.id == key }) else { return }
        items[index].progress = progress
    }

    private func upload(_ pending: PendingUpload, session: Int) async {
        let key = pending.clientMsgId
        setProgress(key, 0)
        let uploader = self.uploader
        let file = files.url(pending.localPath)
        let mimeType = pending.mimeType ?? "application/octet-stream"
        do {
            let done = try await uploader.upload(file: file, name: pending.name, mimeType: mimeType) { [weak self] value in
                Task { @MainActor in
                    guard let self, self.epoch == session else { return }
                    if let current = self.items.first(where: { $0.id == key })?.progress, Int(current * 100) == Int(value * 100) { return }
                    self.setProgress(key, value)
                }
            }
            guard epoch == session, items.contains(where: { $0.id == key }) else { return }
            let metadata = AttachmentRules.metadata(fileId: done.id, size: done.fileSize, mimeType: done.mimeType, width: pending.width ?? done.width, height: pending.height ?? done.height)
            let outcome = await engine.enqueue(
                conversation: pending.conversation,
                text: pending.name,
                msgType: AttachmentRules.isImage(name: pending.name, mimeType: pending.mimeType) ? "image" : "file",
                replyToId: pending.replyToId,
                metadata: metadata,
                clientMsgId: key,
                owner: pending.owner
            )
            guard epoch == session else { return }
            if !outcome.persisted {
                // The outbox could not be written: the file waits and goes again.
                setProgress(key, nil)
                scheduleRetry(key)
                return
            }
            if engine.state.outbox.contains(where: { $0.clientMsgId == key }) {
                handedOver[key] = pending
            } else {
                files.discard(pending.localPath)
            }
            items.removeAll { $0.id == key }
            do {
                try await store.removeUpload(key)
            } catch {
                log("an uploaded file's row could not be deleted: \(error)")
            }
        } catch {
            guard epoch == session, items.contains(where: { $0.id == key }) else { return }
            if error is CancellationError { return }
            if AttachmentRules.isTransportFailure(error) {
                // No answer from the server: not refused, it waits for the connection.
                setProgress(key, nil)
                scheduleRetry(key)
                return
            }
            let reason = AttachmentRules.failureText(error)
            guard let index = items.firstIndex(where: { $0.id == key }) else { return }
            items[index].progress = nil
            items[index].pending.failed = true
            items[index].pending.error = reason
            let failed = items[index].pending
            do {
                try await store.putUpload(failed)
            } catch {
                log("a refused file could not be recorded: \(error)")
            }
            noticeSerial += 1
            lastNotice = Notice(conversation: pending.conversation, text: reason, serial: noticeSerial)
        }
    }

    private func scheduleRetry(_ key: String) {
        retries.removeValue(forKey: key)?.cancel()
        let clock = self.clock
        retries[key] = Task { [weak self] in
            try? await clock.sleep(milliseconds: Self.retryDelayMs)
            guard !Task.isCancelled, let self else { return }
            self.retries[key] = nil
            if self.online { self.launch(key) }
        }
    }
}
